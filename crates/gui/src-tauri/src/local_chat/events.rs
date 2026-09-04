use serde::{Deserialize, Serialize};
use specta::Type;
#[cfg(test)]
use std::sync::{Arc, Mutex};
use tauri_specta::Event;

use crate::local_chat::harness::LocalChatHarnessKind;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct LocalChatSpeedTierStatus {
    pub requested: Option<String>,
    pub active: Option<String>,
    pub eligible: bool,
    pub available: bool,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionInitEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub provider_resume_id: Option<String>,
    pub model: String,
    pub tools: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub speed_tier_status: Option<LocalChatSpeedTierStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatTextEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub text: String,
    pub is_partial: bool,
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatTurnStartedEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    pub is_root: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatToolCallEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub tool_id: String,
    pub tool_name: String,
    pub input: String,
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatToolResultEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub tool_id: String,
    pub result: String,
    pub is_error: bool,
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatFileChange {
    pub path: String,
    pub kind: String,
    pub diff: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatFileChangeEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub tool_id: String,
    pub status: String,
    pub changes: Vec<LocalChatFileChange>,
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionUsageEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub model: String,
    pub context_tokens: u32,
    pub context_window: u32,
    /// Cumulative thread token total, distinct from the current request's
    /// context utilization above.
    pub thread_total_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionEndEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    pub is_root: bool,
    pub duration_ms: u32,
    pub cost_usd: f64,
    pub num_turns: u32,
    pub result: String,
    pub is_error: bool,
    pub context_tokens: u32,
    pub context_window: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionErrorEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionWarningEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub warning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatCompactionEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub trigger: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub pre_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LocalChatEvent {
    Init(LocalChatSessionInitEvent),
    TurnStarted(LocalChatTurnStartedEvent),
    Text(LocalChatTextEvent),
    ToolCall(LocalChatToolCallEvent),
    ToolResult(LocalChatToolResultEvent),
    FileChange(LocalChatFileChangeEvent),
    Usage(LocalChatSessionUsageEvent),
    End(LocalChatSessionEndEvent),
    Error(LocalChatSessionErrorEvent),
    Warning(LocalChatSessionWarningEvent),
    Compaction(LocalChatCompactionEvent),
}

impl LocalChatEvent {
    #[cfg(test)]
    pub(crate) fn tauri_event_name(&self) -> &'static str {
        match self {
            LocalChatEvent::Init(_) => "local-chat-session-init-event",
            LocalChatEvent::TurnStarted(_) => "local-chat-turn-started-event",
            LocalChatEvent::Text(_) => "local-chat-text-event",
            LocalChatEvent::ToolCall(_) => "local-chat-tool-call-event",
            LocalChatEvent::ToolResult(_) => "local-chat-tool-result-event",
            LocalChatEvent::FileChange(_) => "local-chat-file-change-event",
            LocalChatEvent::Usage(_) => "local-chat-session-usage-event",
            LocalChatEvent::End(_) => "local-chat-session-end-event",
            LocalChatEvent::Error(_) => "local-chat-session-error-event",
            LocalChatEvent::Warning(_) => "local-chat-session-warning-event",
            LocalChatEvent::Compaction(_) => "local-chat-compaction-event",
        }
    }
}

#[derive(Clone)]
pub(crate) struct LocalChatEventSink {
    app_handle: Option<tauri::AppHandle>,
    #[cfg(test)]
    captured_events: Option<Arc<Mutex<Vec<LocalChatEvent>>>>,
    #[cfg(test)]
    delivery_error: Option<String>,
}

impl LocalChatEventSink {
    pub(crate) fn tauri(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle: Some(app_handle),
            #[cfg(test)]
            captured_events: None,
            #[cfg(test)]
            delivery_error: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn inert_for_tests() -> Self {
        Self {
            app_handle: None,
            captured_events: None,
            delivery_error: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn capturing_for_tests() -> (Self, Arc<Mutex<Vec<LocalChatEvent>>>) {
        let captured_events = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                app_handle: None,
                captured_events: Some(captured_events.clone()),
                delivery_error: None,
            },
            captured_events,
        )
    }

    #[cfg(test)]
    pub(crate) fn failing_for_tests(error: &str) -> Self {
        Self {
            app_handle: None,
            captured_events: None,
            delivery_error: Some(error.to_string()),
        }
    }

    pub(crate) fn emit(&self, event: LocalChatEvent) {
        let _ = self.try_emit(event);
    }

    pub(crate) fn try_emit(&self, event: LocalChatEvent) -> Result<(), String> {
        #[cfg(test)]
        if let Some(captured_events) = &self.captured_events {
            captured_events
                .lock()
                .expect("local chat event capture lock poisoned")
                .push(event.clone());
        }

        #[cfg(test)]
        if let Some(error) = &self.delivery_error {
            return Err(error.clone());
        }

        let Some(app_handle) = &self.app_handle else {
            return Ok(());
        };

        let result = match &event {
            LocalChatEvent::Init(payload) => payload.emit(app_handle),
            LocalChatEvent::TurnStarted(payload) => payload.emit(app_handle),
            LocalChatEvent::Text(payload) => payload.emit(app_handle),
            LocalChatEvent::ToolCall(payload) => payload.emit(app_handle),
            LocalChatEvent::ToolResult(payload) => payload.emit(app_handle),
            LocalChatEvent::FileChange(payload) => payload.emit(app_handle),
            LocalChatEvent::Usage(payload) => payload.emit(app_handle),
            LocalChatEvent::End(payload) => payload.emit(app_handle),
            LocalChatEvent::Error(payload) => payload.emit(app_handle),
            LocalChatEvent::Warning(payload) => payload.emit(app_handle),
            LocalChatEvent::Compaction(payload) => payload.emit(app_handle),
        };
        result.map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests;
