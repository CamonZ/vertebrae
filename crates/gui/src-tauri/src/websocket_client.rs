//! WebSocket connection to Sacrum's Phoenix channels
//!
//! Handles connection to ws://host:port/socket/websocket with Phoenix channel protocol
//! and subscribes to real-time task/workflow change events.

use futures::{stream::SplitSink, stream::SplitStream, SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{async_runtime::JoinHandle as ActorJoinHandle, Emitter, Runtime};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tungstenite::Message;
use url::Url;
use uuid::Uuid;

use crate::events::{
    ArtifactChangeType, ArtifactChangedEvent, PermissionRequestEvent, SectionChangeType,
    SectionChangedEvent, SessionLogCreatedEvent, SessionLogUpdatedEvent, StepChangeType,
    StepChangedEvent, StepExecutionChangeType, StepExecutionChangedEvent, StepExecutionStatus,
    StepTransitionChangeType, StepTransitionChangedEvent, TaskChangeType, TaskChangedEvent,
    TaskPreviousBucketIdentity, TaskRunChangeType, TaskRunChangedEvent, TaskRunControlsPayload,
    TaskRunStepChangedEvent, TaskStepChangedEvent, WorkflowChangeType, WorkflowChangedEvent,
    WorkflowTransitionChangeType, WorkflowTransitionChangedEvent,
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

/// Derive `started_at`/`completed_at` for a step execution WS payload.
///
/// Sacrum's `step_executions` table has no timing columns — the channel
/// payload carries `inserted_at`/`updated_at` instead. Mirror the REST
/// path (`sacrum-client::execution_service::response_to_execution`):
/// `started_at := inserted_at`, and `completed_at := updated_at` once the
/// status is terminal (`completed`/`failed`). Fields already present and
/// non-empty are left untouched.
fn normalize_step_execution_payload(payload: &serde_json::Value) -> serde_json::Value {
    let mut normalized = payload.clone();
    let Some(obj) = normalized.as_object_mut() else {
        return normalized;
    };

    let is_blank = |value: Option<&serde_json::Value>| match value {
        None => true,
        Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(s)) => s.is_empty(),
        Some(_) => false,
    };

    if is_blank(obj.get("started_at")) {
        if let Some(inserted_at) = obj.get("inserted_at").cloned() {
            obj.insert("started_at".to_string(), inserted_at);
        }
    }

    let is_terminal = matches!(
        obj.get("status").and_then(|v| v.as_str()),
        Some("completed") | Some("failed")
    );
    if is_terminal && is_blank(obj.get("completed_at")) {
        if let Some(updated_at) = obj.get("updated_at").cloned() {
            obj.insert("completed_at".to_string(), updated_at);
        }
    }

    normalized
}

/// Default heartbeat interval (30 seconds as per Phoenix protocol)
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Maximum time to wait for a Phoenix join acknowledgement
const JOIN_REPLY_TIMEOUT: Duration = Duration::from_secs(5);

/// Maximum time to wait for graceful actor shutdown before aborting
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);

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

enum SocketCommand {
    SwitchProject {
        project_slug: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

enum ConnectionOutcome {
    Lost(String),
    Shutdown,
}

type SacrumWebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct ActiveConnection {
    write: SplitSink<SacrumWebSocket, Message>,
    read: SplitStream<SacrumWebSocket>,
    joined_topic: Option<String>,
    join_ref: Option<String>,
    next_ref: u64,
}

impl ActiveConnection {
    fn next_ref(&mut self) -> String {
        let ref_id = self.next_ref.to_string();
        self.next_ref += 1;
        ref_id
    }

    async fn join_project<R: Runtime>(
        &mut self,
        api_token: &str,
        project_slug: &str,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let join_ref = Uuid::new_v4().to_string();
        let ref_id = self.next_ref();
        let topic = Self::project_topic(project_slug);
        let join_payload = serde_json::json!({
            "token": api_token
        });

        let join_msg = serde_json::json!([join_ref, ref_id, topic, "phx_join", join_payload]);
        log::info!("[WebSocket] Sending join for topic '{}'", topic);
        self.write
            .send(Message::Text(join_msg.to_string()))
            .await
            .map_err(|e| format!("Failed to send join message: {}", e))?;

        self.wait_for_join_reply(&join_ref, app_handle).await?;
        self.joined_topic = Some(topic);
        self.join_ref = Some(join_ref);
        Ok(())
    }

    async fn wait_for_join_reply<R: Runtime>(
        &mut self,
        join_ref: &str,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        tokio::time::timeout(JOIN_REPLY_TIMEOUT, async {
            loop {
                match self.read.next().await {
                    Some(Ok(Message::Text(text))) => {
                        match Self::join_reply_result(&text, join_ref) {
                            Ok(Some(result)) => return result,
                            Ok(None) => {}
                            Err(e) => {
                                log::warn!(
                                    "[WebSocket] Ignoring malformed message before join: {}",
                                    e
                                );
                                continue;
                            }
                        }

                        if let Err(e) = SacrumSocket::handle_phoenix_message_for_topic(
                            &text,
                            app_handle,
                            self.joined_topic.as_deref(),
                        ) {
                            log::warn!("[WebSocket] Failed to handle message before join: {}", e);
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        return Err("Server closed connection while waiting for join".to_string());
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        return Err(format!("WebSocket error while waiting for join: {}", e));
                    }
                    None => {
                        return Err("Read stream ended while waiting for join".to_string());
                    }
                }
            }
        })
        .await
        .map_err(|_| {
            format!(
                "Timed out waiting for phx_join reply after {:?}",
                JOIN_REPLY_TIMEOUT
            )
        })?
    }

    fn join_reply_result(
        text: &str,
        expected_join_ref: &str,
    ) -> Result<Option<Result<(), String>>, String> {
        let msg: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("Failed to parse message: {}", e))?;
        let Some(arr) = msg.as_array() else {
            return Ok(None);
        };

        if arr.first().and_then(|v| v.as_str()) != Some(expected_join_ref) {
            return Ok(None);
        }

        let event = arr
            .get(3)
            .and_then(|v| v.as_str())
            .ok_or("Missing event field")?;

        match event {
            "phx_reply" => {
                let payload = arr.get(4).ok_or("Missing payload")?;
                let status = payload
                    .get("status")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing phx_reply status")?;

                if status == "ok" {
                    Ok(Some(Ok(())))
                } else {
                    Ok(Some(Err(format!(
                        "phx_join rejected with status '{}': {}",
                        status, payload
                    ))))
                }
            }
            "phx_error" => Ok(Some(Err("phx_join failed with phx_error".to_string()))),
            _ => Ok(None),
        }
    }

    async fn leave_current(&mut self) -> Result<(), String> {
        let Some(topic) = self.joined_topic.take() else {
            self.join_ref = None;
            return Ok(());
        };

        let join_ref = self
            .join_ref
            .take()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let ref_id = self.next_ref();
        let leave_msg = serde_json::json!([join_ref, ref_id, topic, "phx_leave", {}]);
        log::info!("[WebSocket] Sending leave for topic '{}'", topic);
        self.write
            .send(Message::Text(leave_msg.to_string()))
            .await
            .map_err(|e| format!("Failed to send leave message: {}", e))?;
        Ok(())
    }

    async fn close(mut self) {
        let _ = self.leave_current().await;
        let _ = self.write.send(Message::Close(None)).await;
        let _ = self.write.close().await;
    }

    fn project_topic(project_slug: &str) -> String {
        format!("project:{}", project_slug)
    }
}

/// Wraps a Phoenix WebSocket connection for Sacrum event subscriptions
pub struct SacrumSocket {
    /// Current connection state
    state: Arc<Mutex<ConnectionState>>,
    /// Command sender for the long-lived socket actor
    command_tx: Option<mpsc::UnboundedSender<SocketCommand>>,
    /// Actor task handle, used for deterministic shutdown
    actor_handle: Option<ActorJoinHandle<()>>,
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
            command_tx: None,
            actor_handle: None,
            base_url,
            api_token,
            project_slug,
        }
    }

    /// Create a disconnected socket placeholder (for when no project is selected)
    pub fn disconnected() -> Self {
        SacrumSocket {
            state: Arc::new(Mutex::new(ConnectionState::Disconnected)),
            command_tx: None,
            actor_handle: None,
            base_url: String::new(),
            api_token: String::new(),
            project_slug: String::new(),
        }
    }

    /// Start the WebSocket connection in the background
    ///
    /// This spawns a tokio task that handles connection, event subscription,
    /// and automatic reconnection with exponential backoff.
    pub fn connect<R: Runtime>(&mut self, app_handle: &tauri::AppHandle<R>) {
        if self.command_tx.is_some() {
            log::debug!("[WebSocket] Actor already running, ignoring connect request");
            return;
        }

        let base_url = self.base_url.clone();
        let api_token = self.api_token.clone();
        let initial_project = if self.project_slug.is_empty() {
            None
        } else {
            Some(self.project_slug.clone())
        };
        let state = Arc::clone(&self.state);
        let app_handle = app_handle.clone();
        let (command_tx, command_rx) = mpsc::unbounded_channel();

        let actor_handle = tauri::async_runtime::spawn(async move {
            Self::run_actor(
                base_url,
                api_token,
                initial_project,
                app_handle,
                state,
                command_rx,
            )
            .await;
        });

        self.command_tx = Some(command_tx);
        self.actor_handle = Some(actor_handle);
    }

    /// Return whether this socket actor targets the same Sacrum backend credentials.
    pub fn has_backend(&self, base_url: &str, api_token: &str) -> bool {
        self.base_url == base_url && self.api_token == api_token
    }

    /// Return whether an actor task is currently registered for this socket.
    pub fn is_running(&self) -> bool {
        self.command_tx.is_some()
    }

    /// Switch the Phoenix project channel over the existing transport.
    ///
    /// `Ok(())` means the actor accepted the desired project. It does not
    /// guarantee that the Phoenix join has already succeeded; transient join
    /// failures are retried by the actor's reconnect loop. `Err` means the actor
    /// is stopped or unreachable and the caller should rebuild the socket.
    pub async fn switch_project(&mut self, project_slug: Option<String>) -> Result<(), String> {
        self.project_slug = project_slug.clone().unwrap_or_default();
        let Some(command_tx) = &self.command_tx else {
            return Err("WebSocket actor is not running".to_string());
        };
        let (reply, result) = oneshot::channel();

        command_tx
            .send(SocketCommand::SwitchProject {
                project_slug,
                reply,
            })
            .map_err(|_| "WebSocket actor is not running".to_string())?;
        result
            .await
            .map_err(|_| "WebSocket actor stopped before switching project".to_string())?
    }

    /// Stop the actor and wait for the connection sink to close.
    pub async fn shutdown(&mut self) {
        if let Some(command_tx) = self.command_tx.take() {
            let _ = command_tx.send(SocketCommand::Shutdown);
        }

        if let Some(mut actor_handle) = self.actor_handle.take() {
            tokio::select! {
                result = &mut actor_handle => {
                    if let Err(e) = result {
                        log::warn!("[WebSocket] Actor shutdown join error: {}", e);
                    }
                }
                _ = tokio::time::sleep(SHUTDOWN_TIMEOUT) => {
                    log::warn!(
                        "[WebSocket] Actor did not stop within {:?}; aborting",
                        SHUTDOWN_TIMEOUT
                    );
                    actor_handle.abort();
                    if let Err(e) = actor_handle.await {
                        log::debug!("[WebSocket] Actor abort join result: {}", e);
                    }
                }
            }
        }

        {
            let mut state = self.state.lock().await;
            *state = ConnectionState::Disconnected;
        }
    }

    async fn run_actor<R: Runtime>(
        base_url: String,
        api_token: String,
        initial_project: Option<String>,
        app_handle: tauri::AppHandle<R>,
        state: Arc<Mutex<ConnectionState>>,
        mut commands: mpsc::UnboundedReceiver<SocketCommand>,
    ) {
        let mut desired_project = initial_project;
        let mut reconnect_delay = Duration::from_millis(100);
        let mut has_connected = false;

        loop {
            if desired_project.is_none() {
                Self::set_state(
                    &state,
                    ConnectionState::Disconnected,
                    Some("disconnected"),
                    Some(&app_handle),
                )
                .await;

                match commands.recv().await {
                    Some(SocketCommand::SwitchProject {
                        project_slug,
                        reply,
                    }) => {
                        desired_project = project_slug;
                        let _ = reply.send(Ok(()));
                        continue;
                    }
                    Some(SocketCommand::Shutdown) | None => break,
                }
            }

            let connecting_state = if has_connected {
                ConnectionState::Reconnecting
            } else {
                ConnectionState::Connecting
            };

            let connection_result = tokio::select! {
                result = Self::open_connection(
                    &base_url,
                    &api_token,
                    &state,
                    &app_handle,
                    connecting_state,
                ) => result,
                command = commands.recv() => {
                    match command {
                        Some(SocketCommand::SwitchProject { project_slug, reply }) => {
                            desired_project = project_slug;
                            let _ = reply.send(Ok(()));
                            continue;
                        }
                        Some(SocketCommand::Shutdown) | None => break,
                    }
                }
            };

            match connection_result {
                Ok(mut connection) => {
                    has_connected = true;
                    reconnect_delay = Duration::from_millis(100);

                    let initial_join = match desired_project.as_deref() {
                        Some(project_slug) => {
                            tokio::select! {
                                biased;
                                result = connection.join_project(&api_token, project_slug, &app_handle) => result,
                                command = commands.recv() => {
                                    match command {
                                        Some(SocketCommand::SwitchProject { project_slug, reply }) => {
                                            desired_project = project_slug;
                                            let _ = reply.send(Ok(()));
                                            Err("join interrupted by project switch".to_string())
                                        }
                                        Some(SocketCommand::Shutdown) | None => {
                                            connection.close().await;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        None => Ok(()),
                    };

                    if let Err(e) = initial_join {
                        log::warn!(
                            "[WebSocket] Initial join failed; will retry desired project: {}",
                            e
                        );
                        connection.close().await;
                        Self::set_state(
                            &state,
                            ConnectionState::Reconnecting,
                            Some("reconnecting"),
                            Some(&app_handle),
                        )
                        .await;
                    } else {
                        match Self::connection_loop(
                            connection,
                            &api_token,
                            &mut desired_project,
                            &app_handle,
                            &mut commands,
                        )
                        .await
                        {
                            ConnectionOutcome::Shutdown => break,
                            ConnectionOutcome::Lost(reason) => {
                                log::warn!("[WebSocket] Connection lost: {}", reason);
                                Self::set_state(
                                    &state,
                                    ConnectionState::Reconnecting,
                                    Some("reconnecting"),
                                    Some(&app_handle),
                                )
                                .await;
                            }
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[WebSocket] Connection failed: {}, retrying in {:?}",
                        e,
                        reconnect_delay
                    );
                    Self::set_state(
                        &state,
                        ConnectionState::Reconnecting,
                        Some("reconnecting"),
                        Some(&app_handle),
                    )
                    .await;
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(reconnect_delay) => {
                    reconnect_delay =
                        Duration::from_millis((reconnect_delay.as_millis() * 2) as u64)
                            .min(MAX_RECONNECT_DELAY);
                }
                command = commands.recv() => {
                    match command {
                        Some(SocketCommand::SwitchProject { project_slug, reply }) => {
                            desired_project = project_slug;
                            let _ = reply.send(Ok(()));
                        }
                        Some(SocketCommand::Shutdown) | None => break,
                    }
                }
            }
        }

        Self::set_state(
            &state,
            ConnectionState::Disconnected,
            Some("disconnected"),
            Some(&app_handle),
        )
        .await;
        log::info!("[WebSocket] Actor stopped");
    }

    async fn set_state<R: Runtime>(
        state: &Arc<Mutex<ConnectionState>>,
        next: ConnectionState,
        event: Option<&str>,
        app_handle: Option<&tauri::AppHandle<R>>,
    ) {
        {
            let mut s = state.lock().await;
            *s = next;
        }
        if let (Some(event), Some(app_handle)) = (event, app_handle) {
            let _ = app_handle.emit("websocket-state-changed", event);
        }
    }

    async fn open_connection(
        base_url: &str,
        api_token: &str,
        state: &Arc<Mutex<ConnectionState>>,
        app_handle: &tauri::AppHandle<impl Runtime>,
        connecting_state: ConnectionState,
    ) -> Result<ActiveConnection, String> {
        let state_event = match connecting_state {
            ConnectionState::Reconnecting => "reconnecting",
            _ => "connecting",
        };
        Self::set_state(state, connecting_state, Some(state_event), Some(app_handle)).await;

        let ws_url = format!(
            "{}{}?token={}&vsn=2.0.0",
            base_url
                .replace("https://", "wss://")
                .replace("http://", "ws://"),
            "/socket/websocket",
            api_token
        );

        log::info!("[WebSocket] Connecting to {}", ws_url);

        let _url = Url::parse(&ws_url).map_err(|e| format!("Invalid URL: {}", e))?;
        let (socket, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

        log::info!("[WebSocket] Connected");
        Self::set_state(
            state,
            ConnectionState::Connected,
            Some("connected"),
            Some(app_handle),
        )
        .await;

        let (write, read) = socket.split();
        Ok(ActiveConnection {
            write,
            read,
            joined_topic: None,
            join_ref: None,
            next_ref: 1,
        })
    }

    async fn connection_loop(
        mut connection: ActiveConnection,
        api_token: &str,
        desired_project: &mut Option<String>,
        app_handle: &tauri::AppHandle<impl Runtime>,
        commands: &mut mpsc::UnboundedReceiver<SocketCommand>,
    ) -> ConnectionOutcome {
        let mut heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
            HEARTBEAT_INTERVAL,
        );

        loop {
            tokio::select! {
                command = commands.recv() => {
                    match command {
                        Some(SocketCommand::SwitchProject {
                            project_slug,
                            reply,
                        }) => {
                            *desired_project = project_slug.clone();

                            let switch_result = match project_slug {
                                Some(project_slug) => {
                                    let next_topic = ActiveConnection::project_topic(&project_slug);
                                    if connection.joined_topic.as_deref() == Some(next_topic.as_str()) {
                                        log::debug!(
                                            "[WebSocket] Already joined to '{}', switch is a no-op",
                                            next_topic
                                        );
                                        let _ = reply.send(Ok(()));
                                        continue;
                                    }

                                    if let Err(e) = connection.leave_current().await {
                                        Err(e)
                                    } else {
                                        tokio::select! {
                                            biased;
                                            result = connection.join_project(api_token, &project_slug, app_handle) => result,
                                            command = commands.recv() => {
                                                match command {
                                                    Some(SocketCommand::SwitchProject {
                                                        project_slug,
                                                        reply: next_reply,
                                                    }) => {
                                                        *desired_project = project_slug;
                                                        let _ = next_reply.send(Ok(()));
                                                        Err("join interrupted by project switch".to_string())
                                                    }
                                                    Some(SocketCommand::Shutdown) | None => {
                                                        let _ = reply.send(Err(
                                                            "WebSocket actor stopped before switching project"
                                                                .to_string(),
                                                        ));
                                                        connection.close().await;
                                                        return ConnectionOutcome::Shutdown;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                None => connection.leave_current().await,
                            };

                            if let Err(e) = switch_result {
                                let _ = reply.send(Ok(()));
                                connection.close().await;
                                return ConnectionOutcome::Lost(e);
                            }

                            let _ = reply.send(Ok(()));
                        }
                        Some(SocketCommand::Shutdown) | None => {
                            connection.close().await;
                            return ConnectionOutcome::Shutdown;
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    let heartbeat_msg =
                        serde_json::json!([null, "phx_heartbeat", "phoenix", "heartbeat", {}]);

                    if let Err(e) = connection.write.send(Message::Text(heartbeat_msg.to_string())).await {
                        connection.close().await;
                        return ConnectionOutcome::Lost(format!("Heartbeat failed: {}", e));
                    }

                    log::debug!("[WebSocket] Sent heartbeat");
                }
                msg = connection.read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            log::info!("[WebSocket] Received message ({} bytes)", text.len());
                            log::debug!("[WebSocket] Raw message: {}", text);

                            if let Err(e) = Self::handle_phoenix_message_for_topic(
                                &text,
                                app_handle,
                                connection.joined_topic.as_deref(),
                            ) {
                                log::warn!("[WebSocket] Failed to handle message: {}", e);
                            }
                        }
                        Some(Ok(Message::Close(_))) => {
                            log::info!("[WebSocket] Server closed connection");
                            return ConnectionOutcome::Lost("server closed connection".to_string());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            log::error!("[WebSocket] Read error: {}", e);
                            return ConnectionOutcome::Lost(format!("WebSocket error: {}", e));
                        }
                        None => {
                            return ConnectionOutcome::Lost("read stream ended".to_string());
                        }
                    }
                }
            }
        }
    }

    /// Handle incoming Phoenix channel messages
    #[cfg(test)]
    fn handle_phoenix_message<R: Runtime>(
        text: &str,
        app_handle: &tauri::AppHandle<R>,
        project_slug: &str,
    ) -> Result<(), String> {
        let current_topic = ActiveConnection::project_topic(project_slug);
        Self::handle_phoenix_message_for_topic(text, app_handle, Some(current_topic.as_str()))
    }

    fn handle_phoenix_message_for_topic<R: Runtime>(
        text: &str,
        app_handle: &tauri::AppHandle<R>,
        current_topic: Option<&str>,
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

            if topic.starts_with("project:") && Some(topic) != current_topic {
                log::debug!(
                    "[WebSocket] Dropping event '{}' on stale topic '{}' (current={:?})",
                    event,
                    topic,
                    current_topic
                );
                Self::trace_event(&format!(
                    "DROP event='{}' topic='{}' current='{}'",
                    event,
                    topic,
                    current_topic.unwrap_or("<none>")
                ));
                return Ok(());
            }

            log::info!(
                "[WebSocket] Dispatching event '{}' on topic '{}'",
                event,
                topic
            );
            Self::trace_event(&format!("RECV event='{}' topic='{}'", event, topic));

            match event {
                "artifact_created" | "artifact_updated" | "artifact_deleted" => {
                    Self::handle_artifact_event(event, payload, app_handle)?;
                }
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
                "session_log_created" | "session_log_updated" => {
                    Self::handle_session_log_event(event, payload, app_handle)?;
                }
                "section_created" | "section_updated" | "section_deleted" => {
                    Self::handle_section_event(event, payload, app_handle)?;
                }
                "permission_request" => {
                    Self::handle_permission_request_event(payload, app_handle)?;
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

    fn handle_artifact_event<R: Runtime>(
        event: &str,
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let artifact_id = payload
            .get("id")
            .or_else(|| payload.get("artifact_id"))
            .and_then(|value| value.as_str())
            .ok_or("Missing artifact_id in payload")?
            .to_string();
        let change_type = match event {
            "artifact_created" => ArtifactChangeType::Created,
            "artifact_updated" => ArtifactChangeType::Updated,
            "artifact_deleted" => ArtifactChangeType::Deleted,
            _ => return Err(format!("Unhandled artifact event: {event}")),
        };
        let task_id = payload
            .get("task_id")
            .or_else(|| payload.get("subject_id"))
            .and_then(|value| value.as_str())
            .map(ToString::to_string);
        let artifact = serde_json::from_value::<types::Artifact>(payload.clone()).ok();
        app_handle
            .emit(
                "artifact-changed-event",
                &ArtifactChangedEvent {
                    artifact_id,
                    task_id,
                    change_type,
                    artifact,
                },
            )
            .map_err(|error| format!("Failed to emit artifact event: {error}"))
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
        let previous = payload
            .get("previous")
            .and_then(|value| value.as_object())
            .map(|previous| TaskPreviousBucketIdentity {
                archived: previous.get("archived").and_then(|value| value.as_bool()),
                level: previous
                    .get("level")
                    .map(|value| serde_json::from_value::<types::TaskLevel>(value.clone()).ok()),
                current_step_id: previous
                    .get("current_step_id")
                    .map(|value| value.as_str().map(ToString::to_string)),
                workflow_id: previous
                    .get("workflow_id")
                    .map(|value| value.as_str().map(ToString::to_string)),
            });

        let event = TaskChangedEvent {
            task_id,
            change_type,
            task,
            current_step_id,
            workflow_id,
            level,
            archived,
            previous,
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

        let normalized = normalize_step_execution_payload(payload);
        let execution = try_deserialize::<types::StepExecution>(&normalized, "StepExecution");

        let task_run_id = payload
            .get("task_run_id")
            .and_then(|v| v.as_str())
            .or_else(|| {
                execution
                    .as_ref()
                    .and_then(|execution| execution.task_run_id.as_deref())
            })
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

        let event = StepExecutionChangedEvent {
            execution_id,
            task_id,
            task_run_id,
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

        // Deserialize the flat channel row once. `run_controls` remains raw
        // until the valid TaskRun has been retained, so a malformed controls
        // object cannot erase a live run update.
        #[derive(Deserialize)]
        struct FlatTaskRunPayload {
            #[serde(flatten)]
            task_run: types::TaskRun,
            run_controls: serde_json::Value,
        }

        let run_controls_value = payload
            .get("run_controls")
            .ok_or("Missing run_controls in task run payload")?;
        let flat_payload = serde_json::from_value::<FlatTaskRunPayload>(payload.clone())
            .map_err(|e| format!("Failed to parse TaskRun payload: {e}"))?;
        let run_controls = if run_controls_value.is_null() {
            TaskRunControlsPayload::Deleted
        } else {
            match serde_json::from_value::<types::TaskRunControls>(flat_payload.run_controls) {
                Ok(controls) => TaskRunControlsPayload::Present(Box::new(controls)),
                Err(error) => {
                    log::warn!("[WebSocket] Malformed TaskRunControls payload: {error}");
                    TaskRunControlsPayload::Malformed
                }
            }
        };

        Ok(TaskRunChangedEvent {
            task_run_id,
            task_id,
            status,
            change_type,
            task_run: Some(flat_payload.task_run),
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
        event_name: &str,
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

        match event_name {
            "session_log_created" => {
                let event = SessionLogCreatedEvent {
                    log_id,
                    step_execution_id,
                    session_log,
                };

                log::debug!("[WebSocket] Emitting SessionLogCreatedEvent: {:?}", event);

                app_handle
                    .emit("session-log-created-event", &event)
                    .map_err(|e| format!("Failed to emit event: {}", e))?;
            }
            "session_log_updated" => {
                let event = SessionLogUpdatedEvent {
                    log_id,
                    step_execution_id,
                    session_log,
                };

                log::debug!("[WebSocket] Emitting SessionLogUpdatedEvent: {:?}", event);

                app_handle
                    .emit("session-log-updated-event", &event)
                    .map_err(|e| format!("Failed to emit event: {}", e))?;
            }
            _ => return Err(format!("Unsupported session log event: {}", event_name)),
        }

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

    fn handle_permission_request_event<R: Runtime>(
        payload: &serde_json::Value,
        app_handle: &tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let request_id = payload
            .get("request_id")
            .or_else(|| payload.get("id"))
            .and_then(|v| v.as_str())
            .ok_or("Missing request_id in permission request payload")?
            .to_string();

        let tool_name = payload
            .get("tool_name")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let tool_use_id = payload
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let session_id = payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let message = payload
            .get("message")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let input = payload
            .get("input")
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        let event = PermissionRequestEvent {
            request_id,
            session_id,
            turn_id: None,
            thread_id: None,
            is_root: false,
            tool_name,
            tool_use_id,
            input,
            message,
            questions: None,
            input_error: None,
        };

        log::debug!("[WebSocket] Emitting PermissionRequestEvent: {:?}", event);

        app_handle
            .emit("permission-request-event", &event)
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
    use tokio::net::TcpListener;
    use tokio::sync::mpsc as tokio_mpsc;
    use tokio::time::{timeout, Duration as TokioDuration};

    #[derive(Debug)]
    enum TestServerEvent {
        Connected(usize),
        Text(usize, serde_json::Value),
        Closed(usize),
    }

    async fn start_recording_ws_server() -> (
        String,
        tokio_mpsc::UnboundedReceiver<TestServerEvent>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test websocket server");
        let addr = listener.local_addr().expect("read listener addr");
        let (events_tx, events_rx) = tokio_mpsc::unbounded_channel();

        let server = tokio::spawn(async move {
            let mut connection_id = 0usize;
            while let Ok((stream, _)) = listener.accept().await {
                connection_id += 1;
                let id = connection_id;
                let tx = events_tx.clone();

                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };

                    let _ = tx.send(TestServerEvent::Connected(id));
                    while let Some(message) = socket.next().await {
                        match message {
                            Ok(Message::Text(text)) => {
                                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                                {
                                    if is_phx_join(&value) {
                                        send_join_reply(&mut socket, &value).await;
                                    }
                                    let _ = tx.send(TestServerEvent::Text(id, value));
                                }
                            }
                            Ok(Message::Close(_)) => {
                                let _ = tx.send(TestServerEvent::Closed(id));
                                break;
                            }
                            Ok(_) => {}
                            Err(_) => {
                                let _ = tx.send(TestServerEvent::Closed(id));
                                break;
                            }
                        }
                    }
                });
            }
        });

        (format!("http://{}", addr), events_rx, server)
    }

    async fn next_server_event(
        events: &mut tokio_mpsc::UnboundedReceiver<TestServerEvent>,
    ) -> TestServerEvent {
        timeout(TokioDuration::from_secs(2), events.recv())
            .await
            .expect("server event should arrive before timeout")
            .expect("server event channel should stay open")
    }

    async fn next_text_event(
        events: &mut tokio_mpsc::UnboundedReceiver<TestServerEvent>,
    ) -> (usize, serde_json::Value) {
        loop {
            if let TestServerEvent::Text(id, value) = next_server_event(events).await {
                return (id, value);
            }
        }
    }

    fn assert_channel_message(value: &serde_json::Value, topic: &str, event: &str) -> String {
        let arr = value
            .as_array()
            .expect("Phoenix message should be an array");
        assert_eq!(arr.get(2).and_then(|v| v.as_str()), Some(topic));
        assert_eq!(arr.get(3).and_then(|v| v.as_str()), Some(event));
        arr.first()
            .and_then(|v| v.as_str())
            .expect("join_ref should be a string")
            .to_string()
    }

    fn is_phx_join(value: &serde_json::Value) -> bool {
        value
            .as_array()
            .and_then(|arr| arr.get(3))
            .and_then(|v| v.as_str())
            == Some("phx_join")
    }

    async fn send_join_reply(
        socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
        join_msg: &serde_json::Value,
    ) {
        send_join_reply_with_status(socket, join_msg, "ok").await;
    }

    async fn send_join_reply_with_status(
        socket: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
        join_msg: &serde_json::Value,
        status: &str,
    ) {
        let Some(arr) = join_msg.as_array() else {
            return;
        };

        let reply = serde_json::json!([
            arr.first().cloned().unwrap_or(serde_json::Value::Null),
            arr.get(1).cloned().unwrap_or(serde_json::Value::Null),
            arr.get(2).cloned().unwrap_or(serde_json::Value::Null),
            "phx_reply",
            {
                "status": status,
                "response": {}
            }
        ]);

        let _ = socket.send(Message::Text(reply.to_string())).await;
    }

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

    /// Sacrum-shaped payload: no `started_at`/`completed_at`, only row
    /// timestamps. A freshly created execution must derive `started_at`
    /// from `inserted_at` and leave `completed_at` unset.
    #[test]
    fn step_execution_payload_derives_started_at_from_inserted_at() {
        let payload = serde_json::json!({
            "id": "exec-live-1",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "implement",
            "status": "started",
            "inserted_at": "2026-05-09T10:00:00Z",
            "updated_at": "2026-05-09T10:00:00Z",
        });

        let normalized = normalize_step_execution_payload(&payload);
        let exec = try_deserialize::<types::StepExecution>(&normalized, "StepExecution")
            .expect("created payload must deserialize");

        assert_eq!(exec.status, types::ExecutionStatus::InProgress);
        assert_eq!(exec.started_at, "2026-05-09T10:00:00Z");
        assert!(exec.completed_at.is_none());
    }

    /// Terminal payload must derive `completed_at` from `updated_at`.
    #[test]
    fn step_execution_payload_derives_completed_at_when_terminal() {
        let payload = serde_json::json!({
            "id": "exec-live-2",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "implement",
            "status": "completed",
            "inserted_at": "2026-05-09T10:00:00Z",
            "updated_at": "2026-05-09T10:05:00Z",
        });

        let normalized = normalize_step_execution_payload(&payload);
        let exec = try_deserialize::<types::StepExecution>(&normalized, "StepExecution")
            .expect("terminal payload must deserialize");

        assert_eq!(exec.status, types::ExecutionStatus::Completed);
        assert_eq!(exec.started_at, "2026-05-09T10:00:00Z");
        assert_eq!(exec.completed_at.as_deref(), Some("2026-05-09T10:05:00Z"));
    }

    /// Non-terminal updates (e.g. `waiting`) must NOT set `completed_at`,
    /// matching `ExecutionStatus::is_terminal` on the REST path.
    #[test]
    fn step_execution_payload_keeps_completed_at_unset_when_not_terminal() {
        let payload = serde_json::json!({
            "id": "exec-live-3",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "review",
            "status": "waiting",
            "inserted_at": "2026-05-09T10:00:00Z",
            "updated_at": "2026-05-09T10:03:00Z",
        });

        let normalized = normalize_step_execution_payload(&payload);
        let exec = try_deserialize::<types::StepExecution>(&normalized, "StepExecution")
            .expect("waiting payload must deserialize");

        assert_eq!(exec.status, types::ExecutionStatus::InProgress);
        assert_eq!(exec.started_at, "2026-05-09T10:00:00Z");
        assert!(exec.completed_at.is_none());
    }

    /// Explicit timing fields win over row timestamps when both are present.
    #[test]
    fn step_execution_payload_prefers_explicit_timing_fields() {
        let payload = serde_json::json!({
            "id": "exec-live-4",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "review",
            "status": "completed",
            "started_at": "2026-05-09T09:59:00Z",
            "completed_at": "2026-05-09T10:04:00Z",
            "inserted_at": "2026-05-09T10:00:00Z",
            "updated_at": "2026-05-09T10:05:00Z",
        });

        let normalized = normalize_step_execution_payload(&payload);
        let exec = try_deserialize::<types::StepExecution>(&normalized, "StepExecution")
            .expect("payload with explicit timing must deserialize");

        assert_eq!(exec.started_at, "2026-05-09T09:59:00Z");
        assert_eq!(exec.completed_at.as_deref(), Some("2026-05-09T10:04:00Z"));
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

        let TaskRunControlsPayload::Present(controls) = event.run_controls else {
            panic!("run_controls should be copied from the channel payload");
        };
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
        assert!(matches!(
            event.run_controls,
            TaskRunControlsPayload::Deleted
        ));
    }

    #[test]
    fn task_run_ws_payload_marks_malformed_controls_without_dropping_the_run() {
        let payload = serde_json::json!({
            "id": "run-ws-malformed-controls",
            "task_id": "task-1",
            "project_id": "project-1",
            "status": "executing",
            "run_controls": { "runnable": "not-a-boolean" }
        });

        let event = SacrumSocket::task_run_changed_event_from_payload("task_run_updated", &payload)
            .expect("a valid TaskRun must survive malformed controls");

        assert!(event.task_run.is_some());
        assert!(matches!(
            event.run_controls,
            TaskRunControlsPayload::Malformed
        ));
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

    // ===== Socket Actor Tests =====

    #[test]
    fn test_socket_backend_identity() {
        let socket = SacrumSocket::new(
            "http://localhost:4000".to_string(),
            "sac_test".to_string(),
            "test".to_string(),
        );

        assert!(socket.has_backend("http://localhost:4000", "sac_test"));
        assert!(!socket.has_backend("http://localhost:4001", "sac_test"));
        assert!(!socket.has_backend("http://localhost:4000", "other_token"));
        assert!(!socket.is_running());
    }

    #[tokio::test]
    async fn socket_switches_project_without_transport_reconnect() {
        let (base_url, mut events, server) = start_recording_ws_server().await;
        let app = build_test_app();
        let mut socket =
            SacrumSocket::new(base_url, "sac_test".to_string(), "project-a".to_string());

        socket.connect(app.handle());

        match next_server_event(&mut events).await {
            TestServerEvent::Connected(1) => {}
            other => panic!("expected first websocket connection, got {other:?}"),
        }

        let (connection_id, join_a) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 1);
        let join_ref_a = assert_channel_message(&join_a, "project:project-a", "phx_join");
        tokio::time::sleep(TokioDuration::from_millis(20)).await;

        socket
            .switch_project(Some("project-b".to_string()))
            .await
            .expect("switch to project-b should send actor command");

        let (connection_id, leave_a) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 1);
        let leave_ref_a = assert_channel_message(&leave_a, "project:project-a", "phx_leave");
        assert_eq!(
            leave_ref_a, join_ref_a,
            "phx_leave should reference the phx_join join_ref"
        );

        let (connection_id, join_b) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 1);
        assert_channel_message(&join_b, "project:project-b", "phx_join");

        assert!(
            timeout(TokioDuration::from_millis(150), events.recv())
                .await
                .is_err(),
            "project switch should not create another websocket connection"
        );

        socket.shutdown().await;
        server.abort();
    }

    #[tokio::test]
    async fn socket_switch_join_rejection_is_best_effort_and_retries_desired_project() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind join rejection test server");
        let addr = listener.local_addr().expect("read join rejection addr");
        let (events_tx, mut events) = tokio_mpsc::unbounded_channel();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept first websocket");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept first websocket handshake");
            events_tx
                .send(TestServerEvent::Connected(1))
                .expect("record first connection");

            if let Some(Ok(Message::Text(text))) = socket.next().await {
                let value = serde_json::from_str::<serde_json::Value>(&text)
                    .expect("initial join should be JSON");
                send_join_reply(&mut socket, &value).await;
                events_tx
                    .send(TestServerEvent::Text(1, value))
                    .expect("record initial join");
            }

            if let Some(Ok(Message::Text(text))) = socket.next().await {
                let value =
                    serde_json::from_str::<serde_json::Value>(&text).expect("leave should be JSON");
                events_tx
                    .send(TestServerEvent::Text(1, value))
                    .expect("record leave");
            }

            if let Some(Ok(Message::Text(text))) = socket.next().await {
                let value = serde_json::from_str::<serde_json::Value>(&text)
                    .expect("rejected join should be JSON");
                send_join_reply_with_status(&mut socket, &value, "error").await;
                events_tx
                    .send(TestServerEvent::Text(1, value))
                    .expect("record rejected join");
            }

            let (stream, _) = listener.accept().await.expect("accept retry websocket");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept retry websocket handshake");
            events_tx
                .send(TestServerEvent::Connected(2))
                .expect("record retry connection");

            if let Some(Ok(Message::Text(text))) = socket.next().await {
                let value = serde_json::from_str::<serde_json::Value>(&text)
                    .expect("retry join should be JSON");
                send_join_reply(&mut socket, &value).await;
                events_tx
                    .send(TestServerEvent::Text(2, value))
                    .expect("record retry join");
            }
        });

        let app = build_test_app();
        let mut socket = SacrumSocket::new(
            format!("http://{}", addr),
            "sac_test".to_string(),
            "project-a".to_string(),
        );
        socket.connect(app.handle());

        match next_server_event(&mut events).await {
            TestServerEvent::Connected(1) => {}
            other => panic!("expected initial websocket connection, got {other:?}"),
        }
        let (connection_id, join_a) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 1);
        assert_channel_message(&join_a, "project:project-a", "phx_join");
        tokio::time::sleep(TokioDuration::from_millis(20)).await;

        socket
            .switch_project(Some("project-b".to_string()))
            .await
            .expect("rejected live join should still accept the desired project");

        let (connection_id, leave_a) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 1);
        assert_channel_message(&leave_a, "project:project-a", "phx_leave");

        let (connection_id, rejected_join_b) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 1);
        assert_channel_message(&rejected_join_b, "project:project-b", "phx_join");

        match next_server_event(&mut events).await {
            TestServerEvent::Connected(2) => {}
            other => panic!("expected retry websocket connection, got {other:?}"),
        }
        let (connection_id, retry_join_b) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 2);
        assert_channel_message(&retry_join_b, "project:project-b", "phx_join");

        socket.shutdown().await;
        server.abort();
    }

    #[tokio::test]
    async fn socket_switch_interrupts_slow_initial_join() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind slow join test server");
        let addr = listener.local_addr().expect("read slow join addr");
        let (events_tx, mut events) = tokio_mpsc::unbounded_channel();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept first websocket");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept first websocket handshake");
            events_tx
                .send(TestServerEvent::Connected(1))
                .expect("record first connection");

            if let Some(Ok(Message::Text(text))) = socket.next().await {
                let value = serde_json::from_str::<serde_json::Value>(&text)
                    .expect("initial join should be JSON");
                events_tx
                    .send(TestServerEvent::Text(1, value))
                    .expect("record slow initial join");
            }

            while let Some(message) = socket.next().await {
                if matches!(message, Ok(Message::Close(_)) | Err(_)) {
                    break;
                }
            }

            let (stream, _) = listener.accept().await.expect("accept retry websocket");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept retry websocket handshake");
            events_tx
                .send(TestServerEvent::Connected(2))
                .expect("record retry connection");

            if let Some(Ok(Message::Text(text))) = socket.next().await {
                let value = serde_json::from_str::<serde_json::Value>(&text)
                    .expect("retry join should be JSON");
                send_join_reply(&mut socket, &value).await;
                events_tx
                    .send(TestServerEvent::Text(2, value))
                    .expect("record retry join");
            }
        });

        let app = build_test_app();
        let mut socket = SacrumSocket::new(
            format!("http://{}", addr),
            "sac_test".to_string(),
            "project-a".to_string(),
        );
        socket.connect(app.handle());

        match next_server_event(&mut events).await {
            TestServerEvent::Connected(1) => {}
            other => panic!("expected initial websocket connection, got {other:?}"),
        }
        let (connection_id, join_a) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 1);
        assert_channel_message(&join_a, "project:project-a", "phx_join");

        timeout(
            TokioDuration::from_millis(250),
            socket.switch_project(Some("project-b".to_string())),
        )
        .await
        .expect("switch should not wait for the slow join timeout")
        .expect("switch command should be accepted");

        match next_server_event(&mut events).await {
            TestServerEvent::Connected(2) => {}
            other => panic!("expected retry websocket connection, got {other:?}"),
        }
        let (connection_id, join_b) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 2);
        assert_channel_message(&join_b, "project:project-b", "phx_join");

        socket.shutdown().await;
        server.abort();
    }

    #[tokio::test]
    async fn socket_shutdown_closes_active_connection() {
        let (base_url, mut events, server) = start_recording_ws_server().await;
        let app = build_test_app();
        let mut socket =
            SacrumSocket::new(base_url, "sac_test".to_string(), "project-a".to_string());

        socket.connect(app.handle());
        match next_server_event(&mut events).await {
            TestServerEvent::Connected(1) => {}
            other => panic!("expected first websocket connection, got {other:?}"),
        }
        let _ = next_text_event(&mut events).await;

        socket.shutdown().await;
        assert!(!socket.is_running());
        assert_eq!(socket.get_state().await, ConnectionState::Disconnected);

        let mut saw_close = false;
        for _ in 0..3 {
            match next_server_event(&mut events).await {
                TestServerEvent::Closed(1) => {
                    saw_close = true;
                    break;
                }
                TestServerEvent::Text(1, value) => {
                    let event = value
                        .as_array()
                        .and_then(|arr| arr.get(3))
                        .and_then(|v| v.as_str());
                    assert_eq!(event, Some("phx_leave"));
                }
                other => panic!("unexpected server event during shutdown: {other:?}"),
            }
        }
        assert!(saw_close, "shutdown should close the websocket sink");

        server.abort();
    }

    #[tokio::test]
    async fn socket_reconnects_and_rejoins_current_project() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind reconnect test server");
        let addr = listener.local_addr().expect("read reconnect listener addr");
        let (events_tx, mut events) = tokio_mpsc::unbounded_channel();

        let server = tokio::spawn(async move {
            for id in 1..=2 {
                let (stream, _) = listener.accept().await.expect("accept websocket");
                let mut socket = tokio_tungstenite::accept_async(stream)
                    .await
                    .expect("accept websocket handshake");
                events_tx
                    .send(TestServerEvent::Connected(id))
                    .expect("record connection");

                if let Some(Ok(Message::Text(text))) = socket.next().await {
                    let value = serde_json::from_str::<serde_json::Value>(&text)
                        .expect("join message should be JSON");
                    if is_phx_join(&value) {
                        send_join_reply(&mut socket, &value).await;
                    }
                    events_tx
                        .send(TestServerEvent::Text(id, value))
                        .expect("record join");
                }

                if id == 1 {
                    let _ = socket.close(None).await;
                } else {
                    while let Some(message) = socket.next().await {
                        if matches!(message, Ok(Message::Close(_)) | Err(_)) {
                            break;
                        }
                    }
                }
            }
        });

        let app = build_test_app();
        let mut socket = SacrumSocket::new(
            format!("http://{}", addr),
            "sac_test".to_string(),
            "project-a".to_string(),
        );
        socket.connect(app.handle());

        match next_server_event(&mut events).await {
            TestServerEvent::Connected(1) => {}
            other => panic!("expected initial websocket connection, got {other:?}"),
        }
        let (connection_id, first_join) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 1);
        assert_channel_message(&first_join, "project:project-a", "phx_join");

        match next_server_event(&mut events).await {
            TestServerEvent::Connected(2) => {}
            other => panic!("expected reconnect websocket connection, got {other:?}"),
        }
        let (connection_id, rejoin) = next_text_event(&mut events).await;
        assert_eq!(connection_id, 2);
        assert_channel_message(&rejoin, "project:project-a", "phx_join");

        socket.shutdown().await;
        server.abort();
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
    fn test_handle_task_event_updated_preserves_sparse_previous_bucket_identity() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("task-changed-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });
        let payload = serde_json::json!({
            "id": "task456",
            "title": "Updated",
            "previous": {
                "archived": false,
                "level": null,
                "current_step_id": null
            }
        });

        SacrumSocket::handle_task_event("task_updated", &payload, handle).unwrap();

        let emitted: serde_json::Value = serde_json::from_str(
            &rx.recv_timeout(StdDuration::from_secs(1))
                .expect("task event should be emitted"),
        )
        .unwrap();
        assert_eq!(emitted["previous"]["archived"], false);
        assert!(emitted["previous"]["level"].is_null());
        assert!(emitted["previous"]["current_step_id"].is_null());
        assert!(emitted["previous"].get("workflow_id").is_none());
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
        let result =
            SacrumSocket::handle_session_log_event("session_log_created", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_session_log_updated_event() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({
            "id": "log123",
            "logical_key": "thinking:sess-1",
            "step_execution_id": "exec123"
        });
        let result =
            SacrumSocket::handle_session_log_event("session_log_updated", &payload, handle);
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_session_log_event_missing_id_returns_error() {
        let app = build_test_app();
        let handle = app.handle();
        let payload = serde_json::json!({"step_execution_id": "exec123"});
        let result =
            SacrumSocket::handle_session_log_event("session_log_created", &payload, handle);
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
    fn handle_phoenix_message_drops_stale_project_topic() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("session-log-created-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });

        let msg = r#"["ref1", "1", "project:old", "session_log_created", {"id": "log-old", "step_execution_id": "exec123"}]"#;
        let result =
            SacrumSocket::handle_phoenix_message_for_topic(msg, handle, Some("project:new"));

        assert!(result.is_ok());
        assert!(
            rx.recv_timeout(StdDuration::from_millis(100)).is_err(),
            "stale project broadcasts must not be forwarded to the webview"
        );
    }

    #[test]
    fn handle_phoenix_message_emits_current_project_session_log_once() {
        let app = build_test_app();
        let handle = app.handle();
        let (tx, rx) = mpsc::channel();
        app.listen_any("session-log-created-event", move |event| {
            tx.send(event.payload().to_string()).unwrap();
        });

        let msg = r#"["ref1", "1", "project:project-a", "session_log_created", {"id": "log-a", "step_execution_id": "exec-a"}]"#;
        let result =
            SacrumSocket::handle_phoenix_message_for_topic(msg, handle, Some("project:project-a"));

        assert!(result.is_ok());
        let emitted = rx
            .recv_timeout(StdDuration::from_secs(1))
            .expect("current project session log should emit once");
        let event: SessionLogCreatedEvent =
            serde_json::from_str(&emitted).expect("event payload should deserialize");
        assert_eq!(event.log_id, "log-a");
        assert_eq!(event.step_execution_id, "exec-a");
        assert!(
            rx.recv_timeout(StdDuration::from_millis(100)).is_err(),
            "one websocket broadcast should produce exactly one webview event"
        );
    }

    #[test]
    fn test_handle_phoenix_message_session_log_updated() {
        let app = build_test_app();
        let handle = app.handle();
        let msg = r#"["ref1", "1", "project:test", "session_log_updated", {"id": "log123", "logical_key": "thinking:sess-1", "step_execution_id": "exec123"}]"#;
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
            match event.run_controls {
                TaskRunControlsPayload::Present(controls) => controls.active_run.map(|run| run.id),
                _ => None,
            },
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
}
