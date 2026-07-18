use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
};

use async_trait::async_trait;
use chrono::Utc;
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin},
    sync::{mpsc, oneshot, watch},
};
use vertebrae_harness_core::{
    CompletionStatus, ControlDecision, ControlRequestEnvelope, ControlRequestId, ControlResolution,
    ControlSink, DiagnosticEvent, EventCorrelation, EventSequencer, EventSink, HarnessCapabilities,
    HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1, HarnessRuntime, ModelCapability,
    ProviderResumeId, QuestionCapabilities, ResolutionSource, RunHandle, RunId, RunOutcome,
    RunRequest, SendTurnRequest, SequencedEventSink, SessionCloseOutcome, SessionCloseStatus,
    SessionHandle, SessionId, StartSessionRequest, StreamId, ThreadId, TurnId, TurnInput,
    TurnInputProvenance, TurnOutcome, TurnStarted, UpdateSemantics,
};

use crate::{
    ClaudeDecodeContext, ClaudeLaunchMode, ClaudeProviderConfig, ClaudeRootLocatorResolver,
    ClaudeStreamDecoder, DEFAULT_CLAUDE_MODELS,
};

mod handles;
mod process;

use handles::{ClaudeRunHandle, ClaudeSessionHandle, OutcomeState};
use process::{ProcessOutput, reap, spawn_output_readers, spawn_process, wait_then_reap};

#[derive(Clone)]
pub struct ClaudeRuntime {
    config: Arc<ClaudeProviderConfig>,
}

impl ClaudeRuntime {
    pub fn new(config: ClaudeProviderConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }

    pub fn config(&self) -> &ClaudeProviderConfig {
        &self.config
    }
}

enum SessionCommand {
    Send {
        request: SendTurnRequest,
        outcome_tx: watch::Sender<OutcomeState<TurnOutcome>>,
        response: oneshot::Sender<Result<(), String>>,
    },
    Interrupt {
        turn_id: TurnId,
        response: oneshot::Sender<Result<(), String>>,
    },
    Close {
        response: oneshot::Sender<Result<SessionCloseOutcome, String>>,
    },
}

struct PendingTurn {
    id: TurnId,
    content: String,
    input_emitted: bool,
    response: Option<oneshot::Sender<Result<(), String>>>,
    outcome_tx: watch::Sender<OutcomeState<TurnOutcome>>,
}

struct PendingControl {
    request: ControlRequestEnvelope,
    provider_input: Option<serde_json::Value>,
    stream_id: StreamId,
    correlation: EventCorrelation,
    abort: tokio::task::AbortHandle,
}

struct ControlCompletion {
    request_id: ControlRequestId,
    result: Result<ControlResolution, HarnessError>,
}

#[async_trait]
impl HarnessRuntime for ClaudeRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        match self.config.resolve_executable() {
            Ok(_) => Ok(HarnessCapabilities {
                provider: "anthropic".into(),
                available: true,
                unavailable_reason: None,
                persistent_sessions: true,
                one_shot_runs: true,
                session_resumption: true,
                default_model: Some("sonnet".into()),
                models: DEFAULT_CLAUDE_MODELS
                    .iter()
                    .map(|(id, label)| ModelCapability {
                        id: (*id).into(),
                        label: (*label).into(),
                        reasoning_efforts: BTreeSet::new(),
                    })
                    .collect(),
                approval_categories: BTreeSet::new(),
                questions: QuestionCapabilities {
                    multiple_selection: true,
                    free_form_answers: true,
                    automatic_resolution: true,
                },
            }),
            Err(error) => Ok(HarnessCapabilities {
                provider: "anthropic".into(),
                available: false,
                unavailable_reason: Some(error.to_string()),
                persistent_sessions: true,
                one_shot_runs: true,
                session_resumption: true,
                default_model: Some("sonnet".into()),
                models: Vec::new(),
                approval_categories: BTreeSet::new(),
                questions: QuestionCapabilities::default(),
            }),
        }
    }

    async fn start_session(
        &self,
        request: StartSessionRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        let spec = self.config.command_spec(
            ClaudeLaunchMode::Persistent {
                resume_id: request.resume_id.as_ref().map(ProviderResumeId::as_str),
            },
            &request.config,
        )?;
        let mut child = spawn_process(&spec, true)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stdin".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stdout".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stderr".into())
        })?;
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let (close_tx, close_rx) = watch::channel(OutcomeState::Pending);
        let context = ClaudeDecodeContext {
            // A newly created Claude session has no provider conversation id
            // until the first input causes Claude to emit system/init. A
            // resumed session can safely send its known provider id.
            session_id: request
                .resume_id
                .as_ref()
                .map(|resume_id| SessionId::new(resume_id.as_str())),
            root_thread_id: ThreadId::new(request.session_id.as_str()),
            root_stream_id: request.stream_id,
            turn_id: None,
            run_id: None,
            provider_resume_id: request.resume_id.clone(),
        };
        let cleanup_timeout = self.config.cleanup_timeout;
        let initialization_timeout = self.config.initialization_timeout;
        let root_locator_resolver = self.config.root_locator_resolver.clone();
        tokio::spawn(run_persistent_process_v2(
            child,
            stdin,
            stdout,
            stderr,
            command_rx,
            close_tx,
            context,
            event_sink,
            control_sink,
            cleanup_timeout,
            initialization_timeout,
            root_locator_resolver,
        ));
        Ok(Arc::new(ClaudeSessionHandle {
            // Claude Code emits its canonical system/init record only after
            // the first stream-json user message. The authoritative provider
            // identity arrives through SessionStarted; these request values
            // keep the handle usable while that first turn is in flight.
            session_id: request.session_id,
            provider_resume_id: request.resume_id,
            command_tx,
            close_rx,
        }))
    }

    async fn run_once(
        &self,
        request: RunRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        let spec = self.config.command_spec(
            ClaudeLaunchMode::OneShot {
                prompt: &request.prompt,
            },
            &request.config,
        )?;
        let mut child = spawn_process(&spec, true)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stdin".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stdout".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            HarnessError::Operation("Claude process was spawned without piped stderr".into())
        })?;
        let (cancel_tx, cancel_rx) = mpsc::unbounded_channel();
        let (outcome_tx, outcome_rx) = watch::channel(OutcomeState::Pending);
        let context = ClaudeDecodeContext::one_shot(request.run_id.clone(), request.stream_id);
        let cleanup_timeout = self.config.cleanup_timeout;
        let terminal_exit_timeout = self.config.terminal_exit_timeout;
        let root_locator_resolver = self.config.root_locator_resolver.clone();
        tokio::spawn(run_one_shot_process_v2(
            child,
            stdin,
            stdout,
            stderr,
            cancel_rx,
            outcome_tx,
            context,
            request.prompt,
            event_sink,
            control_sink,
            cleanup_timeout,
            terminal_exit_timeout,
            root_locator_resolver,
        ));
        Ok(Arc::new(ClaudeRunHandle {
            run_id: request.run_id,
            cancel_tx,
            outcome_rx,
        }))
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_persistent_process_v2(
    mut child: Child,
    mut stdin: ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    mut commands: mpsc::UnboundedReceiver<SessionCommand>,
    close_tx: watch::Sender<OutcomeState<SessionCloseOutcome>>,
    context: ClaudeDecodeContext,
    event_sink: Arc<dyn EventSink>,
    control_sink: Arc<dyn ControlSink>,
    cleanup_timeout: std::time::Duration,
    initialization_timeout: std::time::Duration,
    root_locator_resolver: Option<Arc<dyn ClaudeRootLocatorResolver>>,
) {
    let stream_id = context.root_stream_id.clone();
    let sequenced = SequencedEventSink::new(Arc::new(EventSequencer::default()), event_sink);
    let mut decoder =
        ClaudeStreamDecoder::with_root_locator_resolver(context, root_locator_resolver);
    let mut output = spawn_output_readers(stdout, stderr);
    let mut pending_turn: Option<PendingTurn> = None;
    let mut initialization_timer = Box::pin(tokio::time::sleep(initialization_timeout));
    let mut initialization_timer_armed = false;
    let mut initialized = false;
    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<ControlCompletion>();
    let mut controls = HashMap::new();
    let mut close_response = None;
    // Unexpected process/runtime failures settle controls as fallbacks. Only an
    // explicit consumer stop is cancellation; keeping those cases distinct is
    // part of the cross-surface lifecycle contract.
    let mut stop_source = ResolutionSource::Fallback;
    let mut requested_stop = false;
    let mut close_status = SessionCloseStatus::ProcessLost;
    let mut close_error = Some("Claude stdout closed unexpectedly".to_string());

    'process: loop {
        tokio::select! {
            _ = &mut initialization_timer, if initialization_timer_armed && !initialized => {
                close_status = SessionCloseStatus::Failed;
                close_error = Some(format!(
                    "Claude session initialization timed out after {} ms",
                    initialization_timeout.as_millis()
                ));
                break 'process;
            }
            command = commands.recv() => match command {
                Some(SessionCommand::Send { request, outcome_tx, response }) => {
                    if pending_turn.is_some() {
                        let _ = response.send(Err("Claude accepts only one active turn per session".into()));
                        continue;
                    }
                    match begin_persistent_turn(
                        &mut stdin,
                        request,
                        outcome_tx,
                        response,
                        &mut decoder,
                        &sequenced,
                    )
                    .await
                    {
                        Ok(turn) => {
                            if !initialized {
                                initialization_timer.as_mut().reset(tokio::time::Instant::now() + initialization_timeout);
                                initialization_timer_armed = true;
                            }
                            let initialized_before_send = turn.input_emitted;
                            pending_turn = Some(turn);
                            if initialized_before_send
                                && let Some(turn) = pending_turn.as_mut()
                                && let Some(response) = turn.response.take()
                            {
                                let _ = response.send(Ok(()));
                            }
                        }
                        Err(error) => {
                            close_status = SessionCloseStatus::Failed;
                            close_error = Some(error);
                            break 'process;
                        }
                    }
                }
                Some(SessionCommand::Interrupt { turn_id, response }) => {
                    if pending_turn.as_ref().map(|turn| &turn.id) != Some(&turn_id) {
                        let _ = response.send(Err(format!("turn {turn_id} is not active")));
                        continue;
                    }
                    let outcome = TurnOutcome { status: CompletionStatus::Interrupted, result_text: None, structured_output: None, usage: None, metrics: vertebrae_harness_core::OutcomeMetrics::default(), error: None };
                    if let Some(turn) = pending_turn.take() {
                        if let Some(response) = turn.response {
                            let _ = response.send(Err(
                                "Claude turn was interrupted before canonical initialization"
                                    .into(),
                            ));
                        }
                        let _ = turn.outcome_tx.send(OutcomeState::Ready(outcome.clone()));
                    }
                    let context = decoder.context().clone();
                    if emit_runtime_event(&sequenced, stream_id.clone(), correlation(context.session_id, &context.root_thread_id, Some(turn_id), None), HarnessEventPayloadV1::TurnFinished(outcome)).await.is_err() {
                        close_status = SessionCloseStatus::Failed;
                        close_error = Some("event sink failed while interrupting Claude turn".into());
                    } else {
                        close_status = SessionCloseStatus::Closed;
                        close_error = None;
                    }
                    stop_source = ResolutionSource::Interrupted;
                    requested_stop = true;
                    let _ = response.send(Ok(()));
                    break 'process;
                }
                Some(SessionCommand::Close { response }) => {
                    close_response = Some(response);
                    close_status = SessionCloseStatus::Closed;
                    close_error = None;
                    stop_source = ResolutionSource::Cancelled;
                    requested_stop = true;
                    break 'process;
                }
                None => {
                    stop_source = ResolutionSource::Cancelled;
                    requested_stop = true;
                    break 'process;
                }
            },
            completion = control_rx.recv(), if !controls.is_empty() => {
                let Some(completion) = completion else { continue };
                let Some(pending_control) = controls.remove(&completion.request_id) else { continue };
                match completion.result {
                    Ok(resolution) => {
                        if emit_control_resolution(&sequenced, &pending_control, resolution.clone()).await.is_err() {
                            close_status = SessionCloseStatus::Failed;
                            close_error = Some("event sink failed while resolving Claude control".into());
                            break 'process;
                        }
                        match encode_control_response(
                            &pending_control.request,
                            pending_control.provider_input.as_ref(),
                            &resolution,
                        ) {
                            Ok(line) => {
                                if let Err(error) = write_line(&mut stdin, &line).await {
                                    close_status = SessionCloseStatus::Failed;
                                    close_error = Some(format!("failed to write Claude control response: {error}"));
                                    break 'process;
                                }
                            }
                            Err(error) => {
                                close_status = SessionCloseStatus::Failed;
                                close_error = Some(error);
                                break 'process;
                            }
                        }
                    }
                    Err(error) => {
                        let resolution = ControlResolution {
                            request_id: pending_control.request.request_id.clone(),
                            source: ResolutionSource::Fallback,
                            decision: None,
                            message: Some(format!("Claude control request failed: {error}")),
                        };
                        if emit_control_resolution(&sequenced, &pending_control, resolution)
                            .await
                            .is_err()
                        {
                            close_error = Some(
                                "event sink failed while reporting Claude control failure".into(),
                            );
                            close_status = SessionCloseStatus::Failed;
                            break 'process;
                        }
                        close_status = SessionCloseStatus::Failed;
                        close_error = Some(format!("Claude control request failed: {error}"));
                        break 'process;
                    }
                }
            }
            message = output.recv() => match message {
                Some(ProcessOutput::Stdout(line)) => match decoder.decode_line(&line) {
                    Ok(drafts) => {
                        let mut saw_root_declaration = false;
                        for draft in drafts {
                            saw_root_declaration |= matches!(&draft.payload, HarnessEventPayloadV1::ThreadDeclared(declaration) if declaration.kind == vertebrae_harness_core::ThreadKind::Root);
                            let terminal = match &draft.payload {
                                HarnessEventPayloadV1::TurnFinished(outcome) => Some(outcome.clone()),
                                _ => None,
                            };
                            let provider_input = provider_control_input(&mut decoder, &draft);
                            if let Err(error) = dispatch_provider_draft(&sequenced, control_sink.clone(), &control_tx, &mut controls, draft, provider_input).await {
                                close_status = SessionCloseStatus::Failed;
                                close_error = Some(error.to_string());
                                break 'process;
                            }
                            if saw_root_declaration {
                                initialized = true;
                                initialization_timer_armed = false;
                                if let Some(turn) = pending_turn.as_mut()
                                    && !turn.input_emitted
                                    && let Err(error) = emit_pending_turn_input(turn, &decoder, &sequenced).await
                                {
                                    close_status = SessionCloseStatus::Failed;
                                    close_error = Some(error);
                                    break 'process;
                                }
                                if let Some(turn) = pending_turn.as_mut()
                                    && turn.input_emitted
                                    && let Some(response) = turn.response.take()
                                {
                                    let _ = response.send(Ok(()));
                                }
                            }
                            if let Some(outcome) = terminal
                                && let Some(turn) = pending_turn.take()
                            {
                                let _ = turn.outcome_tx.send(OutcomeState::Ready(outcome));
                                decoder.context_mut().turn_id = None;
                                if let Err(error) = settle_pending_controls(
                                    &sequenced,
                                    &mut controls,
                                    ResolutionSource::Cancelled,
                                    "Claude turn ended",
                                )
                                .await
                                {
                                    close_status = SessionCloseStatus::Failed;
                                    close_error = Some(format!(
                                        "event sink failed while settling Claude controls: {error}"
                                    ));
                                    break 'process;
                                }
                            }
                        }
                    }
                    Err(error) => {
                        let correlation = canonical_diagnostic_correlation(
                            decoder.context(),
                            decoder.root_declared(),
                        );
                        if emit_diagnostic(&sequenced, stream_id.clone(), correlation, error.to_string(), "claude_malformed_record", true).await.is_err() {
                            close_error = Some("event sink failed while reporting malformed Claude output".into());
                        } else {
                            close_error = Some(error.to_string());
                        }
                        close_status = SessionCloseStatus::Failed;
                        break 'process;
                    }
                },
                Some(ProcessOutput::Stderr(line)) => {
                    if emit_diagnostic(&sequenced, stream_id.clone(), canonical_diagnostic_correlation(decoder.context(), decoder.root_declared()), line, "claude_stderr", false).await.is_err() {
                        close_status = SessionCloseStatus::Failed;
                        close_error = Some("event sink failed while reporting Claude stderr".into());
                        break 'process;
                    }
                }
                Some(ProcessOutput::ReadError(error)) => {
                    close_status = SessionCloseStatus::Failed;
                    close_error = Some(error);
                    break 'process;
                }
                Some(ProcessOutput::StdoutClosed) | None => break 'process,
                Some(ProcessOutput::StderrClosed) => {}
            }
        }
    }

    for draft in decoder.unresolved_diagnostics() {
        if sequenced.emit(draft).await.is_err() {
            close_status = SessionCloseStatus::Failed;
            close_error = Some("event sink failed while reporting unresolved Claude agents".into());
        }
    }
    if let Err(error) = settle_pending_controls(
        &sequenced,
        &mut controls,
        stop_source,
        "Claude session ended",
    )
    .await
    {
        close_status = SessionCloseStatus::Failed;
        close_error = Some(format!(
            "event sink failed while settling Claude controls: {error}"
        ));
    }
    if let Some(mut turn) = pending_turn.take() {
        let was_initialized = initialized;
        if was_initialized
            && !turn.input_emitted
            && let Err(error) = emit_pending_turn_input(&mut turn, &decoder, &sequenced).await
        {
            close_status = SessionCloseStatus::Failed;
            close_error = Some(error);
        }
        if let Some(response) = turn.response.take() {
            let error = close_error
                .clone()
                .unwrap_or_else(|| "Claude session ended before canonical initialization".into());
            let _ = response.send(if was_initialized && turn.input_emitted {
                Ok(())
            } else {
                Err(error)
            });
        }
        let error = close_error
            .clone()
            .unwrap_or_else(|| "Claude session closed during active turn".into());
        let outcome = TurnOutcome {
            status: if stop_source == ResolutionSource::Cancelled {
                CompletionStatus::Cancelled
            } else {
                CompletionStatus::Failed
            },
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: vertebrae_harness_core::OutcomeMetrics::default(),
            error: (stop_source != ResolutionSource::Cancelled).then_some(error),
        };
        let context = decoder.context().clone();
        let emitted = emit_runtime_event(
            &sequenced,
            stream_id.clone(),
            correlation(
                context.session_id,
                &context.root_thread_id,
                Some(turn.id),
                None,
            ),
            HarnessEventPayloadV1::TurnFinished(outcome.clone()),
        )
        .await
        .is_ok();
        if emitted {
            let _ = turn.outcome_tx.send(OutcomeState::Ready(outcome));
        } else {
            let _ = turn.outcome_tx.send(OutcomeState::Failed(
                "event sink failed while finishing Claude turn".into(),
            ));
        }
    }
    let (status, forced) = if requested_stop {
        (reap(&mut child, cleanup_timeout).await, true)
    } else {
        wait_then_reap(&mut child, cleanup_timeout).await
    };
    if !forced
        && let Some(status) = status
        && !status.success()
    {
        close_status = SessionCloseStatus::Failed;
        close_error = Some(format!("Claude exited with status {status}"));
    }
    let outcome = SessionCloseOutcome {
        status: close_status,
        error: close_error,
    };
    let context = decoder.context();
    let _ = emit_runtime_event(
        &sequenced,
        stream_id,
        canonical_diagnostic_correlation(context, decoder.root_declared()),
        HarnessEventPayloadV1::SessionClosed(outcome.clone()),
    )
    .await;
    let _ = close_tx.send(OutcomeState::Ready(outcome.clone()));
    if let Some(response) = close_response {
        let _ = response.send(Ok(outcome));
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_one_shot_process_v2(
    mut child: Child,
    mut stdin: ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    mut cancel_rx: mpsc::UnboundedReceiver<()>,
    outcome_tx: watch::Sender<OutcomeState<RunOutcome>>,
    context: ClaudeDecodeContext,
    prompt: String,
    event_sink: Arc<dyn EventSink>,
    control_sink: Arc<dyn ControlSink>,
    cleanup_timeout: std::time::Duration,
    terminal_exit_timeout: std::time::Duration,
    root_locator_resolver: Option<Arc<dyn ClaudeRootLocatorResolver>>,
) {
    let stream_id = context.root_stream_id.clone();
    let run_id = context.run_id.clone().expect("one-shot context has run id");
    let sequenced = SequencedEventSink::new(Arc::new(EventSequencer::default()), event_sink);
    let mut decoder =
        ClaudeStreamDecoder::with_root_locator_resolver(context, root_locator_resolver);
    let mut output = spawn_output_readers(stdout, stderr);
    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<ControlCompletion>();
    let mut controls = HashMap::new();
    let mut input = Some(prompt);
    let mut terminal: Option<RunOutcome> = None;
    let mut failure: Option<String> = None;
    let mut cancelled = false;

    'process: loop {
        tokio::select! {
            cancel = cancel_rx.recv() => {
                if cancel.is_some() { cancelled = true; }
                break 'process;
            }
            completion = control_rx.recv(), if !controls.is_empty() => {
                let Some(completion) = completion else { continue };
                let Some(pending_control) = controls.remove(&completion.request_id) else { continue };
                match completion.result {
                    Ok(resolution) => {
                        if emit_control_resolution(&sequenced, &pending_control, resolution.clone()).await.is_err() {
                            failure = Some("event sink failed while resolving Claude control".into());
                            break 'process;
                        }
                        match encode_control_response(
                            &pending_control.request,
                            pending_control.provider_input.as_ref(),
                            &resolution,
                        ) {
                            Ok(line) => if let Err(error) = write_line(&mut stdin, &line).await {
                                failure = Some(format!("failed to write Claude control response: {error}"));
                                break 'process;
                            },
                            Err(error) => { failure = Some(error); break 'process; }
                        }
                    }
                    Err(error) => {
                        let resolution = ControlResolution {
                            request_id: pending_control.request.request_id.clone(),
                            source: ResolutionSource::Fallback,
                            decision: None,
                            message: Some(format!("Claude control request failed: {error}")),
                        };
                        if emit_control_resolution(&sequenced, &pending_control, resolution).await.is_err() {
                            failure = Some("event sink failed while reporting Claude control failure".into());
                        } else {
                            failure = Some(format!("Claude control request failed: {error}"));
                        }
                        break 'process;
                    }
                }
            }
            message = output.recv() => match message {
                Some(ProcessOutput::Stdout(line)) => match decoder.decode_line(&line) {
                    Ok(drafts) => {
                        for draft in drafts {
                            let lifecycle_correlation = draft.correlation.clone();
                            let lifecycle_thread = lifecycle_correlation.thread_id.clone();
                            let root_declaration = matches!(&draft.payload, HarnessEventPayloadV1::ThreadDeclared(declaration) if declaration.kind == vertebrae_harness_core::ThreadKind::Root);
                            if let HarnessEventPayloadV1::RunFinished(outcome) = &draft.payload {
                                terminal = Some(outcome.clone());
                                break;
                            }
                            let provider_input = provider_control_input(&mut decoder, &draft);
                            if let Err(error) = dispatch_provider_draft(&sequenced, control_sink.clone(), &control_tx, &mut controls, draft, provider_input).await {
                                failure = Some(error.to_string());
                                break 'process;
                            }
                            if root_declaration
                                && let Some(prompt) = input.take()
                                && let Some(thread_id) = lifecycle_thread
                                && emit_run_input(&sequenced, stream_id.clone(), lifecycle_correlation, thread_id, run_id.clone(), prompt).await.is_err()
                            {
                                failure = Some("event sink failed while starting Claude run".into());
                                break 'process;
                            }
                        }
                        if terminal.is_some() { break 'process; }
                    }
                    Err(error) => {
                        if emit_diagnostic(&sequenced, stream_id.clone(), canonical_diagnostic_correlation(decoder.context(), decoder.root_declared()), error.to_string(), "claude_malformed_record", true).await.is_err() {
                            failure = Some("event sink failed while reporting malformed Claude output".into());
                        } else { failure = Some(error.to_string()); }
                        break 'process;
                    }
                },
                Some(ProcessOutput::Stderr(line)) => {
                    if emit_diagnostic(&sequenced, stream_id.clone(), canonical_diagnostic_correlation(decoder.context(), decoder.root_declared()), line, "claude_stderr", false).await.is_err() {
                        failure = Some("event sink failed while reporting Claude stderr".into());
                        break 'process;
                    }
                }
                Some(ProcessOutput::ReadError(error)) => { failure = Some(error); break 'process; }
                Some(ProcessOutput::StdoutClosed) | None => break 'process,
                Some(ProcessOutput::StderrClosed) => {}
            }
        }
    }

    let root_declared = decoder.root_declared();
    for draft in decoder.unresolved_diagnostics() {
        if sequenced.emit(draft).await.is_err() {
            failure = Some("event sink failed while reporting unresolved Claude agents".into());
        }
    }
    let control_source = if cancelled {
        ResolutionSource::Cancelled
    } else {
        ResolutionSource::Fallback
    };
    if let Err(error) = settle_pending_controls(
        &sequenced,
        &mut controls,
        control_source,
        "Claude run ended",
    )
    .await
    {
        failure = Some(format!(
            "event sink failed while settling Claude controls: {error}"
        ));
    }
    let context = decoder.context().clone();
    let (status, forced) = if terminal.is_some() {
        let deadline = tokio::time::sleep(terminal_exit_timeout);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                result = child.wait() => {
                    break (result.ok(), false);
                }
                message = output.recv() => match message {
                    Some(ProcessOutput::Stderr(line)) => {
                        if emit_diagnostic(&sequenced, stream_id.clone(), canonical_diagnostic_correlation(&context, root_declared), line, "claude_stderr", false).await.is_err() {
                            failure = Some("event sink failed while reporting Claude stderr".into());
                        }
                    }
                    Some(ProcessOutput::ReadError(error)) => failure = Some(error),
                    Some(ProcessOutput::StdoutClosed | ProcessOutput::StderrClosed) | None => {}
                    Some(ProcessOutput::Stdout(_)) => {}
                },
                () = &mut deadline => {
                    break (reap(&mut child, cleanup_timeout).await, true);
                }
            }
        }
    } else {
        (reap(&mut child, cleanup_timeout).await, true)
    };
    if terminal.is_some() {
        let drain_deadline = tokio::time::sleep(terminal_exit_timeout);
        tokio::pin!(drain_deadline);
        loop {
            tokio::select! {
                message = output.recv() => match message {
                    Some(ProcessOutput::Stderr(line)) => {
                        if emit_diagnostic(
                            &sequenced,
                            stream_id.clone(),
                            canonical_diagnostic_correlation(&context, root_declared),
                            line,
                            "claude_stderr",
                            false,
                        )
                        .await
                        .is_err()
                        {
                            failure = Some("event sink failed while reporting Claude stderr".into());
                            break;
                        }
                    }
                    Some(ProcessOutput::ReadError(error)) => failure = Some(error),
                    Some(ProcessOutput::StdoutClosed | ProcessOutput::StderrClosed) => {}
                    Some(ProcessOutput::Stdout(_)) => {}
                    None => break,
                },
                () = &mut drain_deadline => break,
            }
        }
    }
    if root_declared && let Some(prompt) = input.take() {
        let fallback_thread = context.root_thread_id.clone();
        if emit_run_input(
            &sequenced,
            stream_id.clone(),
            correlation(
                context.session_id.clone(),
                &fallback_thread,
                None,
                Some(run_id.clone()),
            ),
            fallback_thread,
            run_id.clone(),
            prompt,
        )
        .await
        .is_err()
        {
            failure = Some("event sink failed while starting Claude run".into());
        }
    }
    let mut outcome = if cancelled {
        RunOutcome {
            status: CompletionStatus::Cancelled,
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: vertebrae_harness_core::OutcomeMetrics::default(),
            error: None,
        }
    } else if let Some(error) = failure {
        RunOutcome {
            status: CompletionStatus::Failed,
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: vertebrae_harness_core::OutcomeMetrics::default(),
            error: Some(error),
        }
    } else if let Some(outcome) = terminal {
        outcome
    } else {
        RunOutcome {
            status: CompletionStatus::Failed,
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: vertebrae_harness_core::OutcomeMetrics::default(),
            error: Some(
                status
                    .map(|status| {
                        format!("Claude exited with status {status} without a result record")
                    })
                    .unwrap_or_else(|| "Claude exited without a result record".into()),
            ),
        }
    };
    if !forced
        && matches!(outcome.status, CompletionStatus::Completed)
        && let Some(status) = status
        && !status.success()
    {
        outcome.status = CompletionStatus::Failed;
        outcome.error = Some(format!("Claude exited with status {status}"));
    }
    let terminal_correlation = canonical_diagnostic_correlation(&context, root_declared);
    if emit_runtime_event(
        &sequenced,
        stream_id,
        terminal_correlation,
        HarnessEventPayloadV1::RunFinished(outcome.clone()),
    )
    .await
    .is_err()
    {
        let _ = outcome_tx.send(OutcomeState::Failed(
            "event sink failed while finishing Claude run".into(),
        ));
    } else {
        let _ = outcome_tx.send(OutcomeState::Ready(outcome));
    }
}

async fn dispatch_provider_draft(
    sink: &SequencedEventSink,
    control_sink: Arc<dyn ControlSink>,
    completion_tx: &mpsc::UnboundedSender<ControlCompletion>,
    controls: &mut HashMap<ControlRequestId, PendingControl>,
    draft: HarnessEventDraftV1,
    provider_input: Option<serde_json::Value>,
) -> Result<(), HarnessError> {
    let control = match &draft.payload {
        HarnessEventPayloadV1::ControlRequested(control) => Some(control.clone()),
        _ => None,
    };
    let provider_cancel = match &draft.payload {
        HarnessEventPayloadV1::ControlResolved(resolution)
            if resolution.source == ResolutionSource::Provider
                && matches!(resolution.decision, Some(ControlDecision::Cancel)) =>
        {
            Some(resolution.request_id.clone())
        }
        _ => None,
    };
    let stream_id = draft.stream_id.clone();
    let correlation = draft.correlation.clone();
    if let Some(request_id) = provider_cancel {
        if let Some(pending) = controls.remove(&request_id) {
            pending.abort.abort();
            sink.emit(HarnessEventDraftV1 {
                stream_id: pending.stream_id,
                correlation: pending.correlation,
                ..draft
            })
            .await?;
        } else {
            sink.emit(HarnessEventDraftV1 {
                payload: HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!(
                        "Claude cancelled unknown or already-resolved control request {request_id}"
                    ),
                    code: Some("claude_unknown_control_cancel".into()),
                }),
                ..draft
            })
            .await?;
        }
        return Ok(());
    }
    sink.emit(draft).await?;
    if let Some(request) = control {
        if controls.contains_key(&request.request_id) {
            return Err(HarnessError::Control(format!(
                "duplicate Claude control request {}",
                request.request_id
            )));
        }
        let request_id = request.request_id.clone();
        let task_request = request.clone();
        let completion_tx = completion_tx.clone();
        let task = tokio::spawn(async move {
            let result = control_sink.request(task_request).await;
            let _ = completion_tx.send(ControlCompletion { request_id, result });
        });
        controls.insert(
            request.request_id.clone(),
            PendingControl {
                request,
                provider_input,
                stream_id,
                correlation,
                abort: task.abort_handle(),
            },
        );
    }
    Ok(())
}

fn provider_control_input(
    decoder: &mut ClaudeStreamDecoder,
    draft: &HarnessEventDraftV1,
) -> Option<serde_json::Value> {
    match &draft.payload {
        HarnessEventPayloadV1::ControlRequested(request) => {
            decoder.take_provider_control_input(&request.request_id)
        }
        _ => None,
    }
}

async fn emit_control_resolution(
    sink: &SequencedEventSink,
    pending: &PendingControl,
    resolution: ControlResolution,
) -> Result<(), HarnessError> {
    emit_runtime_event(
        sink,
        pending.stream_id.clone(),
        pending.correlation.clone(),
        HarnessEventPayloadV1::ControlResolved(resolution),
    )
    .await
}

async fn settle_pending_controls(
    sink: &SequencedEventSink,
    controls: &mut HashMap<ControlRequestId, PendingControl>,
    source: ResolutionSource,
    message: &str,
) -> Result<(), HarnessError> {
    let mut first_error = None;
    for (_, pending) in controls.drain() {
        pending.abort.abort();
        let resolution = ControlResolution {
            request_id: pending.request.request_id.clone(),
            source,
            decision: None,
            message: Some(message.to_string()),
        };
        if let Err(error) = emit_control_resolution(sink, &pending, resolution).await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    if let Some(error) = first_error {
        Err(error)
    } else {
        Ok(())
    }
}

fn encode_control_response(
    request: &ControlRequestEnvelope,
    provider_input: Option<&serde_json::Value>,
    resolution: &ControlResolution,
) -> Result<String, String> {
    let original_input = provider_input
        .cloned()
        .unwrap_or_else(|| match &request.request {
            vertebrae_harness_core::ControlRequest::Approval(approval) => approval
                .details
                .as_ref()
                .and_then(|details| details.get("input"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
            _ => serde_json::json!({}),
        });
    let provider_decision = match resolution.decision.as_ref() {
        Some(ControlDecision::Deny | ControlDecision::Cancel) | None => serde_json::json!({
            "behavior": "deny",
            "message": resolution.message.clone().unwrap_or_else(|| "Denied by consumer".into())
        }),
        Some(ControlDecision::Modified(input)) => serde_json::json!({
            "behavior": "allow",
            "updatedInput": input
        }),
        Some(ControlDecision::QuestionsAnswered(answers)) => {
            let questions = match &request.request {
                vertebrae_harness_core::ControlRequest::UserQuestion { questions } => questions,
                _ => {
                    return Err(
                        "Claude question answers were supplied for a non-question control".into(),
                    );
                }
            };
            let mut provider_answers = serde_json::Map::new();
            for question in questions {
                let answer = answers
                    .iter()
                    .find(|answer| answer.question_id == question.id)
                    .ok_or_else(|| {
                        format!("no answer was supplied for question {}", question.id)
                    })?;
                for option_id in &answer.selected_option_ids {
                    if !question
                        .options
                        .iter()
                        .any(|option| &option.id == option_id)
                    {
                        return Err(format!(
                            "answer for question {} references unknown option {option_id}",
                            question.id
                        ));
                    }
                }
                let mut values = answer.selected_option_ids.clone();
                if let Some(free_form) = answer
                    .free_form
                    .as_deref()
                    .map(str::trim)
                    .filter(|answer| !answer.is_empty())
                {
                    values.push(free_form.to_owned());
                }
                provider_answers.insert(
                    question.prompt.clone(),
                    serde_json::Value::String(values.join(", ")),
                );
            }
            let mut updated_input = original_input.clone();
            let updated_input_object = updated_input
                .as_object_mut()
                .ok_or_else(|| "AskUserQuestion original input is not an object".to_string())?;
            updated_input_object.insert("answers".into(), provider_answers.into());
            serde_json::json!({
                "behavior": "allow",
                "updatedInput": updated_input
            })
        }
        Some(
            ControlDecision::AllowOnce
            | ControlDecision::AllowForSession
            | ControlDecision::PermissionsGranted { .. },
        ) => serde_json::json!({
            "behavior": "allow",
            "updatedInput": original_input
        }),
    };
    serde_json::to_string(&serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request.request_id.as_str(),
            "response": provider_decision
        }
    }))
    .map_err(|error| format!("failed to encode Claude control response: {error}"))
}

fn canonical_diagnostic_correlation(
    context: &ClaudeDecodeContext,
    root_declared: bool,
) -> EventCorrelation {
    if root_declared {
        correlation(
            context.session_id.clone(),
            &context.root_thread_id,
            context.turn_id.clone(),
            context.run_id.clone(),
        )
    } else {
        EventCorrelation {
            run_id: context.run_id.clone(),
            ..EventCorrelation::default()
        }
    }
}

async fn begin_persistent_turn(
    stdin: &mut ChildStdin,
    request: SendTurnRequest,
    outcome_tx: watch::Sender<OutcomeState<TurnOutcome>>,
    response: oneshot::Sender<Result<(), String>>,
    decoder: &mut ClaudeStreamDecoder,
    sink: &SequencedEventSink,
) -> Result<PendingTurn, String> {
    if request.output_schema.is_some() {
        let error = "per-turn output schemas require a new Claude process".to_string();
        let _ = response.send(Err(error.clone()));
        return Err(error);
    }
    let context = decoder.context().clone();
    let encoded = encode_user_message(context.session_id.as_ref(), &request.content);
    if let Err(error) = write_line(stdin, &encoded).await {
        let error = format!("failed to write Claude stdin: {error}");
        let _ = outcome_tx.send(OutcomeState::Failed(error.clone()));
        let _ = response.send(Err(error.clone()));
        return Err(error);
    }
    decoder.context_mut().turn_id = Some(request.turn_id.clone());
    let mut pending = PendingTurn {
        id: request.turn_id,
        content: request.content,
        input_emitted: false,
        response: Some(response),
        outcome_tx,
    };
    if decoder.root_declared()
        && let Err(error) = emit_pending_turn_input(&mut pending, decoder, sink).await
    {
        let _ = pending.outcome_tx.send(OutcomeState::Failed(error.clone()));
        if let Some(response) = pending.response.take() {
            let _ = response.send(Err(error.clone()));
        }
        return Err(error);
    }
    Ok(pending)
}

async fn emit_pending_turn_input(
    turn: &mut PendingTurn,
    decoder: &ClaudeStreamDecoder,
    sink: &SequencedEventSink,
) -> Result<(), String> {
    if turn.input_emitted {
        return Ok(());
    }
    let context = decoder.context().clone();
    let mut event_correlation = correlation(
        context.session_id,
        &context.root_thread_id,
        Some(turn.id.clone()),
        None,
    );
    event_correlation.provider_resume_id = context.provider_resume_id;
    if emit_runtime_event(
        sink,
        context.root_stream_id.clone(),
        event_correlation.clone(),
        HarnessEventPayloadV1::TurnStarted(TurnStarted {
            input_summary: summary(&turn.content),
        }),
    )
    .await
    .is_err()
        || emit_runtime_event(
            sink,
            context.root_stream_id,
            event_correlation,
            HarnessEventPayloadV1::TurnInput(TurnInput {
                thread_id: context.root_thread_id,
                run_id: None,
                content: turn.content.clone(),
                provenance: TurnInputProvenance::Human,
            }),
        )
        .await
        .is_err()
    {
        return Err("event sink failed while starting Claude turn".into());
    }
    turn.input_emitted = true;
    Ok(())
}

async fn emit_run_input(
    sink: &SequencedEventSink,
    stream_id: StreamId,
    correlation: EventCorrelation,
    thread_id: ThreadId,
    run_id: RunId,
    prompt: String,
) -> Result<(), HarnessError> {
    emit_runtime_event(
        sink,
        stream_id.clone(),
        correlation.clone(),
        HarnessEventPayloadV1::TurnStarted(TurnStarted {
            input_summary: summary(&prompt),
        }),
    )
    .await?;
    emit_runtime_event(
        sink,
        stream_id,
        correlation,
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id,
            run_id: Some(run_id),
            content: prompt,
            provenance: TurnInputProvenance::Human,
        }),
    )
    .await
}

async fn emit_runtime_event(
    sink: &SequencedEventSink,
    stream_id: StreamId,
    correlation: EventCorrelation,
    payload: HarnessEventPayloadV1,
) -> Result<(), HarnessError> {
    sink.emit(HarnessEventDraftV1 {
        stream_id,
        correlation,
        timestamp: Utc::now(),
        semantics: UpdateSemantics::Snapshot,
        provider_sequence: None,
        payload,
    })
    .await
    .map(|_| ())
}

async fn emit_diagnostic(
    sink: &SequencedEventSink,
    stream_id: StreamId,
    correlation: EventCorrelation,
    message: String,
    code: &str,
    error: bool,
) -> Result<(), HarnessError> {
    let diagnostic = DiagnosticEvent {
        message,
        code: Some(code.into()),
    };
    let payload = if error {
        HarnessEventPayloadV1::Error(diagnostic)
    } else {
        HarnessEventPayloadV1::Warning(diagnostic)
    };
    emit_runtime_event(sink, stream_id, correlation, payload).await
}

fn correlation(
    session_id: Option<SessionId>,
    thread_id: &ThreadId,
    turn_id: Option<TurnId>,
    run_id: Option<RunId>,
) -> EventCorrelation {
    EventCorrelation {
        session_id,
        thread_id: Some(thread_id.clone()),
        turn_id,
        run_id,
        ..EventCorrelation::default()
    }
}

fn encode_user_message(session_id: Option<&SessionId>, content: &str) -> String {
    serde_json::json!({
        "type": "user",
        "session_id": session_id.map(SessionId::as_str),
        "parent_tool_use_id": Value::Null,
        "message": { "role": "user", "content": content },
    })
    .to_string()
}

fn summary(content: &str) -> Option<String> {
    const MAX_CHARS: usize = 160;
    let mut chars = content.chars();
    let summary = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if summary.is_empty() {
        None
    } else if chars.next().is_some() {
        Some(format!("{summary}…"))
    } else {
        Some(summary)
    }
}

async fn write_line(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

use serde_json::Value;
