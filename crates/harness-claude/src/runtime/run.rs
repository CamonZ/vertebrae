use std::collections::HashMap;
use std::sync::Arc;

use tokio::{
    process::{Child, ChildStdin},
    sync::{mpsc, watch},
};
use vertebrae_harness_core::{
    CompletionStatus, ControlSink, EventSequencer, EventSink, HarnessEventPayloadV1,
    ResolutionSource, RunOutcome, SequencedEventSink,
};

use crate::{ClaudeDecodeContext, ClaudeRootLocatorResolver, ClaudeStreamDecoder};

use super::{
    OutcomeState,
    controls::{
        ControlCompletion, dispatch_provider_draft, emit_control_resolution,
        provider_control_input, settle_pending_controls,
    },
    events::{
        canonical_diagnostic_correlation, emit_diagnostic, emit_run_input, emit_runtime_event,
    },
    process::{ProcessOutput, reap, spawn_output_readers},
};

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_one_shot_process_v2(
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
    let mut stdout_closed = false;
    let mut stderr_closed = false;

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
                        match super::controls::encode_control_response(
                            &pending_control.request,
                            pending_control.provider_input.as_ref(),
                            &resolution,
                        ) {
                            Ok(line) => if let Err(error) = super::events::write_line(&mut stdin, &line).await {
                                failure = Some(format!("failed to write Claude control response: {error}"));
                                break 'process;
                            },
                            Err(error) => { failure = Some(error); break 'process; }
                        }
                    }
                    Err(error) => {
                        let resolution = vertebrae_harness_core::ControlResolution {
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
                Some(ProcessOutput::StdoutClosed) => {
                    stdout_closed = true;
                    if stderr_closed {
                        break 'process;
                    }
                }
                Some(ProcessOutput::StderrClosed) => {
                    stderr_closed = true;
                    if stdout_closed {
                        break 'process;
                    }
                }
                None => break 'process,
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
            super::events::correlation(
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
    } else if status.is_some_and(|status| status.success()) {
        RunOutcome {
            status: CompletionStatus::Completed,
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: vertebrae_harness_core::OutcomeMetrics::default(),
            error: None,
        }
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
