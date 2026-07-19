use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use vertebrae_harness_core::{
    CompletionStatus, ControlRequestEnvelope, ControlResolution, ControlSink, EventSink,
    FileChangeKind, HarnessError, HarnessEventPayloadV1, HarnessEventV1, ToolStatus,
    UpdateSemantics,
};
#[cfg(test)]
use vertebrae_harness_core::{
    EventCorrelation, EventId, FileChange, FileChangeEvent, StreamId, ToolCallId,
};

use crate::local_chat::{
    LocalChatEvent, LocalChatEventSink, LocalChatFileChange, LocalChatFileChangeEvent,
    LocalChatHarnessKind, LocalChatRuntime, LocalChatSessionEndEvent, LocalChatSessionErrorEvent,
    LocalChatSessionInitEvent, LocalChatSessionUsageEvent, LocalChatSessionWarningEvent,
    LocalChatTextEvent, LocalChatToolCallEvent, LocalChatToolResultEvent,
};

#[derive(Default)]
pub(crate) struct LocalChatSessionStats {
    pub(crate) turns: u32,
    pub(crate) context_tokens: u32,
    pub(crate) context_window: u32,
    pub(crate) thread_total_tokens: u32,
    pub(crate) model: String,
}

/// Translates provider-neutral harness events into the GUI's local-chat
/// events. Provider adapters only own startup, session lifecycle, and
/// provider-specific configuration; event compatibility stays here.
pub(crate) struct LocalChatHarnessEventSink {
    pub(crate) backend_session_id: String,
    harness: LocalChatHarnessKind,
    sink: LocalChatEventSink,
    pub(crate) stats: Arc<Mutex<LocalChatSessionStats>>,
    default_context_window: u32,
    inherit_terminal_usage: bool,
}

impl LocalChatHarnessEventSink {
    pub(crate) fn new(
        backend_session_id: String,
        harness: LocalChatHarnessKind,
        sink: LocalChatEventSink,
        initial_model: Option<String>,
        default_context_window: u32,
        inherit_terminal_usage: bool,
    ) -> Self {
        Self {
            backend_session_id,
            harness,
            sink,
            stats: Arc::new(Mutex::new(LocalChatSessionStats {
                model: initial_model.unwrap_or_default(),
                ..Default::default()
            })),
            default_context_window,
            inherit_terminal_usage,
        }
    }

    pub(crate) fn record_turn(&self) -> u32 {
        let mut stats = self
            .stats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        stats.turns = stats.turns.saturating_add(1);
        stats.turns
    }

    pub(crate) fn value_text(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::String(value) => value.clone(),
            value => serde_json::to_string(value).unwrap_or_default(),
        }
    }

    pub(crate) fn emit_error(&self, error: impl Into<String>) -> Result<(), HarnessError> {
        self.emit_local(LocalChatEvent::Error(LocalChatSessionErrorEvent {
            backend_session_id: self.backend_session_id.clone(),
            harness: self.harness,
            error: error.into(),
        }))
    }

    fn emit_local(&self, event: LocalChatEvent) -> Result<(), HarnessError> {
        self.sink.try_emit(event).map_err(HarnessError::EventSink)
    }

    fn is_root_stream(&self, event: &HarnessEventV1) -> bool {
        event.stream_id.as_str() == format!("local-chat:{}", self.backend_session_id)
    }

    fn emit_end(
        &self,
        status: CompletionStatus,
        result: Option<String>,
        metrics: &vertebrae_harness_core::OutcomeMetrics,
    ) -> Result<(), HarnessError> {
        let mut stats = self
            .stats
            .lock()
            .map_err(|_| HarnessError::EventSink("GUI event state is poisoned".into()))?;
        if let Some(turn_count) = metrics.turn_count {
            stats.turns = turn_count.min(u64::from(u32::MAX)) as u32;
        }
        let context_tokens = metrics.context_tokens.unwrap_or_else(|| {
            if self.inherit_terminal_usage {
                u64::from(stats.context_tokens)
            } else {
                0
            }
        });
        stats.context_tokens = context_tokens.min(u64::from(u32::MAX)) as u32;
        stats.context_window = metrics
            .context_window
            .unwrap_or_else(|| {
                if self.inherit_terminal_usage {
                    u64::from(stats.context_window.max(self.default_context_window))
                } else {
                    u64::from(self.default_context_window)
                }
            })
            .min(u64::from(u32::MAX)) as u32;
        let context_tokens = stats.context_tokens;
        let context_window = stats.context_window;
        drop(stats);

        self.emit_local(LocalChatEvent::End(LocalChatSessionEndEvent {
            backend_session_id: self.backend_session_id.clone(),
            harness: self.harness,
            duration_ms: metrics
                .duration_ms
                .unwrap_or_default()
                .min(u64::from(u32::MAX)) as u32,
            cost_usd: metrics.total_cost_usd.unwrap_or_default(),
            num_turns: if self.inherit_terminal_usage {
                self.stats
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .turns
            } else {
                metrics
                    .turn_count
                    .unwrap_or_default()
                    .min(u64::from(u32::MAX)) as u32
            },
            result: result.unwrap_or_default(),
            is_error: status != CompletionStatus::Completed,
            context_tokens,
            context_window,
        }))
    }
}

#[async_trait]
impl EventSink for LocalChatHarnessEventSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        let backend_session_id = self.backend_session_id.clone();
        let harness = self.harness;
        let parent_tool_use_id = event
            .correlation
            .parent_tool_call_id
            .as_ref()
            .map(ToString::to_string);
        let is_root_stream = self.is_root_stream(&event);

        match event.payload {
            HarnessEventPayloadV1::SessionStarted(started) => {
                let mut stats = self
                    .stats
                    .lock()
                    .map_err(|_| HarnessError::EventSink("GUI event state is poisoned".into()))?;
                if let Some(model) = started.model {
                    stats.model = model;
                }
                let model = if stats.model.is_empty() {
                    match harness {
                        LocalChatHarnessKind::Claude => "Claude default",
                        LocalChatHarnessKind::Codex => "Codex default",
                    }
                    .to_string()
                } else {
                    stats.model.clone()
                };
                stats.model = model.clone();
                drop(stats);
                self.emit_local(LocalChatEvent::Init(LocalChatSessionInitEvent {
                    backend_session_id,
                    harness,
                    provider_resume_id: started.provider_resume_id.map(|value| value.to_string()),
                    model,
                    tools: started.tools,
                }))?;
            }
            HarnessEventPayloadV1::Text(value) => {
                self.emit_local(LocalChatEvent::Text(LocalChatTextEvent {
                    backend_session_id,
                    harness,
                    text: value.text,
                    is_partial: event.semantics == UpdateSemantics::Delta,
                    parent_tool_use_id,
                }))?;
            }
            HarnessEventPayloadV1::ToolCall(value) => {
                if value.name == crate::local_chat::permissions::ASK_USER_QUESTION_TOOL {
                    return Ok(());
                }
                self.emit_local(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                    backend_session_id,
                    harness,
                    tool_id: value.tool_call_id.to_string(),
                    tool_name: value.name,
                    input: serde_json::to_string(&value.input).unwrap_or_default(),
                    parent_tool_use_id,
                }))?;
            }
            HarnessEventPayloadV1::ToolOutput(value) => {
                self.emit_local(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                    backend_session_id,
                    harness,
                    tool_id: value.tool_call_id.to_string(),
                    result: Self::value_text(&value.output),
                    is_error: matches!(
                        value.status,
                        ToolStatus::Failed | ToolStatus::Declined | ToolStatus::Cancelled
                    ),
                    parent_tool_use_id,
                }))?;
            }
            HarnessEventPayloadV1::FileChange(value) => {
                self.emit_local(LocalChatEvent::FileChange(LocalChatFileChangeEvent {
                    backend_session_id,
                    harness,
                    tool_id: value
                        .tool_call_id
                        .map(|tool_id| tool_id.to_string())
                        .unwrap_or_default(),
                    status: file_change_status(value.status),
                    changes: value
                        .changes
                        .into_iter()
                        .map(|change| LocalChatFileChange {
                            path: change.path,
                            kind: file_change_kind(change.kind),
                            diff: change.patch,
                        })
                        .collect(),
                    parent_tool_use_id,
                }))?;
            }
            HarnessEventPayloadV1::Usage(value) => {
                if !is_root_stream {
                    return Ok(());
                }
                if let Some(snapshot) = value.session_snapshot {
                    let mut stats = self.stats.lock().map_err(|_| {
                        HarnessError::EventSink("GUI event state is poisoned".into())
                    })?;
                    stats.context_tokens = snapshot
                        .context_tokens
                        .unwrap_or_default()
                        .min(u64::from(u32::MAX)) as u32;
                    stats.context_window = snapshot
                        .context_window
                        .unwrap_or_default()
                        .min(u64::from(u32::MAX)) as u32;
                    stats.thread_total_tokens = snapshot
                        .tokens
                        .input_tokens
                        .saturating_add(snapshot.tokens.output_tokens)
                        .min(u64::from(u32::MAX))
                        as u32;
                    let model = stats.model.clone();
                    let context_tokens = stats.context_tokens;
                    let context_window = stats.context_window;
                    let thread_total_tokens = stats.thread_total_tokens;
                    drop(stats);
                    self.emit_local(LocalChatEvent::Usage(LocalChatSessionUsageEvent {
                        backend_session_id,
                        harness,
                        model,
                        context_tokens,
                        context_window,
                        thread_total_tokens,
                    }))?;
                }
            }
            HarnessEventPayloadV1::TurnFinished(outcome) => {
                self.emit_end(outcome.status, outcome.result_text, &outcome.metrics)?;
            }
            HarnessEventPayloadV1::RunFinished(outcome) => {
                self.emit_end(outcome.status, outcome.result_text, &outcome.metrics)?;
            }
            HarnessEventPayloadV1::Warning(value) => {
                self.emit_local(LocalChatEvent::Warning(LocalChatSessionWarningEvent {
                    backend_session_id,
                    harness,
                    warning: value.message,
                }))?;
            }
            HarnessEventPayloadV1::Error(value) => {
                self.emit_local(LocalChatEvent::Error(LocalChatSessionErrorEvent {
                    backend_session_id,
                    harness,
                    error: value.message,
                }))?;
            }
            _ => {}
        }
        Ok(())
    }
}

fn file_change_status(status: ToolStatus) -> String {
    match status {
        ToolStatus::Started | ToolStatus::Running => "started",
        ToolStatus::Completed => "completed",
        ToolStatus::Failed => "failed",
        ToolStatus::Declined => "declined",
        ToolStatus::Cancelled => "cancelled",
    }
    .into()
}

fn file_change_kind(kind: FileChangeKind) -> String {
    match kind {
        FileChangeKind::Added => "add",
        FileChangeKind::Modified => "update",
        FileChangeKind::Deleted => "delete",
        FileChangeKind::Renamed => "rename",
    }
    .into()
}

#[derive(Clone)]
pub(crate) struct LocalChatControlSink {
    backend_session_id: String,
    runtime: LocalChatRuntime,
}

impl LocalChatControlSink {
    pub(crate) fn new(backend_session_id: String, runtime: LocalChatRuntime) -> Self {
        Self {
            backend_session_id,
            runtime,
        }
    }
}

#[async_trait]
impl ControlSink for LocalChatControlSink {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        self.runtime
            .permission_bridge()
            .request_harness_control(&self.backend_session_id, self.runtime.app_handle(), request)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn translates_file_change_events_for_local_chat() {
        let (event_sink, captured) = LocalChatEventSink::capturing_for_tests();
        let sink = LocalChatHarnessEventSink::new(
            "backend-1".into(),
            LocalChatHarnessKind::Codex,
            event_sink,
            Some("gpt".into()),
            1_000,
            false,
        );

        sink.emit(HarnessEventV1 {
            event_id: EventId::new("file-event"),
            stream_id: StreamId::new("local-chat:backend-1"),
            sequence: 1,
            correlation: EventCorrelation::default(),
            timestamp: chrono::Utc::now(),
            semantics: UpdateSemantics::Snapshot,
            provider_sequence: None,
            payload: HarnessEventPayloadV1::FileChange(FileChangeEvent {
                tool_call_id: Some(ToolCallId::new("file-1")),
                changes: vec![FileChange {
                    path: "src/new.rs".into(),
                    kind: FileChangeKind::Added,
                    previous_path: None,
                    patch: Some("+fn main() {}".into()),
                }],
                status: ToolStatus::Completed,
            }),
        })
        .await
        .unwrap();

        let captured = captured.lock().unwrap();
        assert!(matches!(
            captured.as_slice(),
            [LocalChatEvent::FileChange(event)]
                if event.harness == LocalChatHarnessKind::Codex
                    && event.tool_id == "file-1"
                    && event.status == "completed"
                    && event.changes[0].kind == "add"
        ));
    }
}
