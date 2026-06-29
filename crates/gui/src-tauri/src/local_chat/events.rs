use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::claude_session::{
    ClaudeSessionEndEvent, ClaudeSessionErrorEvent, ClaudeSessionInitEvent,
    ClaudeSessionUsageEvent, ClaudeSessionWarningEvent, ClaudeTextEvent, ClaudeToolCallEvent,
    ClaudeToolResultEvent,
};
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

    pub(crate) fn claude_compatibility_event(&self) -> Option<ClaudeCompatibilityEvent> {
        match self {
            LocalChatEvent::Init(event) if event.harness == LocalChatHarnessKind::Claude => {
                Some(ClaudeCompatibilityEvent::Init(ClaudeSessionInitEvent {
                    session_id: event.backend_session_id.clone(),
                    claude_conversation_id: event.provider_resume_id.clone(),
                    model: event.model.clone(),
                    tools: event.tools.clone(),
                }))
            }
            LocalChatEvent::Text(event) if event.harness == LocalChatHarnessKind::Claude => {
                Some(ClaudeCompatibilityEvent::Text(ClaudeTextEvent {
                    session_id: event.backend_session_id.clone(),
                    text: event.text.clone(),
                    is_partial: event.is_partial,
                }))
            }
            LocalChatEvent::ToolCall(event) if event.harness == LocalChatHarnessKind::Claude => {
                Some(ClaudeCompatibilityEvent::ToolCall(ClaudeToolCallEvent {
                    session_id: event.backend_session_id.clone(),
                    tool_id: event.tool_id.clone(),
                    tool_name: event.tool_name.clone(),
                    input: event.input.clone(),
                    parent_tool_use_id: event.parent_tool_use_id.clone(),
                }))
            }
            LocalChatEvent::ToolResult(event) if event.harness == LocalChatHarnessKind::Claude => {
                Some(ClaudeCompatibilityEvent::ToolResult(
                    ClaudeToolResultEvent {
                        session_id: event.backend_session_id.clone(),
                        tool_id: event.tool_id.clone(),
                        result: event.result.clone(),
                        is_error: event.is_error,
                        parent_tool_use_id: event.parent_tool_use_id.clone(),
                    },
                ))
            }
            LocalChatEvent::Usage(event) if event.harness == LocalChatHarnessKind::Claude => {
                Some(ClaudeCompatibilityEvent::Usage(ClaudeSessionUsageEvent {
                    session_id: event.backend_session_id.clone(),
                    model: event.model.clone(),
                    context_tokens: event.context_tokens,
                    context_window: event.context_window,
                }))
            }
            LocalChatEvent::End(event) if event.harness == LocalChatHarnessKind::Claude => {
                Some(ClaudeCompatibilityEvent::End(ClaudeSessionEndEvent {
                    session_id: event.backend_session_id.clone(),
                    duration_ms: event.duration_ms,
                    cost_usd: event.cost_usd,
                    num_turns: event.num_turns,
                    result: event.result.clone(),
                    is_error: event.is_error,
                    context_tokens: event.context_tokens,
                    context_window: event.context_window,
                }))
            }
            LocalChatEvent::Error(event) if event.harness == LocalChatHarnessKind::Claude => {
                Some(ClaudeCompatibilityEvent::Error(ClaudeSessionErrorEvent {
                    session_id: event.backend_session_id.clone(),
                    error: event.error.clone(),
                }))
            }
            LocalChatEvent::Warning(event) if event.harness == LocalChatHarnessKind::Claude => {
                Some(ClaudeCompatibilityEvent::Warning(
                    ClaudeSessionWarningEvent {
                        session_id: event.backend_session_id.clone(),
                        warning: event.warning.clone(),
                    },
                ))
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum ClaudeCompatibilityEvent {
    Init(ClaudeSessionInitEvent),
    Text(ClaudeTextEvent),
    ToolCall(ClaudeToolCallEvent),
    ToolResult(ClaudeToolResultEvent),
    Usage(ClaudeSessionUsageEvent),
    End(ClaudeSessionEndEvent),
    Error(ClaudeSessionErrorEvent),
    Warning(ClaudeSessionWarningEvent),
}

impl ClaudeCompatibilityEvent {
    fn emit(&self, app_handle: &tauri::AppHandle) {
        match self {
            ClaudeCompatibilityEvent::Init(event) => {
                let _ = event.emit(app_handle);
            }
            ClaudeCompatibilityEvent::Text(event) => {
                let _ = event.emit(app_handle);
            }
            ClaudeCompatibilityEvent::ToolCall(event) => {
                let _ = event.emit(app_handle);
            }
            ClaudeCompatibilityEvent::ToolResult(event) => {
                let _ = event.emit(app_handle);
            }
            ClaudeCompatibilityEvent::Usage(event) => {
                let _ = event.emit(app_handle);
            }
            ClaudeCompatibilityEvent::End(event) => {
                let _ = event.emit(app_handle);
            }
            ClaudeCompatibilityEvent::Error(event) => {
                let _ = event.emit(app_handle);
            }
            ClaudeCompatibilityEvent::Warning(event) => {
                let _ = event.emit(app_handle);
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct LocalChatEventSink {
    app_handle: Option<tauri::AppHandle>,
    mirror_claude_compatibility_events: bool,
}

impl LocalChatEventSink {
    pub(crate) fn tauri(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle: Some(app_handle),
            mirror_claude_compatibility_events: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn inert_for_tests() -> Self {
        Self {
            app_handle: None,
            mirror_claude_compatibility_events: false,
        }
    }

    pub(crate) fn with_claude_compatibility_events(mut self) -> Self {
        self.mirror_claude_compatibility_events = true;
        self
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

        if self.mirror_claude_compatibility_events {
            if let Some(compatibility_event) = event.claude_compatibility_event() {
                compatibility_event.emit(app_handle);
            }
        }
    }
}

#[cfg(test)]
mod tests;
