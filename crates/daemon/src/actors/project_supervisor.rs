//! ProjectSupervisor - per-project actor for the workflow execution daemon.
//!
//! Each ProjectSupervisor manages a single project's lifecycle:
//! - Receives demuxed channel events from the DaemonSupervisor
//! - Classifies incoming events and dispatches domain-specific handling
//! - Uses OneForOne supervision for future per-task child actors

use ractor::{Actor, ActorProcessingErr, ActorRef, SupervisionEvent};

use crate::phoenix::PhoenixMessage;

/// Configuration needed to start a ProjectSupervisor.
#[derive(Debug, Clone)]
pub struct ProjectConfig {
    /// The Sacrum project ID (UUID string).
    pub project_id: String,
    /// Sacrum base URL (e.g. "http://localhost:4000").
    pub base_url: String,
    /// API token for Sacrum authentication.
    pub api_token: String,
}

/// Messages the ProjectSupervisor can receive.
pub enum ProjectMessage {
    /// An incoming channel event routed from the DaemonSupervisor.
    ChannelEvent(PhoenixMessage),
    /// Initiate graceful shutdown of this project actor.
    Shutdown,
}

impl std::fmt::Debug for ProjectMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ChannelEvent(msg) => f
                .debug_struct("ChannelEvent")
                .field("topic", &msg.topic)
                .field("event", &msg.event)
                .finish(),
            Self::Shutdown => write!(f, "Shutdown"),
        }
    }
}

/// Result of classifying an incoming project channel event.
#[derive(Debug, PartialEq)]
pub enum ProjectAction {
    /// A task-related event (e.g. task_created, task_updated, task_deleted).
    TaskEvent { event: String },
    /// A workflow-related event (e.g. workflow_updated, workflow_assigned).
    WorkflowEvent { event: String },
    /// A step execution event (e.g. step_started, step_completed).
    StepEvent { event: String },
    /// An unrecognized event type -- log and skip.
    Unknown { event: String },
}

/// Classify an incoming project channel event into a domain action.
///
/// This is a pure function so it can be tested without an actor.
pub fn classify_project_event(msg: &PhoenixMessage) -> ProjectAction {
    let event = &msg.event;
    if event.starts_with("task_") {
        ProjectAction::TaskEvent {
            event: event.clone(),
        }
    } else if event.starts_with("workflow_") {
        ProjectAction::WorkflowEvent {
            event: event.clone(),
        }
    } else if event.starts_with("step_") {
        ProjectAction::StepEvent {
            event: event.clone(),
        }
    } else {
        ProjectAction::Unknown {
            event: event.clone(),
        }
    }
}

/// Runtime state held by the ProjectSupervisor actor.
pub struct ProjectState {
    /// The project ID this actor manages.
    project_id: String,
}

/// Per-project supervisor actor.
///
/// Handles all channel events routed from the `DaemonSupervisor`.
/// Future child actors (e.g. per-workflow-run executors) would be supervised here.
pub struct ProjectSupervisor;

impl Actor for ProjectSupervisor {
    type Msg = ProjectMessage;
    type State = ProjectState;
    type Arguments = ProjectConfig;

    async fn pre_start(
        &self,
        _myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        tracing::info!("ProjectSupervisor starting for project {}", args.project_id);

        Ok(ProjectState {
            project_id: args.project_id,
        })
    }

    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            ProjectMessage::ChannelEvent(msg) => {
                self.handle_channel_event(msg, state);
            }
            ProjectMessage::Shutdown => {
                self.handle_shutdown(myself, state);
            }
        }
        Ok(())
    }

    async fn handle_supervisor_evt(
        &self,
        _myself: ActorRef<Self::Msg>,
        message: SupervisionEvent,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match &message {
            SupervisionEvent::ActorStarted(cell) => {
                tracing::info!(
                    "[project:{}] Child actor started: {:?} (id={})",
                    state.project_id,
                    cell.get_name(),
                    cell.get_id()
                );
            }
            SupervisionEvent::ActorTerminated(cell, _state, reason) => {
                tracing::warn!(
                    "[project:{}] Child actor terminated: {:?} (id={}), reason: {:?}",
                    state.project_id,
                    cell.get_name(),
                    cell.get_id(),
                    reason
                );
            }
            SupervisionEvent::ActorFailed(cell, err) => {
                tracing::error!(
                    "[project:{}] Child actor failed: {:?} (id={}), error: {}",
                    state.project_id,
                    cell.get_name(),
                    cell.get_id(),
                    err
                );
            }
            SupervisionEvent::ProcessGroupChanged(change) => {
                tracing::debug!(
                    "[project:{}] Process group changed: {} in scope {}",
                    state.project_id,
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
        tracing::info!("ProjectSupervisor stopped for project {}", state.project_id);
        Ok(())
    }
}

impl ProjectSupervisor {
    /// Handle an incoming channel event by classifying and dispatching it.
    fn handle_channel_event(&self, msg: PhoenixMessage, state: &mut ProjectState) {
        let action = classify_project_event(&msg);

        match action {
            ProjectAction::TaskEvent { event } => {
                tracing::info!(
                    "[project:{}] Task event: {}, payload={}",
                    state.project_id,
                    event,
                    msg.payload
                );
                // Future: trigger workflow actions, update caches, etc.
            }
            ProjectAction::WorkflowEvent { event } => {
                tracing::info!(
                    "[project:{}] Workflow event: {}, payload={}",
                    state.project_id,
                    event,
                    msg.payload
                );
            }
            ProjectAction::StepEvent { event } => {
                tracing::info!(
                    "[project:{}] Step event: {}, payload={}",
                    state.project_id,
                    event,
                    msg.payload
                );
            }
            ProjectAction::Unknown { event } => {
                tracing::debug!(
                    "[project:{}] Unknown event type: {}, payload={}",
                    state.project_id,
                    event,
                    msg.payload
                );
            }
        }
    }

    /// Handle graceful shutdown: stop self.
    fn handle_shutdown(&self, myself: ActorRef<ProjectMessage>, state: &mut ProjectState) {
        tracing::info!(
            "ProjectSupervisor shutdown requested for project {}",
            state.project_id
        );
        myself.stop(Some("shutdown requested".to_string()));
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

    // ===== classify_project_event tests =====

    #[test]
    fn classify_task_created() {
        let m = msg(
            "project:proj-1",
            "task_created",
            serde_json::json!({"id": "t1"}),
        );
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::TaskEvent {
                event: "task_created".to_string()
            }
        );
    }

    #[test]
    fn classify_task_updated() {
        let m = msg(
            "project:proj-1",
            "task_updated",
            serde_json::json!({"id": "t1"}),
        );
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::TaskEvent {
                event: "task_updated".to_string()
            }
        );
    }

    #[test]
    fn classify_task_deleted() {
        let m = msg(
            "project:proj-1",
            "task_deleted",
            serde_json::json!({"id": "t1"}),
        );
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::TaskEvent {
                event: "task_deleted".to_string()
            }
        );
    }

    #[test]
    fn classify_workflow_updated() {
        let m = msg(
            "project:proj-1",
            "workflow_updated",
            serde_json::json!({"id": "w1"}),
        );
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::WorkflowEvent {
                event: "workflow_updated".to_string()
            }
        );
    }

    #[test]
    fn classify_workflow_assigned() {
        let m = msg(
            "project:proj-1",
            "workflow_assigned",
            serde_json::json!({"task_id": "t1"}),
        );
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::WorkflowEvent {
                event: "workflow_assigned".to_string()
            }
        );
    }

    #[test]
    fn classify_step_started() {
        let m = msg(
            "project:proj-1",
            "step_started",
            serde_json::json!({"step_id": "s1"}),
        );
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::StepEvent {
                event: "step_started".to_string()
            }
        );
    }

    #[test]
    fn classify_step_completed() {
        let m = msg(
            "project:proj-1",
            "step_completed",
            serde_json::json!({"step_id": "s1"}),
        );
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::StepEvent {
                event: "step_completed".to_string()
            }
        );
    }

    #[test]
    fn classify_unknown_event() {
        let m = msg("project:proj-1", "custom_event", serde_json::json!({}));
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::Unknown {
                event: "custom_event".to_string()
            }
        );
    }

    #[test]
    fn classify_empty_event_name() {
        let m = msg("project:proj-1", "", serde_json::json!({}));
        assert_eq!(
            classify_project_event(&m),
            ProjectAction::Unknown {
                event: "".to_string()
            }
        );
    }

    // ===== ProjectConfig tests =====

    #[test]
    fn project_config_debug_format() {
        let config = ProjectConfig {
            project_id: "proj-123".to_string(),
            base_url: "http://localhost:4000".to_string(),
            api_token: "token-abc".to_string(),
        };
        let debug = format!("{:?}", config);
        assert!(debug.contains("proj-123"));
        assert!(debug.contains("http://localhost:4000"));
    }

    #[test]
    fn project_config_clone() {
        let config = ProjectConfig {
            project_id: "proj-123".to_string(),
            base_url: "http://localhost:4000".to_string(),
            api_token: "token-abc".to_string(),
        };
        let cloned = config.clone();
        assert_eq!(cloned.project_id, "proj-123");
        assert_eq!(cloned.base_url, "http://localhost:4000");
        assert_eq!(cloned.api_token, "token-abc");
    }

    // ===== ProjectMessage debug tests =====

    #[test]
    fn project_message_debug_channel_event() {
        let m = msg("project:proj-1", "task_created", serde_json::json!({}));
        let pm = ProjectMessage::ChannelEvent(m);
        let debug = format!("{:?}", pm);
        assert!(debug.contains("ChannelEvent"));
        assert!(debug.contains("project:proj-1"));
        assert!(debug.contains("task_created"));
    }

    #[test]
    fn project_message_debug_shutdown() {
        let pm = ProjectMessage::Shutdown;
        let debug = format!("{:?}", pm);
        assert_eq!(debug, "Shutdown");
    }
}
