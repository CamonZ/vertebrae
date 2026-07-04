use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::local_chat::{
    LocalChatEvent, LocalChatEventSink, LocalChatHarnessKind, LocalChatSessionEndEvent,
    LocalChatSessionErrorEvent, LocalChatSessionUsageEvent, LocalChatSessionWarningEvent,
    LocalChatTextEvent, LocalChatToolCallEvent, LocalChatToolResultEvent,
};

use super::models::CODEX_DEFAULT_MODEL_LABEL;
use super::protocol::{
    child_thread_status_from_params, codex_error_message, codex_tool_call, codex_tool_result,
    unresolved_collab_spawn, value_to_u32,
};
use super::thread_state::{CodexThreadState, SyntheticSpawnParent};

pub(super) fn approval_request_kind(method: &str) -> Option<&'static str> {
    match method {
        "item/commandExecution/requestApproval" => Some("command execution"),
        "item/fileChange/requestApproval" => Some("file change"),
        "item/permissions/requestApproval" => Some("additional permission"),
        _ => None,
    }
}

pub(super) fn is_turn_notification(method: &str) -> bool {
    matches!(
        method,
        "item/agentMessage/delta"
            | "item/started"
            | "item/completed"
            | "thread/tokenUsage/updated"
            | "turn/completed"
            | "error"
    )
}

pub(super) struct TurnNotificationHandler {
    backend_session_id: String,
    thread_id: String,
    model: String,
    event_sink: LocalChatEventSink,
    pub(super) active_turn: Option<ActiveTurnState>,
    pending_notifications: Vec<(String, Value)>,
    pub(super) thread_state: Arc<StdMutex<CodexThreadState>>,
}

impl TurnNotificationHandler {
    pub(super) fn new(
        backend_session_id: String,
        event_sink: LocalChatEventSink,
        thread_state: Arc<StdMutex<CodexThreadState>>,
    ) -> Self {
        Self {
            backend_session_id,
            thread_id: String::new(),
            model: CODEX_DEFAULT_MODEL_LABEL.to_string(),
            event_sink,
            active_turn: None,
            pending_notifications: Vec::new(),
            thread_state,
        }
    }

    pub(super) fn set_thread(&mut self, thread_id: String, model: String) {
        self.thread_id = thread_id;
        self.model = model;
    }

    pub(super) fn begin_turn(
        &mut self,
        num_turns: u32,
        completion_tx: oneshot::Sender<TurnOutcome>,
    ) {
        self.active_turn = Some(ActiveTurnState {
            num_turns,
            text: String::new(),
            context_tokens: 0,
            context_window: 0,
            expected_turn_id: None,
            completion_tx: Some(completion_tx),
        });
        self.pending_notifications.clear();
    }

    pub(super) fn clear_active_turn(&mut self) {
        self.active_turn = None;
        self.pending_notifications.clear();
    }

    pub(super) fn handle(&mut self, method: &str, params: &Value) {
        let notification_thread_id = params.get("threadId").and_then(Value::as_str);
        let mut parent_tool_use_id = self.parent_tool_use_id_for_notification(params);
        if notification_thread_id != Some(self.thread_id.as_str()) && parent_tool_use_id.is_none() {
            // A Codex session can contain multiple threads. If a child thread
            // races ahead of its parent spawn item, register a minimal stable
            // spawn parent immediately so status/result updates still have a
            // stable Agent row. Child work itself stays in the child thread.
            if notification_thread_id.is_some() {
                if let Some(parent) = self.ensure_parent_for_child_notification(params) {
                    if parent.should_emit {
                        self.emit_synthetic_spawn_parent(params, &parent.tool_id);
                    }
                    parent_tool_use_id = Some(parent.tool_id);
                } else {
                    return;
                }
            } else {
                return;
            }
        }
        if self
            .active_turn
            .as_ref()
            .is_some_and(|turn| turn.expected_turn_id.is_none())
            && parent_tool_use_id.is_none()
            && is_turn_notification(method)
        {
            self.pending_notifications
                .push((method.to_string(), params.clone()));
            return;
        }
        if parent_tool_use_id.is_none()
            && self.active_turn.is_some()
            && !self.matches_expected_turn(method, params)
        {
            return;
        }

        match method {
            "item/agentMessage/delta" => {
                self.handle_agent_delta(params, parent_tool_use_id.as_deref())
            }
            "item/started" => self.handle_item_started(params, parent_tool_use_id.as_deref()),
            "item/completed" => self.handle_item_completed(params, parent_tool_use_id.as_deref()),
            "thread/status/changed" => {
                if let Some(parent_tool_use_id) = parent_tool_use_id.as_deref() {
                    self.handle_child_thread_status(params, parent_tool_use_id);
                }
            }
            "thread/tokenUsage/updated" => {
                if parent_tool_use_id.is_none() {
                    self.handle_usage(params);
                }
            }
            "turn/completed" => {
                if let Some(parent_tool_use_id) = parent_tool_use_id.as_deref() {
                    self.handle_child_turn_completed(params, parent_tool_use_id);
                } else {
                    self.handle_turn_completed(params);
                }
            }
            "error" => self.handle_error(params),
            _ => {}
        }
    }

    pub(super) fn set_expected_turn_id(&mut self, turn_id: &str) {
        let Some(active_turn) = self.active_turn.as_mut() else {
            return;
        };
        active_turn.expected_turn_id = Some(turn_id.to_string());
        let pending_notifications = std::mem::take(&mut self.pending_notifications);
        for (method, params) in pending_notifications {
            self.handle(&method, &params);
        }
    }

    fn matches_expected_turn(&self, method: &str, params: &Value) -> bool {
        let Some(expected_turn_id) = self
            .active_turn
            .as_ref()
            .and_then(|turn| turn.expected_turn_id.as_deref())
        else {
            return true;
        };
        let turn_id = match method {
            "turn/completed" => params.pointer("/turn/id").and_then(Value::as_str),
            _ => params.get("turnId").and_then(Value::as_str),
        };
        match turn_id {
            Some(turn_id) => turn_id == expected_turn_id,
            None => true,
        }
    }

    pub(super) fn handle_agent_delta(&mut self, params: &Value, parent_tool_use_id: Option<&str>) {
        let Some(delta) = params.get("delta").and_then(Value::as_str) else {
            return;
        };
        if parent_tool_use_id.is_some() {
            return;
        }
        if parent_tool_use_id.is_none() {
            if let Some(active_turn) = self.active_turn.as_mut() {
                active_turn.text.push_str(delta);
            }
        }
        self.event_sink
            .emit(LocalChatEvent::Text(LocalChatTextEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                text: delta.to_string(),
                is_partial: true,
                parent_tool_use_id: parent_tool_use_id.map(str::to_string),
            }));
    }

    pub(super) fn handle_item_started(&mut self, params: &Value, parent_tool_use_id: Option<&str>) {
        let Some(item) = params.get("item") else {
            return;
        };
        if parent_tool_use_id.is_some() {
            return;
        }
        if unresolved_collab_spawn(item) {
            return;
        }
        if let Some((tool_id, tool_name, input)) = codex_tool_call(item) {
            if item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall") {
                self.remember_child_thread_parents(item, &tool_id);
            }
            self.event_sink
                .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Codex,
                    tool_id,
                    tool_name,
                    input,
                    parent_tool_use_id: parent_tool_use_id.map(str::to_string),
                }));
        }
    }

    pub(super) fn handle_item_completed(
        &mut self,
        params: &Value,
        parent_tool_use_id: Option<&str>,
    ) {
        let Some(item) = params.get("item") else {
            return;
        };
        if parent_tool_use_id.is_some() {
            self.handle_child_item_completed(params);
            return;
        }
        if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
            self.handle_agent_message_completed(item, parent_tool_use_id);
        }
        if item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall") {
            if let Some((tool_id, tool_name, input)) = codex_tool_call(item) {
                self.remember_child_thread_parents(item, &tool_id);
                self.event_sink
                    .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                        backend_session_id: self.backend_session_id.clone(),
                        harness: LocalChatHarnessKind::Codex,
                        tool_id,
                        tool_name,
                        input,
                        parent_tool_use_id: parent_tool_use_id.map(str::to_string),
                    }));
            }
        }
        if let Some((tool_id, result, is_error)) = codex_tool_result(item) {
            self.event_sink
                .emit(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Codex,
                    tool_id,
                    result,
                    is_error,
                    parent_tool_use_id: parent_tool_use_id.map(str::to_string),
                }));
        }
    }

    pub(super) fn handle_child_item_completed(&mut self, params: &Value) {
        let Some(item) = params.get("item") else {
            return;
        };
        if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
            return;
        }
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let Some(text) = item.get("text").and_then(Value::as_str) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        let turn_id = params.get("turnId").and_then(Value::as_str);
        self.thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .remember_child_turn_result(thread_id, turn_id, text.to_string());
    }

    pub(super) fn handle_agent_message_completed(
        &mut self,
        item: &Value,
        parent_tool_use_id: Option<&str>,
    ) {
        let Some(text) = item.get("text").and_then(Value::as_str) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        self.event_sink
            .emit(LocalChatEvent::Text(LocalChatTextEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                text: text.to_string(),
                is_partial: false,
                parent_tool_use_id: parent_tool_use_id.map(str::to_string),
            }));
    }

    pub(super) fn remember_child_thread_parents(&mut self, item: &Value, tool_id: &str) {
        self.thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .remember_child_thread_parents(item, tool_id);
    }

    pub(super) fn parent_tool_use_id_for_notification(&self, params: &Value) -> Option<String> {
        self.thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .parent_tool_use_id_for_notification(params)
    }

    pub(super) fn ensure_parent_for_child_notification(
        &self,
        params: &Value,
    ) -> Option<SyntheticSpawnParent> {
        self.thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .ensure_parent_for_child_notification(params)
    }

    fn emit_synthetic_spawn_parent(&self, params: &Value, tool_id: &str) {
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or("child-thread");
        self.event_sink
            .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id: tool_id.to_string(),
                tool_name: "Agent".to_string(),
                input: serde_json::to_string(&json!({
                    "collab_tool": "spawnAgent",
                    "receiver_thread_ids": [thread_id],
                    "description": "Agent",
                }))
                .unwrap_or_default(),
                parent_tool_use_id: None,
            }));
    }

    pub(super) fn handle_usage(&mut self, params: &Value) {
        let Some(active_turn) = self.active_turn.as_mut() else {
            return;
        };
        active_turn.context_tokens = value_to_u32(params.pointer("/tokenUsage/total/totalTokens"))
            .unwrap_or(active_turn.context_tokens);
        active_turn.context_window = value_to_u32(params.pointer("/tokenUsage/modelContextWindow"))
            .unwrap_or(active_turn.context_window);
        self.event_sink
            .emit(LocalChatEvent::Usage(LocalChatSessionUsageEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                model: self.model.clone(),
                context_tokens: active_turn.context_tokens,
                context_window: active_turn.context_window,
            }));
    }

    pub(super) fn handle_child_thread_status(&self, params: &Value, parent_tool_use_id: &str) {
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let Some(status) = child_thread_status_from_params(params) else {
            return;
        };
        self.emit_child_agent_status(parent_tool_use_id, thread_id, status);
        let parent_done = self
            .thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .record_child_thread_status(parent_tool_use_id, thread_id, status);
        if let Some(is_error) = parent_done {
            self.emit_parent_agent_completion(parent_tool_use_id, status, is_error);
        }
    }

    pub(super) fn handle_child_turn_completed(&self, params: &Value, parent_tool_use_id: &str) {
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let turn_id = params.pointer("/turn/id").and_then(Value::as_str);
        let status = params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        self.emit_child_agent_status(parent_tool_use_id, thread_id, status);
        let (parent_done, result) = {
            let mut state = self
                .thread_state
                .lock()
                .expect("codex local chat thread state lock poisoned");
            (
                state.record_child_thread_status(parent_tool_use_id, thread_id, status),
                state.take_child_turn_result(thread_id, turn_id),
            )
        };
        if let Some(is_error) = parent_done {
            self.emit_parent_agent_completion(parent_tool_use_id, status, is_error);
        }
        if let Some(result) = result {
            self.emit_child_agent_result(parent_tool_use_id, thread_id, turn_id, status, result);
        }
    }

    fn emit_parent_agent_completion(&self, parent_tool_use_id: &str, status: &str, is_error: bool) {
        self.event_sink
            .emit(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id: parent_tool_use_id.to_string(),
                result: status.to_string(),
                is_error,
                parent_tool_use_id: None,
            }));
    }

    fn emit_child_agent_status(&self, parent_tool_use_id: &str, thread_id: &str, status: &str) {
        let mut agents_states = serde_json::Map::new();
        agents_states.insert(
            thread_id.to_string(),
            json!({
                "status": status,
                "message": Value::Null,
            }),
        );
        self.event_sink
            .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id: parent_tool_use_id.to_string(),
                tool_name: "Agent".to_string(),
                input: serde_json::to_string(&json!({
                    "collab_tool": "spawnAgent",
                    "receiver_thread_ids": [thread_id],
                    "agents_states": Value::Object(agents_states),
                }))
                .unwrap_or_default(),
                parent_tool_use_id: None,
            }));
    }

    fn emit_child_agent_result(
        &self,
        parent_tool_use_id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
        status: &str,
        result: String,
    ) {
        let tool_id = format!(
            "{parent_tool_use_id}:result:{}",
            turn_id.unwrap_or(thread_id)
        );
        self.event_sink
            .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id: tool_id.clone(),
                tool_name: "Agent Result".to_string(),
                input: serde_json::to_string(&json!({
                    "collab_tool": "agentResult",
                    "receiver_thread_ids": [thread_id],
                    "parent_tool_use_id": parent_tool_use_id,
                }))
                .unwrap_or_default(),
                parent_tool_use_id: None,
            }));
        self.event_sink
            .emit(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id,
                result,
                is_error: status != "completed",
                parent_tool_use_id: None,
            }));
    }

    pub(super) fn handle_turn_completed(&mut self, params: &Value) {
        let Some(mut active_turn) = self.active_turn.take() else {
            return;
        };
        let status = params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let duration_ms = value_to_u32(params.pointer("/turn/durationMs")).unwrap_or(0);
        let error = if status == "completed" {
            None
        } else {
            Some(codex_error_message(params).unwrap_or_else(|| status.to_string()))
        };

        if let Some(error) = &error {
            log::error!(
                "[Codex local chat] turn completed with error for {}: status={}, error={}, params={}",
                self.backend_session_id,
                status,
                error,
                params
            );
            self.emit_error(error.clone());
        }

        self.event_sink
            .emit(LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                duration_ms,
                cost_usd: 0.0,
                num_turns: active_turn.num_turns,
                result: active_turn.text.clone(),
                is_error: error.is_some(),
                context_tokens: active_turn.context_tokens,
                context_window: active_turn.context_window,
            }));

        let outcome = TurnOutcome {
            context_tokens: active_turn.context_tokens,
            context_window: active_turn.context_window,
            error,
        };
        if let Some(completion_tx) = active_turn.completion_tx.take() {
            let _ = completion_tx.send(outcome);
        }
    }

    pub(super) fn handle_error(&mut self, params: &Value) {
        let error = codex_error_message(params)
            .unwrap_or_else(|| format!("Codex app-server error: {params}"));
        log::error!(
            "[Codex local chat] app-server error notification for {}: {}",
            self.backend_session_id,
            params
        );
        self.emit_error(error.clone());
        self.finish_active_turn_with_error(error);
    }

    fn emit_error(&self, error: String) {
        self.event_sink
            .emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                error,
            }));
    }

    pub(super) fn emit_approval_warning(&self, method: &str) {
        let Some(request_kind) = approval_request_kind(method) else {
            return;
        };
        self.event_sink
            .emit(LocalChatEvent::Warning(LocalChatSessionWarningEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                warning: format!(
                    "Codex requested {request_kind} approval, but Vertebrae local chat does not have a Codex approval UI yet, so the request was denied."
                ),
            }));
    }

    pub(super) fn fail_active_turn(&mut self, error: String) {
        self.emit_error(error.clone());
        self.finish_active_turn_with_error(error);
    }

    fn finish_active_turn_with_error(&mut self, error: String) {
        let Some(mut active_turn) = self.active_turn.take() else {
            return;
        };
        let outcome = TurnOutcome {
            context_tokens: active_turn.context_tokens,
            context_window: active_turn.context_window,
            error: Some(error),
        };
        if let Some(completion_tx) = active_turn.completion_tx.take() {
            let _ = completion_tx.send(outcome);
        }
    }
}

pub(super) struct TurnOutcome {
    pub(super) context_tokens: u32,
    pub(super) context_window: u32,
    pub(super) error: Option<String>,
}

pub(super) struct ActiveTurnState {
    num_turns: u32,
    text: String,
    context_tokens: u32,
    context_window: u32,
    expected_turn_id: Option<String>,
    completion_tx: Option<oneshot::Sender<TurnOutcome>>,
}
