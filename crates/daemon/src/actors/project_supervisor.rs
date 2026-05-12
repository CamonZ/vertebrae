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
use vertebrae_core::model_catalog::Provider;
use vertebrae_core::models::{AgentConfig, ExecutionStatus};

use crate::actors::step_executor::{
    StepConfig, StepExecutor, StepExecutorConfig, StepExecutorMessage, StepResult,
};
use crate::helpers::ProviderBinaries;
use crate::output_validator::SchemaValidationError;
use crate::phoenix::PhoenixMessage;

pub(crate) fn build_failure_output_payload(
    error: &str,
    schema_errors: Option<&[SchemaValidationError]>,
) -> String {
    match schema_errors {
        Some(errors) => {
            let payload = serde_json::json!({
                "kind": "schema_validation_failure",
                "error": error,
                "schema_errors": errors,
            });
            serde_json::to_string(&payload)
                .expect("failure payload is composed of serializable primitives")
        }
        None => error.to_string(),
    }
}

/// Configuration needed to start a ProjectSupervisor.
pub struct ProjectConfig {
    /// The Sacrum project ID (UUID string).
    pub project_id: String,
    /// Per-project Sacrum-backed services (tasks, workflows, executions, steps).
    pub services: Arc<VertebraeServices>,
    /// Project root directory (for running Claude Code CLI).
    pub project_root: PathBuf,
    /// Provider CLI binaries resolved at daemon startup. Threaded through
    /// to each spawned `StepExecutor` so per-step provider resolution can
    /// pick the right binary.
    pub provider_binaries: ProviderBinaries,
    /// The user's full login shell PATH for child processes.
    pub shell_path: String,
}

impl std::fmt::Debug for ProjectConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectConfig")
            .field("project_id", &self.project_id)
            .field("project_root", &self.project_root)
            .field("provider_binaries", &self.provider_binaries)
            .field("shell_path", &"<...>")
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
        step_config: Box<StepConfig>,
        worktree: Option<PathBuf>,
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
                step_config,
                worktree,
            } => f
                .debug_struct("ExecuteStep")
                .field("execution_id", execution_id)
                .field("task_id", task_id)
                .field("step_config", step_config)
                .field("worktree", worktree)
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
    /// The composed prompt for this step execution (built by Sacrum).
    #[serde(default)]
    pub prompt: Option<String>,
    /// Agent names to use for this step.
    #[serde(default)]
    pub agents: Vec<String>,
    /// Skill names available for this step.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Additional agent configuration.
    #[serde(default)]
    pub agent_config: serde_json::Value,
    /// Optional worktree path override for the execution directory.
    /// When present, the daemon uses this instead of the project root.
    #[serde(default)]
    pub worktree: Option<String>,
    /// Optional JSON Schema for structured output.
    /// When present, overrides `agent_config.json_schema` (step-level contract).
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
    /// When true, the daemon emits detailed diagnostic logs for this step
    /// execution at well-known checkpoints (raw payload, resolved agent_config,
    /// final claude argv, claude stderr, stream-json system/init line).
    ///
    /// Defaults to false. Sacrum omits this field from the broadcast payload
    /// when false, so older daemons (and the non-verbose path) see no change.
    #[serde(default)]
    pub verbose_daemon_logging: bool,
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

/// Build a `StepConfig` from a parsed `RunStepPayload`.
///
/// This is a pure function so it can be tested without an actor.
/// - Uses the `prompt` field directly from the payload (composed by Sacrum).
/// - Parses `agent_config` JSON into an `AgentConfig` struct.
/// - Carries `agents` and `skills` from the payload into the config.
pub fn build_step_config_from_payload(payload: &RunStepPayload) -> StepConfig {
    let prompt = match payload.prompt.as_deref().filter(|s| !s.is_empty()) {
        Some(p) => p.to_string(),
        None => "Execute step".to_string(),
    };

    let mut agent_config: AgentConfig =
        serde_json::from_value(payload.agent_config.clone()).unwrap_or_default();

    // Step-level contract from Sacrum overrides agent_config.
    if let Some(schema) = payload.output_schema.as_ref().filter(|v| !v.is_null()) {
        agent_config = agent_config.with_json_schema(schema.clone());
    }

    StepConfig {
        prompt,
        agent_config,
        agents: payload.agents.clone(),
        skills: payload.skills.clone(),
        verbose_daemon_logging: payload.verbose_daemon_logging,
    }
}

/// Resolve the `(provider, model)` pair the daemon reports for an execution.
/// Provider comes verbatim from `agent_config` (defaulting to Anthropic via
/// [`crate::provider::resolve_provider_from_agent_config`]); model is never
/// inferred from the model string.
pub fn resolved_execution_metadata(agent_config: &AgentConfig) -> (Provider, Option<String>) {
    let provider = crate::provider::resolve_provider_from_agent_config(agent_config);
    let model = agent_config
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(|m| m.to_string());
    (provider, model)
}

fn attach_resolved_metadata(
    params: UpdateExecutionStatusParams,
    agent_config: &AgentConfig,
) -> UpdateExecutionStatusParams {
    let (provider, model) = resolved_execution_metadata(agent_config);
    let mut params = params.with_model_provider(provider.as_str());
    if let Some(model) = model {
        params = params.with_model(model);
    }
    params
}

/// Stable tracing target for verbose daemon diagnostics.
///
/// Lines emitted under this target are gated behind a step's
/// `verbose_daemon_logging` flag and intentionally include full schema /
/// argv / stderr content. Greppable from logs as `daemon::verbose`.
pub const VERBOSE_LOG_TARGET: &str = "daemon::verbose";

pub const CHECKPOINT_RUN_STEP_PAYLOAD: &str = "run_step_payload";
pub const CHECKPOINT_STEP_CONFIG_BUILT: &str = "step_config_built";

/// Runtime state held by the ProjectSupervisor actor.
pub struct ProjectState {
    /// The project ID this actor manages.
    project_id: String,
    /// Per-project Sacrum-backed services.
    services: Arc<VertebraeServices>,
    /// Project root directory (for running Claude Code CLI).
    project_root: PathBuf,
    /// Provider CLI binaries resolved at daemon startup. Cloned into each
    /// spawned `StepExecutorConfig` so the per-step resolver can pick the
    /// right binary.
    provider_binaries: ProviderBinaries,
    /// The user's full login shell PATH for child processes.
    shell_path: String,
    /// Map from execution_id to the running StepExecutor actor ref.
    /// Used to route cancel_step events to the correct executor.
    running_executors: HashMap<String, ActorRef<StepExecutorMessage>>,
    /// AgentConfig captured at spawn time, keyed by execution_id, so terminal
    /// status updates can re-attach provider/model metadata after the
    /// StepExecutor (which owned the original) has stopped.
    pending_metadata: HashMap<String, AgentConfig>,
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
            provider_binaries: args.provider_binaries,
            shell_path: args.shell_path,
            running_executors: HashMap::new(),
            pending_metadata: HashMap::new(),
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
                step_config,
                worktree,
            } => {
                self.handle_execute_step(
                    myself.clone(),
                    &execution_id,
                    &task_id,
                    *step_config,
                    worktree,
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
            ProjectAction::RunStep => match parse_run_step_payload(&msg.payload) {
                Ok(payload) => {
                    tracing::info!(
                        "[project:{}] run_step received: execution_id={}, task_id={}",
                        state.project_id,
                        payload.id,
                        payload.task_id,
                    );

                    let verbose = payload.verbose_daemon_logging;

                    // Verbose checkpoint 1: raw RunStepPayload — confirms whether
                    // output_schema arrived from Sacrum at all (and what shape it has).
                    if verbose {
                        let output_schema_json = payload
                            .output_schema
                            .as_ref()
                            .map(|v| {
                                serde_json::to_string(v)
                                    .unwrap_or_else(|_| "<unserializable>".to_string())
                            })
                            .unwrap_or_else(|| "<absent>".to_string());
                        tracing::info!(
                            target: VERBOSE_LOG_TARGET,
                            execution_id = %payload.id,
                            task_id = %payload.task_id,
                            checkpoint = CHECKPOINT_RUN_STEP_PAYLOAD,
                            output_schema_present = payload.output_schema.is_some(),
                            output_schema = %output_schema_json,
                            agents = ?payload.agents,
                            skills = ?payload.skills,
                            "verbose: parsed run_step payload"
                        );
                    }

                    let step_config = build_step_config_from_payload(&payload);

                    // Verbose checkpoint 2: post build_step_config_from_payload —
                    // confirms whether output_schema merged into agent_config.json_schema.
                    if verbose {
                        let json_schema_json = step_config
                            .agent_config
                            .json_schema
                            .as_ref()
                            .map(|v| {
                                serde_json::to_string(v)
                                    .unwrap_or_else(|_| "<unserializable>".to_string())
                            })
                            .unwrap_or_else(|| "<absent>".to_string());
                        tracing::info!(
                            target: VERBOSE_LOG_TARGET,
                            execution_id = %payload.id,
                            task_id = %payload.task_id,
                            checkpoint = CHECKPOINT_STEP_CONFIG_BUILT,
                            json_schema_present = step_config.agent_config.json_schema.is_some(),
                            json_schema = %json_schema_json,
                            model = ?step_config.agent_config.model,
                            "verbose: resolved agent_config after build_step_config_from_payload"
                        );
                    }

                    let worktree = payload.worktree.map(PathBuf::from);

                    if let Err(e) = myself.cast(ProjectMessage::ExecuteStep {
                        execution_id: payload.id,
                        task_id: payload.task_id,
                        step_config: Box::new(step_config),
                        worktree,
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
            },
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
        step_config: StepConfig,
        worktree: Option<PathBuf>,
        state: &mut ProjectState,
    ) -> Result<(), ActorProcessingErr> {
        tracing::info!(
            "[project:{}] Executing step: execution_id={}, task_id={}",
            state.project_id,
            execution_id,
            task_id
        );

        let running_params = attach_resolved_metadata(
            UpdateExecutionStatusParams::new(ExecutionStatus::InProgress),
            &step_config.agent_config,
        );

        if let Err(e) = state
            .services
            .executions()
            .update_execution_status(execution_id, running_params)
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

        state
            .pending_metadata
            .insert(execution_id.to_string(), step_config.agent_config.clone());

        let executor_config = StepExecutorConfig {
            execution_id: execution_id.to_string(),
            task_id: task_id.to_string(),
            step_config,
            project_root: state.project_root.clone(),
            worktree,
            provider_binaries: state.provider_binaries.clone(),
            shell_path: state.shell_path.clone(),
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
                    state.pending_metadata.remove(execution_id);
                }
            }
            Err(e) => {
                tracing::error!(
                    "[project:{}] Failed to spawn StepExecutor for execution {}: {}",
                    state.project_id,
                    execution_id,
                    e
                );

                let agent_config = state.pending_metadata.remove(execution_id);
                let mut failure_params = UpdateExecutionStatusParams::new(ExecutionStatus::Failed)
                    .with_output(format!("Failed to spawn executor: {e}"));
                if let Some(cfg) = agent_config.as_ref() {
                    failure_params = attach_resolved_metadata(failure_params, cfg);
                }
                let _ = state
                    .services
                    .executions()
                    .update_execution_status(execution_id, failure_params)
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
        let agent_config = state.pending_metadata.remove(execution_id);

        match result {
            StepResult::Completed {
                exit_code,
                metrics,
                output,
            } => {
                tracing::info!(
                    "[project:{}] Step completed: execution_id={}, task_id={}, exit_code={}, metrics={:?}, has_output={}",
                    state.project_id,
                    execution_id,
                    task_id,
                    exit_code,
                    metrics,
                    output.is_some(),
                );

                // Build update params, populating metrics and output when available.
                let mut params = UpdateExecutionStatusParams::new(ExecutionStatus::Completed);

                if let Some(m) = metrics {
                    params = params
                        .with_input_tokens(m.input_tokens)
                        .with_output_tokens(m.output_tokens)
                        .with_cost(m.cost_usd.to_string())
                        .with_duration_ms(m.duration_ms);
                }

                if let Some(text) = output {
                    params = params.with_output(text);
                }

                if let Some(cfg) = agent_config.as_ref() {
                    params = attach_resolved_metadata(params, cfg);
                }

                // Report completed status to Sacrum via updateStepExecution.
                if let Err(e) = state
                    .services
                    .executions()
                    .update_execution_status(execution_id, params)
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
            StepResult::Failed {
                exit_code,
                error,
                schema_errors,
            } => {
                tracing::warn!(
                    "[project:{}] Step failed: execution_id={}, task_id={}, exit_code={:?}, error={}, schema_errors={}",
                    state.project_id,
                    execution_id,
                    task_id,
                    exit_code,
                    error,
                    schema_errors.as_ref().map(|e| e.len()).unwrap_or(0),
                );

                let output_payload = build_failure_output_payload(error, schema_errors.as_deref());

                let mut params = UpdateExecutionStatusParams::new(ExecutionStatus::Failed)
                    .with_output(output_payload);
                if let Some(cfg) = agent_config.as_ref() {
                    params = attach_resolved_metadata(params, cfg);
                }
                if let Err(e) = state
                    .services
                    .executions()
                    .update_execution_status(execution_id, params)
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
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
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
            step_config: Box::new(StepConfig {
                prompt: "Implement feature".to_string(),
                agent_config: AgentConfig::new().with_model("claude-sonnet-4-20250514"),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            }),
            worktree: None,
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("ExecuteStep"));
        assert!(debug.contains("exec-789"));
        assert!(debug.contains("task-xyz"));
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
            result: StepResult::Completed {
                exit_code: 0,
                metrics: None,
                output: None,
            },
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("StepFinished"));
        assert!(debug.contains("exec-123"));
        assert!(debug.contains("task-abc"));
        assert!(debug.contains("Completed"));
    }

    #[test]
    fn project_message_debug_step_finished_completed_with_output() {
        let pm = ProjectMessage::StepFinished {
            execution_id: "exec-out-1".to_string(),
            task_id: "task-out-1".to_string(),
            result: StepResult::Completed {
                exit_code: 0,
                metrics: None,
                output: Some("Task completed successfully".to_string()),
            },
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("Completed"));
        assert!(debug.contains("Task completed successfully"));
    }

    #[test]
    fn project_message_debug_step_finished_failed() {
        let pm = ProjectMessage::StepFinished {
            execution_id: "exec-456".to_string(),
            task_id: "task-def".to_string(),
            result: StepResult::failed(Some(1), "process crashed"),
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
            "prompt": "Implement the feature",
            "agents": ["agent1"],
            "skills": ["skill1", "skill2"],
            "agent_config": {"model": "claude-opus-4-20250514"}
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert_eq!(result.id, "exec-uuid-1");
        assert_eq!(result.task_id, "task-uuid-1");
        assert_eq!(result.prompt.as_deref(), Some("Implement the feature"));
        assert_eq!(result.agents, vec!["agent1"]);
        assert_eq!(result.skills, vec!["skill1", "skill2"]);
        assert_eq!(
            result.agent_config.get("model").and_then(|v| v.as_str()),
            Some("claude-opus-4-20250514")
        );
    }

    #[test]
    fn parse_run_step_minimal_payload() {
        let payload = serde_json::json!({
            "id": "exec-uuid-2",
            "task_id": "task-uuid-2"
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert_eq!(result.id, "exec-uuid-2");
        assert_eq!(result.task_id, "task-uuid-2");
        assert!(result.prompt.is_none());
        assert!(result.agents.is_empty());
        assert!(result.skills.is_empty());
        assert_eq!(result.agent_config, serde_json::Value::Null);
    }

    #[test]
    fn parse_run_step_missing_required_field() {
        let payload = serde_json::json!({
            "id": "exec-uuid-3"
            // missing task_id
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
    fn parse_run_step_ignores_unknown_fields() {
        let payload = serde_json::json!({
            "id": "exec-uuid-4",
            "task_id": "task-uuid-4",
            "workflow_id": "wf-uuid-4",
            "step_name": "deploy",
            "status": "pending",
            "goal": "Deploy to production",
            "context": {"title": "Some task"},
            "is_final": true,
            "transitions_to": ["next-step"]
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert_eq!(result.id, "exec-uuid-4");
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

    // ===== build_step_config_from_payload tests =====

    #[test]
    fn build_step_config_passes_prompt_through_directly() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-1",
            "task_id": "task-1",
            "prompt": "Implement JWT token validation\n\n## Task Context\n**Title:** JWT Auth",
            "agents": ["reviewer.md", "coder.md"],
            "skills": ["WebSearch", "Read"],
            "agent_config": {
                "model": "claude-opus-4-20250514",
                "max_budget_usd": 10.0,
                "append_system_prompt": "Be thorough",
                "disallowed_tools": ["Bash(rm*)"]
            }
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);

        assert_eq!(
            config.prompt,
            "Implement JWT token validation\n\n## Task Context\n**Title:** JWT Auth"
        );
        assert_eq!(
            config.agent_config.model,
            Some("claude-opus-4-20250514".to_string())
        );
        assert_eq!(config.agent_config.max_budget_usd, Some(10.0));
        assert_eq!(
            config.agent_config.append_system_prompt,
            Some("Be thorough".to_string())
        );
        assert_eq!(
            config.agent_config.disallowed_tools,
            vec!["Bash(rm*)".to_string()]
        );
        assert_eq!(config.agents, vec!["reviewer.md", "coder.md"]);
        assert_eq!(config.skills, vec!["WebSearch", "Read"]);
    }

    #[test]
    fn build_step_config_falls_back_when_no_prompt() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-2",
            "task_id": "task-2"
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);

        assert_eq!(config.prompt, "Execute step");
        assert!(config.agent_config.model.is_none());
        assert!(config.agents.is_empty());
        assert!(config.skills.is_empty());
        assert!(config.agent_config.is_empty());
    }

    #[test]
    fn build_step_config_falls_back_when_prompt_is_empty() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-3",
            "task_id": "task-3",
            "prompt": ""
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);
        assert_eq!(config.prompt, "Execute step");
    }

    #[test]
    fn build_step_config_model_only_agent_config() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-4",
            "task_id": "task-4",
            "agent_config": {"model": "haiku"}
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);
        assert_eq!(config.agent_config.model, Some("haiku".to_string()));
        assert!(config.agent_config.max_budget_usd.is_none());
    }

    #[test]
    fn build_step_config_with_permission_mode() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-5",
            "task_id": "task-5",
            "agent_config": {
                "permission_mode": "plan"
            }
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);
        assert_eq!(
            config.agent_config.permission_mode,
            Some(vertebrae_core::models::PermissionMode::Plan)
        );
    }

    #[test]
    fn build_step_config_empty_object_agent_config() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-6",
            "task_id": "task-6",
            "agent_config": {}
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);
        assert!(config.agent_config.is_empty());
    }

    // ===== RunStepPayload worktree tests =====

    #[test]
    fn parse_run_step_payload_with_worktree() {
        let payload = serde_json::json!({
            "id": "exec-wt-1",
            "task_id": "task-wt-1",
            "worktree": "/home/user/code/project-worktree-abc"
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert_eq!(
            result.worktree.as_deref(),
            Some("/home/user/code/project-worktree-abc")
        );
    }

    #[test]
    fn parse_run_step_payload_without_worktree() {
        let payload = serde_json::json!({
            "id": "exec-wt-2",
            "task_id": "task-wt-2"
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert!(
            result.worktree.is_none(),
            "worktree should default to None when absent"
        );
    }

    #[test]
    fn parse_run_step_payload_with_null_worktree() {
        let payload = serde_json::json!({
            "id": "exec-wt-3",
            "task_id": "task-wt-3",
            "worktree": null
        });

        let result = parse_run_step_payload(&payload).unwrap();
        assert!(
            result.worktree.is_none(),
            "worktree should be None when explicitly null"
        );
    }

    #[test]
    fn project_message_debug_execute_step_with_worktree() {
        let pm = ProjectMessage::ExecuteStep {
            execution_id: "exec-wt".to_string(),
            task_id: "task-wt".to_string(),
            step_config: Box::new(StepConfig {
                prompt: "Implement in worktree".to_string(),
                agent_config: AgentConfig::default(),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            }),
            worktree: Some(PathBuf::from("/home/user/code/worktree-abc")),
        };
        let debug = format!("{:?}", pm);
        assert!(debug.contains("worktree-abc"));
    }

    // ===== output_schema tests =====

    #[test]
    fn parse_run_step_payload_deserializes_output_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "summary": { "type": "string" },
                "score": { "type": "integer" }
            },
            "required": ["summary", "score"]
        });

        let payload = serde_json::json!({
            "id": "exec-os-1",
            "task_id": "task-os-1",
            "prompt": "Evaluate the code",
            "output_schema": schema
        });

        let result = parse_run_step_payload(&payload).unwrap();
        let os = result
            .output_schema
            .expect("output_schema should be present");
        assert_eq!(os["type"], "object");
        assert_eq!(os["properties"]["summary"]["type"], "string");
        assert_eq!(os["properties"]["score"]["type"], "integer");
        assert_eq!(os["required"], serde_json::json!(["summary", "score"]));
    }

    #[test]
    fn parse_run_step_payload_output_schema_defaults_to_none() {
        let absent = parse_run_step_payload(&serde_json::json!({
            "id": "exec-os-2",
            "task_id": "task-os-2"
        }))
        .unwrap();
        assert!(
            absent.output_schema.is_none(),
            "absent key should default to None"
        );

        let explicit_null = parse_run_step_payload(&serde_json::json!({
            "id": "exec-os-3",
            "task_id": "task-os-3",
            "output_schema": null
        }))
        .unwrap();
        assert!(
            explicit_null.output_schema.is_none(),
            "explicit null should be None"
        );
    }

    #[test]
    fn build_step_config_sets_json_schema_when_output_schema_present() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "result": { "type": "string" }
            }
        });

        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-os-4",
            "task_id": "task-os-4",
            "output_schema": schema
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);
        let json_schema = config
            .agent_config
            .json_schema
            .expect("json_schema should be set from output_schema");
        assert_eq!(json_schema["type"], "object");
        assert_eq!(json_schema["properties"]["result"]["type"], "string");
    }

    #[test]
    fn build_step_config_leaves_json_schema_none_when_output_schema_absent() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-os-5",
            "task_id": "task-os-5"
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);
        assert!(
            config.agent_config.json_schema.is_none(),
            "json_schema should be None when output_schema is absent"
        );
    }

    #[test]
    fn build_step_config_ignores_null_output_schema() {
        let payload = RunStepPayload {
            id: "exec-os-null".to_string(),
            task_id: "task-os-null".to_string(),
            prompt: None,
            agent_config: serde_json::json!({}),
            agents: Vec::new(),
            skills: Vec::new(),
            worktree: None,
            output_schema: Some(serde_json::Value::Null),
            verbose_daemon_logging: false,
        };

        let config = build_step_config_from_payload(&payload);
        assert!(
            config.agent_config.json_schema.is_none(),
            "Value::Null output_schema should not be merged into agent_config"
        );
    }

    #[test]
    fn build_step_config_output_schema_takes_precedence_over_agent_config_json_schema() {
        let agent_schema = serde_json::json!({
            "type": "object",
            "properties": {
                "old_field": { "type": "string" }
            }
        });
        let output_schema = serde_json::json!({
            "type": "object",
            "properties": {
                "new_field": { "type": "integer" }
            }
        });

        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-os-6",
            "task_id": "task-os-6",
            "agent_config": {
                "json_schema": agent_schema
            },
            "output_schema": output_schema
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);
        let json_schema = config
            .agent_config
            .json_schema
            .expect("json_schema should be set");

        // output_schema should win over agent_config.json_schema
        assert!(
            json_schema["properties"].get("new_field").is_some(),
            "json_schema should contain the output_schema's new_field"
        );
        assert!(
            json_schema["properties"].get("old_field").is_none(),
            "json_schema should NOT contain the agent_config's old_field"
        );
        assert_eq!(json_schema["properties"]["new_field"]["type"], "integer");
    }

    #[test]
    fn build_step_config_preserves_agent_config_json_schema_when_no_output_schema() {
        let agent_schema = serde_json::json!({
            "type": "object",
            "properties": {
                "agent_field": { "type": "boolean" }
            }
        });

        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-os-7",
            "task_id": "task-os-7",
            "agent_config": {
                "json_schema": agent_schema
            }
        }))
        .unwrap();

        let config = build_step_config_from_payload(&payload);
        let json_schema = config
            .agent_config
            .json_schema
            .expect("json_schema from agent_config should be preserved");
        assert_eq!(json_schema["properties"]["agent_field"]["type"], "boolean");
    }

    // ===== build_failure_output_payload tests =====

    #[test]
    fn failure_payload_without_schema_errors_is_plain_string() {
        let payload = build_failure_output_payload("process exited with code 2", None);
        assert_eq!(payload, "process exited with code 2");
    }

    #[test]
    fn failure_payload_with_schema_errors_is_structured_json() {
        let errors = vec![
            SchemaValidationError {
                instance_path: "/summary".to_string(),
                schema_path: "/properties/summary/type".to_string(),
                message: "42 is not of type \"string\"".to_string(),
            },
            SchemaValidationError {
                instance_path: "/passed".to_string(),
                schema_path: "/properties/passed/type".to_string(),
                message: "\"yes\" is not of type \"boolean\"".to_string(),
            },
        ];
        let payload = build_failure_output_payload(
            "step output violated output_schema (2 error(s))",
            Some(&errors),
        );

        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(parsed["kind"], "schema_validation_failure");
        assert_eq!(
            parsed["error"],
            "step output violated output_schema (2 error(s))"
        );
        let errs = parsed["schema_errors"]
            .as_array()
            .expect("schema_errors should be an array");
        assert_eq!(errs.len(), 2);
        assert_eq!(errs[0]["instance_path"], "/summary");
        assert_eq!(errs[0]["schema_path"], "/properties/summary/type");
        assert_eq!(errs[0]["message"], "42 is not of type \"string\"");
        assert_eq!(errs[1]["instance_path"], "/passed");
    }

    #[test]
    fn failure_payload_with_empty_schema_errors_still_structured() {
        // An empty slice still signals a schema-validation failure, so we keep
        // the structured wrapper rather than degrading to a plain string.
        let payload = build_failure_output_payload("some validation error", Some(&[]));
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(parsed["kind"], "schema_validation_failure");
        assert_eq!(parsed["schema_errors"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn end_to_end_schema_violation_preserves_structured_detail() {
        use crate::output_validator::{CompiledSchema, SchemaError};

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "passed": {"type": "boolean"}
            },
            "required": ["summary", "passed"]
        });
        let compiled = CompiledSchema::compile(&schema).expect("schema must compile");

        let result_text =
            "Here is my answer:\n\n```json\n{\"summary\":42,\"passed\":\"nope\"}\n```";

        let err = compiled
            .validate_output(None, Some(result_text))
            .expect_err("must fail validation");
        let summary = err.summary();
        let schema_errors = match err {
            SchemaError::SchemaViolation(list) => list,
            other => panic!("expected SchemaViolation, got {other:?}"),
        };

        let failed = StepResult::failed_schema(summary, schema_errors.clone());

        let (error_msg, errs) = match &failed {
            StepResult::Failed {
                error,
                schema_errors,
                ..
            } => (error.clone(), schema_errors.clone()),
            _ => panic!("expected Failed"),
        };
        let payload = build_failure_output_payload(&error_msg, errs.as_deref());

        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(parsed["kind"], "schema_validation_failure");
        let errs_json = parsed["schema_errors"]
            .as_array()
            .expect("schema_errors should be an array");
        assert_eq!(errs_json.len(), schema_errors.len());
        let paths: Vec<&str> = errs_json
            .iter()
            .map(|e| e["instance_path"].as_str().unwrap())
            .collect();
        assert!(
            paths.iter().any(|p| p.contains("summary")),
            "expected /summary in paths: {paths:?}"
        );
        assert!(
            paths.iter().any(|p| p.contains("passed")),
            "expected /passed in paths: {paths:?}"
        );
    }

    // ===== verbose_daemon_logging tests =====

    #[test]
    fn parse_run_step_payload_omitted_verbose_flag_defaults_to_false() {
        // Backward-compat: a Sacrum payload without the field at all must
        // deserialize and yield false (this is the pre-PR-58 daemon behavior).
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-vrb-1",
            "task_id": "task-vrb-1"
        }))
        .expect("payload without verbose_daemon_logging must parse");
        assert!(
            !payload.verbose_daemon_logging,
            "missing key must default to false"
        );
    }

    #[test]
    fn parse_run_step_payload_explicit_true_verbose_flag_round_trips() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-vrb-2",
            "task_id": "task-vrb-2",
            "verbose_daemon_logging": true
        }))
        .expect("payload with verbose_daemon_logging=true must parse");
        assert!(
            payload.verbose_daemon_logging,
            "explicit true must round-trip as true"
        );
    }

    #[test]
    fn parse_run_step_payload_explicit_false_verbose_flag_is_false() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-vrb-3",
            "task_id": "task-vrb-3",
            "verbose_daemon_logging": false
        }))
        .expect("payload with verbose_daemon_logging=false must parse");
        assert!(!payload.verbose_daemon_logging);
    }

    #[test]
    fn build_step_config_propagates_verbose_flag_when_true() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-vrb-4",
            "task_id": "task-vrb-4",
            "verbose_daemon_logging": true
        }))
        .unwrap();
        let config = build_step_config_from_payload(&payload);
        assert!(
            config.verbose_daemon_logging,
            "StepConfig must carry verbose_daemon_logging=true from payload"
        );
    }

    #[test]
    fn build_step_config_propagates_verbose_flag_when_false() {
        let payload = parse_run_step_payload(&serde_json::json!({
            "id": "exec-vrb-5",
            "task_id": "task-vrb-5"
        }))
        .unwrap();
        let config = build_step_config_from_payload(&payload);
        assert!(
            !config.verbose_daemon_logging,
            "StepConfig must default verbose_daemon_logging to false"
        );
    }

    // =========================================================================
    // resolved_execution_metadata tests
    // =========================================================================

    #[test]
    fn resolved_metadata_defaults_provider_to_anthropic_when_unset() {
        let agent_config = AgentConfig::default();
        let (provider, model) = resolved_execution_metadata(&agent_config);
        assert_eq!(provider, Provider::Anthropic);
        assert!(model.is_none());
    }

    #[test]
    fn resolved_metadata_uses_explicit_openai_provider_with_codex_model() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-5");
        let (provider, model) = resolved_execution_metadata(&agent_config);
        assert_eq!(provider, Provider::Openai);
        assert_eq!(model.as_deref(), Some("gpt-5"));
    }

    #[test]
    fn resolved_metadata_uses_explicit_anthropic_provider_with_claude_model() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Anthropic)
            .with_model("claude-sonnet-4-5");
        let (provider, model) = resolved_execution_metadata(&agent_config);
        assert_eq!(provider, Provider::Anthropic);
        assert_eq!(model.as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn resolved_metadata_treats_blank_model_as_unset() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Anthropic)
            .with_model("   ");
        let (provider, model) = resolved_execution_metadata(&agent_config);
        assert_eq!(provider, Provider::Anthropic);
        assert!(
            model.is_none(),
            "blank/whitespace-only model must be treated as unset"
        );
    }

    #[test]
    fn resolved_metadata_does_not_infer_provider_from_model_name() {
        // Provider must come from agent_config.provider, not from a model-name
        // classifier. Default-to-Anthropic applies even for Codex-shaped names.
        let agent_config = AgentConfig::new().with_model("gpt-5");
        let (provider, model) = resolved_execution_metadata(&agent_config);
        assert_eq!(
            provider,
            Provider::Anthropic,
            "provider must come from agent_config, not from the model string"
        );
        assert_eq!(model.as_deref(), Some("gpt-5"));
    }

    #[test]
    fn attach_resolved_metadata_sets_provider_and_model_on_params() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-5");
        let params = attach_resolved_metadata(
            UpdateExecutionStatusParams::new(ExecutionStatus::InProgress),
            &agent_config,
        );
        assert_eq!(params.model.as_deref(), Some("gpt-5"));
        assert_eq!(params.model_provider.as_deref(), Some("openai"));
    }

    #[test]
    fn attach_resolved_metadata_sets_default_provider_without_model() {
        let agent_config = AgentConfig::default();
        let params = attach_resolved_metadata(
            UpdateExecutionStatusParams::new(ExecutionStatus::InProgress),
            &agent_config,
        );
        assert_eq!(params.model_provider.as_deref(), Some("anthropic"));
        assert!(
            params.model.is_none(),
            "no model in agent_config means no model on the update params"
        );
    }

    #[test]
    fn attach_resolved_metadata_preserves_existing_metric_fields() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Anthropic)
            .with_model("claude-sonnet-4-5");
        let params = UpdateExecutionStatusParams::new(ExecutionStatus::Completed)
            .with_input_tokens(1500)
            .with_output_tokens(800)
            .with_cost("0.0123")
            .with_duration_ms(4321)
            .with_output("done");
        let params = attach_resolved_metadata(params, &agent_config);
        assert_eq!(params.input_tokens, Some(1500));
        assert_eq!(params.output_tokens, Some(800));
        assert_eq!(params.cost.as_deref(), Some("0.0123"));
        assert_eq!(params.duration_ms, Some(4321));
        assert_eq!(params.output.as_deref(), Some("done"));
        assert_eq!(params.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(params.model_provider.as_deref(), Some("anthropic"));
    }
}
