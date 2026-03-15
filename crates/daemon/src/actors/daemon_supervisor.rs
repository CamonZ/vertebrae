//! DaemonSupervisor - root supervisor actor for the workflow execution daemon.
//!
//! Manages the daemon lifecycle:
//! - Maintains a single Phoenix WebSocket connection to Sacrum
//! - Joins `project:{id}` channels for each registered project
//! - Demuxes incoming channel messages by topic
//! - Routes messages to the corresponding ProjectSupervisor actor
//! - Uses OneForOne supervision: project failures are isolated

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ractor::{Actor, ActorProcessingErr, ActorRef, SupervisionEvent};
use tokio_tungstenite::tungstenite::Message;
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

use crate::actors::project_supervisor::{ProjectConfig, ProjectMessage, ProjectSupervisor};
use crate::phoenix::{PhoenixMessage, PhoenixSocket};

/// Result of classifying an incoming channel message.
#[derive(Debug, PartialEq)]
pub enum ChannelAction {
    /// A normal app event for a known project — route it.
    RouteToProject(String),
    /// The server confirmed our channel join.
    JoinConfirmed(String),
    /// The server rejected our channel join (with optional reason).
    JoinFailed(String, Option<String>),
    /// A phx_error on a project channel.
    ChannelError(String),
    /// Message is for a non-project topic (e.g. "phoenix") — skip.
    NonProjectTopic,
    /// Message is for a project we don't track — skip.
    UnknownProject(String),
}

/// Classify an incoming channel message into an action the supervisor should take.
///
/// This is a pure function so it can be tested without an actor or socket.
/// Accepts any `HashMap<String, V>` so tests can use a lightweight value type.
fn classify_channel_message<V>(
    msg: &PhoenixMessage,
    known_projects: &HashMap<String, V>,
) -> ChannelAction {
    let Some(project_id) = msg.project_id() else {
        return ChannelAction::NonProjectTopic;
    };

    if !known_projects.contains_key(project_id) {
        return ChannelAction::UnknownProject(project_id.to_string());
    }

    let pid = project_id.to_string();

    match msg.event.as_str() {
        "phx_reply" => {
            let status = msg.payload.get("status").and_then(|v| v.as_str());
            match status {
                Some("ok") => ChannelAction::JoinConfirmed(pid),
                Some("error") => {
                    let reason = msg
                        .payload
                        .get("response")
                        .and_then(|r| r.get("reason"))
                        .and_then(|r| r.as_str())
                        .map(String::from);
                    ChannelAction::JoinFailed(pid, reason)
                }
                _ => ChannelAction::JoinFailed(pid, Some("missing status".to_string())),
            }
        }
        "phx_error" => ChannelAction::ChannelError(pid),
        "phx_close" => ChannelAction::ChannelError(pid),
        _ => ChannelAction::RouteToProject(pid),
    }
}

/// Configuration needed to start the DaemonSupervisor.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// Sacrum base URL (e.g. "http://localhost:4000").
    pub base_url: String,
    /// API token for Sacrum authentication.
    pub api_token: String,
    /// Resolved absolute path to the Claude Code CLI binary.
    pub claude_binary: std::path::PathBuf,
    /// The user's full login shell PATH, resolved at startup.
    /// Passed to child processes so they can find tools like `mix`, `node`, `vtb`, etc.
    pub shell_path: String,
}

/// Maximum delay between reconnection attempts (30 seconds).
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// Compute the next backoff delay by doubling `current`, capped at `max`.
fn next_backoff(current: Duration, max: Duration) -> Duration {
    // Saturating mul avoids overflow; min caps at the ceiling.
    current.saturating_mul(2).min(max)
}

/// Messages the DaemonSupervisor can receive.
pub enum DaemonMessage {
    /// Register a project and join its Phoenix channel.
    AddProject {
        /// The Sacrum project ID (UUID string).
        project_id: String,
        /// The project root directory (for running Claude Code CLI).
        project_root: std::path::PathBuf,
    },
    /// Unregister a project, leave its channel, and stop its ProjectSupervisor.
    RemoveProject {
        /// The Sacrum project ID (UUID string).
        project_id: String,
    },
    /// An incoming channel message from the WebSocket reader pump.
    ChannelMessage(PhoenixMessage),
    /// The WebSocket reader pump has exited (connection lost).
    ConnectionLost,
    /// A reconnection attempt succeeded — carries the new socket.
    Reconnected(Box<PhoenixSocket>),
    /// Initiate graceful shutdown: leave all channels, stop children, then self.
    Shutdown,
}

impl std::fmt::Debug for DaemonMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AddProject {
                project_id,
                project_root,
            } => f
                .debug_struct("AddProject")
                .field("project_id", project_id)
                .field("project_root", project_root)
                .finish(),
            Self::RemoveProject { project_id } => f
                .debug_struct("RemoveProject")
                .field("project_id", project_id)
                .finish(),
            Self::ChannelMessage(msg) => f.debug_tuple("ChannelMessage").field(msg).finish(),
            Self::ConnectionLost => write!(f, "ConnectionLost"),
            Self::Reconnected(_) => write!(f, "Reconnected(<PhoenixSocket>)"),
            Self::Shutdown => write!(f, "Shutdown"),
        }
    }
}

/// Runtime state held by the DaemonSupervisor actor.
pub struct DaemonState {
    /// The Phoenix WebSocket connection.
    socket: PhoenixSocket,
    /// Saved config (needed for reconnection).
    config: DaemonConfig,
    /// Map from project_id to its ProjectSupervisor actor ref.
    projects: HashMap<String, ActorRef<ProjectMessage>>,
    /// Handle to the WebSocket reader pump task.
    reader_handle: Option<tokio::task::JoinHandle<()>>,
    /// Handle to an in-flight reconnection task, if any.
    reconnect_handle: Option<tokio::task::JoinHandle<()>>,
    /// Set to true once shutdown is initiated so we don't attempt reconnection.
    shutting_down: bool,
}

/// The root supervisor actor.
///
/// Owns the single Phoenix WebSocket connection and manages per-project
/// child actors via OneForOne supervision (project failures are isolated).
pub struct DaemonSupervisor;

impl Actor for DaemonSupervisor {
    type Msg = DaemonMessage;
    type State = DaemonState;
    type Arguments = DaemonConfig;

    async fn pre_start(
        &self,
        myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        tracing::info!(
            "DaemonSupervisor starting, connecting to Sacrum at {}",
            args.base_url
        );

        let socket = PhoenixSocket::connect(&args.base_url, &args.api_token)
            .await
            .map_err(|e| format!("Failed to connect to Sacrum WebSocket: {e}"))?;

        // Take the reader half and spawn a pump task that forwards messages to our actor.
        let reader = socket
            .take_reader()
            .await
            .ok_or("WebSocket reader already taken")?;

        let myself_clone = myself.clone();
        let reader_handle = tokio::spawn(Self::ws_reader_pump(reader, myself_clone));

        Ok(DaemonState {
            socket,
            config: args,
            projects: HashMap::new(),
            reader_handle: Some(reader_handle),
            reconnect_handle: None,
            shutting_down: false,
        })
    }

    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            DaemonMessage::AddProject {
                project_id,
                project_root,
            } => {
                self.handle_add_project(&myself, &project_id, &project_root, state)
                    .await?;
            }
            DaemonMessage::RemoveProject { project_id } => {
                self.handle_remove_project(&project_id, state).await?;
            }
            DaemonMessage::ChannelMessage(msg) => {
                self.handle_channel_message(msg, state);
            }
            DaemonMessage::ConnectionLost => {
                self.handle_connection_lost(myself, state);
            }
            DaemonMessage::Reconnected(new_socket) => {
                self.handle_reconnected(*new_socket, myself, state).await?;
            }
            DaemonMessage::Shutdown => {
                self.handle_shutdown(myself, state).await?;
            }
        }
        Ok(())
    }

    async fn handle_supervisor_evt(
        &self,
        _myself: ActorRef<Self::Msg>,
        message: SupervisionEvent,
        _state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        // OneForOne strategy: log the event but do NOT stop self when a child dies.
        // Each project is isolated.
        match &message {
            SupervisionEvent::ActorStarted(cell) => {
                tracing::info!(
                    "Child actor started: {:?} (id={})",
                    cell.get_name(),
                    cell.get_id()
                );
            }
            SupervisionEvent::ActorTerminated(cell, _state, reason) => {
                tracing::warn!(
                    "Child actor terminated: {:?} (id={}), reason: {:?}",
                    cell.get_name(),
                    cell.get_id(),
                    reason
                );
                // OneForOne: do not propagate the stop to self.
                // Future enhancement: could restart the ProjectSupervisor here.
            }
            SupervisionEvent::ActorFailed(cell, err) => {
                tracing::error!(
                    "Child actor failed: {:?} (id={}), error: {}",
                    cell.get_name(),
                    cell.get_id(),
                    err
                );
                // OneForOne: do not propagate the failure to self.
                // Future enhancement: could restart the ProjectSupervisor here.
            }
            SupervisionEvent::ProcessGroupChanged(change) => {
                tracing::debug!(
                    "Process group changed: {} in scope {}",
                    change.get_group(),
                    change.get_scope()
                );
            }
        }
        Ok(())
    }

    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        tracing::info!("DaemonSupervisor stopping, cleaning up");

        // Abort the reader pump
        if let Some(handle) = state.reader_handle.take() {
            handle.abort();
        }

        // Abort any in-flight reconnection attempt
        if let Some(handle) = state.reconnect_handle.take() {
            handle.abort();
        }

        // Close the WebSocket connection
        state.socket.close().await;

        tracing::info!("DaemonSupervisor stopped");
        Ok(())
    }
}

impl DaemonSupervisor {
    /// WebSocket reader pump: reads frames from the WebSocket and forwards
    /// parsed Phoenix messages to the actor as `DaemonMessage::ChannelMessage`.
    async fn ws_reader_pump(
        mut reader: futures::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
        myself: ActorRef<DaemonMessage>,
    ) {
        use futures::StreamExt;

        while let Some(frame) = reader.next().await {
            match frame {
                Ok(Message::Text(text)) => match PhoenixMessage::parse(&text) {
                    Ok(msg) => {
                        // Only skip messages on the "phoenix" topic (heartbeat replies).
                        // Project-topic phx_reply / phx_error need to reach the actor
                        // so it can confirm joins or handle failures.
                        if msg.topic == "phoenix" {
                            tracing::debug!(
                                "Phoenix internal: event={}, topic={}",
                                msg.event,
                                msg.topic
                            );
                            continue;
                        }
                        if let Err(e) = myself.cast(DaemonMessage::ChannelMessage(msg)) {
                            tracing::error!("Failed to forward channel message to actor: {e}");
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse Phoenix message: {e}");
                    }
                },
                Ok(Message::Close(_)) => {
                    tracing::info!("WebSocket closed by server");
                    break;
                }
                Ok(_) => {
                    // Ignore ping/pong/binary frames
                }
                Err(e) => {
                    tracing::error!("WebSocket read error: {e}");
                    break;
                }
            }
        }

        tracing::info!("WebSocket reader pump exited");

        // Notify the actor that the connection was lost so it can attempt reconnection.
        let _ = myself.cast(DaemonMessage::ConnectionLost);
    }

    /// Handle AddProject: join the project channel and spawn a ProjectSupervisor.
    async fn handle_add_project(
        &self,
        myself: &ActorRef<DaemonMessage>,
        project_id: &str,
        project_root: &std::path::Path,
        state: &mut DaemonState,
    ) -> Result<(), ActorProcessingErr> {
        if state.projects.contains_key(project_id) {
            tracing::warn!("Project {} already registered, skipping", project_id);
            return Ok(());
        }

        let topic = format!("project:{}", project_id);
        state
            .socket
            .join(&topic, &state.config.api_token, "daemon")
            .await
            .map_err(|e| format!("Failed to join channel {topic}: {e}"))?;

        tracing::info!("Joined channel for project {}", project_id);

        let sacrum_config = SacrumConfig::new(
            state.config.base_url.clone(),
            state.config.api_token.clone(),
            project_id.to_string(),
        );
        let client = Arc::new(GraphqlClient::new(sacrum_config));
        let services = Arc::new(vertebrae_sacrum_client::from_sacrum(client));

        let project_config = ProjectConfig {
            project_id: project_id.to_string(),
            services,
            project_root: project_root.to_path_buf(),
            claude_binary: state.config.claude_binary.clone(),
            shell_path: state.config.shell_path.clone(),
        };

        let (child_ref, _handle) = Actor::spawn_linked(
            Some(format!("project-{project_id}")),
            ProjectSupervisor,
            project_config,
            myself.get_cell(),
        )
        .await
        .map_err(|e| format!("Failed to spawn ProjectSupervisor for {project_id}: {e}"))?;

        state.projects.insert(project_id.to_string(), child_ref);

        Ok(())
    }

    /// Handle RemoveProject: stop the child actor, leave the channel, and clean up.
    async fn handle_remove_project(
        &self,
        project_id: &str,
        state: &mut DaemonState,
    ) -> Result<(), ActorProcessingErr> {
        let Some(actor_ref) = state.projects.remove(project_id) else {
            tracing::warn!("Project {} not registered, nothing to remove", project_id);
            return Ok(());
        };

        // Stop the ProjectSupervisor child actor.
        actor_ref.stop(Some("project removed".to_string()));

        let topic = format!("project:{}", project_id);
        if let Err(e) = state.socket.leave(&topic).await {
            tracing::warn!("Failed to leave channel {topic}: {e}");
        }

        tracing::info!("Removed project {}", project_id);
        Ok(())
    }

    /// Demux an incoming channel message by topic and route to the correct project.
    fn handle_channel_message(&self, msg: PhoenixMessage, state: &mut DaemonState) {
        match classify_channel_message(&msg, &state.projects) {
            ChannelAction::RouteToProject(project_id) => {
                if let Some(actor_ref) = state.projects.get(&project_id) {
                    if let Err(e) = actor_ref.cast(ProjectMessage::ChannelEvent(msg)) {
                        tracing::error!("Failed to route message to project {}: {}", project_id, e);
                    }
                } else {
                    tracing::warn!(
                        "No ProjectSupervisor found for project {} (race condition?)",
                        project_id,
                    );
                }
            }
            ChannelAction::JoinConfirmed(project_id) => {
                tracing::info!("Channel join confirmed for project {}", project_id);
            }
            ChannelAction::JoinFailed(project_id, reason) => {
                tracing::error!(
                    "Channel join failed for project {}: {}",
                    project_id,
                    reason.as_deref().unwrap_or("unknown reason")
                );
                if let Some(actor_ref) = state.projects.remove(&project_id) {
                    actor_ref.stop(Some("channel join failed".to_string()));
                }
            }
            ChannelAction::ChannelError(project_id) => {
                tracing::error!("Channel error for project {}, removing", project_id);
                if let Some(actor_ref) = state.projects.remove(&project_id) {
                    actor_ref.stop(Some("channel error".to_string()));
                }
            }
            ChannelAction::NonProjectTopic => {
                tracing::debug!("Ignoring message for non-project topic: {}", msg.topic);
            }
            ChannelAction::UnknownProject(project_id) => {
                tracing::warn!(
                    "Received message for unknown project {}: event={}",
                    project_id,
                    msg.event
                );
            }
        }
    }

    /// Handle connection loss: abort old reader pump, spawn a reconnection task.
    fn handle_connection_lost(&self, myself: ActorRef<DaemonMessage>, state: &mut DaemonState) {
        if state.shutting_down {
            tracing::debug!("Ignoring ConnectionLost during shutdown");
            return;
        }

        // Abort old reader pump (it may already be done, but be safe).
        if let Some(handle) = state.reader_handle.take() {
            handle.abort();
        }

        // Abort any previous reconnect attempt.
        if let Some(handle) = state.reconnect_handle.take() {
            handle.abort();
        }

        tracing::warn!("Connection lost, starting reconnection with exponential backoff");

        let config = state.config.clone();
        let actor_ref = myself;

        let handle = tokio::spawn(async move {
            let mut delay = Duration::from_millis(100);

            loop {
                tokio::time::sleep(delay).await;

                tracing::info!("Attempting reconnection (delay was {:?})", delay);

                match PhoenixSocket::connect(&config.base_url, &config.api_token).await {
                    Ok(socket) => {
                        tracing::info!("Reconnection succeeded");
                        let _ = actor_ref.cast(DaemonMessage::Reconnected(Box::new(socket)));
                        return;
                    }
                    Err(e) => {
                        tracing::warn!("Reconnection failed: {e}");
                        delay = next_backoff(delay, MAX_RECONNECT_DELAY);
                    }
                }
            }
        });

        state.reconnect_handle = Some(handle);
    }

    /// Handle successful reconnection: replace socket, start new reader pump, rejoin channels.
    async fn handle_reconnected(
        &self,
        new_socket: PhoenixSocket,
        myself: ActorRef<DaemonMessage>,
        state: &mut DaemonState,
    ) -> Result<(), ActorProcessingErr> {
        // Close the old socket (heartbeat, writer).
        state.socket.close().await;

        // Replace with the new socket.
        state.socket = new_socket;

        // Start a new reader pump.
        let reader = state
            .socket
            .take_reader()
            .await
            .ok_or("WebSocket reader already taken on reconnect")?;

        let myself_clone = myself.clone();
        state.reader_handle = Some(tokio::spawn(Self::ws_reader_pump(reader, myself_clone)));

        // Rejoin all project channels.
        let project_ids: Vec<String> = state.projects.keys().cloned().collect();
        for project_id in &project_ids {
            let topic = format!("project:{}", project_id);
            if let Err(e) = state
                .socket
                .join(&topic, &state.config.api_token, "daemon")
                .await
            {
                tracing::error!("Failed to rejoin channel {topic} after reconnect: {e}");
            }
        }

        tracing::info!(
            "Reconnection complete, rejoined {} project channels",
            project_ids.len()
        );

        Ok(())
    }

    /// Handle graceful shutdown: leave all channels, stop all children, then stop self.
    async fn handle_shutdown(
        &self,
        myself: ActorRef<DaemonMessage>,
        state: &mut DaemonState,
    ) -> Result<(), ActorProcessingErr> {
        tracing::info!("Graceful shutdown initiated");

        state.shutting_down = true;

        // Abort any in-flight reconnection attempt.
        if let Some(handle) = state.reconnect_handle.take() {
            handle.abort();
        }

        // Stop all ProjectSupervisor children and leave channels.
        let entries: Vec<(String, ActorRef<ProjectMessage>)> = state.projects.drain().collect();
        for (project_id, actor_ref) in &entries {
            actor_ref.stop(Some("daemon shutdown".to_string()));
            let topic = format!("project:{}", project_id);
            if let Err(e) = state.socket.leave(&topic).await {
                tracing::warn!("Failed to leave channel {topic} during shutdown: {e}");
            }
        }

        // Stop self — this triggers post_stop which cleans up the WebSocket.
        myself.stop(Some("shutdown requested".to_string()));

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== Test helpers =====

    /// Build a PhoenixMessage for testing.
    fn msg(topic: &str, event: &str, payload: serde_json::Value) -> PhoenixMessage {
        PhoenixMessage {
            join_ref: None,
            msg_ref: None,
            topic: topic.to_string(),
            event: event.to_string(),
            payload,
        }
    }

    /// Build a known-projects map containing the given project IDs.
    /// Uses () as value since classify_channel_message is generic over the value type.
    fn known_projects(ids: &[&str]) -> HashMap<String, ()> {
        ids.iter().map(|id| (id.to_string(), ())).collect()
    }

    // ===== classify_channel_message tests =====

    #[test]
    fn classify_routes_app_event_to_project() {
        let projects = known_projects(&["proj-1"]);
        let m = msg("project:proj-1", "task_created", serde_json::json!({}));
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::RouteToProject("proj-1".to_string())
        );
    }

    #[test]
    fn classify_join_ok() {
        let projects = known_projects(&["proj-1"]);
        let m = msg(
            "project:proj-1",
            "phx_reply",
            serde_json::json!({"status": "ok", "response": {}}),
        );
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::JoinConfirmed("proj-1".to_string())
        );
    }

    #[test]
    fn classify_join_error_with_reason() {
        let projects = known_projects(&["proj-1"]);
        let m = msg(
            "project:proj-1",
            "phx_reply",
            serde_json::json!({"status": "error", "response": {"reason": "unauthorized"}}),
        );
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::JoinFailed("proj-1".to_string(), Some("unauthorized".to_string()))
        );
    }

    #[test]
    fn classify_join_error_missing_reason() {
        let projects = known_projects(&["proj-1"]);
        let m = msg(
            "project:proj-1",
            "phx_reply",
            serde_json::json!({"status": "error", "response": {}}),
        );
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::JoinFailed("proj-1".to_string(), None)
        );
    }

    #[test]
    fn classify_join_error_missing_status() {
        let projects = known_projects(&["proj-1"]);
        let m = msg(
            "project:proj-1",
            "phx_reply",
            serde_json::json!({"response": {}}),
        );
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::JoinFailed("proj-1".to_string(), Some("missing status".to_string()))
        );
    }

    #[test]
    fn classify_phx_error() {
        let projects = known_projects(&["proj-1"]);
        let m = msg("project:proj-1", "phx_error", serde_json::json!({}));
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::ChannelError("proj-1".to_string())
        );
    }

    #[test]
    fn classify_phx_close() {
        let projects = known_projects(&["proj-1"]);
        let m = msg("project:proj-1", "phx_close", serde_json::json!({}));
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::ChannelError("proj-1".to_string())
        );
    }

    #[test]
    fn classify_non_project_topic() {
        let projects = known_projects(&["proj-1"]);
        let m = msg("phoenix", "heartbeat", serde_json::json!({}));
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::NonProjectTopic
        );
    }

    #[test]
    fn classify_unknown_project() {
        let projects = known_projects(&["proj-1"]);
        let m = msg("project:unknown", "task_created", serde_json::json!({}));
        assert_eq!(
            classify_channel_message(&m, &projects),
            ChannelAction::UnknownProject("unknown".to_string())
        );
    }

    // ===== next_backoff tests =====

    #[test]
    fn next_backoff_doubles_delay() {
        let max = Duration::from_secs(30);
        assert_eq!(
            next_backoff(Duration::from_millis(100), max),
            Duration::from_millis(200)
        );
    }

    #[test]
    fn next_backoff_caps_at_max() {
        let max = Duration::from_secs(30);
        assert_eq!(next_backoff(Duration::from_secs(20), max), max);
    }

    #[test]
    fn next_backoff_stays_at_max() {
        let max = Duration::from_secs(30);
        assert_eq!(next_backoff(max, max), max);
    }
}
