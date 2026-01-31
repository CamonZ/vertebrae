//! WebSocket connection to Sacrum's Phoenix channels
//!
//! Handles connection to ws://host:port/socket/websocket with Phoenix channel protocol
//! and subscribes to real-time task/workflow change events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::Mutex;
use tungstenite::Message;
use url::Url;
use uuid::Uuid;

use crate::events::{TaskChangeType, TaskChangedEvent, WorkflowChangeType, WorkflowChangedEvent};

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

        tokio::spawn(async move {
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
            "{}{}?token={}",
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

        log::debug!("[WebSocket] Sending join message: {}", join_msg_str);
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
                    log::debug!("[WebSocket] Received message: {}", text);

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
    fn handle_phoenix_message(
        text: &str,
        app_handle: &tauri::AppHandle,
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

            let event = arr
                .get(3)
                .and_then(|v| v.as_str())
                .ok_or("Missing event field")?;
            let payload = arr.get(4).ok_or("Missing payload")?;

            log::debug!("[WebSocket] Event: {}, Payload: {}", event, payload);

            match event {
                "task_created" | "task_updated" | "task_deleted" => {
                    Self::handle_task_event(event, payload, app_handle)?;
                }
                "workflow_created" | "workflow_updated" | "workflow_deleted"
                | "workflow_changed" => {
                    Self::handle_workflow_event(event, payload, app_handle)?;
                }
                "phx_reply" | "phx_error" => {
                    log::debug!("[WebSocket] Phoenix reply: {}", event);
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
    fn handle_task_event(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle,
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

        let event = TaskChangedEvent {
            task_id,
            change_type,
        };

        log::info!("[WebSocket] Emitting TaskChangedEvent: {:?}", event);

        app_handle
            .emit("task-changed-event", &event)
            .map_err(|e| format!("Failed to emit event: {}", e))?;

        Ok(())
    }

    /// Handle workflow events and emit to Tauri
    fn handle_workflow_event(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle,
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

        let event = WorkflowChangedEvent {
            workflow_id,
            change_type,
        };

        log::info!("[WebSocket] Emitting WorkflowChangedEvent: {:?}", event);

        app_handle
            .emit("workflow-changed-event", &event)
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

    #[tokio::test]
    async fn test_connection_state_initial() {
        let socket = SacrumSocket::new(
            "http://localhost:4000".to_string(),
            "sac_test".to_string(),
            "test".to_string(),
        );

        assert_eq!(socket.get_state().await, ConnectionState::Disconnected);
    }

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
    fn test_phoenix_message_parsing() {
        let msg = r#"["ref1", "1", "project:my-project", "task_created", {"id": "task123"}]"#;
        // This would be tested with a full mock setup in integration tests
        let _parsed: serde_json::Value = serde_json::from_str(msg).unwrap();
        assert!(_parsed.is_array());
    }
}
