//! ProjectSupervisor - per-project actor for the workflow execution daemon.
//!
//! Each ProjectSupervisor manages a single project's lifecycle:
//! - Receives demuxed channel events from the DaemonSupervisor
//! - Classifies incoming events and dispatches domain-specific handling
//! - Uses OneForOne supervision for future per-task child actors

use std::path::PathBuf;
use std::sync::Arc;

use ractor::{Actor, ActorProcessingErr, ActorRef, SupervisionEvent};
use vertebrae_core::VertebraeServices;

use crate::actors::step_executor::{
    StepConfig, StepExecutor, StepExecutorConfig, StepExecutorMessage, StepResult,
};
use crate::phoenix::PhoenixMessage;

/// Configuration needed to start a ProjectSupervisor.
pub struct ProjectConfig {
    /// The Sacrum project ID (UUID string).
    pub project_id: String,
    /// Per-project Sacrum-backed services (tasks, workflows, executions, steps).
    pub services: Arc<VertebraeServices>,
}

impl std::fmt::Debug for ProjectConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectConfig")
            .field("project_id", &self.project_id)
            .field("services", &"<VertebraeServices>")
            .finish()
    }
}

pub enum ProjectMessage {
    ChannelEvent(PhoenixMessage),
    /// Spawn a StepExecutor to run a workflow step.
    ExecuteStep {
        execution_id: String,
        task_id: String,
        step_config: StepConfig,
        project_root: PathBuf,
    },
    StepFinished {
        execution_id: String,
        task_id: String,
        result: StepResult,
    },
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
            Self::ExecuteStep {
                execution_id,
                task_id,
                step_config,
                project_root,
            } => f
                .debug_struct("ExecuteStep")
                .field("execution_id", execution_id)
                .field("task_id", task_id)
                .field("step_config", step_config)
                .field("project_root", project_root)
                .finish(),
            Self::StepFinished {
                execution_id,
                task_id,
                result,
            } => f
                .debug_struct("StepFinished")
                .field("execution_id", execution_id)
                .field("task_id", task_id)
                .field("result", result)
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
    /// Per-project Sacrum-backed services.
    services: Arc<VertebraeServices>,
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
            services: args.services,
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
            ProjectMessage::ExecuteStep {
                execution_id,
                task_id,
                step_config,
                project_root,
            } => {
                self.handle_execute_step(
                    myself.clone(),
                    &execution_id,
                    &task_id,
                    step_config,
                    project_root,
                    state,
                )
                .await?;
            }
            ProjectMessage::StepFinished {
                execution_id,
                task_id,
                result,
            } => {
                self.handle_step_finished(&execution_id, &task_id, &result, state)
                    .await;
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

    /// Spawn a StepExecutor child actor, marking the step as started in Sacrum first.
    async fn handle_execute_step(
        &self,
        myself: ActorRef<ProjectMessage>,
        execution_id: &str,
        task_id: &str,
        step_config: StepConfig,
        project_root: PathBuf,
        state: &mut ProjectState,
    ) -> Result<(), ActorProcessingErr> {
        tracing::info!(
            "[project:{}] Executing step: execution_id={}, task_id={}",
            state.project_id,
            execution_id,
            task_id
        );

        // Mark the step as started in Sacrum before spawning the executor.
        if let Err(e) = state.services.tasks().start_step(task_id).await {
            tracing::error!(
                "[project:{}] Failed to start step for task {}: {}",
                state.project_id,
                task_id,
                e
            );
            return Ok(());
        }

        let executor_config = StepExecutorConfig {
            execution_id: execution_id.to_string(),
            task_id: task_id.to_string(),
            step_config,
            project_root,
            execution_service: state.services.executions_arc(),
        };

        let actor_name = format!("step-{}-{}", state.project_id, execution_id);

        match Actor::spawn_linked(
            Some(actor_name),
            StepExecutor,
            (executor_config, myself.clone()),
            myself.get_cell(),
        )
        .await
        {
            Ok((executor_ref, _handle)) => {
                if let Err(e) = executor_ref.cast(StepExecutorMessage::Execute) {
                    tracing::error!(
                        "[project:{}] Failed to send Execute to StepExecutor: {}",
                        state.project_id,
                        e
                    );
                }
            }
            Err(e) => {
                tracing::error!(
                    "[project:{}] Failed to spawn StepExecutor for execution {}: {}",
                    state.project_id,
                    execution_id,
                    e
                );
            }
        }

        Ok(())
    }

    async fn handle_step_finished(
        &self,
        execution_id: &str,
        task_id: &str,
        result: &StepResult,
        state: &mut ProjectState,
    ) {
        match result {
            StepResult::Completed { exit_code } => {
                tracing::info!(
                    "[project:{}] Step completed: execution_id={}, task_id={}, exit_code={}",
                    state.project_id,
                    execution_id,
                    task_id,
                    exit_code
                );

                if let Err(e) = state.services.tasks().complete_step(task_id).await {
                    tracing::error!(
                        "[project:{}] Failed to complete step for task {}: {}",
                        state.project_id,
                        task_id,
                        e
                    );
                }
            }
            StepResult::Failed { exit_code, error } => {
                tracing::warn!(
                    "[project:{}] Step failed: execution_id={}, task_id={}, exit_code={:?}, error={}",
                    state.project_id,
                    execution_id,
                    task_id,
                    exit_code,
                    error
                );

                // On failure, reject the step with the error as feedback.
                // We pass task_id as target_step_id to keep the task on the same step.
                if let Err(e) = state
                    .services
                    .tasks()
                    .reject_step(task_id, task_id, Some(error))
                    .await
                {
                    tracing::error!(
                        "[project:{}] Failed to reject step for task {}: {}",
                        state.project_id,
                        task_id,
                        e
                    );
                }
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

    fn test_services() -> Arc<VertebraeServices> {
        use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = Arc::new(GraphqlClient::new(config));
        Arc::new(vertebrae_sacrum_client::from_sacrum(client))
    }

    #[test]
    fn project_config_debug_format() {
        let config = ProjectConfig {
            project_id: "proj-123".to_string(),
            services: test_services(),
        };
        let debug = format!("{:?}", config);
        assert!(debug.contains("proj-123"));
        assert!(debug.contains("VertebraeServices"));
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
    fn project_message_debug_execute_step() {
        let pm = ProjectMessage::ExecuteStep {
            execution_id: "exec-789".to_string(),
            task_id: "task-xyz".to_string(),
            step_config: StepConfig {
                prompt: "Implement feature".to_string(),
                model: "claude-sonnet-4-20250514".to_string(),
            },
            project_root: PathBuf::from("/home/user/project"),
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("ExecuteStep"));
        assert!(debug.contains("exec-789"));
        assert!(debug.contains("task-xyz"));
        assert!(debug.contains("Implement feature"));
    }

    #[test]
    fn project_message_debug_step_finished_completed() {
        let pm = ProjectMessage::StepFinished {
            execution_id: "exec-123".to_string(),
            task_id: "task-abc".to_string(),
            result: StepResult::Completed { exit_code: 0 },
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("StepFinished"));
        assert!(debug.contains("exec-123"));
        assert!(debug.contains("task-abc"));
        assert!(debug.contains("Completed"));
    }

    #[test]
    fn project_message_debug_step_finished_failed() {
        let pm = ProjectMessage::StepFinished {
            execution_id: "exec-456".to_string(),
            task_id: "task-def".to_string(),
            result: StepResult::Failed {
                exit_code: Some(1),
                error: "process crashed".to_string(),
            },
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("StepFinished"));
        assert!(debug.contains("exec-456"));
        assert!(debug.contains("task-def"));
        assert!(debug.contains("Failed"));
        assert!(debug.contains("process crashed"));
    }

    #[test]
    fn project_message_debug_shutdown() {
        let pm = ProjectMessage::Shutdown;
        let debug = format!("{:?}", pm);
        assert_eq!(debug, "Shutdown");
    }
}
