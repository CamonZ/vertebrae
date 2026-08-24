use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use vertebrae_harness_core::{
    CompactionState, CompletionStatus, ControlRequestEnvelope, ControlResolution, ControlSink,
    EventSink, FileChangeKind, HarnessError, HarnessEventPayloadV1, HarnessEventV1, ToolStatus,
    UpdateSemantics,
};
#[cfg(test)]
use vertebrae_harness_core::{
    EventCorrelation, EventId, FileChange, FileChangeEvent, StreamId, ToolCallId,
};

use crate::local_chat::{
    LocalChatCompactionEvent, LocalChatEvent, LocalChatEventSink, LocalChatFileChange,
    LocalChatFileChangeEvent, LocalChatHarnessKind, LocalChatRuntime, LocalChatSessionEndEvent,
    LocalChatSessionErrorEvent, LocalChatSessionInitEvent, LocalChatSessionUsageEvent,
    LocalChatSessionWarningEvent, LocalChatSpeedTierStatus, LocalChatTextEvent,
    LocalChatToolCallEvent, LocalChatToolResultEvent, LocalChatTurnStartedEvent,
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
            turn_id: None,
            thread_id: None,
            is_root: true,
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
        turn_id: String,
        thread_id: Option<String>,
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
            turn_id,
            thread_id,
            is_root: true,
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
        let turn_id = event.correlation.turn_id.as_ref().map(ToString::to_string);
        let thread_id = event
            .correlation
            .thread_id
            .as_ref()
            .map(ToString::to_string);

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
                    speed_tier_status: started.speed_tier_status.map(|status| {
                        LocalChatSpeedTierStatus {
                            requested: status.requested.map(|tier| tier.as_str().to_string()),
                            active: status.active.map(|tier| tier.as_str().to_string()),
                            eligible: status.eligible,
                            available: status.available,
                            diagnostic: status.diagnostic,
                        }
                    }),
                }))?;
            }
            HarnessEventPayloadV1::TurnStarted(_) => {
                if !is_root_stream {
                    return Ok(());
                }
                let Some(turn_id) = turn_id else {
                    return Ok(());
                };
                self.emit_local(LocalChatEvent::TurnStarted(LocalChatTurnStartedEvent {
                    backend_session_id,
                    harness,
                    turn_id,
                    thread_id,
                    is_root: true,
                }))?;
            }
            HarnessEventPayloadV1::Text(value) => {
                self.emit_local(LocalChatEvent::Text(LocalChatTextEvent {
                    backend_session_id,
                    harness,
                    turn_id,
                    thread_id,
                    is_root: is_root_stream,
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
                    turn_id,
                    thread_id,
                    is_root: is_root_stream,
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
                    turn_id,
                    thread_id,
                    is_root: is_root_stream,
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
                    turn_id,
                    thread_id,
                    is_root: is_root_stream,
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
                        turn_id,
                        thread_id,
                        is_root: true,
                        model,
                        context_tokens,
                        context_window,
                        thread_total_tokens,
                    }))?;
                }
            }
            HarnessEventPayloadV1::TurnFinished(outcome) => {
                if !is_root_stream {
                    return Ok(());
                }
                let Some(turn_id) = turn_id else {
                    return Ok(());
                };
                self.emit_end(
                    turn_id,
                    thread_id,
                    outcome.status,
                    outcome.result_text,
                    &outcome.metrics,
                )?;
            }
            HarnessEventPayloadV1::RunFinished(outcome) => {
                if !is_root_stream {
                    return Ok(());
                }
                let Some(turn_id) = turn_id else {
                    return Ok(());
                };
                self.emit_end(
                    turn_id,
                    thread_id,
                    outcome.status,
                    outcome.result_text,
                    &outcome.metrics,
                )?;
            }
            HarnessEventPayloadV1::Compaction(value) => {
                self.emit_local(LocalChatEvent::Compaction(LocalChatCompactionEvent {
                    backend_session_id,
                    harness,
                    turn_id,
                    thread_id,
                    is_root: is_root_stream,
                    state: compaction_state(value.state).into(),
                    trigger: value.trigger,
                    pre_tokens: value
                        .pre_tokens
                        .map(|tokens| tokens.min(u64::from(u32::MAX)) as u32),
                }))?;
            }
            HarnessEventPayloadV1::Warning(value) => {
                self.emit_local(LocalChatEvent::Warning(LocalChatSessionWarningEvent {
                    backend_session_id,
                    harness,
                    turn_id,
                    thread_id,
                    is_root: is_root_stream,
                    warning: value.message,
                }))?;
            }
            HarnessEventPayloadV1::Error(value) => {
                self.emit_local(LocalChatEvent::Error(LocalChatSessionErrorEvent {
                    backend_session_id,
                    harness,
                    turn_id,
                    thread_id,
                    is_root: is_root_stream,
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

fn compaction_state(state: CompactionState) -> &'static str {
    match state {
        CompactionState::Active => "active",
        CompactionState::Completed => "completed",
        CompactionState::Cleared => "cleared",
    }
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
            correlation: EventCorrelation {
                thread_id: Some(vertebrae_harness_core::ThreadId::new("root-thread")),
                turn_id: Some(vertebrae_harness_core::TurnId::new("root-turn")),
                ..EventCorrelation::default()
            },
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
                    && event.turn_id.as_deref() == Some("root-turn")
                    && event.thread_id.as_deref() == Some("root-thread")
                    && event.is_root
                    && event.tool_id == "file-1"
                    && event.status == "completed"
                    && event.changes[0].kind == "add"
        ));
    }

    #[tokio::test]
    async fn translates_compaction_events_with_session_correlation_and_metadata() {
        let (event_sink, captured) = LocalChatEventSink::capturing_for_tests();
        let sink = LocalChatHarnessEventSink::new(
            "backend-1".into(),
            LocalChatHarnessKind::Claude,
            event_sink,
            Some("sonnet".into()),
            1_000,
            false,
        );
        let correlation = EventCorrelation {
            thread_id: Some(vertebrae_harness_core::ThreadId::new("root-thread")),
            turn_id: Some(vertebrae_harness_core::TurnId::new("root-turn")),
            ..EventCorrelation::default()
        };
        for (sequence, state, trigger, pre_tokens) in [
            (1, CompactionState::Active, None, None),
            (2, CompactionState::Completed, Some("auto"), Some(4_096)),
        ] {
            sink.emit(HarnessEventV1 {
                event_id: EventId::new(format!("compaction-{sequence}")),
                stream_id: StreamId::new("local-chat:backend-1"),
                sequence,
                correlation: correlation.clone(),
                timestamp: chrono::Utc::now(),
                semantics: UpdateSemantics::Snapshot,
                provider_sequence: Some(sequence),
                payload: HarnessEventPayloadV1::Compaction(
                    vertebrae_harness_core::CompactionEvent {
                        state,
                        trigger: trigger.map(str::to_owned),
                        pre_tokens,
                    },
                ),
            })
            .await
            .unwrap();
        }

        let captured = captured.lock().unwrap();
        assert!(matches!(
            captured.as_slice(),
            [
                LocalChatEvent::Compaction(active),
                LocalChatEvent::Compaction(completed)
            ] if active.backend_session_id == "backend-1"
                && active.harness == LocalChatHarnessKind::Claude
                && active.turn_id.as_deref() == Some("root-turn")
                && active.thread_id.as_deref() == Some("root-thread")
                && active.is_root
                && active.state == "active"
                && active.trigger.is_none()
                && active.pre_tokens.is_none()
                && completed.state == "completed"
                && completed.trigger.as_deref() == Some("auto")
                && completed.pre_tokens == Some(4_096)
        ));
    }

    #[tokio::test]
    async fn forwards_running_tool_progress_to_local_chat() {
        let (event_sink, captured) = LocalChatEventSink::capturing_for_tests();
        let sink = LocalChatHarnessEventSink::new(
            "backend-1".into(),
            LocalChatHarnessKind::Claude,
            event_sink,
            Some("sonnet".into()),
            1_000,
            false,
        );

        sink.emit(HarnessEventV1 {
            event_id: EventId::new("progress-event"),
            stream_id: StreamId::new("local-chat:backend-1"),
            sequence: 1,
            correlation: EventCorrelation {
                thread_id: Some(vertebrae_harness_core::ThreadId::new("root-thread")),
                turn_id: Some(vertebrae_harness_core::TurnId::new("root-turn")),
                ..EventCorrelation::default()
            },
            timestamp: chrono::Utc::now(),
            semantics: UpdateSemantics::Delta,
            provider_sequence: Some(3),
            payload: HarnessEventPayloadV1::ToolOutput(vertebrae_harness_core::ToolOutputEvent {
                tool_call_id: ToolCallId::new("tool-1"),
                output: serde_json::json!({
                    "kind": "progress",
                    "tool_name": "Bash",
                    "elapsed_seconds": 1.25,
                    "task_id": "task-1"
                }),
                status: ToolStatus::Running,
                content_semantics: UpdateSemantics::Delta,
            }),
        })
        .await
        .unwrap();

        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let LocalChatEvent::ToolResult(result) = &captured[0] else {
            panic!("expected local-chat tool result, got {:?}", captured[0]);
        };
        assert_eq!(result.tool_id, "tool-1");
        assert!(!result.is_error);
        assert_eq!(result.turn_id.as_deref(), Some("root-turn"));
        assert_eq!(result.thread_id.as_deref(), Some("root-thread"));
        let progress: serde_json::Value = serde_json::from_str(&result.result).unwrap();
        assert_eq!(progress["kind"], "progress");
        assert_eq!(progress["elapsed_seconds"], 1.25);
        assert_eq!(progress["task_id"], "task-1");
    }

    #[tokio::test]
    async fn ignores_child_turn_finished_for_local_chat_lifecycle() {
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
            event_id: EventId::new("child-turn-finished"),
            stream_id: StreamId::new("local-chat:backend-1:thread:child-1"),
            sequence: 1,
            correlation: EventCorrelation {
                thread_id: Some(vertebrae_harness_core::ThreadId::new("child-1")),
                turn_id: Some(vertebrae_harness_core::TurnId::new("child-turn")),
                parent_tool_call_id: Some(ToolCallId::new("spawn-1")),
                ..EventCorrelation::default()
            },
            timestamp: chrono::Utc::now(),
            semantics: UpdateSemantics::Snapshot,
            provider_sequence: None,
            payload: HarnessEventPayloadV1::TurnFinished(vertebrae_harness_core::TurnOutcome {
                status: CompletionStatus::Completed,
                result_text: Some("child result".into()),
                structured_output: None,
                usage: None,
                metrics: Default::default(),
                error: None,
            }),
        })
        .await
        .unwrap();

        assert!(captured.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn preserves_root_identity_from_turn_start_through_completion() {
        let (event_sink, captured) = LocalChatEventSink::capturing_for_tests();
        let sink = LocalChatHarnessEventSink::new(
            "backend-1".into(),
            LocalChatHarnessKind::Codex,
            event_sink,
            Some("gpt".into()),
            1_000,
            false,
        );
        let correlation = EventCorrelation {
            thread_id: Some(vertebrae_harness_core::ThreadId::new("root-thread")),
            turn_id: Some(vertebrae_harness_core::TurnId::new("root-turn")),
            ..EventCorrelation::default()
        };

        for (sequence, payload) in [
            (
                1,
                HarnessEventPayloadV1::TurnStarted(vertebrae_harness_core::TurnStarted {
                    input_summary: Some("hello".into()),
                }),
            ),
            (
                2,
                HarnessEventPayloadV1::Text(vertebrae_harness_core::TextEvent {
                    text: "answer".into(),
                }),
            ),
            (
                3,
                HarnessEventPayloadV1::TurnFinished(vertebrae_harness_core::TurnOutcome {
                    status: CompletionStatus::Completed,
                    result_text: Some("answer".into()),
                    structured_output: None,
                    usage: None,
                    metrics: Default::default(),
                    error: None,
                }),
            ),
        ] {
            sink.emit(HarnessEventV1 {
                event_id: EventId::new(format!("event-{sequence}")),
                stream_id: StreamId::new("local-chat:backend-1"),
                sequence,
                correlation: correlation.clone(),
                timestamp: chrono::Utc::now(),
                semantics: UpdateSemantics::Snapshot,
                provider_sequence: None,
                payload,
            })
            .await
            .unwrap();
        }

        let captured = captured.lock().unwrap();
        assert!(matches!(
            captured.as_slice(),
            [
                LocalChatEvent::TurnStarted(started),
                LocalChatEvent::Text(text),
                LocalChatEvent::End(end),
            ] if started.turn_id == "root-turn"
                && started.thread_id.as_deref() == Some("root-thread")
                && started.is_root
                && text.turn_id.as_deref() == Some("root-turn")
                && text.thread_id.as_deref() == Some("root-thread")
                && text.is_root
                && end.turn_id == "root-turn"
                && end.thread_id.as_deref() == Some("root-thread")
                && end.is_root
        ));
    }

    #[tokio::test]
    async fn translates_harness_sequence_to_shared_frontend_fixture() {
        let (event_sink, captured) = LocalChatEventSink::capturing_for_tests();
        let sink = LocalChatHarnessEventSink::new(
            "backend-bridge".into(),
            LocalChatHarnessKind::Codex,
            event_sink,
            Some("gpt".into()),
            1_000,
            false,
        );
        let root = EventCorrelation {
            thread_id: Some(vertebrae_harness_core::ThreadId::new("root-thread")),
            turn_id: Some(vertebrae_harness_core::TurnId::new("root-turn")),
            ..EventCorrelation::default()
        };
        let child = EventCorrelation {
            thread_id: Some(vertebrae_harness_core::ThreadId::new("child-thread")),
            turn_id: Some(vertebrae_harness_core::TurnId::new("child-turn")),
            parent_tool_call_id: Some(ToolCallId::new("spawn-1")),
            ..EventCorrelation::default()
        };
        let events = [
            (
                "local-chat:backend-bridge",
                root.clone(),
                HarnessEventPayloadV1::TurnStarted(vertebrae_harness_core::TurnStarted {
                    input_summary: Some("question".into()),
                }),
            ),
            (
                "local-chat:backend-bridge",
                root.clone(),
                HarnessEventPayloadV1::Text(vertebrae_harness_core::TextEvent {
                    text: "root answer".into(),
                }),
            ),
            (
                "local-chat:backend-bridge",
                root.clone(),
                HarnessEventPayloadV1::ToolCall(vertebrae_harness_core::ToolCallEvent {
                    tool_call_id: ToolCallId::new("spawn-1"),
                    name: "Agent".into(),
                    input: serde_json::json!({ "prompt": "inspect" }),
                    status: ToolStatus::Started,
                }),
            ),
            (
                "local-chat:backend-bridge:thread:child-thread",
                child.clone(),
                HarnessEventPayloadV1::Text(vertebrae_harness_core::TextEvent {
                    text: "child update".into(),
                }),
            ),
            (
                "local-chat:backend-bridge:thread:child-thread",
                child,
                HarnessEventPayloadV1::TurnFinished(vertebrae_harness_core::TurnOutcome {
                    status: CompletionStatus::Completed,
                    result_text: Some("child done".into()),
                    structured_output: None,
                    usage: None,
                    metrics: Default::default(),
                    error: None,
                }),
            ),
            (
                "local-chat:backend-bridge",
                root,
                HarnessEventPayloadV1::TurnFinished(vertebrae_harness_core::TurnOutcome {
                    status: CompletionStatus::Completed,
                    result_text: Some("root done".into()),
                    structured_output: None,
                    usage: None,
                    metrics: Default::default(),
                    error: None,
                }),
            ),
        ];

        for (index, (stream_id, correlation, payload)) in events.into_iter().enumerate() {
            sink.emit(HarnessEventV1 {
                event_id: EventId::new(format!("bridge-{index}")),
                stream_id: StreamId::new(stream_id),
                sequence: index as u64 + 1,
                correlation,
                timestamp: chrono::Utc::now(),
                semantics: UpdateSemantics::Snapshot,
                provider_sequence: None,
                payload,
            })
            .await
            .unwrap();
        }

        let translated = captured
            .lock()
            .unwrap()
            .iter()
            .map(|event| match event {
                LocalChatEvent::TurnStarted(payload) => {
                    serde_json::json!({ "type": "turn_started", "payload": payload })
                }
                LocalChatEvent::Text(payload) => {
                    serde_json::json!({ "type": "text", "payload": payload })
                }
                LocalChatEvent::ToolCall(payload) => {
                    serde_json::json!({ "type": "tool_call", "payload": payload })
                }
                LocalChatEvent::End(payload) => {
                    serde_json::json!({ "type": "end", "payload": payload })
                }
                event => panic!("unexpected translated event: {event:?}"),
            })
            .collect::<Vec<_>>();
        let expected: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../../src/test/fixtures/localChatTurnTranslation.json"
        ))
        .unwrap();

        assert_eq!(translated, expected);
    }
}
