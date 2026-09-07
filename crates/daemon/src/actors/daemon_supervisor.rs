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

use futures::future::join_all;
use ractor::{Actor, ActorProcessingErr, ActorRef, SupervisionEvent};
use tokio_tungstenite::tungstenite::Message;
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

use crate::actors::project_supervisor::{ProjectConfig, ProjectMessage, ProjectSupervisor};
use crate::capabilities::SharedDaemonCapabilities;
use crate::connection::{
    INITIAL_RECONNECT_DELAY, MAX_RECONNECT_DELAY, connect_with_auth, next_backoff, reconnect,
};
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
    DaemonJoinConfirmed(String),
    DaemonJoinFailed(String, Option<String>),
    DaemonChannelInterrupted,
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
    if let Some(daemon_id) = msg.daemon_id() {
        let daemon_id = daemon_id.to_string();
        return match msg.event.as_str() {
            "phx_reply" if msg.payload.get("status").and_then(|v| v.as_str()) == Some("ok") => {
                ChannelAction::DaemonJoinConfirmed(daemon_id)
            }
            "phx_reply" => ChannelAction::DaemonJoinFailed(
                daemon_id,
                msg.payload
                    .get("response")
                    .and_then(|response| response.get("reason"))
                    .and_then(|reason| reason.as_str())
                    .map(str::to_string),
            ),
            "phx_error" | "phx_close" => ChannelAction::DaemonChannelInterrupted,
            _ => ChannelAction::NonProjectTopic,
        };
    }

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

#[derive(Debug, PartialEq)]
enum ChannelRecovery {
    Reconnect,
    Stop(String),
}

fn daemon_join_recovery(reason: Option<&str>) -> ChannelRecovery {
    match reason {
        Some("invalid_credentials") => ChannelRecovery::Stop(
            "daemon credentials rejected; re-enrollment is required".to_string(),
        ),
        Some("identity_mismatch" | "invalid_registration" | "unsupported_operation") => {
            ChannelRecovery::Stop(
                "daemon registration configuration is incompatible with the backend".to_string(),
            )
        }
        // Includes already_connected: an old connection can remain registered
        // until the backend notices a network interruption. Rotation cannot fix that.
        _ => ChannelRecovery::Reconnect,
    }
}

#[derive(Clone)]
pub enum DaemonAuthentication {
    AccountToken(String),
    Standalone(crate::config::DaemonIdentity),
}

impl std::fmt::Debug for DaemonAuthentication {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AccountToken(_) => f.write_str("AccountToken(<redacted>)"),
            Self::Standalone(identity) => f.debug_tuple("Standalone").field(identity).finish(),
        }
    }
}

/// Configuration needed to start the DaemonSupervisor.
#[derive(Clone)]
pub struct DaemonConfig {
    /// Sacrum base URL (e.g. "http://localhost:4000").
    pub base_url: String,
    /// Authentication used for the Phoenix socket. Credentials are redacted
    /// by the manual [`Debug`] impl below.
    pub authentication: DaemonAuthentication,
    /// Immutable provider, path, skill, and Claude compatibility discovery
    /// captured before this actor starts.
    pub capabilities: SharedDaemonCapabilities,
}

impl std::fmt::Debug for DaemonConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonConfig")
            .field("base_url", &self.base_url)
            .field("authentication", &self.authentication)
            .field("capabilities", &self.capabilities)
            .finish()
    }
}

const PROJECT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(20);

async fn stop_projects(
    projects: impl IntoIterator<Item = (String, ActorRef<ProjectMessage>)>,
    reason: &str,
) {
    let reason = reason.to_string();
    let results = join_all(projects.into_iter().map(|(project_id, actor_ref)| {
        let reason = reason.clone();
        async move {
            let result = actor_ref
                .stop_and_wait(Some(reason.clone()), Some(PROJECT_SHUTDOWN_TIMEOUT))
                .await;
            (project_id, reason, result)
        }
    }))
    .await;
    for (project_id, reason, result) in results {
        if let Err(error) = result {
            tracing::error!(
                "ProjectSupervisor for {project_id} did not finish {reason}: {error:?}"
            );
        }
    }
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
    ReconnectFailed(String),
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
            Self::ReconnectFailed(reason) => {
                f.debug_tuple("ReconnectFailed").field(reason).finish()
            }
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
    /// Reset only after registration is confirmed, not merely after TCP connects.
    reconnect_delay: Duration,
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

        let socket = connect_with_auth(&args.base_url, &args.authentication)
            .await
            .map_err(|e| format!("Failed to connect to Sacrum WebSocket: {e}"))?;

        if let DaemonAuthentication::Standalone(identity) = &args.authentication {
            socket
                .join_daemon(&identity.daemon_id)
                .await
                .map_err(|e| format!("Failed to register daemon identity: {e}"))?;
        }

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
            reconnect_delay: INITIAL_RECONNECT_DELAY,
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
            DaemonMessage::ChannelMessage(msg) => match self.handle_channel_message(msg, state) {
                Some(ChannelRecovery::Stop(reason)) => {
                    tracing::error!(%reason, "Daemon registration rejected");
                    myself.stop(Some(reason));
                }
                Some(ChannelRecovery::Reconnect) => {
                    self.handle_connection_lost(myself, state).await
                }
                None => {}
            },
            DaemonMessage::ConnectionLost => {
                self.handle_connection_lost(myself, state).await;
            }
            DaemonMessage::Reconnected(new_socket) => {
                self.handle_reconnected(*new_socket, myself, state).await?;
            }
            DaemonMessage::ReconnectFailed(reason) => {
                tracing::error!(%reason, "Daemon cannot reconnect");
                myself.stop(Some(reason));
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

        stop_projects(
            std::mem::take(&mut state.projects),
            "daemon post-stop cleanup",
        )
        .await;

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
        let account_token = match &state.config.authentication {
            DaemonAuthentication::AccountToken(token) => token,
            DaemonAuthentication::Standalone(_) => {
                return Err("standalone daemon identity has no project execution channel".into());
            }
        };
        state
            .socket
            .join(&topic, account_token, "daemon")
            .await
            .map_err(|e| format!("Failed to join channel {topic}: {e}"))?;

        tracing::info!("Joined channel for project {}", project_id);

        let sacrum_config = SacrumConfig::new(
            state.config.base_url.clone(),
            account_token.clone(),
            project_id.to_string(),
        );
        let client = Arc::new(GraphqlClient::new(sacrum_config));
        let services = Arc::new(vertebrae_sacrum_client::from_sacrum(client));

        let project_config = ProjectConfig {
            project_id: project_id.to_string(),
            services,
            project_root: project_root.to_path_buf(),
            capabilities: state.config.capabilities.clone(),
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

        stop_projects(vec![(project_id.to_string(), actor_ref)], "project removed").await;

        let topic = format!("project:{}", project_id);
        if let Err(e) = state.socket.leave(&topic).await {
            tracing::warn!("Failed to leave channel {topic}: {e}");
        }

        tracing::info!("Removed project {}", project_id);
        Ok(())
    }

    /// Demux an incoming channel message by topic and route to the correct project.
    fn handle_channel_message(
        &self,
        msg: PhoenixMessage,
        state: &mut DaemonState,
    ) -> Option<ChannelRecovery> {
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
            ChannelAction::DaemonJoinConfirmed(daemon_id) => {
                state.reconnect_delay = INITIAL_RECONNECT_DELAY;
                tracing::info!(daemon_id = %daemon_id, "Standalone daemon identity registered");
            }
            ChannelAction::DaemonJoinFailed(_, reason) => {
                return Some(daemon_join_recovery(reason.as_deref()));
            }
            ChannelAction::DaemonChannelInterrupted => return Some(ChannelRecovery::Reconnect),
        }
        None
    }

    /// Handle connection loss: abort old reader pump, spawn a reconnection task.
    async fn handle_connection_lost(
        &self,
        myself: ActorRef<DaemonMessage>,
        state: &mut DaemonState,
    ) {
        if state.shutting_down {
            tracing::debug!("Ignoring ConnectionLost during shutdown");
            return;
        }

        // One reconnect owner also absorbs duplicate close/error notifications.
        if state.reconnect_handle.is_some() {
            return;
        }
        if let Some(handle) = state.reader_handle.take() {
            handle.abort();
        }
        // Release the previous registration before opening another socket.
        let _ = tokio::time::timeout(Duration::from_secs(5), state.socket.close()).await;
        tracing::warn!("Connection lost, starting reconnection with exponential backoff");
        let initial_delay = state.reconnect_delay;
        state.reconnect_delay = next_backoff(initial_delay, MAX_RECONNECT_DELAY);
        let config = state.config.clone();
        let actor_ref = myself;

        let handle = tokio::spawn(async move {
            match reconnect(
                &config.base_url,
                &config.authentication,
                initial_delay,
                MAX_RECONNECT_DELAY,
            )
            .await
            {
                Ok(socket) => {
                    let _ = actor_ref.cast(DaemonMessage::Reconnected(Box::new(socket)));
                }
                Err(error) => {
                    let reason = match error {
                        crate::phoenix::PhoenixError::AuthenticationRejected => {
                            "daemon authentication was rejected; re-enrollment is required"
                        }
                        _ => "invalid daemon connection configuration",
                    };
                    let _ = actor_ref.cast(DaemonMessage::ReconnectFailed(reason.to_string()));
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
        state.reconnect_handle = None;
        // The reconnect owner has already closed the old socket.
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

        if let DaemonAuthentication::Standalone(identity) = &state.config.authentication {
            if let Err(error) = state.socket.join_daemon(&identity.daemon_id).await {
                tracing::warn!(%error, "Registration send failed; reconnecting");
                self.handle_connection_lost(myself, state).await;
            }
        } else {
            state.reconnect_delay = INITIAL_RECONNECT_DELAY;
            let project_ids: Vec<String> = state.projects.keys().cloned().collect();
            let account_token = match &state.config.authentication {
                DaemonAuthentication::AccountToken(token) => token,
                DaemonAuthentication::Standalone(_) => unreachable!("handled above"),
            };
            for project_id in &project_ids {
                let topic = format!("project:{}", project_id);
                if let Err(e) = state.socket.join(&topic, account_token, "daemon").await {
                    tracing::error!("Failed to rejoin channel {topic} after reconnect: {e}");
                }
            }
            tracing::info!(
                "Reconnection complete, rejoined {} project channels",
                project_ids.len()
            );
        }

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

        let entries: Vec<(String, ActorRef<ProjectMessage>)> = state.projects.drain().collect();
        let project_ids = entries
            .iter()
            .map(|(project_id, _)| project_id.clone())
            .collect::<Vec<_>>();
        stop_projects(entries, "daemon shutdown").await;
        for project_id in project_ids {
            let topic = format!("project:{project_id}");
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
mod tests;
