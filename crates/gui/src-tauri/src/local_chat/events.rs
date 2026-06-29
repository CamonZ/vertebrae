use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::local_chat::harness::LocalChatHarnessKind;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionInitEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub provider_resume_id: Option<String>,
    pub model: String,
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatTextEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub text: String,
    pub is_partial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatToolCallEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub tool_id: String,
    pub tool_name: String,
    pub input: String,
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatToolResultEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub tool_id: String,
    pub result: String,
    pub is_error: bool,
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionUsageEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub model: String,
    pub context_tokens: u32,
    pub context_window: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionEndEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
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
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event, PartialEq)]
pub struct LocalChatSessionWarningEvent {
    pub backend_session_id: String,
    pub harness: LocalChatHarnessKind,
    pub warning: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LocalChatEvent {
    Init(LocalChatSessionInitEvent),
    Text(LocalChatTextEvent),
    ToolCall(LocalChatToolCallEvent),
    ToolResult(LocalChatToolResultEvent),
    Usage(LocalChatSessionUsageEvent),
    End(LocalChatSessionEndEvent),
    Error(LocalChatSessionErrorEvent),
    Warning(LocalChatSessionWarningEvent),
}

impl LocalChatEvent {
    #[cfg(test)]
    pub(crate) fn tauri_event_name(&self) -> &'static str {
        match self {
            LocalChatEvent::Init(_) => "local-chat-session-init-event",
            LocalChatEvent::Text(_) => "local-chat-text-event",
            LocalChatEvent::ToolCall(_) => "local-chat-tool-call-event",
            LocalChatEvent::ToolResult(_) => "local-chat-tool-result-event",
            LocalChatEvent::Usage(_) => "local-chat-session-usage-event",
            LocalChatEvent::End(_) => "local-chat-session-end-event",
            LocalChatEvent::Error(_) => "local-chat-session-error-event",
            LocalChatEvent::Warning(_) => "local-chat-session-warning-event",
        }
    }
}

#[derive(Clone)]
pub(crate) struct LocalChatEventSink {
    app_handle: Option<tauri::AppHandle>,
}

impl LocalChatEventSink {
    pub(crate) fn tauri(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle: Some(app_handle),
        }
    }

    #[cfg(test)]
    pub(crate) fn inert_for_tests() -> Self {
        Self { app_handle: None }
    }

    pub(crate) fn emit(&self, event: LocalChatEvent) {
        let Some(app_handle) = &self.app_handle else {
            return;
        };

        match &event {
            LocalChatEvent::Init(payload) => {
                let _ = payload.emit(app_handle);
            }
            LocalChatEvent::Text(payload) => {
                let _ = payload.emit(app_handle);
            }
            LocalChatEvent::ToolCall(payload) => {
                let _ = payload.emit(app_handle);
            }
            LocalChatEvent::ToolResult(payload) => {
                let _ = payload.emit(app_handle);
            }
            LocalChatEvent::Usage(payload) => {
                let _ = payload.emit(app_handle);
            }
            LocalChatEvent::End(payload) => {
                let _ = payload.emit(app_handle);
            }
            LocalChatEvent::Error(payload) => {
                let _ = payload.emit(app_handle);
            }
            LocalChatEvent::Warning(payload) => {
                let _ = payload.emit(app_handle);
            }
        }
    }
}

#[cfg(test)]
mod tests;
