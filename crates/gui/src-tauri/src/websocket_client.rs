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
        let ws_url = format!("{}{}?token={}", transformed, "/socket/websocket", api_token);

        assert_eq!(
            ws_url,
            "ws://localhost:4000/socket/websocket?token=test_token"
        );
    }

    #[test]
    fn test_url_transformation_https_to_wss() {
        let base_url = "https://secure.example.com:4000";
        let api_token = "secure_token";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!("{}{}?token={}", transformed, "/socket/websocket", api_token);

        assert_eq!(
            ws_url,
            "wss://secure.example.com:4000/socket/websocket?token=secure_token"
        );
    }

    #[test]
    fn test_url_transformation_preserves_path_components() {
        let base_url = "http://api.example.com:8080/app";
        let api_token = "path_token";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!("{}{}?token={}", transformed, "/socket/websocket", api_token);

        assert_eq!(
            ws_url,
            "ws://api.example.com:8080/app/socket/websocket?token=path_token"
        );
    }

    #[test]
    fn test_url_transformation_http_127_0_0_1() {
        let base_url = "http://127.0.0.1:8000";
        let api_token = "token123";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!("{}{}?token={}", transformed, "/socket/websocket", api_token);

        assert_eq!(
            ws_url,
            "ws://127.0.0.1:8000/socket/websocket?token=token123"
        );
    }

    #[test]
    fn test_url_transformation_https_no_port() {
        let base_url = "https://api.example.com";
        let api_token = "secure123";

        let transformed = base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let ws_url = format!("{}{}?token={}", transformed, "/socket/websocket", api_token);

        assert_eq!(
            ws_url,
            "wss://api.example.com/socket/websocket?token=secure123"
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
}
