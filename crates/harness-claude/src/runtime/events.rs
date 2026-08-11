use chrono::Utc;
use tokio::{io::AsyncWriteExt, process::ChildStdin};
use vertebrae_harness_core::{
    DiagnosticEvent, EventCorrelation, HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1,
    RunId, SequencedEventSink, SessionId, StreamId, ThreadId, TurnInput, TurnInputProvenance,
    TurnStarted, UpdateSemantics,
};

use super::ClaudeDecodeContext;

/// Emit a structured, debug-console-only trace record. The GUI logger parses
/// this prefix into its in-memory local-harness inspector; it is deliberately
/// not part of the provider-neutral harness event stream or chat persistence.
pub(super) fn trace(
    session_id: &str,
    kind: &str,
    direction: &str,
    turn_id: Option<&str>,
    state: &str,
    detail: Option<&str>,
    payload: Option<&str>,
) {
    let record = serde_json::json!({
        "timestamp_ms": chrono::Utc::now().timestamp_millis(),
        "source": "claude",
        "kind": kind,
        "direction": direction,
        "session_id": session_id,
        "turn_id": turn_id,
        "state": state,
        "detail": detail,
        "payload": payload,
    });
    log::info!("[LOCAL_CHAT_TRACE] {record}");
}

pub(super) fn canonical_diagnostic_correlation(
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

pub(super) async fn emit_runtime_event(
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

pub(super) async fn emit_diagnostic(
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

pub(super) fn correlation(
    session_id: Option<SessionId>,
    thread_id: &ThreadId,
    turn_id: Option<vertebrae_harness_core::TurnId>,
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

pub(super) async fn emit_run_input(
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

pub(super) fn encode_user_message(session_id: Option<&SessionId>, content: &str) -> String {
    serde_json::json!({
        "type": "user",
        "session_id": session_id.map(SessionId::as_str),
        "parent_tool_use_id": serde_json::Value::Null,
        "message": { "role": "user", "content": content },
    })
    .to_string()
}

pub(super) fn summary(content: &str) -> Option<String> {
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

pub(super) async fn write_line(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}
