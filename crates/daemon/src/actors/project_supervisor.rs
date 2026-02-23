//! ProjectSupervisor - per-project actor for the workflow execution daemon.
//!
//! Each ProjectSupervisor manages a single project's lifecycle:
//! - Receives demuxed channel events from the DaemonSupervisor
//! - Classifies incoming events and dispatches domain-specific handling
//! - Tracks running StepExecutors by execution ID for cancel support
//! - Reports execution status changes back to Sacrum via GraphQL

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use ractor::{Actor, ActorProcessingErr, ActorRef, SupervisionEvent};
use vertebrae_core::VertebraeServices;
use vertebrae_core::execution_service::UpdateExecutionStatusParams;
use vertebrae_core::models::ExecutionStatus;

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
    /// Project root directory (for running Claude Code CLI).
    pub project_root: PathBuf,
}

impl std::fmt::Debug for ProjectConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectConfig")
            .field("project_id", &self.project_id)
            .field("project_root", &self.project_root)
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
        workflow_id: String,
        step_config: StepConfig,
    },
    /// Cancel a running StepExecutor.
    CancelStep {
        step_execution_id: String,
        task_id: String,
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
                workflow_id,
                step_config,
            } => f
                .debug_struct("ExecuteStep")
                .field("execution_id", execution_id)
                .field("task_id", task_id)
                .field("workflow_id", workflow_id)
                .field("step_config", step_config)
                .finish(),
            Self::CancelStep {
                step_execution_id,
                task_id,
            } => f
                .debug_struct("CancelStep")
                .field("step_execution_id", step_execution_id)
                .field("task_id", task_id)
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
    /// Sacrum is requesting the daemon to run a workflow step.
    RunStep,
    /// Sacrum is requesting the daemon to cancel a running step.
    CancelStep,
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
/// Daemon clients only receive `run_step` and `cancel_step` events from Sacrum,
/// but we classify all event types for completeness.
pub fn classify_project_event(msg: &PhoenixMessage) -> ProjectAction {
    let event = &msg.event;
    match event.as_str() {
        "run_step" => ProjectAction::RunStep,
        "cancel_step" => ProjectAction::CancelStep,
        _ if event.starts_with("task_") => ProjectAction::TaskEvent {
            event: event.clone(),
        },
        _ if event.starts_with("workflow_") => ProjectAction::WorkflowEvent {
            event: event.clone(),
        },
        _ if event.starts_with("step_") => ProjectAction::StepEvent {
            event: event.clone(),
        },
        _ => ProjectAction::Unknown {
            event: event.clone(),
        },
    }
}

/// Parsed payload for a `run_step` channel event from Sacrum.
///
/// Sacrum sends this when it wants the daemon to execute a workflow step.
/// The daemon creates a StepExecution record and spawns a StepExecutor to run it.
#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub struct RunStepPayload {
    /// The StepExecution ID (pre-created by Sacrum).
    pub id: String,
    /// The task this step belongs to.
    pub task_id: String,
    /// The workflow this step belongs to.
    pub workflow_id: String,
    /// The workflow step name.
    pub step_name: String,
    /// Current status (typically "pending").
    pub status: String,
    /// The goal/prompt for this step execution.
    #[serde(default)]
    pub goal: Option<String>,
    /// Agent names to use for this step.
    #[serde(default)]
    pub agents: Vec<String>,
    /// Skill names available for this step.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Additional agent configuration.
    #[serde(default)]
    pub agent_config: serde_json::Value,
    /// Whether this is the final step in the workflow.
    #[serde(default)]
    pub is_final: bool,
}

/// Parsed payload for a `cancel_step` channel event from Sacrum.
#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
pub struct CancelStepPayload {
    /// The StepExecution ID to cancel.
    pub step_execution_id: String,
    /// The task this step belongs to.
    pub task_id: String,
}

/// Parse a `run_step` event payload into a strongly-typed struct.
///
/// This is a pure function so it can be tested without an actor.
pub fn parse_run_step_payload(payload: &serde_json::Value) -> Result<RunStepPayload, String> {
    serde_json::from_value(payload.clone())
        .map_err(|e| format!("Failed to parse run_step payload: {e}"))
}

/// Parse a `cancel_step` event payload into a strongly-typed struct.
///
/// This is a pure function so it can be tested without an actor.
pub fn parse_cancel_step_payload(payload: &serde_json::Value) -> Result<CancelStepPayload, String> {
    serde_json::from_value(payload.clone())
        .map_err(|e| format!("Failed to parse cancel_step payload: {e}"))
}

/// Runtime state held by the ProjectSupervisor actor.
pub struct ProjectState {
    /// The project ID this actor manages.
    project_id: String,
    /// Per-project Sacrum-backed services.
    services: Arc<VertebraeServices>,
    /// Project root directory (for running Claude Code CLI).
    project_root: PathBuf,
    /// Map from execution_id to the running StepExecutor actor ref.
    /// Used to route cancel_step events to the correct executor.
    running_executors: HashMap<String, ActorRef<StepExecutorMessage>>,
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
        tracing::info!(
            "ProjectSupervisor starting for project {} (root: {})",
            args.project_id,
            args.project_root.display()
        );

        Ok(ProjectState {
            project_id: args.project_id,
            services: args.services,
            project_root: args.project_root,
            running_executors: HashMap::new(),
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
                self.handle_channel_event(msg, &myself, state).await;
            }
            ProjectMessage::ExecuteStep {
                execution_id,
                task_id,
                workflow_id,
                step_config,
            } => {
                self.handle_execute_step(
                    myself.clone(),
                    &execution_id,
                    &task_id,
                    &workflow_id,
                    step_config,
                    state,
                )
                .await?;
            }
            ProjectMessage::CancelStep {
                step_execution_id,
                task_id,
            } => {
                self.handle_cancel_step(&step_execution_id, &task_id, state)
                    .await;
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
    async fn handle_channel_event(
        &self,
        msg: PhoenixMessage,
        myself: &ActorRef<ProjectMessage>,
        state: &mut ProjectState,
    ) {
        let action = classify_project_event(&msg);

        match action {
            ProjectAction::RunStep => {
                match parse_run_step_payload(&msg.payload) {
                    Ok(payload) => {
                        tracing::info!(
                            "[project:{}] run_step received: execution_id={}, task_id={}, step_name={}",
                            state.project_id,
                            payload.id,
                            payload.task_id,
                            payload.step_name
                        );

                        // Build StepConfig from the payload
                        let prompt = payload
                            .goal
                            .unwrap_or_else(|| format!("Execute step: {}", payload.step_name));
                        let step_config = StepConfig {
                            prompt,
                            // Default model; agent_config could override this in the future
                            model: payload
                                .agent_config
                                .get("model")
                                .and_then(|v| v.as_str())
                                .unwrap_or("claude-sonnet-4-20250514")
                                .to_string(),
                        };

                        if let Err(e) = myself.cast(ProjectMessage::ExecuteStep {
                            execution_id: payload.id,
                            task_id: payload.task_id,
                            workflow_id: payload.workflow_id,
                            step_config,
                        }) {
                            tracing::error!(
                                "[project:{}] Failed to send ExecuteStep message: {}",
                                state.project_id,
                                e
                            );
                        }
                    }
                    Err(e) => {
                        tracing::error!(
                            "[project:{}] Failed to parse run_step payload: {}",
                            state.project_id,
                            e
                        );
                    }
                }
            }
            ProjectAction::CancelStep => match parse_cancel_step_payload(&msg.payload) {
                Ok(payload) => {
                    tracing::info!(
                        "[project:{}] cancel_step received: execution_id={}, task_id={}",
                        state.project_id,
                        payload.step_execution_id,
                        payload.task_id
                    );

                    if let Err(e) = myself.cast(ProjectMessage::CancelStep {
                        step_execution_id: payload.step_execution_id,
                        task_id: payload.task_id,
                    }) {
                        tracing::error!(
                            "[project:{}] Failed to send CancelStep message: {}",
                            state.project_id,
                            e
                        );
                    }
                }
                Err(e) => {
                    tracing::error!(
                        "[project:{}] Failed to parse cancel_step payload: {}",
                        state.project_id,
                        e
                    );
                }
            },
            ProjectAction::TaskEvent { event } => {
                tracing::info!(
                    "[project:{}] Task event: {}, payload={}",
                    state.project_id,
                    event,
                    msg.payload
                );
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

    /// Spawn a StepExecutor child actor, reporting status to Sacrum via GraphQL.
    ///
    /// 1. Updates the execution status to "running" in Sacrum
    /// 2. Spawns a StepExecutor actor to run Claude Code CLI
    /// 3. Tracks the executor in `running_executors` for cancel support
    async fn handle_execute_step(
        &self,
        myself: ActorRef<ProjectMessage>,
        execution_id: &str,
        task_id: &str,
        _workflow_id: &str,
        step_config: StepConfig,
        state: &mut ProjectState,
    ) -> Result<(), ActorProcessingErr> {
        tracing::info!(
            "[project:{}] Executing step: execution_id={}, task_id={}",
            state.project_id,
            execution_id,
            task_id
        );

        // Mark execution as running in Sacrum.
        if let Err(e) = state
            .services
            .executions()
            .update_execution_status(
                execution_id,
                UpdateExecutionStatusParams::new(ExecutionStatus::InProgress),
            )
            .await
        {
            tracing::error!(
                "[project:{}] Failed to update execution {} to running: {}",
                state.project_id,
                execution_id,
                e
            );
            return Ok(());
        }

        let executor_config = StepExecutorConfig {
            execution_id: execution_id.to_string(),
            task_id: task_id.to_string(),
            step_config,
            project_root: state.project_root.clone(),
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
                // Track the executor for cancel support.
                state
                    .running_executors
                    .insert(execution_id.to_string(), executor_ref.clone());

                if let Err(e) = executor_ref.cast(StepExecutorMessage::Execute) {
                    tracing::error!(
                        "[project:{}] Failed to send Execute to StepExecutor: {}",
                        state.project_id,
                        e
                    );
                    state.running_executors.remove(execution_id);
                }
            }
            Err(e) => {
                tracing::error!(
                    "[project:{}] Failed to spawn StepExecutor for execution {}: {}",
                    state.project_id,
                    execution_id,
                    e
                );

                // Report failure to Sacrum since we already marked it running.
                let _ = state
                    .services
                    .executions()
                    .update_execution_status(
                        execution_id,
                        UpdateExecutionStatusParams::new(ExecutionStatus::Failed)
                            .with_output(format!("Failed to spawn executor: {e}")),
                    )
                    .await;
            }
        }

        Ok(())
    }

    /// Handle a cancel_step request by finding and stopping the running executor.
    async fn handle_cancel_step(
        &self,
        step_execution_id: &str,
        task_id: &str,
        state: &mut ProjectState,
    ) {
        if let Some(executor_ref) = state.running_executors.remove(step_execution_id) {
            tracing::info!(
                "[project:{}] Cancelling step execution {} for task {}",
                state.project_id,
                step_execution_id,
                task_id
            );
            if let Err(e) = executor_ref.cast(StepExecutorMessage::Cancel) {
                tracing::warn!(
                    "[project:{}] Failed to send Cancel to StepExecutor: {} (may have already stopped)",
                    state.project_id,
                    e
                );
            }
        } else {
            tracing::warn!(
                "[project:{}] cancel_step for unknown execution {}, task {}",
                state.project_id,
                step_execution_id,
                task_id
            );
        }
    }

    async fn handle_step_finished(
        &self,
        execution_id: &str,
        task_id: &str,
        result: &StepResult,
        state: &mut ProjectState,
    ) {
        // Remove from running executors map (it may already be removed by cancel).
        state.running_executors.remove(execution_id);

        match result {
            StepResult::Completed { exit_code } => {
                tracing::info!(
                    "[project:{}] Step completed: execution_id={}, task_id={}, exit_code={}",
                    state.project_id,
                    execution_id,
                    task_id,
                    exit_code
                );

                // Report completed status to Sacrum via updateStepExecution.
                if let Err(e) = state
                    .services
                    .executions()
                    .update_execution_status(
                        execution_id,
                        UpdateExecutionStatusParams::new(ExecutionStatus::Completed),
                    )
                    .await
                {
                    tracing::error!(
                        "[project:{}] Failed to update execution {} to completed: {}",
                        state.project_id,
                        execution_id,
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

                // Report failed status to Sacrum via updateStepExecution.
                if let Err(e) = state
                    .services
                    .executions()
                    .update_execution_status(
                        execution_id,
                        UpdateExecutionStatusParams::new(ExecutionStatus::Failed)
                            .with_output(error.clone()),
                    )
                    .await
                {
                    tracing::error!(
                        "[project:{}] Failed to update execution {} to failed: {}",
                        state.project_id,
                        execution_id,
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
            project_root: PathBuf::from("/home/user/project"),
        };
        let debug = format!("{:?}", config);
        assert!(debug.contains("proj-123"));
        assert!(debug.contains("VertebraeServices"));
        assert!(debug.contains("/home/user/project"));
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
            workflow_id: "wf-456".to_string(),
            step_config: StepConfig {
                prompt: "Implement feature".to_string(),
                model: "claude-sonnet-4-20250514".to_string(),
            },
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("ExecuteStep"));
        assert!(debug.contains("exec-789"));
        assert!(debug.contains("task-xyz"));
        assert!(debug.contains("wf-456"));
        assert!(debug.contains("Implement feature"));
    }

    #[test]
    fn project_message_debug_cancel_step() {
        let pm = ProjectMessage::CancelStep {
            step_execution_id: "exec-cancel-1".to_string(),
            task_id: "task-abc".to_string(),
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("CancelStep"));
        assert!(debug.contains("exec-cancel-1"));
        assert!(debug.contains("task-abc"));
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

    // ===== RunStepPayload tests =====

    #[test]
    fn parse_run_step_full_payload() {
        let payload = serde_json::json!({
            "id": "exec-uuid-1",
            "task_id": "task-uuid-1",
            "workflow_id": "wf-uuid-1",
            "step_name": "implement",
            "status": "pending",
            "goal": "Write the feature code",
            "agents": ["agent1"],
            "skills": ["skill1", "skill2"],
            "agent_config": {"model": "claude-opus-4-20250514"},
            "is_final": false
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert_eq!(result.id, "exec-uuid-1");
        assert_eq!(result.task_id, "task-uuid-1");
        assert_eq!(result.workflow_id, "wf-uuid-1");
        assert_eq!(result.step_name, "implement");
        assert_eq!(result.status, "pending");
        assert_eq!(result.goal.as_deref(), Some("Write the feature code"));
        assert_eq!(result.agents, vec!["agent1"]);
        assert_eq!(result.skills, vec!["skill1", "skill2"]);
        assert_eq!(
            result.agent_config.get("model").and_then(|v| v.as_str()),
            Some("claude-opus-4-20250514")
        );
        assert!(!result.is_final);
    }

    #[test]
    fn parse_run_step_minimal_payload() {
        let payload = serde_json::json!({
            "id": "exec-uuid-2",
            "task_id": "task-uuid-2",
            "workflow_id": "wf-uuid-2",
            "step_name": "review",
            "status": "pending"
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert_eq!(result.id, "exec-uuid-2");
        assert_eq!(result.task_id, "task-uuid-2");
        assert!(result.goal.is_none());
        assert!(result.agents.is_empty());
        assert!(result.skills.is_empty());
        assert_eq!(result.agent_config, serde_json::Value::Null);
        assert!(!result.is_final);
    }

    #[test]
    fn parse_run_step_missing_required_field() {
        let payload = serde_json::json!({
            "id": "exec-uuid-3",
            "task_id": "task-uuid-3"
            // missing workflow_id, step_name, status
        });

        let result = parse_run_step_payload(&payload);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .contains("Failed to parse run_step payload")
        );
    }

    #[test]
    fn parse_run_step_is_final_true() {
        let payload = serde_json::json!({
            "id": "exec-uuid-4",
            "task_id": "task-uuid-4",
            "workflow_id": "wf-uuid-4",
            "step_name": "deploy",
            "status": "pending",
            "is_final": true
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert!(result.is_final);
    }

    // ===== CancelStepPayload tests =====

    #[test]
    fn parse_cancel_step_payload_success() {
        let payload = serde_json::json!({
            "step_execution_id": "exec-uuid-cancel",
            "task_id": "task-uuid-cancel"
        });

        let result = parse_cancel_step_payload(&payload).unwrap();
        assert_eq!(result.step_execution_id, "exec-uuid-cancel");
        assert_eq!(result.task_id, "task-uuid-cancel");
    }

    #[test]
    fn parse_cancel_step_payload_missing_field() {
        let payload = serde_json::json!({
            "step_execution_id": "exec-uuid-cancel"
            // missing task_id
        });

        let result = parse_cancel_step_payload(&payload);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .contains("Failed to parse cancel_step payload")
        );
    }

    // ===== classify_project_event tests for run_step/cancel_step =====

    #[test]
    fn classify_run_step_event() {
        let m = msg("project:proj-1", "run_step", serde_json::json!({}));
        assert_eq!(classify_project_event(&m), ProjectAction::RunStep);
    }

    #[test]
    fn classify_cancel_step_event() {
        let m = msg("project:proj-1", "cancel_step", serde_json::json!({}));
        assert_eq!(classify_project_event(&m), ProjectAction::CancelStep);
    }
}
