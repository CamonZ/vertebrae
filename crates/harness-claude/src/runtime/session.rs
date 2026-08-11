use std::collections::HashMap;
use std::sync::Arc;

use tokio::{
    process::{Child, ChildStdin},
    sync::{mpsc, oneshot, watch},
};
use vertebrae_harness_core::{
    CompletionStatus, ControlSink, EventCorrelation, EventSequencer, EventSink, HarnessError,
    HarnessEventPayloadV1, ResolutionSource, SequencedEventSink, SessionCloseOutcome,
    SessionCloseStatus, StreamId, ThreadKind, TurnInput, TurnInputProvenance, TurnOutcome,
    TurnStarted,
};

use crate::{ClaudeDecodeContext, ClaudeRootLocatorResolver, ClaudeStreamDecoder};

use super::{
    OutcomeState, PendingTurn, SessionCommand,
    controls::{
        ControlCompletion, dispatch_provider_draft, emit_control_resolution,
        provider_control_input, settle_pending_controls,
    },
    events::{
        canonical_diagnostic_correlation, correlation, emit_diagnostic, emit_runtime_event,
        encode_user_message, trace, write_line,
    },
    process::{ProcessOutput, reap, spawn_output_readers, wait_then_reap},
};

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_persistent_process_v2(
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
    let mut stdout_closed = false;
    let mut stderr_closed = false;

    trace(
        decoder.context().root_thread_id.as_str(),
        "process.started",
        "internal",
        None,
        "running",
        Some(&format!("pid={:?}", child.id())),
        None,
    );

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
                    let request_turn_id = request.turn_id.to_string();
                    let request_content = request.content.clone();
                    if pending_turn.is_some() {
                        trace(
                            decoder.context().root_thread_id.as_str(),
                            "message.rejected",
                            "internal",
                            Some(&request_turn_id),
                            "pending_turn",
                            Some("Claude accepts only one active turn per session"),
                            Some(&request_content),
                        );
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
                            trace(
                                decoder.context().root_thread_id.as_str(),
                                "message.accepted",
                                "internal",
                                Some(&request_turn_id),
                                "awaiting_provider",
                                None,
                                Some(&request_content),
                            );
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
                    if let Some(mut turn) = pending_turn.take() {
                        if let Some(response) = turn.response.take() {
                            let _ = response.send(Err(
                                "Claude turn was interrupted before canonical initialization".into(),
                            ));
                        }
                        let context = decoder.context().clone();
                        if let Err(error) = settle_turn(
                            &sequenced,
                            turn,
                            outcome,
                            Some((
                                stream_id.clone(),
                                correlation(
                                    context.session_id,
                                    &context.root_thread_id,
                                    Some(turn_id),
                                    None,
                                ),
                            )),
                        )
                        .await
                        {
                            close_status = SessionCloseStatus::Failed;
                            close_error = Some(error.to_string());
                        } else {
                            close_status = SessionCloseStatus::Closed;
                            close_error = None;
                        }
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
                        match super::controls::encode_control_response(
                            &pending_control.request,
                            pending_control.provider_input.as_ref(),
                            &resolution,
                        ) {
                            Ok(line) => {
                                trace(
                                    decoder.context().root_thread_id.as_str(),
                                    "control.response",
                                    "harness_to_provider",
                                    pending_control
                                        .request
                                        .turn_id
                                        .as_ref()
                                        .map(|id| id.as_str()),
                                    "writing",
                                    Some(&pending_control.request.request_id.to_string()),
                                    Some(&line),
                                );
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
                        let resolution = vertebrae_harness_core::ControlResolution {
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
                Some(ProcessOutput::Stdout(line)) => {
                    trace(
                        decoder.context().root_thread_id.as_str(),
                        "stdout",
                        "provider_to_harness",
                        decoder.context().turn_id.as_ref().map(|id| id.as_str()),
                        "running",
                        None,
                        Some(&line),
                    );
                    match decoder.decode_line(&line) {
                            Ok(drafts) => {
                        let mut saw_root_declaration = false;
                        for draft in drafts {
                            saw_root_declaration |= matches!(&draft.payload, HarnessEventPayloadV1::ThreadDeclared(declaration) if declaration.kind == ThreadKind::Root);
                            let terminal = match &draft.payload {
                                HarnessEventPayloadV1::TurnFinished(outcome) => Some(outcome.clone()),
                                _ => None,
                            };
                            let provider_input = provider_control_input(&mut decoder, &draft);
                            if let Err(error) = dispatch_provider_draft(&sequenced, control_sink.clone(), &control_tx, &mut controls, draft, provider_input).await {
                                if terminal.is_some()
                                    && let Some(mut turn) = pending_turn.take()
                                {
                                    let sink_error = event_sink_message(&error);
                                    if let Some(response) = turn.response.take() {
                                        let _ = response.send(Err(sink_error.clone()));
                                    }
                                    let _ = turn.outcome_tx.send(OutcomeState::EventSinkFailed(
                                        sink_error,
                                    ));
                                    decoder.context_mut().turn_id = None;
                                }
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
                                && let Some(mut turn) = pending_turn.take()
                            {
                                let settled_turn_id = turn.id.to_string();
                                trace(
                                    decoder.context().root_thread_id.as_str(),
                                    "turn.terminal",
                                    "provider_to_harness",
                                    Some(turn.id.as_str()),
                                    "settling",
                                    Some(&format!("status={:?}", outcome.status)),
                                    None,
                                );
                                if let Some(response) = turn.response.take() {
                                    let _ = response.send(Ok(()));
                                }
                                let _ = settle_turn(
                                    &sequenced,
                                    turn,
                                    outcome,
                                    None,
                                )
                                .await;
                                decoder.context_mut().turn_id = None;
                                trace(
                                    decoder.context().root_thread_id.as_str(),
                                    "turn.settled",
                                    "internal",
                                    Some(settled_turn_id.as_str()),
                                    "idle",
                                    None,
                                    None,
                                );
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
                    }
                },
                Some(ProcessOutput::Stderr(line)) => {
                    trace(
                        decoder.context().root_thread_id.as_str(),
                        "stderr",
                        "provider_to_harness",
                        decoder.context().turn_id.as_ref().map(|id| id.as_str()),
                        "running",
                        None,
                        Some(&line),
                    );
                    if emit_diagnostic(&sequenced, stream_id.clone(), canonical_diagnostic_correlation(decoder.context(), decoder.root_declared()), line, "claude_stderr", false).await.is_err() {
                        close_status = SessionCloseStatus::Failed;
                        close_error = Some("event sink failed while reporting Claude stderr".into());
                        break 'process;
                    }
                }
                Some(ProcessOutput::ReadError(error)) => {
                    trace(
                        decoder.context().root_thread_id.as_str(),
                        "process.read_error",
                        "provider_to_harness",
                        decoder.context().turn_id.as_ref().map(|id| id.as_str()),
                        "failed",
                        Some(&error),
                        None,
                    );
                    close_status = SessionCloseStatus::Failed;
                    close_error = Some(error);
                    break 'process;
                }
                Some(ProcessOutput::StdoutClosed) => {
                    trace(
                        decoder.context().root_thread_id.as_str(),
                        "stdout.closed",
                        "provider_to_harness",
                        decoder.context().turn_id.as_ref().map(|id| id.as_str()),
                        "closed",
                        None,
                        None,
                    );
                    stdout_closed = true;
                    if stderr_closed {
                        break 'process;
                    }
                }
                Some(ProcessOutput::StderrClosed) => {
                    trace(
                        decoder.context().root_thread_id.as_str(),
                        "stderr.closed",
                        "provider_to_harness",
                        decoder.context().turn_id.as_ref().map(|id| id.as_str()),
                        "closed",
                        None,
                        None,
                    );
                    stderr_closed = true;
                    if stdout_closed {
                        break 'process;
                    }
                }
                None => break 'process,
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
        let terminal_event = Some((
            stream_id.clone(),
            correlation(
                context.session_id,
                &context.root_thread_id,
                Some(turn.id.clone()),
                None,
            ),
        ));
        if let Err(error) = settle_turn(&sequenced, turn, outcome, terminal_event).await {
            close_status = SessionCloseStatus::Failed;
            close_error = Some(error.to_string());
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
    trace(
        decoder.context().root_thread_id.as_str(),
        "process.closed",
        "internal",
        None,
        "closed",
        Some(&format!(
            "status={:?}; error={:?}",
            outcome.status, outcome.error
        )),
        None,
    );
    let _ = close_tx.send(OutcomeState::Ready(outcome.clone()));
    if let Some(response) = close_response {
        let _ = response.send(Ok(outcome));
    }
}

async fn settle_turn(
    sink: &SequencedEventSink,
    turn: PendingTurn,
    outcome: TurnOutcome,
    terminal_event: Option<(StreamId, EventCorrelation)>,
) -> Result<(), HarnessError> {
    if let Some((stream_id, correlation)) = terminal_event
        && let Err(error) = emit_runtime_event(
            sink,
            stream_id,
            correlation,
            HarnessEventPayloadV1::TurnFinished(outcome.clone()),
        )
        .await
    {
        let sink_error = event_sink_message(&error);
        let _ = turn
            .outcome_tx
            .send(OutcomeState::EventSinkFailed(sink_error));
        return Err(error);
    }

    let _ = turn.outcome_tx.send(OutcomeState::Ready(outcome));
    Ok(())
}

fn event_sink_message(error: &HarnessError) -> String {
    match error {
        HarnessError::EventSink(message) => message.clone(),
        error => error.to_string(),
    }
}

pub(super) async fn begin_persistent_turn(
    stdin: &mut ChildStdin,
    request: vertebrae_harness_core::SendTurnRequest,
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
    let request_turn_id = request.turn_id.to_string();
    trace(
        context.root_thread_id.as_str(),
        "stdin",
        "harness_to_provider",
        Some(&request_turn_id),
        "writing",
        None,
        Some(&encoded),
    );
    if let Err(error) = write_line(stdin, &encoded).await {
        trace(
            context.root_thread_id.as_str(),
            "stdin.write_failed",
            "harness_to_provider",
            Some(&request_turn_id),
            "failed",
            Some(&error.to_string()),
            None,
        );
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

pub(super) async fn emit_pending_turn_input(
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
            input_summary: super::events::summary(&turn.content),
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
