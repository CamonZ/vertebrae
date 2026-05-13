//! WebSocket connection to Sacrum's Phoenix channels
//!
//! Handles connection to ws://host:port/socket/websocket with Phoenix channel protocol
//! and subscribes to real-time task/workflow change events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Runtime};
use tokio::sync::Mutex;
use tungstenite::Message;
use url::Url;
use uuid::Uuid;

use crate::events::{
    LiveChatEventCreatedEvent, LiveChatMessageCreatedEvent, LiveChatSessionChangeType,
    LiveChatSessionChangedEvent, SectionChangeType, SectionChangedEvent, SessionLogCreatedEvent,
    StepChangeType, StepChangedEvent, StepExecutionChangeType, StepExecutionChangedEvent,
    StepExecutionStatus, StepTransitionChangeType, StepTransitionChangedEvent, TaskChangeType,
    TaskChangedEvent, TaskRunChangeType, TaskRunChangedEvent, TaskRunStepChangedEvent,
    TaskStepChangedEvent, WorkflowChangeType, WorkflowChangedEvent, WorkflowTransitionChangeType,
    WorkflowTransitionChangedEvent,
};
use crate::types;

/// Attempt to deserialize a WebSocket payload into a GUI type.
/// Returns `None` and logs a warning if deserialization fails.
fn try_deserialize<T: serde::de::DeserializeOwned>(
    payload: &serde_json::Value,
    type_name: &str,
) -> Option<T> {
    match serde_json::from_value::<T>(payload.clone()) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!(
                "[WebSocket] Failed to deserialize {} from payload: {}",
                type_name,
                e
            );
            None
        }
    }
}

/// Default heartbeat interval (30 seconds as per Phoenix protocol)
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Maximum reconnection delay (30 seconds)
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// WebSocket connection state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

/// Wraps a Phoenix WebSocket connection for Sacrum event subscriptions
pub struct SacrumSocket {
    /// Current connection state
    state: Arc<Mutex<ConnectionState>>,
    /// Whether reconnection is allowed (for clean shutdown)
    allow_reconnect: Arc<AtomicBool>,
    /// Sacrum configuration
    base_url: String,
    api_token: String,
    project_slug: String,
}

impl SacrumSocket {
    /// Append a line to the WebSocket event trace log for debugging acceptance tests.
    /// Errors are silently ignored to avoid disrupting event processing.
    fn trace_event(entry: &str) {
        use std::io::Write;
        let _ = std::fs::create_dir_all("/app/test-output");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/app/test-output/websocket-events.log")
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let _ = writeln!(f, "[{ts}] {entry}");
        }
    }

    /// Create a new Sacrum socket connection handler
    pub fn new(base_url: String, api_token: String, project_slug: String) -> Self {
        SacrumSocket {
            state: Arc::new(Mutex::new(ConnectionState::Disconnected)),
            allow_reconnect: Arc::new(AtomicBool::new(true)),
            base_url,
            api_token,
            project_slug,
        }
    }

    /// Create a disconnected socket placeholder (for when no project is selected)
    pub fn disconnected() -> Self {
        SacrumSocket {
            state: Arc::new(Mutex::new(ConnectionState::Disconnected)),
            allow_reconnect: Arc::new(AtomicBool::new(false)),
            base_url: String::new(),
            api_token: String::new(),
            project_slug: String::new(),
        }
    }

    /// Start the WebSocket connection in the background
    ///
    /// This spawns a tokio task that handles connection, event subscription,
    /// and automatic reconnection with exponential backoff.
    pub fn connect(&self, app_handle: &tauri::AppHandle) {
        let base_url = self.base_url.clone();
        let api_token = self.api_token.clone();
        let project_slug = self.project_slug.clone();
        let state = Arc::clone(&self.state);
        let allow_reconnect = Arc::clone(&self.allow_reconnect);
        let app_handle = app_handle.clone();

        tauri::async_runtime::spawn(async move {
            let mut reconnect_delay = Duration::from_millis(100);

            loop {
                if !allow_reconnect.load(Ordering::Relaxed) {
                    log::info!("[WebSocket] Reconnection disabled, shutting down");
                    break;
                }

                match Self::connect_with_retry(
                    &base_url,
                    &api_token,
                    &project_slug,
                    &app_handle,
                    state.clone(),
                    allow_reconnect.clone(),
                )
                .await
                {
                    Ok(_) => {
                        // Connection succeeded, reset delay
                        reconnect_delay = Duration::from_millis(100);
                    }
                    Err(e) => {
                        log::warn!(
                            "[WebSocket] Connection failed: {}, retrying in {:?}",
                            e,
                            reconnect_delay
                        );

                        // Emit reconnecting event
                        let _ = app_handle.emit("websocket-state-changed", "reconnecting");

                        tokio::time::sleep(reconnect_delay).await;

                        // Exponential backoff: double the delay, capped at MAX_RECONNECT_DELAY
                        reconnect_delay =
                            Duration::from_millis((reconnect_delay.as_millis() * 2) as u64)
                                .min(MAX_RECONNECT_DELAY);
                    }
                }
            }
        });
    }

    /// Stop the WebSocket connection (prevents reconnection)
    pub fn disconnect(&self) {
        self.allow_reconnect.store(false, Ordering::Relaxed);
    }

    /// Connect to Sacrum and handle Phoenix channel protocol
    async fn connect_with_retry(
        base_url: &str,
        api_token: &str,
        project_slug: &str,
        app_handle: &tauri::AppHandle,
        state: Arc<Mutex<ConnectionState>>,
        allow_reconnect: Arc<AtomicBool>,
    ) -> Result<(), String> {
        // Update state to connecting
        {
            let mut s = state.lock().await;
            *s = ConnectionState::Connecting;
        }
        let _ = app_handle.emit("websocket-state-changed", "connecting");

        // Build WebSocket URL
        let ws_url = format!(
            "{}{}?token={}&vsn=2.0.0",
            base_url
                .replace("https://", "wss://")
                .replace("http://", "ws://"),
            "/socket/websocket",
            api_token
        );

        log::info!("[WebSocket] Connecting to {}", ws_url);

        // Connect to WebSocket
        let _url = Url::parse(&ws_url).map_err(|e| format!("Invalid URL: {}", e))?;
        let (socket, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

        log::info!(
            "[WebSocket] Connected, attempting to join project:{} channel",
            project_slug
        );

        // Update state to connected
        {
            let mut s = state.lock().await;
            *s = ConnectionState::Connected;
        }
        let _ = app_handle.emit("websocket-state-changed", "connected");

        // Split into sender and receiver
        use futures::sink::SinkExt;
        use futures::stream::StreamExt;

        let (mut write, mut read) = socket.split();

        // Send join message with Phoenix protocol
        // Format: [join_ref, ref, topic, event, payload]
        let join_ref = Uuid::new_v4().to_string();
        let ref_id = "1";
        let topic = format!("project:{}", project_slug);
        let join_payload = serde_json::json!({
            "token": api_token
        });

        let join_msg = serde_json::json!([join_ref, ref_id, topic, "phx_join", join_payload]);
        let join_msg_str = join_msg.to_string();

        log::info!("[WebSocket] Sending join for topic '{}'", topic);
        write
            .send(Message::Text(join_msg_str))
            .await
            .map_err(|e| format!("Failed to send join message: {}", e))?;

        // Start heartbeat task
        let write_clone = Arc::new(Mutex::new(write));
        let write_clone_heartbeat = Arc::clone(&write_clone);
        let app_handle_clone = app_handle.clone();

        let heartbeat_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);

            loop {
                interval.tick().await;

                let heartbeat_msg =
                    serde_json::json!([null, "phx_heartbeat", "phoenix", "heartbeat", {}]);
                let heartbeat_str = heartbeat_msg.to_string();

                match write_clone_heartbeat
                    .lock()
                    .await
                    .send(Message::Text(heartbeat_str))
                    .await
                {
                    Ok(_) => {
                        log::debug!("[WebSocket] Sent heartbeat");
                    }
                    Err(e) => {
                        log::warn!("[WebSocket] Heartbeat failed: {}", e);
                        let _ = app_handle_clone.emit("websocket-state-changed", "disconnected");
                        break;
                    }
                }
            }
        });

        // Read messages from server
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    log::info!("[WebSocket] Received message ({} bytes)", text.len());
                    log::debug!("[WebSocket] Raw message: {}", text);

                    if let Err(e) = Self::handle_phoenix_message(&text, app_handle, project_slug) {
                        log::warn!("[WebSocket] Failed to handle message: {}", e);
                    }
                }
                Ok(Message::Close(_)) => {
                    log::info!("[WebSocket] Server closed connection");
                    let _ = app_handle.emit("websocket-state-changed", "disconnected");
                    heartbeat_task.abort();
                    break;
                }
                Ok(_) => {
                    // Ignore other message types
                }
                Err(e) => {
                    log::error!("[WebSocket] Read error: {}", e);
                    let _ = app_handle.emit("websocket-state-changed", "disconnected");
                    heartbeat_task.abort();
                    return Err(format!("WebSocket error: {}", e));
                }
            }
        }

        if !allow_reconnect.load(Ordering::Relaxed) {
            {
                let mut s = state.lock().await;
                *s = ConnectionState::Disconnected;
            }
            return Err("Reconnection disabled".to_string());
        }

        {
            let mut s = state.lock().await;
            *s = ConnectionState::Reconnecting;
        }

        Err("Connection closed".to_string())
    }

    /// Handle incoming Phoenix channel messages
    fn handle_phoenix_message<R: Runtime>(
        text: &str,
        app_handle: &tauri::AppHandle<R>,
        _project_slug: &str,
    ) -> Result<(), String> {
        // Parse as JSON array: [join_ref, ref, topic, event, payload]
        let msg: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("Failed to parse message: {}", e))?;

        // Phoenix messages are arrays
        if let Some(arr) = msg.as_array() {
            if arr.len() < 4 {
                return Err("Message too short".to_string());
            }

            let topic = arr.get(2).and_then(|v| v.as_str()).unwrap_or("?");
            let event = arr
                .get(3)
                .and_then(|v| v.as_str())
                .ok_or("Missing event field")?;
            let payload = arr.get(4).ok_or("Missing payload")?;

            log::info!(
                "[WebSocket] Dispatching event '{}' on topic '{}'",
                event,
                topic
            );
            Self::trace_event(&format!("RECV event='{}' topic='{}'", event, topic));

            match event {
                "task_created" | "task_updated" | "task_deleted" => {
                    Self::handle_task_event(event, payload, app_handle)?;
                }
                "workflow_created" | "workflow_updated" | "workflow_deleted"
                | "workflow_changed" => {
                    Self::handle_workflow_event(event, payload, app_handle)?;
                }
                "step_created" | "step_updated" | "step_deleted" => {
                    Self::handle_step_event(event, payload, app_handle)?;
                }
                "step_transition_created" | "step_transition_deleted" => {
                    Self::handle_step_transition_event(event, payload, app_handle)?;
                }
                "workflow_transition_created" | "workflow_transition_deleted" => {
                    Self::handle_workflow_transition_event(event, payload, app_handle)?;
                }
                "step_execution_created" | "step_execution_status_changed" => {
                    Self::handle_step_execution_event(event, payload, app_handle)?;
                }
                "task_run_created" | "task_run_updated" => {
                    Self::handle_task_run_event(event, payload, app_handle)?;
                }
                "task_run_step_changed" => {
                    Self::handle_task_run_step_changed(payload, app_handle)?;
                }
                "task_step_changed" => {
                    Self::handle_task_step_changed(payload, app_handle)?;
                }
                "session_log_created" => {
                    Self::handle_session_log_event(payload, app_handle)?;
                }
                "section_created" | "section_updated" | "section_deleted" => {
                    Self::handle_section_event(event, payload, app_handle)?;
                }
                "chat_session_created" | "chat_session_updated" => {
                    Self::handle_chat_session_event(event, payload, app_handle)?;
                }
                "chat_message_created" => {
                    Self::handle_chat_message_event(payload, app_handle)?;
                }
                "chat_event_created" => {
                    Self::handle_chat_event_event(payload, app_handle)?;
                }
                "phx_reply" | "phx_error" => {
                    log::info!(
                        "[WebSocket] Phoenix reply/error on topic '{}': payload={}",
                        topic,
                        payload
                    );
                }
                "phx_close" => {
                    log::info!("[WebSocket] Phoenix close message");
                }
                _ => {
                    log::debug!("[WebSocket] Unhandled event: {}", event);
                }
            }
        }

        Ok(())
    }

    /// Handle task events and emit to Tauri
    fn handle_task_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        // Extract task_id from payload
        let task_id = payload
            .get("id")
            .or_else(|| payload.get("task_id"))
            .and_then(|v| v.as_str())
            .ok_or("Missing task_id in payload")?
            .to_string();

        let change_type = match event {
            "task_created" => TaskChangeType::Created,
            "task_updated" => TaskChangeType::Updated,
            "task_deleted" => TaskChangeType::Deleted,
            _ => TaskChangeType::StatusChanged,
        };

        Self::trace_event(&format!(
            "TASK event='{}' task_id='{}' payload_keys={:?}",
            event,
            task_id,
            payload
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        ));

        let task = if !matches!(change_type, TaskChangeType::Deleted) {
            let result = serde_json::from_value::<types::Task>(payload.clone());
            match result {
                Ok(t) => {
                    Self::trace_event(&format!(
                        "TASK deserialized ok task_id='{}' title='{}'",
                        task_id, t.title
                    ));
                    Some(t)
                }
                Err(e) => {
                    Self::trace_event(&format!(
                        "TASK deser FAILED task_id='{}' error='{}'",
                        task_id, e
                    ));
                    log::warn!("[WebSocket] Failed to deserialize Task from payload: {}", e);
                    None
                }
            }
        } else {
            None
        };

        let current_step_id = payload
            .get("current_step_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let workflow_id = payload
            .get("workflow_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let level = payload
            .get("level")
            .and_then(|v| serde_json::from_value::<types::TaskLevel>(v.clone()).ok());
        let archived = payload.get("archived").and_then(|v| v.as_bool());

        let event = TaskChangedEvent {
            task_id,
            change_type,
            task,
            current_step_id,
            workflow_id,
            level,
            archived,
        };

        Self::trace_event(&format!(
            "TASK emitted change_type='{:?}' task_id='{}' has_task={}",
            event.change_type,
            event.task_id,
            event.task.is_some()
        ));
        log::info!(
            "[WebSocket] Emitting task {:?} event for task_id={}",
            event.change_type,
            event.task_id
        );

        app_handle
            .emit("task-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle workflow events and emit to Tauri
    fn handle_workflow_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        // Extract workflow_id from payload
        let workflow_id = payload
            .get("id")
            .or_else(|| payload.get("workflow_id"))
            .and_then(|v| v.as_str())
            .ok_or("Missing workflow_id in payload")?
            .to_string();

        let change_type = match event {
            "workflow_created" => WorkflowChangeType::Created,
            "workflow_updated" | "workflow_changed" => WorkflowChangeType::Updated,
            "workflow_deleted" => WorkflowChangeType::Deleted,
            _ => WorkflowChangeType::Updated,
        };

        Self::trace_event(&format!(
            "WORKFLOW event='{}' workflow_id='{}' payload_keys={:?}",
            event,
            workflow_id,
            payload
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        ));

        let workflow = if !matches!(change_type, WorkflowChangeType::Deleted) {
            let result = serde_json::from_value::<types::Workflow>(payload.clone());
            match result {
                Ok(w) => {
                    Self::trace_event(&format!(
                        "WORKFLOW deserialized ok workflow_id='{}' name='{}'",
                        workflow_id, w.name
                    ));
                    Some(w)
                }
                Err(e) => {
                    Self::trace_event(&format!(
                        "WORKFLOW deser FAILED workflow_id='{}' error='{}'",
                        workflow_id, e
                    ));
                    log::warn!(
                        "[WebSocket] Failed to deserialize Workflow from payload: {}",
                        e
                    );
                    None
                }
            }
        } else {
            None
        };

        let event = WorkflowChangedEvent {
            workflow_id,
            change_type,
            workflow,
        };

        Self::trace_event(&format!(
            "WORKFLOW emitted change_type='{:?}' workflow_id='{}' has_workflow={}",
            event.change_type,
            event.workflow_id,
            event.workflow.is_some()
        ));
        log::info!(
            "[WebSocket] Emitting workflow {:?} event for workflow_id={}",
            event.change_type,
            event.workflow_id
        );

        app_handle
            .emit("workflow-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle step events and emit to Tauri
    fn handle_step_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let step_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in step payload")?
            .to_string();

        let workflow_id = payload
            .get("workflow_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let change_type = match event {
            "step_created" => StepChangeType::Created,
            "step_updated" => StepChangeType::Updated,
            "step_deleted" => StepChangeType::Deleted,
            _ => StepChangeType::Updated,
        };

        Self::trace_event(&format!(
            "STEP event='{}' step_id='{}' workflow_id='{}' payload_keys={:?}",
            event,
            step_id,
            workflow_id,
            payload
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        ));

        let step = if !matches!(change_type, StepChangeType::Deleted) {
            let result = serde_json::from_value::<types::Step>(payload.clone());
            match result {
                Ok(s) => {
                    Self::trace_event(&format!(
                        "STEP deserialized ok step_id='{}' name='{}'",
                        step_id, s.name
                    ));
                    Some(s)
                }
                Err(e) => {
                    Self::trace_event(&format!(
                        "STEP deser FAILED step_id='{}' error='{}'",
                        step_id, e
                    ));
                    log::warn!("[WebSocket] Failed to deserialize Step from payload: {}", e);
                    None
                }
            }
        } else {
            None
        };

        let event = StepChangedEvent {
            step_id,
            workflow_id,
            change_type,
            step,
        };

        Self::trace_event(&format!(
            "STEP emitted change_type='{:?}' step_id='{}' has_step={}",
            event.change_type,
            event.step_id,
            event.step.is_some()
        ));
        log::info!(
            "[WebSocket] Emitting step {:?} event for step_id={}",
            event.change_type,
            event.step_id
        );

        app_handle
            .emit("step-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle step transition events and emit to Tauri
    fn handle_step_transition_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let transition_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in step transition payload")?
            .to_string();

        let from_step_id = payload
            .get("from_step_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let to_step_id = payload
            .get("to_step_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let change_type = match event {
            "step_transition_created" => StepTransitionChangeType::Created,
            "step_transition_deleted" => StepTransitionChangeType::Deleted,
            _ => StepTransitionChangeType::Created,
        };

        let event = StepTransitionChangedEvent {
            transition_id,
            from_step_id,
            to_step_id,
            change_type,
        };

        log::debug!(
            "[WebSocket] Emitting StepTransitionChangedEvent: {:?}",
            event
        );

        app_handle
            .emit("step-transition-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle workflow transition events and emit to Tauri
    fn handle_workflow_transition_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let transition_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in workflow transition payload")?
            .to_string();

        let from_workflow_id = payload
            .get("from_workflow_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let to_workflow_id = payload
            .get("to_workflow_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let target_step_id = payload
            .get("target_step_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let label = payload
            .get("label")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let change_type = match event {
            "workflow_transition_created" => WorkflowTransitionChangeType::Created,
            "workflow_transition_deleted" => WorkflowTransitionChangeType::Deleted,
            _ => WorkflowTransitionChangeType::Created,
        };

        let event = WorkflowTransitionChangedEvent {
            transition_id,
            from_workflow_id,
            to_workflow_id,
            target_step_id,
            label,
            change_type,
        };

        log::debug!(
            "[WebSocket] Emitting WorkflowTransitionChangedEvent: {:?}",
            event
        );

        app_handle
            .emit("workflow-transition-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle step execution events and emit to Tauri
    fn handle_step_execution_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let execution_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in step execution payload")?
            .to_string();

        let task_id = payload
            .get("task_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let workflow_id = payload
            .get("workflow_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let step_name = payload
            .get("step_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let status = match payload.get("status").and_then(|v| v.as_str()) {
            Some("running") | Some("started") => StepExecutionStatus::Running,
            Some("completed") => StepExecutionStatus::Completed,
            Some("failed") => StepExecutionStatus::Failed,
            _ => StepExecutionStatus::Pending,
        };

        let change_type = match event {
            "step_execution_created" => StepExecutionChangeType::Created,
            "step_execution_status_changed" => StepExecutionChangeType::StatusChanged,
            _ => StepExecutionChangeType::Created,
        };

        let execution = try_deserialize::<types::StepExecution>(payload, "StepExecution");

        let event = StepExecutionChangedEvent {
            execution_id,
            task_id,
            workflow_id,
            step_name,
            status,
            change_type,
            execution,
        };

        log::debug!(
            "[WebSocket] Emitting StepExecutionChangedEvent: {:?}",
            event
        );

        app_handle
            .emit("step-execution-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    fn task_run_changed_event_from_payload(
        event: &str,
        payload: &serde_json::Value,
    ) -> Result<TaskRunChangedEvent, String> {
        let task_run_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in task run payload")?
            .to_string();

        let task_id = payload
            .get("task_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing task_id in task run payload")?
            .to_string();

        let status = payload
            .get("status")
            .cloned()
            .ok_or_else(|| "Missing status in task run payload".to_string())
            .and_then(|value| {
                serde_json::from_value::<types::TaskRunStatus>(value)
                    .map_err(|e| format!("Failed to parse task run status: {}", e))
            })?;

        let change_type = match event {
            "task_run_created" => TaskRunChangeType::Created,
            "task_run_updated" => TaskRunChangeType::Updated,
            _ => TaskRunChangeType::Updated,
        };

        let task_run = try_deserialize::<types::TaskRun>(payload, "TaskRun");
        let run_controls_value = payload
            .get("run_controls")
            .ok_or("Missing run_controls in task run payload")?;
        let run_controls = if run_controls_value.is_null() {
            None
        } else {
            try_deserialize::<types::TaskRunControls>(run_controls_value, "TaskRunControls")
        };

        Ok(TaskRunChangedEvent {
            task_run_id,
            task_id,
            status,
            change_type,
            task_run,
            run_controls,
        })
    }

    /// Handle TaskRun events and emit to Tauri
    fn handle_task_run_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let event_payload = Self::task_run_changed_event_from_payload(event, payload)?;

        log::debug!(
            "[WebSocket] Emitting TaskRunChangedEvent: {:?}",
            event_payload
        );

        app_handle
            .emit("task-run-changed-event", &event_payload)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle `task_run_step_changed` events from Sacrum and emit a typed
    /// `TaskRunStepChangedEvent` to the frontend.
    ///
    /// Payload contract (`/sacrum/docs/client-taskrun-contract.md`):
    /// ```text
    /// {
    ///   task_run_id, task_id,
    ///   from_step_id: string | null,
    ///   to_step_id:   string | null,
    ///   status:       TaskRunStatus,
    ///   level:        "epic" | "ticket" | "task"
    /// }
    /// ```
    fn handle_task_run_step_changed<R: Runtime>(
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let task_run_id = payload
            .get("task_run_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing task_run_id in task_run_step_changed payload")?
            .to_string();

        let task_id = payload
            .get("task_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing task_id in task_run_step_changed payload")?
            .to_string();

        let from_step_id = payload
            .get("from_step_id")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let to_step_id = payload
            .get("to_step_id")
            .and_then(|v| v.as_str())
            .map(str::to_string);

        let status_value = payload
            .get("status")
            .cloned()
            .ok_or("Missing status in task_run_step_changed payload")?;
        let status: types::TaskRunStatus = serde_json::from_value(status_value)
            .map_err(|e| format!("Failed to parse task run status: {}", e))?;

        let level_value = payload
            .get("level")
            .cloned()
            .ok_or("Missing level in task_run_step_changed payload")?;
        let level: types::TaskLevel = serde_json::from_value(level_value)
            .map_err(|e| format!("Failed to parse level: {}", e))?;

        let event = TaskRunStepChangedEvent {
            task_run_id,
            task_id,
            from_step_id,
            to_step_id,
            status,
            level,
        };

        log::debug!("[WebSocket] Emitting TaskRunStepChangedEvent: {:?}", event);

        app_handle
            .emit("task-run-step-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle `task_step_changed` events from Sacrum and emit a typed
    /// `TaskStepChangedEvent` to the frontend.
    ///
    /// Payload contract (`/sacrum/docs/client-taskrun-contract.md`):
    /// ```text
    /// {
    ///   task_id,
    ///   from_step_id: string | null,
    ///   to_step_id:   string | null,
    ///   workflow_id:  string,
    ///   level:        "epic" | "ticket" | "task"
    /// }
    /// ```
    ///
    /// Disjoint with `task_run_step_changed` — only fires for manual moves
    /// when no orchestrator run exists.
    fn handle_task_step_changed<R: Runtime>(
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let task_id = payload
            .get("task_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing task_id in task_step_changed payload")?
            .to_string();

        let from_step_id = payload
            .get("from_step_id")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let to_step_id = payload
            .get("to_step_id")
            .and_then(|v| v.as_str())
            .map(str::to_string);

        let workflow_id = payload
            .get("workflow_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing workflow_id in task_step_changed payload")?
            .to_string();

        let level_value = payload
            .get("level")
            .cloned()
            .ok_or("Missing level in task_step_changed payload")?;
        let level: types::TaskLevel = serde_json::from_value(level_value)
            .map_err(|e| format!("Failed to parse level: {}", e))?;

        let event = TaskStepChangedEvent {
            task_id,
            from_step_id,
            to_step_id,
            workflow_id,
            level,
        };

        log::debug!("[WebSocket] Emitting TaskStepChangedEvent: {:?}", event);

        app_handle
            .emit("task-step-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle session log events and emit to Tauri
    fn handle_session_log_event<R: Runtime>(
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let log_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in session log payload")?
            .to_string();

        let step_execution_id = payload
            .get("step_execution_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let session_log = try_deserialize::<types::SessionLog>(payload, "SessionLog");

        let event = SessionLogCreatedEvent {
            log_id,
            step_execution_id,
            session_log,
        };

        log::debug!("[WebSocket] Emitting SessionLogCreatedEvent: {:?}", event);

        app_handle
            .emit("session-log-created-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle section events and emit to Tauri
    fn handle_section_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let section_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in section payload")?
            .to_string();

        let task_id = payload
            .get("task_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let change_type = match event {
            "section_created" => SectionChangeType::Created,
            "section_updated" => SectionChangeType::Updated,
            "section_deleted" => SectionChangeType::Deleted,
            _ => SectionChangeType::Updated,
        };

        let section = if !matches!(change_type, SectionChangeType::Deleted) {
            try_deserialize::<types::Section>(payload, "Section")
        } else {
            None
        };

        let event = SectionChangedEvent {
            section_id,
            task_id,
            change_type,
            section,
        };

        log::debug!("[WebSocket] Emitting SectionChangedEvent: {:?}", event);

        app_handle
            .emit("section-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Payload shape: `Sacrum.Chat.PublicEvents.session_payload/1`.
    fn handle_chat_session_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let session_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in chat session payload")?
            .to_string();

        let change_type = match event {
            "chat_session_created" => LiveChatSessionChangeType::Created,
            "chat_session_updated" => LiveChatSessionChangeType::Updated,
            other => unreachable!("handle_chat_session_event called with {other:?}"),
        };

        let session = try_deserialize::<types::ChatSession>(payload, "ChatSession");

        let event = LiveChatSessionChangedEvent {
            session_id,
            change_type,
            session,
        };

        log::debug!(
            "[WebSocket] Emitting LiveChatSessionChangedEvent: {:?}",
            event
        );

        app_handle
            .emit("live-chat-session-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Payload shape: `Sacrum.Chat.PublicEvents.message_payload/1`.
    fn handle_chat_message_event<R: Runtime>(
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let message_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Missing id in chat message payload")?
            .to_string();

        let chat_session_id = payload
            .get("chat_session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing chat_session_id in chat message payload")?
            .to_string();

        let client_message_id = payload
            .get("client_message_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let message = try_deserialize::<types::ChatMessage>(payload, "ChatMessage");

        let event = LiveChatMessageCreatedEvent {
            message_id,
            chat_session_id,
            client_message_id,
            message,
        };

        log::debug!(
            "[WebSocket] Emitting LiveChatMessageCreatedEvent: {:?}",
            event
        );

        app_handle
            .emit("live-chat-message-created-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Payload shape: `Sacrum.Chat.PublicEvents.generic_channel_payload/2`.
    fn handle_chat_event_event<R: Runtime>(
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let event_id = payload
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let chat_session_id = payload
            .get("chat_session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let event_type = payload
            .get("event_type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let inner_payload = payload
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        let event = LiveChatEventCreatedEvent {
            event_id,
            chat_session_id,
            event_type,
            payload: inner_payload,
        };

        log::debug!(
            "[WebSocket] Emitting LiveChatEventCreatedEvent: {:?}",
            event
        );

        app_handle
            .emit("live-chat-event-created-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Get current connection state
    pub async fn get_state(&self) -> ConnectionState {
        *self.state.lock().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration as StdDuration;
    use tauri::Listener;

    // ===== SacrumSocket Creation and Initialization Tests =====

    #[test]
    fn test_sacrum_socket_creation() {
        let socket = SacrumSocket::new(
            "http://localhost:4000".to_string(),
            "sac_test_token".to_string(),
            "my-project".to_string(),
        );

        assert_eq!(socket.base_url, "http://localhost:4000");
        assert_eq!(socket.api_token, "sac_test_token");
        assert_eq!(socket.project_slug, "my-project");
    }

    #[test]
    fn test_sacrum_socket_creation_with_https() {
        let socket = SacrumSocket::new(
            "https://secure.example.com:4000".to_string(),
            "sac_secure_token_xyz".to_string(),
            "secure-project".to_string(),
        );

        assert_eq!(socket.base_url, "https://secure.example.com:4000");
        assert_eq!(socket.api_token, "sac_secure_token_xyz");
        assert_eq!(socket.project_slug, "secure-project");
    }

    #[test]
    fn test_sacrum_socket_creation_various_urls() {
        let socket_1 = SacrumSocket::new(
            "http://127.0.0.1:8000".to_string(),
            "token_001".to_string(),
            "proj1".to_string(),
        );
        assert_eq!(socket_1.base_url, "http://127.0.0.1:8000");

        let socket_2 = SacrumSocket::new(
            "https://api.example.com".to_string(),
            "token_002".to_string(),
            "proj2".to_string(),
        );
        assert_eq!(socket_2.base_url, "https://api.example.com");
    }

    // ===== Connection State Tests =====

    #[tokio::test]
    async fn test_connection_state_initial() {
        let socket = SacrumSocket::new(
            "http://localhost:4000".to_string(),
            "sac_test".to_string(),
            "test".to_string(),
        );

        assert_eq!(socket.get_state().await, ConnectionState::Disconnected);
    }

    #[tokio::test]
    async fn test_connection_state_transitions() {
        let socket = SacrumSocket::new(
            "http://localhost:4000".to_string(),
            "sac_test".to_string(),
            "test".to_string(),
        );

        // Initial state
        let state = socket.get_state().await;
        assert_eq!(state, ConnectionState::Disconnected);

        // Simulate state changes via direct access to state mutex (for unit test)
        {
            let mut s = socket.state.lock().await;
            *s = ConnectionState::Connecting;
        }
        assert_eq!(socket.get_state().await, ConnectionState::Connecting);

        {
            let mut s = socket.state.lock().await;
            *s = ConnectionState::Connected;
        }
        assert_eq!(socket.get_state().await, ConnectionState::Connected);

        {
            let mut s = socket.state.lock().await;
            *s = ConnectionState::Reconnecting;
        }
        assert_eq!(socket.get_state().await, ConnectionState::Reconnecting);

        {
            let mut s = socket.state.lock().await;
            *s = ConnectionState::Disconnected;
        }
        assert_eq!(socket.get_state().await, ConnectionState::Disconnected);
    }

    #[test]
    fn test_connection_state_equality() {
        assert_eq!(ConnectionState::Disconnected, ConnectionState::Disconnected);
        assert_eq!(ConnectionState::Connecting, ConnectionState::Connecting);
        assert_eq!(ConnectionState::Connected, ConnectionState::Connected);
        assert_eq!(ConnectionState::Reconnecting, ConnectionState::Reconnecting);

        assert_ne!(ConnectionState::Connected, ConnectionState::Disconnected);
        assert_ne!(ConnectionState::Connecting, ConnectionState::Connected);
    }

    #[test]
    fn test_connection_state_debug_format() {
        assert_eq!(
            format!("{:?}", ConnectionState::Disconnected),
            "Disconnected"
        );
        assert_eq!(format!("{:?}", ConnectionState::Connecting), "Connecting");
        assert_eq!(format!("{:?}", ConnectionState::Connected), "Connected");
        assert_eq!(
            format!("{:?}", ConnectionState::Reconnecting),
            "Reconnecting"
        );
    }

    // ===== WS Payload Deserialization Tests =====

    /// A sacrum step_execution_status_changed payload should hydrate the full
    /// StepExecution including prompt, output, context, transition_result,
    /// model, model_provider, tokens, cost, duration_ms, handoff, and
    /// session_id without dropping any fields on the way to the frontend.
    #[test]
    fn step_execution_ws_payload_preserves_full_field_set() {
        let payload = serde_json::json!({
            "id": "exec-ws-1",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "review",
            "started_at": "2024-01-01T00:00:00Z",
            "completed_at": "2024-01-01T00:00:09Z",
            "status": "completed",
            "prompt": "ws prompt",
            "output": "ws output",
            "context": "{\"src\":\"ws\"}",
            "transition_result": "approved",
            "model": "claude-opus",
            "model_provider": "anthropic",
            "input_tokens": 200u32,
            "output_tokens": 80u32,
            "cost": "0.0042",
            "duration_ms": 9001u32,
            "handoff": "{\"to\":\"next-step\"}",
            "session_id": "ws-session-1",
        });

        let exec = try_deserialize::<types::StepExecution>(&payload, "StepExecution")
            .expect("WS payload must deserialize into StepExecution");

        assert_eq!(exec.id.as_deref(), Some("exec-ws-1"));
        assert_eq!(exec.prompt.as_deref(), Some("ws prompt"));
        assert_eq!(exec.output.as_deref(), Some("ws output"));
        assert_eq!(exec.context.as_deref(), Some("{\"src\":\"ws\"}"));
        assert_eq!(exec.transition_result.as_deref(), Some("approved"));
        assert_eq!(exec.model.as_deref(), Some("claude-opus"));
        assert_eq!(exec.model_provider.as_deref(), Some("anthropic"));
        assert_eq!(exec.input_tokens, Some(200));
        assert_eq!(exec.output_tokens, Some(80));
        assert_eq!(exec.cost.as_deref(), Some("0.0042"));
        assert_eq!(exec.duration_ms, Some(9001));
        assert_eq!(exec.handoff.as_deref(), Some("{\"to\":\"next-step\"}"));
        assert_eq!(exec.session_id.as_deref(), Some("ws-session-1"));
    }

    /// Minimal payload (only the historical timeline fields) must still
    /// deserialize successfully — the new fields are all optional.
    #[test]
    fn step_execution_ws_payload_minimal_still_deserializes() {
        let payload = serde_json::json!({
            "id": "exec-min",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "todo",
            "started_at": "2024-01-01T00:00:00Z",
            "status": "in_progress",
        });

        let exec = try_deserialize::<types::StepExecution>(&payload, "StepExecution")
            .expect("minimal WS payload must deserialize");
        assert_eq!(exec.id.as_deref(), Some("exec-min"));
        assert!(exec.prompt.is_none());
        assert!(exec.handoff.is_none());
        assert!(exec.session_id.is_none());
    }

    #[test]
    fn task_run_ws_payload_preserves_run_controls() {
        let payload = serde_json::json!({
            "id": "run-ws-1",
            "task_id": "task-1",
            "project_id": "project-1",
            "status": "executing",
            "started_at": "2026-05-09T10:00:00Z",
            "ended_at": null,
            "stop_requested_at": null,
            "latest_step_execution_id": "exec-1",
            "outcome_kind": null,
            "outcome_context": null,
            "parent_task_run_id": null,
            "root_task_run_id": null,
            "triggered_by_step_execution_id": null,
            "inserted_at": "2026-05-09T10:00:00Z",
            "updated_at": "2026-05-09T10:01:00Z",
            "run_controls": {
                "runnable": false,
                "stoppable": true,
                "disabled_reason_code": "active_run",
                "disabled_reason": "A TaskRun is already active",
                "active_run": {
                    "id": "run-ws-1",
                    "task_id": "task-1",
                    "project_id": "project-1",
                    "status": "executing",
                    "started_at": "2026-05-09T10:00:00Z",
                    "ended_at": null,
                    "stop_requested_at": null,
                    "latest_step_execution_id": "exec-1",
                    "outcome_kind": null,
                    "outcome_context": null,
                    "parent_task_run_id": null,
                    "root_task_run_id": null,
                    "triggered_by_step_execution_id": null,
                    "inserted_at": "2026-05-09T10:00:00Z",
                    "updated_at": "2026-05-09T10:01:00Z"
                }
            }
        });

        let event = SacrumSocket::task_run_changed_event_from_payload("task_run_updated", &payload)
            .expect("task_run_updated payload should build a Tauri event");

        assert_eq!(event.task_run_id, "run-ws-1");
        assert_eq!(event.task_id, "task-1");
        assert!(matches!(event.change_type, TaskRunChangeType::Updated));
        assert_eq!(event.status, types::TaskRunStatus::Executing);

        let task_run = event.task_run.expect("full TaskRun should hydrate");
        assert_eq!(task_run.id, "run-ws-1");
        assert_eq!(task_run.latest_step_execution_id.as_deref(), Some("exec-1"));
        assert_eq!(task_run.status, types::TaskRunStatus::Executing);

        let controls = event
            .run_controls
            .expect("run_controls should be copied from the channel payload");
        assert!(!controls.runnable);
        assert!(controls.stoppable);
        assert_eq!(controls.disabled_reason_code.as_deref(), Some("active_run"));
        assert_eq!(
            controls.disabled_reason.as_deref(),
            Some("A TaskRun is already active")
        );
        assert_eq!(
            controls.active_run.as_ref().map(|run| run.id.as_str()),
            Some("run-ws-1")
        );
    }

    #[test]
    fn task_run_ws_payload_allows_null_run_controls() {
        let payload = serde_json::json!({
            "id": "run-ws-null-controls",
            "task_id": "task-1",
            "project_id": "project-1",
            "status": "completed",
            "run_controls": null
        });

        let event = SacrumSocket::task_run_changed_event_from_payload("task_run_created", &payload)
            .expect("task_run_created payload should build a Tauri event");

        assert_eq!(event.task_run_id, "run-ws-null-controls");
        assert_eq!(event.status, types::TaskRunStatus::Completed);
        assert!(matches!(event.change_type, TaskRunChangeType::Created));
        assert!(event.task_run.is_some());
        assert!(event.run_controls.is_none());
    }

    #[test]
    fn task_run_ws_payload_requires_run_controls_field() {
        let payload = serde_json::json!({
            "id": "run-ws-missing-controls",
            "task_id": "task-1",
            "project_id": "project-1",
            "status": "executing"
        });

        let err = SacrumSocket::task_run_changed_event_from_payload("task_run_updated", &payload)
            .expect_err("task_run_updated payload should include run_controls");

        assert_eq!(err, "Missing run_controls in task run payload");
    }

    // ===== Disconnect Flag Tests =====

    #[test]
    fn test_disconnect_flag() {
        let socket = SacrumSocket::new(
            "http://localhost:4000".to_string(),
            "sac_test".to_string(),
            "test".to_string(),
        );

        assert!(socket.allow_reconnect.load(Ordering::Relaxed));
        socket.disconnect();
        assert!(!socket.allow_reconnect.load(Ordering::Relaxed));
    }

    #[test]
    fn test_disconnect_flag_persists() {
        let socket = SacrumSocket::new(
            "http://localhost:4000".to_string(),
            "sac_test".to_string(),
            "test".to_string(),
        );

        // Check initial state multiple times
        assert!(socket.allow_reconnect.load(Ordering::Relaxed));
        assert!(socket.allow_reconnect.load(Ordering::Relaxed));

        // Disconnect
        socket.disconnect();

        // Verify disconnected state persists
        assert!(!socket.allow_reconnect.load(Ordering::Relaxed));
        assert!(!socket.allow_reconnect.load(Ordering::Relaxed));
    }

    #[test]
    fn test_disconnect_flag_cannot_be_reset() {
        let socket = SacrumSocket::new(
            "http://localhost:4000".to_string(),
            "sac_test".to_string(),
            "test".to_string(),
        );

        socket.disconnect();
        // Attempting to call disconnect again should not change anything
        socket.disconnect();
        assert!(!socket.allow_reconnect.load(Ordering::Relaxed));
    }

    // ===== Phoenix Message Parsing Tests =====

    #[test]
    fn test_phoenix_message_parsing_basic() {
        let msg = r#"["ref1", "1", "project:my-project", "task_created", {"id": "task123"}]"#;
        let parsed: serde_json::Value = serde_json::from_str(msg).unwrap();
        assert!(parsed.is_array());
        assert_eq!(parsed.as_array().unwrap().len(), 5);
    }

    #[test]
    fn test_phoenix_message_join_format() {
        // Test join message structure
        let join_ref = "join_ref_abc";
        let ref_id = "1";
        let topic = "project:my-project";
        let event = "phx_join";

        let join_payload = serde_json::json!({
            "token": "test_token_123"
        });

        let msg = serde_json::json!([join_ref, ref_id, topic, event, join_payload]);
        let parsed: serde_json::Value = serde_json::from_str(&msg.to_string()).unwrap();

        assert!(parsed.is_array());
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), 5);
        assert_eq!(arr[0].as_str().unwrap(), "join_ref_abc");
        assert_eq!(arr[1].as_str().unwrap(), "1");
        assert_eq!(arr[2].as_str().unwrap(), "project:my-project");
        assert_eq!(arr[3].as_str().unwrap(), "phx_join");
        assert_eq!(
            arr[4].get("token").unwrap().as_str().unwrap(),
            "test_token_123"
        );
    }

    #[test]
    fn test_phoenix_heartbeat_message_format() {
        // Test heartbeat message structure
        let heartbeat_msg = serde_json::json!([null, "phx_heartbeat", "phoenix", "heartbeat", {}]);
        let parsed: serde_json::Value = serde_json::from_str(&heartbeat_msg.to_string()).unwrap();

        assert!(parsed.is_array());
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), 5);
        assert!(arr[0].is_null());
        assert_eq!(arr[1].as_str().unwrap(), "phx_heartbeat");
        assert_eq!(arr[2].as_str().unwrap(), "phoenix");
        assert_eq!(arr[3].as_str().unwrap(), "heartbeat");
        assert!(arr[4].is_object());
    }

    // ===== Message Parsing Validation Tests =====
    // Testing the pure JSON parsing logic without needing a real AppHandle

    #[test]
    fn test_message_parsing_extract_event() {
        let msg = r#"["ref1", "1", "project:my-project", "task_created", {"id": "task123"}]"#;
        let parsed: serde_json::Value = serde_json::from_str(msg).unwrap();
        let arr = parsed.as_array().unwrap();

        // Event is at index 3
        let event = arr.get(3).and_then(|v| v.as_str()).unwrap();

        assert_eq!(event, "task_created");
    }

    #[test]
    fn test_message_parsing_extract_payload() {
        let msg = r#"["ref1", "1", "project:my-project", "task_updated", {"id": "task456", "title": "Updated"}]"#;
        let parsed: serde_json::Value = serde_json::from_str(msg).unwrap();
        let arr = parsed.as_array().unwrap();

        // Payload is at index 4
        let payload = arr.get(4).unwrap();
        assert_eq!(payload.get("id").unwrap().as_str().unwrap(), "task456");
        assert_eq!(payload.get("title").unwrap().as_str().unwrap(), "Updated");
    }

    #[test]
    fn test_message_parsing_extract_task_id_fallback() {
        // Test fallback from "id" to "task_id" field
        let payload_with_id = serde_json::json!({"id": "task_123"});
        let task_id = payload_with_id
            .get("id")
            .or_else(|| payload_with_id.get("task_id"))
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(task_id, "task_123");

        let payload_with_task_id = serde_json::json!({"task_id": "task_456"});
        let task_id = payload_with_task_id
            .get("id")
            .or_else(|| payload_with_task_id.get("task_id"))
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(task_id, "task_456");
    }

    #[test]
    fn test_message_parsing_extract_workflow_id_fallback() {
        // Test fallback from "id" to "workflow_id" field
        let payload_with_id = serde_json::json!({"id": "wf_123"});
        let workflow_id = payload_with_id
            .get("id")
            .or_else(|| payload_with_id.get("workflow_id"))
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(workflow_id, "wf_123");

        let payload_with_workflow_id = serde_json::json!({"workflow_id": "wf_456"});
        let workflow_id = payload_with_workflow_id
            .get("id")
            .or_else(|| payload_with_workflow_id.get("workflow_id"))
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(workflow_id, "wf_456");
    }

    // ===== Message Validation Tests =====

    #[test]
    fn test_message_parsing_invalid_json() {
        let msg = r#"invalid json"#;
        let result: Result<serde_json::Value, _> = serde_json::from_str(msg);
        assert!(result.is_err(), "Invalid JSON should produce error");
    }

    #[test]
    fn test_message_parsing_not_array() {
        let msg = r#"{"id": "task123"}"#;
        let parsed: serde_json::Value = serde_json::from_str(msg).unwrap();
        assert!(
            !parsed.is_array(),
            "Non-array message should not be an array"
        );
    }

    #[test]
    fn test_message_parsing_array_too_short() {
        let msg = r#"["ref1", "1"]"#;
        let parsed: serde_json::Value = serde_json::from_str(msg).unwrap();
        let arr = parsed.as_array().unwrap();
        assert!(arr.len() < 4, "Array should be shorter than 4 elements");
    }

    #[test]
    fn test_message_parsing_array_with_nulls() {
        let msg = r#"["ref1", "1", "project:my-project", null, {"id": "task123"}]"#;
        let parsed: serde_json::Value = serde_json::from_str(msg).unwrap();
        let arr = parsed.as_array().unwrap();
        assert!(arr[3].is_null(), "Event field should be null");
    }

    #[test]
    fn test_message_parsing_missing_payload() {
        let msg = r#"["ref1", "1", "project:my-project", "task_created"]"#;
        let parsed: serde_json::Value = serde_json::from_str(msg).unwrap();
        let arr = parsed.as_array().unwrap();
        assert!(arr.len() < 5, "Array should not have payload at index 4");
    }

    // ===== Task Event Type Mapping Tests =====

    #[test]
    fn test_task_event_type_created() {
        let event = "task_created";
        let change_type = match event {
            "task_created" => TaskChangeType::Created,
            "task_updated" => TaskChangeType::Updated,
            "task_deleted" => TaskChangeType::Deleted,
            _ => TaskChangeType::StatusChanged,
        };
        assert_eq!(format!("{:?}", change_type), "Created");
    }

    #[test]
    fn test_task_event_type_updated() {
        let event = "task_updated";
        let change_type = match event {
            "task_created" => TaskChangeType::Created,
            "task_updated" => TaskChangeType::Updated,
            "task_deleted" => TaskChangeType::Deleted,
            _ => TaskChangeType::StatusChanged,
        };
        assert_eq!(format!("{:?}", change_type), "Updated");
    }

    #[test]
    fn test_task_event_type_deleted() {
        let event = "task_deleted";
        let change_type = match event {
            "task_created" => TaskChangeType::Created,
            "task_updated" => TaskChangeType::Updated,
            "task_deleted" => TaskChangeType::Deleted,
            _ => TaskChangeType::StatusChanged,
        };
        assert_eq!(format!("{:?}", change_type), "Deleted");
    }

    #[test]
    fn test_task_event_type_unknown_defaults_to_status_changed() {
        let event = "task_unknown";
        let change_type = match event {
            "task_created" => TaskChangeType::Created,
            "task_updated" => TaskChangeType::Updated,
            "task_deleted" => TaskChangeType::Deleted,
            _ => TaskChangeType::StatusChanged,
        };
        assert_eq!(format!("{:?}", change_type), "StatusChanged");
    }

    // ===== Workflow Event Type Mapping Tests =====

    #[test]
    fn test_workflow_event_type_created() {
        let event = "workflow_created";
        let change_type = match event {
            "workflow_created" => WorkflowChangeType::Created,
            "workflow_updated" | "workflow_changed" => WorkflowChangeType::Updated,
            "workflow_deleted" => WorkflowChangeType::Deleted,
            _ => WorkflowChangeType::Updated,
        };
        assert_eq!(format!("{:?}", change_type), "Created");
    }

    #[test]
    fn test_workflow_event_type_updated() {
        let event = "workflow_updated";
        let change_type = match event {
            "workflow_created" => WorkflowChangeType::Created,
            "workflow_updated" | "workflow_changed" => WorkflowChangeType::Updated,
            "workflow_deleted" => WorkflowChangeType::Deleted,
            _ => WorkflowChangeType::Updated,
        };
        assert_eq!(format!("{:?}", change_type), "Updated");
    }

    #[test]
    fn test_workflow_event_type_changed_maps_to_updated() {
        let event = "workflow_changed";
        let change_type = match event {
            "workflow_created" => WorkflowChangeType::Created,
            "workflow_updated" | "workflow_changed" => WorkflowChangeType::Updated,
            "workflow_deleted" => WorkflowChangeType::Deleted,
            _ => WorkflowChangeType::Updated,
        };
        assert_eq!(format!("{:?}", change_type), "Updated");
    }

    #[test]
    fn test_workflow_event_type_deleted() {
        let event = "workflow_deleted";
        let change_type = match event {
            "workflow_created" => WorkflowChangeType::Created,
            "workflow_updated" | "workflow_changed" => WorkflowChangeType::Updated,
            "workflow_deleted" => WorkflowChangeType::Deleted,
            _ => WorkflowChangeType::Updated,
        };
        assert_eq!(format!("{:?}", change_type), "Deleted");
    }

    #[test]
    fn test_workflow_event_type_unknown_defaults_to_updated() {
        let event = "workflow_unknown";
        let change_type = match event {
            "workflow_created" => WorkflowChangeType::Created,
            "workflow_updated" | "workflow_changed" => WorkflowChangeType::Updated,
            "workflow_deleted" => WorkflowChangeType::Deleted,
            _ => WorkflowChangeType::Updated,
        };
        assert_eq!(format!("{:?}", change_type), "Updated");
    }

    // ===== URL Transformation Tests =====

    #[test]
    fn test_url_transformation_http_to_ws() {
        let base_url = "http://localhost:4000";
        let api_token = "test_token";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!(
            "{}{}?token={}&vsn=2.0.0",
            transformed, "/socket/websocket", api_token
        );

        assert_eq!(
            ws_url,
            "ws://localhost:4000/socket/websocket?token=test_token&vsn=2.0.0"
        );
    }

    #[test]
    fn test_url_transformation_https_to_wss() {
        let base_url = "https://secure.example.com:4000";
        let api_token = "secure_token";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!(
            "{}{}?token={}&vsn=2.0.0",
            transformed, "/socket/websocket", api_token
        );

        assert_eq!(
            ws_url,
            "wss://secure.example.com:4000/socket/websocket?token=secure_token&vsn=2.0.0"
        );
    }

    #[test]
    fn test_url_transformation_preserves_path_components() {
        let base_url = "http://api.example.com:8080/app";
        let api_token = "path_token";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!(
            "{}{}?token={}&vsn=2.0.0",
            transformed, "/socket/websocket", api_token
        );

        assert_eq!(
            ws_url,
            "ws://api.example.com:8080/app/socket/websocket?token=path_token&vsn=2.0.0"
        );
    }

    #[test]
    fn test_url_transformation_http_127_0_0_1() {
        let base_url = "http://127.0.0.1:8000";
        let api_token = "token123";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!(
            "{}{}?token={}&vsn=2.0.0",
            transformed, "/socket/websocket", api_token
        );

        assert_eq!(
            ws_url,
            "ws://127.0.0.1:8000/socket/websocket?token=token123&vsn=2.0.0"
        );
    }

    #[test]
    fn test_url_transformation_https_no_port() {
        let base_url = "https://api.example.com";
        let api_token = "secure123";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!(
            "{}{}?token={}&vsn=2.0.0",
            transformed, "/socket/websocket", api_token
        );

        assert_eq!(
            ws_url,
            "wss://api.example.com/socket/websocket?token=secure123&vsn=2.0.0"
        );
    }

    // ===== Reconnection Backoff Tests =====

    #[test]
    fn test_reconnect_delay_backoff_initial() {
        let delay = Duration::from_millis(100);
        assert_eq!(delay.as_millis(), 100);
    }

    #[test]
    fn test_reconnect_delay_backoff_exponential() {
        let mut delay = Duration::from_millis(100);

        // First backoff: 100 -> 200
        delay = Duration::from_millis((delay.as_millis() * 2) as u64).min(MAX_RECONNECT_DELAY);
        assert_eq!(delay.as_millis(), 200);

        // Second backoff: 200 -> 400
        delay = Duration::from_millis((delay.as_millis() * 2) as u64).min(MAX_RECONNECT_DELAY);
        assert_eq!(delay.as_millis(), 400);

        // Third backoff: 400 -> 800
        delay = Duration::from_millis((delay.as_millis() * 2) as u64).min(MAX_RECONNECT_DELAY);
        assert_eq!(delay.as_millis(), 800);

        // Fourth backoff: 800 -> 1600
        delay = Duration::from_millis((delay.as_millis() * 2) as u64).min(MAX_RECONNECT_DELAY);
        assert_eq!(delay.as_millis(), 1600);
    }

    #[test]
    fn test_reconnect_delay_backoff_capped_at_max() {
        let mut delay = Duration::from_millis(100);

        // Increase delay until it hits the cap
        for _ in 0..20 {
            delay = Duration::from_millis((delay.as_millis() * 2) as u64).min(MAX_RECONNECT_DELAY);
            assert!(delay.as_millis() <= MAX_RECONNECT_DELAY.as_millis());
        }

        // Should be capped at MAX_RECONNECT_DELAY (30 seconds = 30000 ms)
        assert_eq!(delay, MAX_RECONNECT_DELAY);
    }

    #[test]
    fn test_reconnect_delay_backoff_sequence() {
        let mut delay = Duration::from_millis(100);
        let expected_sequence = vec![100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 30000];

        for expected in expected_sequence {
            assert_eq!(
                delay.as_millis(),
                expected,
                "Delay should be {} ms",
                expected
            );
            delay = Duration::from_millis((delay.as_millis() * 2) as u64).min(MAX_RECONNECT_DELAY);
        }

        // After hitting max, should stay at max
        assert_eq!(delay.as_millis(), 30000);
    }

    #[test]
    fn test_reconnect_delay_backoff_never_exceeds_max() {
        let mut delay = Duration::from_millis(100);

        for _ in 0..100 {
            delay = Duration::from_millis((delay.as_millis() * 2) as u64).min(MAX_RECONNECT_DELAY);
            assert!(
                delay <= MAX_RECONNECT_DELAY,
                "Delay {} should not exceed max {}",
                delay.as_millis(),
                MAX_RECONNECT_DELAY.as_millis()
            );
        }
    }

    // ===== Heartbeat Configuration Tests =====

    #[test]
    fn test_heartbeat_interval_is_30_seconds() {
        assert_eq!(HEARTBEAT_INTERVAL.as_secs(), 30);
    }

    #[test]
    fn test_max_reconnect_delay_is_30_seconds() {
        assert_eq!(MAX_RECONNECT_DELAY.as_secs(), 30);
    }

    #[test]
    fn test_heartbeat_interval_milliseconds() {
        assert_eq!(HEARTBEAT_INTERVAL.as_millis(), 30000);
    }

    #[test]
    fn test_max_reconnect_delay_milliseconds() {
        assert_eq!(MAX_RECONNECT_DELAY.as_millis(), 30000);
    }

    #[test]
    fn test_heartbeat_and_reconnect_max_equal() {
        assert_eq!(
            HEARTBEAT_INTERVAL.as_millis(),
            MAX_RECONNECT_DELAY.as_millis()
        );
    }

    // ===== Topic and Join Message Tests =====

    #[test]
    fn test_project_topic_format() {
        let project_slug = "my-project";
        let topic = format!("project:{}", project_slug);
        assert_eq!(topic, "project:my-project");
    }

    #[test]
    fn test_project_topic_format_various_slugs() {
        assert_eq!(format!("project:{}", "test-proj"), "project:test-proj");
        assert_eq!(format!("project:{}", "production"), "project:production");
        assert_eq!(format!("project:{}", "dev-123"), "project:dev-123");
    }

    #[test]
    fn test_join_message_components() {
        let join_payload = serde_json::json!({"token": "api_token_xyz"});
        let topic = "project:test";
        let event = "phx_join";
        let ref_id = "1";

        assert_eq!(topic, "project:test");
        assert_eq!(event, "phx_join");
        assert_eq!(ref_id, "1");
        assert_eq!(
            join_payload.get("token").unwrap().as_str().unwrap(),
            "api_token_xyz"
        );
    }

    // ===== Mock Runtime Tests for Event Handlers =====

    fn build_test_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    #[test]
    fn test_handle_task_event_created() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "task123"});
        let result = SacrumSocket::handle_task_event("task_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_task_event_updated() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "task456", "title": "Updated"});
        let result = SacrumSocket::handle_task_event("task_updated", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_task_event_deleted() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "task789"});
        let result = SacrumSocket::handle_task_event("task_deleted", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_task_event_with_task_id_field() {
        let app = build_test_app();
        let handle = app.handle();
        // Uses "task_id" instead of "id"
        let payload = serde_json::json!({"task_id": "task_alt"});
        let result = SacrumSocket::handle_task_event("task_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_task_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"name": "no id here"});
        let result = SacrumSocket::handle_task_event("task_created", &payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing task_id"));
    }

    #[test]
    fn test_handle_workflow_event_created() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "wf123"});
        let result = SacrumSocket::handle_workflow_event("workflow_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_workflow_event_updated() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "wf456"});
        let result = SacrumSocket::handle_workflow_event("workflow_updated", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_workflow_event_deleted() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "wf789"});
        let result = SacrumSocket::handle_workflow_event("workflow_deleted", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_workflow_event_changed() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "wf_changed"});
        let result = SacrumSocket::handle_workflow_event("workflow_changed", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_workflow_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"name": "no id"});
        let result = SacrumSocket::handle_workflow_event("workflow_created", &payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing workflow_id"));
    }

    // ===== Step Event Handler Tests =====

    #[test]
    fn test_handle_step_event_created() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "step123", "workflow_id": "wf123"});
        let result = SacrumSocket::handle_step_event("step_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_event_updated() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "step456", "workflow_id": "wf456"});
        let result = SacrumSocket::handle_step_event("step_updated", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_event_deleted() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "step789", "workflow_id": "wf789"});
        let result = SacrumSocket::handle_step_event("step_deleted", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"workflow_id": "wf123"});
        let result = SacrumSocket::handle_step_event("step_created", &payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing id"));
    }

    // ===== Step Transition Event Handler Tests =====

    #[test]
    fn test_handle_step_transition_event_created() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "trans123"});
        let result =
            SacrumSocket::handle_step_transition_event("step_transition_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_transition_event_deleted() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "trans456"});
        let result =
            SacrumSocket::handle_step_transition_event("step_transition_deleted", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_transition_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"name": "no id"});
        let result =
            SacrumSocket::handle_step_transition_event("step_transition_created", &payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing id"));
    }

    // ===== Step Execution Event Handler Tests =====

    #[test]
    fn test_handle_step_execution_event_created() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({
            "id": "exec123",
            "task_id": "task123",
            "workflow_id": "wf123",
            "step_name": "Step 1",
            "status": "pending"
        });
        let result =
            SacrumSocket::handle_step_execution_event("step_execution_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_execution_event_status_changed() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({
            "id": "exec456",
            "task_id": "task456",
            "workflow_id": "wf456",
            "step_name": "Step 2",
            "status": "completed"
        });
        let result = SacrumSocket::handle_step_execution_event(
            "step_execution_status_changed",
            &payload,
            handle,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_execution_event_running_status() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({
            "id": "exec789",
            "status": "running"
        });
        let result =
            SacrumSocket::handle_step_execution_event("step_execution_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_execution_event_failed_status() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({
            "id": "exec101",
            "status": "failed"
        });
        let result =
            SacrumSocket::handle_step_execution_event("step_execution_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_step_execution_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"task_id": "task123"});
        let result =
            SacrumSocket::handle_step_execution_event("step_execution_created", &payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing id"));
    }

    // ===== Session Log Event Handler Tests =====

    #[test]
    fn test_handle_session_log_event() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({
            "id": "log123",
            "step_execution_id": "exec123"
        });
        let result = SacrumSocket::handle_session_log_event(&payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_session_log_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"step_execution_id": "exec123"});
        let result = SacrumSocket::handle_session_log_event(&payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing id"));
    }

    // ===== Section Event Handler Tests =====

    #[test]
    fn test_handle_section_event_created() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "sec123", "task_id": "task123"});
        let result = SacrumSocket::handle_section_event("section_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_section_event_updated() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "sec456", "task_id": "task456"});
        let result = SacrumSocket::handle_section_event("section_updated", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_section_event_deleted() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "sec789", "task_id": "task789"});
        let result = SacrumSocket::handle_section_event("section_deleted", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_section_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"task_id": "task123"});
        let result = SacrumSocket::handle_section_event("section_created", &payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing id"));
    }

    // ===== Phoenix Message Handler Tests for New Events =====

    #[test]
    fn test_handle_phoenix_message_step_created() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "step_created", {"id": "step123", "workflow_id": "wf123"}]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_phoenix_message_step_transition_created() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "step_transition_created", {"id": "trans123"}]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_phoenix_message_step_execution_created() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "step_execution_created", {"id": "exec123", "status": "pending"}]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_phoenix_message_session_log_created() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "session_log_created", {"id": "log123", "step_execution_id": "exec123"}]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_phoenix_message_section_created() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "section_created", {"id": "sec123", "task_id": "task123"}]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_phoenix_message_task_created() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "task_created", {"id": "task123"}]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_phoenix_message_workflow_updated() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "workflow_updated", {"id": "wf123"}]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_phoenix_message_task_run_updated_emits_event() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("task-run-changed-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });

        let msg = r#"["ref1", "1", "project:test", "task_run_updated", {
            "id": "run-ws-1",
            "task_id": "task-1",
            "project_id": "project-1",
            "status": "executing",
            "started_at": "2026-05-09T10:00:00Z",
            "ended_at": null,
            "stop_requested_at": null,
            "latest_step_execution_id": "exec-1",
            "outcome_kind": null,
            "outcome_context": null,
            "parent_task_run_id": null,
            "root_task_run_id": null,
            "triggered_by_step_execution_id": null,
            "inserted_at": "2026-05-09T10:00:00Z",
            "updated_at": "2026-05-09T10:01:00Z",
            "run_controls": {
                "runnable": false,
                "stoppable": true,
                "disabled_reason_code": "active_run",
                "disabled_reason": "A TaskRun is already active",
                "active_run": {
                    "id": "run-ws-1",
                    "task_id": "task-1",
                    "project_id": "project-1",
                    "status": "executing",
                    "started_at": "2026-05-09T10:00:00Z",
                    "ended_at": null,
                    "stop_requested_at": null,
                    "latest_step_execution_id": "exec-1",
                    "outcome_kind": null,
                    "outcome_context": null,
                    "parent_task_run_id": null,
                    "root_task_run_id": null,
                    "triggered_by_step_execution_id": null,
                    "inserted_at": "2026-05-09T10:00:00Z",
                    "updated_at": "2026-05-09T10:01:00Z"
                }
            }
        }]"#;

        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());

        let emitted = rx
            .recv_timeout(StdDuration::from_secs(1))
            .expect("task_run_updated should emit a Tauri event");
        let event: TaskRunChangedEvent = serde_json::from_str(&emitted)
            .expect("task-run-changed-event payload should deserialize");

        assert_eq!(event.task_run_id, "run-ws-1");
        assert_eq!(event.task_id, "task-1");
        assert!(matches!(event.change_type, TaskRunChangeType::Updated));
        assert_eq!(event.status, types::TaskRunStatus::Executing);
        assert_eq!(
            event
                .run_controls
                .and_then(|controls| controls.active_run)
                .map(|run| run.id),
            Some("run-ws-1".to_string())
        );
    }

    #[test]
    fn test_handle_phoenix_message_phx_reply_ignored() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "phx_reply", {"status": "ok"}]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_phoenix_message_short_array_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1"]"#;
        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Message too short"));
    }

    #[test]
    fn test_handle_phoenix_message_invalid_json_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let result = SacrumSocket::handle_phoenix_message("not json", handle, "test");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse message"));
    }

    // ===== Live Chat Event Dispatch Tests =====

    #[test]
    fn test_handle_phoenix_message_chat_message_created_emits_event() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("live-chat-message-created-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });

        let msg = r#"["ref1", "1", "project:test", "chat_message_created", {
            "id": "msg-assistant-1",
            "project_id": "proj-1",
            "chat_session_id": "sess-1",
            "role": "assistant",
            "content": "Hello back!",
            "content_format": "plain",
            "client_message_id": null,
            "metadata": {},
            "inserted_at": "2026-05-10T12:34:56Z",
            "updated_at": "2026-05-10T12:34:56Z"
        }]"#;

        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());

        let emitted = rx
            .recv_timeout(StdDuration::from_secs(1))
            .expect("chat_message_created should emit a Tauri event");
        let event: LiveChatMessageCreatedEvent = serde_json::from_str(&emitted)
            .expect("live-chat-message-created-event payload should deserialize");

        assert_eq!(event.message_id, "msg-assistant-1");
        assert_eq!(event.chat_session_id, "sess-1");
        assert!(event.client_message_id.is_none());
        let message = event.message.expect("message entity should be present");
        assert_eq!(message.id, "msg-assistant-1");
        assert_eq!(message.role, "assistant");
        assert_eq!(message.content, "Hello back!");
        assert_eq!(message.content_format.as_deref(), Some("plain"));
        assert_eq!(message.chat_session_id, "sess-1");
    }

    #[test]
    fn test_handle_phoenix_message_chat_message_created_carries_client_id() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("live-chat-message-created-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });

        let msg = r#"["ref1", "1", "project:test", "chat_message_created", {
            "id": "msg-user-1",
            "project_id": "proj-1",
            "chat_session_id": "sess-1",
            "role": "user",
            "content": "hi",
            "content_format": "plain",
            "client_message_id": "live-12345-1",
            "metadata": {},
            "inserted_at": "2026-05-10T12:34:55Z",
            "updated_at": "2026-05-10T12:34:55Z"
        }]"#;

        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());

        let emitted = rx
            .recv_timeout(StdDuration::from_secs(1))
            .expect("event should be emitted");
        let event: LiveChatMessageCreatedEvent =
            serde_json::from_str(&emitted).expect("payload should deserialize");

        assert_eq!(
            event.client_message_id.as_deref(),
            Some("live-12345-1"),
            "client_message_id should be hoisted to the top-level event so the \
             frontend can match against optimistic messages"
        );
    }

    #[test]
    fn test_handle_phoenix_message_chat_session_created_emits_event() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("live-chat-session-changed-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });

        let msg = r#"["ref1", "1", "project:test", "chat_session_created", {
            "id": "sess-42",
            "project_id": "proj-1",
            "status": "active",
            "session_kind": "live",
            "started_at": "2026-05-10T12:00:00Z",
            "ended_at": null,
            "stop_requested_at": null,
            "public_metadata": {},
            "inserted_at": "2026-05-10T12:00:00Z",
            "updated_at": "2026-05-10T12:00:00Z"
        }]"#;

        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());

        let emitted = rx
            .recv_timeout(StdDuration::from_secs(1))
            .expect("chat_session_created should emit a Tauri event");
        let event: LiveChatSessionChangedEvent =
            serde_json::from_str(&emitted).expect("payload should deserialize");

        assert_eq!(event.session_id, "sess-42");
        assert!(matches!(
            event.change_type,
            LiveChatSessionChangeType::Created
        ));
        let session = event.session.expect("session entity should be present");
        assert_eq!(session.id, "sess-42");
        assert_eq!(session.project_id, "proj-1");
        assert_eq!(session.status, "active");
        assert_eq!(session.session_kind.as_deref(), Some("live"));
    }

    #[test]
    fn test_handle_phoenix_message_chat_session_updated_uses_updated_change_type() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("live-chat-session-changed-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });

        let msg = r#"["ref1", "1", "project:test", "chat_session_updated", {
            "id": "sess-42",
            "project_id": "proj-1",
            "status": "ended",
            "session_kind": "live",
            "started_at": "2026-05-10T12:00:00Z",
            "ended_at": "2026-05-10T12:05:00Z",
            "stop_requested_at": null,
            "public_metadata": {},
            "inserted_at": "2026-05-10T12:00:00Z",
            "updated_at": "2026-05-10T12:05:00Z"
        }]"#;

        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());

        let emitted = rx
            .recv_timeout(StdDuration::from_secs(1))
            .expect("chat_session_updated should emit a Tauri event");
        let event: LiveChatSessionChangedEvent =
            serde_json::from_str(&emitted).expect("payload should deserialize");

        assert_eq!(event.session_id, "sess-42");
        assert!(matches!(
            event.change_type,
            LiveChatSessionChangeType::Updated
        ));
        assert_eq!(
            event.session.as_ref().map(|s| s.status.as_str()),
            Some("ended"),
            "updated session payload should round-trip the new status"
        );
    }

    #[test]
    fn test_handle_phoenix_message_chat_event_created_emits_generic_event() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("live-chat-event-created-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });

        let msg = r#"["ref1", "1", "project:test", "chat_event_created", {
            "id": "evt-1",
            "project_id": "proj-1",
            "chat_session_id": "sess-1",
            "event_type": "tool_call_started",
            "payload": {"tool": "search", "args": {"q": "foo"}},
            "inserted_at": "2026-05-10T12:34:57Z"
        }]"#;

        let result = SacrumSocket::handle_phoenix_message(msg, handle, "test");
        assert!(result.is_ok());

        let emitted = rx
            .recv_timeout(StdDuration::from_secs(1))
            .expect("chat_event_created should emit a Tauri event");
        let event: LiveChatEventCreatedEvent =
            serde_json::from_str(&emitted).expect("payload should deserialize");

        assert_eq!(event.event_id.as_deref(), Some("evt-1"));
        assert_eq!(event.chat_session_id.as_deref(), Some("sess-1"));
        assert_eq!(event.event_type.as_deref(), Some("tool_call_started"));
        assert_eq!(
            event.payload.get("tool").and_then(|v| v.as_str()),
            Some("search")
        );
    }

    #[test]
    fn test_handle_chat_message_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload =
            serde_json::json!({"chat_session_id": "sess-1", "content": "hi", "role": "user"});
        let result = SacrumSocket::handle_chat_message_event(&payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing id"));
    }

    #[test]
    fn test_handle_chat_message_event_missing_session_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"id": "msg-1", "content": "hi", "role": "user"});
        let result = SacrumSocket::handle_chat_message_event(&payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing chat_session_id"));
    }

    #[test]
    fn test_handle_chat_session_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"project_id": "proj-1"});
        let result =
            SacrumSocket::handle_chat_session_event("chat_session_created", &payload, handle);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Missing id"));
    }
}
