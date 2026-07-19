//! StepExecutor - per-step actor that runs a provider harness for one workflow step.
//!
//! Spawned by ProjectSupervisor upon receiving an execute_step channel event from Sacrum.
//! Each StepExecutor:
//! - Receives step config (prompt, model), execution_id, and task_id from its parent
//! - Runs Claude and Codex through shared harness crates and persists normalized events
//! - Reports StepCompleted or StepFailed to the parent ProjectSupervisor on exit
//! - Cancels the active harness and awaits harness settlement
//!
//! Orchestration (step ordering, parallel vs serial, retry logic) lives entirely
//! in Sacrum/Elixir -- the daemon just executes what it is told.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use ractor::{Actor, ActorProcessingErr, ActorRef};
use vertebrae_core::Provider;
use vertebrae_core::execution_service::ExecutionService;
use vertebrae_core::models::{AgentConfig, PermissionMode};
use vertebrae_harness::{HarnessFactoryConfig, HarnessRuntimeFactory, HarnessRuntimeOptions};
use vertebrae_harness_core::{
    CompletionStatus, ControlDecision, ControlRequest, ControlRequestEnvelope, ControlResolution,
    ControlSink, EventSink, GrantScope, HarnessError, HarnessEventPayloadV1, HarnessEventV1,
    RequestConfig, ResolutionSource, RunHandle, RunOutcome, SessionUsage, StreamId,
};

use crate::actors::project_supervisor::{ProjectMessage, VERBOSE_LOG_TARGET};
use crate::helpers::ProviderBinaries;
use crate::output_validator::{CompiledSchema, SchemaError, SchemaValidationError};
use crate::session_log_event_sink::SessionLogEventSink;
use crate::settings_synthesis::SyntheticSettings;

/// Default model used when agent_config does not specify one.
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";

pub const CHECKPOINT_CLAUDE_ARGV: &str = "claude_argv";
pub const CHECKPOINT_CLAUDE_STDERR: &str = "claude_stderr";
pub const CHECKPOINT_STREAM_JSON_INIT: &str = "stream_json_init";
const CANCELLED_TERMINAL_PERSISTENCE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(250);

#[derive(Debug, Clone)]
pub struct StepConfig {
    pub prompt: String,
    /// Full agent configuration (model, allowed_tools, permission_mode, etc.)
    pub agent_config: AgentConfig,
    /// Agent file paths/names to pass as --agent flags.
    pub agents: Vec<String>,
    /// Skill names to pass as --allowedTools flags.
    pub skills: Vec<String>,
    /// When true, the executor emits detailed diagnostic logs at the
    /// build/spawn/stream checkpoints. Defaults to false; toggled per-step
    /// from the Sacrum `run_step` payload.
    pub verbose_daemon_logging: bool,
}

#[derive(Debug, Clone)]
pub enum StepResult {
    Completed {
        exit_code: i32,
        metrics: Option<crate::stream_json::StreamMetrics>,
        output: Option<String>,
    },
    Failed {
        exit_code: Option<i32>,
        error: String,
        schema_errors: Option<Vec<SchemaValidationError>>,
    },
}

impl StepResult {
    pub(crate) fn failed(exit_code: Option<i32>, error: impl Into<String>) -> Self {
        Self::Failed {
            exit_code,
            error: error.into(),
            schema_errors: None,
        }
    }

    pub(crate) fn failed_schema(
        error: impl Into<String>,
        schema_errors: Vec<SchemaValidationError>,
    ) -> Self {
        Self::Failed {
            exit_code: None,
            error: error.into(),
            schema_errors: Some(schema_errors),
        }
    }
}

/// Configuration for spawning a StepExecutor actor.
pub struct StepExecutorConfig {
    pub execution_id: String,
    pub task_id: String,
    pub step_config: StepConfig,
    pub project_root: PathBuf,
    /// Optional worktree path override. When set, used as current_dir instead of project_root.
    pub worktree: Option<PathBuf>,
    /// Provider CLI binaries resolved at daemon startup. Each entry is
    /// `Some` when the binary was found; `None` when it was not. The shared
    /// runtime factory receives these deployment hints and reports an
    /// unavailable provider before attempting to start a process.
    pub provider_binaries: ProviderBinaries,
    /// The user's full login shell PATH for the child process.
    pub shell_path: String,
    pub execution_service: Arc<dyn ExecutionService>,
}

impl StepExecutorConfig {
    /// Returns the effective working directory: worktree if set, otherwise project_root.
    pub(crate) fn working_dir(&self) -> &Path {
        self.worktree.as_deref().unwrap_or(&self.project_root)
    }
}

impl std::fmt::Debug for StepExecutorConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StepExecutorConfig")
            .field("execution_id", &self.execution_id)
            .field("task_id", &self.task_id)
            .field("step_config", &self.step_config)
            .field("project_root", &self.project_root)
            .field("worktree", &self.worktree)
            .field("provider_binaries", &self.provider_binaries)
            .field("execution_service", &"<ExecutionService>")
            .finish()
    }
}

pub enum StepExecutorMessage {
    Execute,
    Cancel,
    HarnessSettled(Box<Result<RunOutcome, String>>),
}

impl std::fmt::Debug for StepExecutorMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Execute => write!(f, "Execute"),
            Self::Cancel => write!(f, "Cancel"),
            Self::HarnessSettled(result) => f.debug_tuple("HarnessSettled").field(result).finish(),
        }
    }
}

#[derive(Default)]
struct HarnessUsageMetrics {
    input_tokens: u64,
    output_tokens: u64,
    cost_microusd: u64,
    turn_deltas: u64,
    session_snapshot: Option<SessionUsage>,
}

struct DaemonHarnessEventSink {
    persistence: Arc<dyn EventSink>,
    root_stream_id: StreamId,
    usage: Arc<std::sync::Mutex<HarnessUsageMetrics>>,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
    execution_id: String,
    task_id: String,
    verbose: bool,
}

#[async_trait]
impl EventSink for DaemonHarnessEventSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        if self.verbose {
            match &event.payload {
                HarnessEventPayloadV1::SessionStarted(started) => tracing::info!(
                    target: VERBOSE_LOG_TARGET,
                    execution_id = %self.execution_id,
                    task_id = %self.task_id,
                    checkpoint = CHECKPOINT_STREAM_JSON_INIT,
                    session_id = ?started.provider_resume_id,
                    tools = ?started.tools,
                    structured_output_advertised = started.tools.iter().any(|tool| tool == "StructuredOutput"),
                    "verbose: Claude harness session started"
                ),
                HarnessEventPayloadV1::Warning(diagnostic)
                | HarnessEventPayloadV1::Error(diagnostic)
                    if diagnostic.code.as_deref() == Some("claude_stderr") =>
                {
                    tracing::info!(
                        target: VERBOSE_LOG_TARGET,
                        execution_id = %self.execution_id,
                        task_id = %self.task_id,
                        checkpoint = CHECKPOINT_CLAUDE_STDERR,
                        line = %diagnostic.message,
                        "verbose: Claude harness stderr"
                    );
                }
                _ => {}
            }
        }
        // Only durable normalized events contribute to the daemon's legacy
        // StepResult metrics. Terminal RunOutcome.usage is informational and
        // intentionally ignored to avoid counting the same turn twice.
        let normalized_usage = match &event.payload {
            HarnessEventPayloadV1::Usage(usage) if event.stream_id == self.root_stream_id => {
                Some((usage.turn_delta.clone(), usage.session_snapshot.clone()))
            }
            _ => None,
        };
        let mut cancel_rx = self.cancel_rx.clone();
        if *cancel_rx.borrow() {
            if matches!(&event.payload, HarnessEventPayloadV1::RunFinished(_)) {
                return tokio::time::timeout(
                    CANCELLED_TERMINAL_PERSISTENCE_TIMEOUT,
                    self.persistence.emit(event),
                )
                .await
                .map_err(|_| {
                    HarnessError::EventSink(
                        "daemon cancelled while persisting the terminal harness event".into(),
                    )
                })?;
            }
            return Err(HarnessError::EventSink(
                "daemon cancelled while persisting a harness event".into(),
            ));
        }
        tokio::select! {
            result = self.persistence.emit(event) => result?,
            _ = cancel_rx.changed() => {
                return Err(HarnessError::EventSink(
                    "daemon cancelled while persisting a harness event".into(),
                ));
            }
        }
        if let Some((turn_delta, session_snapshot)) = normalized_usage {
            let mut usage = self
                .usage
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(delta) = turn_delta {
                usage.input_tokens = usage.input_tokens.saturating_add(delta.tokens.input_tokens);
                usage.output_tokens = usage
                    .output_tokens
                    .saturating_add(delta.tokens.output_tokens);
                usage.cost_microusd = usage.cost_microusd.saturating_add(delta.cost_microusd);
                usage.turn_deltas = usage.turn_deltas.saturating_add(1);
            }
            if let Some(snapshot) = session_snapshot {
                usage.session_snapshot = Some(snapshot);
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
struct DaemonControlSink {
    permission_mode: PermissionMode,
}

impl DaemonControlSink {
    fn from_agent_config(agent_config: &AgentConfig) -> Self {
        Self {
            permission_mode: agent_config
                .permission_mode
                .clone()
                .unwrap_or(PermissionMode::BypassPermissions),
        }
    }
}

#[async_trait]
impl ControlSink for DaemonControlSink {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        if matches!(request.request, ControlRequest::UserQuestion { .. }) {
            return Err(HarnessError::Control(
                "daemon workflow runs cannot answer interactive Claude questions".into(),
            ));
        }
        let decision = request.automatic_resolution.unwrap_or_else(|| {
            match (&self.permission_mode, &request.request) {
                (PermissionMode::BypassPermissions, ControlRequest::PermissionGrant(grant)) => {
                    ControlDecision::PermissionsGranted {
                        permissions: grant.permissions.clone(),
                        scope: GrantScope::Turn,
                    }
                }
                (PermissionMode::BypassPermissions, _) => ControlDecision::AllowOnce,
                _ => ControlDecision::Deny,
            }
        });
        let message = if matches!(decision, ControlDecision::Deny) {
            "denied by daemon permission mode"
        } else {
            "resolved by daemon automatic control policy"
        };
        Ok(ControlResolution {
            request_id: request.request_id,
            source: ResolutionSource::Consumer,
            decision: Some(decision),
            message: Some(message.into()),
        })
    }
}

pub struct StepExecutorState {
    execution_id: String,
    task_id: String,
    config: StepExecutorConfig,
    parent: ActorRef<ProjectMessage>,
    harness_run: Option<Arc<dyn RunHandle>>,
    harness_outcome_handle: Option<tokio::task::JoinHandle<()>>,
    harness_usage: Arc<std::sync::Mutex<HarnessUsageMetrics>>,
    harness_cancel_tx: tokio::sync::watch::Sender<bool>,
    compiled_schema: Option<Result<CompiledSchema, SchemaError>>,
    /// Owns the temp dir for this execution's `--settings` bundle; dropped on stop.
    settings_guard: Option<SyntheticSettings>,
}

pub struct StepExecutor;

impl Actor for StepExecutor {
    type Msg = StepExecutorMessage;
    type State = StepExecutorState;
    type Arguments = (StepExecutorConfig, ActorRef<ProjectMessage>);

    async fn pre_start(
        &self,
        _myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        let (config, parent) = args;

        tracing::info!(
            "StepExecutor starting for execution {}, task {}",
            config.execution_id,
            config.task_id
        );

        let compiled_schema = config
            .step_config
            .agent_config
            .json_schema
            .as_ref()
            .map(CompiledSchema::compile);

        if let Some(Err(ref err)) = compiled_schema {
            tracing::error!(
                "Failed to compile output_schema for execution {}: {}",
                config.execution_id,
                err
            );
        }

        let (harness_cancel_tx, _harness_cancel_rx) = tokio::sync::watch::channel(false);
        Ok(StepExecutorState {
            execution_id: config.execution_id.clone(),
            task_id: config.task_id.clone(),
            config,
            parent,
            harness_run: None,
            harness_outcome_handle: None,
            harness_usage: Arc::new(std::sync::Mutex::new(HarnessUsageMetrics::default())),
            harness_cancel_tx,
            compiled_schema,
            settings_guard: None,
        })
    }

    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            StepExecutorMessage::Execute => {
                self.handle_execute(myself, state).await?;
            }
            StepExecutorMessage::Cancel => {
                self.handle_cancel(myself, state).await;
            }
            StepExecutorMessage::HarnessSettled(result) => {
                self.handle_harness_settled(*result, myself, state).await;
            }
        }
        Ok(())
    }

    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        tracing::info!("StepExecutor stopping for execution {}", state.execution_id);

        let _ = state.harness_cancel_tx.send(true);
        if let Some(run) = state.harness_run.take() {
            let _ = run.cancel().await;
            if tokio::time::timeout(std::time::Duration::from_secs(10), run.await_outcome())
                .await
                .is_err()
            {
                tracing::error!(
                    "Timed out awaiting Claude harness cleanup for execution {}",
                    state.execution_id
                );
            }
        }
        if let Some(handle) = state.harness_outcome_handle.take() {
            handle.abort();
        }

        // Drop the settings guard after the harness has finished cleaning up.
        state.settings_guard.take();

        Ok(())
    }
}

/// Map an output-schema validation error onto the failed `StepResult`
/// variant -- preserving structured violation entries when available.
pub(crate) fn step_result_for_schema_error(err: SchemaError) -> StepResult {
    let summary = err.summary();
    match err {
        SchemaError::SchemaViolation(errors) => StepResult::failed_schema(summary, errors),
        _ => StepResult::failed(None, summary),
    }
}

impl StepExecutor {
    fn validate_output(
        &self,
        state: &StepExecutorState,
        structured_output: Option<&serde_json::Value>,
        output: Option<&str>,
    ) -> Result<(), SchemaError> {
        match &state.compiled_schema {
            None => Ok(()),
            Some(Err(compile_err)) => Err(compile_err.clone()),
            Some(Ok(schema)) => schema.validate_output(structured_output, output),
        }
    }

    async fn handle_execute(
        &self,
        myself: ActorRef<StepExecutorMessage>,
        state: &mut StepExecutorState,
    ) -> Result<(), ActorProcessingErr> {
        if state.harness_run.is_some() {
            tracing::warn!(
                "Execute received but harness already running for execution {}",
                state.execution_id
            );
            return Ok(());
        }

        tracing::info!(
            "Spawning provider CLI for execution {}, provider={:?}, model={:?}, working_dir={}",
            state.execution_id,
            state.config.step_config.agent_config.provider,
            state.config.step_config.agent_config.model,
            state.config.working_dir().display()
        );

        let provider = HarnessRuntimeFactory::provider_for(&state.config.step_config.agent_config);
        let settings_guard = if provider == Provider::Anthropic {
            match SyntheticSettings::create(&state.execution_id) {
                Ok(guard) => Some(guard),
                Err(err) => {
                    tracing::error!(
                        "Failed to synthesize daemon settings for execution {}: {}",
                        state.execution_id,
                        err
                    );
                    let _ = state.parent.cast(ProjectMessage::StepFinished {
                        execution_id: state.execution_id.clone(),
                        task_id: state.task_id.clone(),
                        result: StepResult::failed(
                            None,
                            format!("Failed to synthesize daemon settings: {err}"),
                        ),
                    });
                    myself.stop(Some("settings synthesis failed".to_string()));
                    return Ok(());
                }
            }
        } else {
            None
        };

        let mut agent_config = state.config.step_config.agent_config.clone();
        if provider == Provider::Anthropic && agent_config.model.is_none() {
            agent_config.model = Some(DEFAULT_MODEL.into());
        }
        for skill in &state.config.step_config.skills {
            if !agent_config.allowed_tools.contains(skill) {
                agent_config.allowed_tools.push(skill.clone());
            }
        }
        for tool in crate::settings_synthesis::SELF_TRANSITION_DENY_TOOLS {
            if !agent_config
                .disallowed_tools
                .iter()
                .any(|configured| configured == tool)
            {
                agent_config.disallowed_tools.push((*tool).into());
            }
        }

        let factory_config = HarnessFactoryConfig {
            anthropic_executable: state.config.provider_binaries.anthropic.clone(),
            openai_executable: state.config.provider_binaries.openai.clone(),
            search_path: Some(state.config.shell_path.clone().into()),
            installed_skills_roots: vertebrae_installer::installed_skills_dir()
                .ok()
                .into_iter()
                .collect(),
            claude_settings_path: settings_guard
                .as_ref()
                .map(SyntheticSettings::settings_path),
            claude_agent_paths: state
                .config
                .step_config
                .agents
                .iter()
                .map(PathBuf::from)
                .collect(),
            claude_root_locator_resolver: Some(Arc::new(
                vertebrae_harness::daemon_opaque_claude_locator,
            )),
            default_permission_mode: Some(PermissionMode::BypassPermissions),
            ..HarnessFactoryConfig::default()
        };
        let request_config = RequestConfig {
            working_directory: Some(state.config.working_dir().to_path_buf()),
            model: agent_config.model.clone(),
            reasoning_effort: agent_config.reasoning_effort.clone(),
            output_schema: agent_config.json_schema.clone(),
            environment: std::iter::once(("PATH".into(), state.config.shell_path.clone()))
                .collect(),
        };
        let instance =
            match HarnessRuntimeFactory::new(factory_config).create(HarnessRuntimeOptions {
                agent_config: agent_config.clone(),
                request_config,
            }) {
                Ok(instance) => instance,
                Err(error) => {
                    let _ = state.parent.cast(ProjectMessage::StepFinished {
                        execution_id: state.execution_id.clone(),
                        task_id: state.task_id.clone(),
                        result: StepResult::failed(
                            None,
                            format!("Provider resolution failed: {error}"),
                        ),
                    });
                    myself.stop(Some("provider resolution failed".into()));
                    return Ok(());
                }
            };
        let request = vertebrae_harness_core::RunRequest {
            run_id: vertebrae_harness_core::RunId::new(state.execution_id.clone()),
            stream_id: vertebrae_harness_core::StreamId::new(state.execution_id.clone()),
            prompt: state.config.step_config.prompt.clone(),
            config: instance.request_config,
        };
        if state.config.step_config.verbose_daemon_logging {
            tracing::info!(
                target: VERBOSE_LOG_TARGET,
                execution_id = %state.execution_id,
                task_id = %state.task_id,
                checkpoint = CHECKPOINT_CLAUDE_ARGV,
                provider = %instance.provider,
                "verbose: built provider harness through the shared runtime factory",
            );
        }

        let event_sink: Arc<dyn EventSink> = Arc::new(DaemonHarnessEventSink {
            persistence: Arc::new(SessionLogEventSink::new(
                &state.execution_id,
                Arc::clone(&state.config.execution_service),
            )),
            root_stream_id: request.stream_id.clone(),
            usage: Arc::clone(&state.harness_usage),
            cancel_rx: state.harness_cancel_tx.subscribe(),
            execution_id: state.execution_id.clone(),
            task_id: state.task_id.clone(),
            verbose: state.config.step_config.verbose_daemon_logging,
        });
        let control_sink: Arc<dyn ControlSink> =
            Arc::new(DaemonControlSink::from_agent_config(&agent_config));
        let run = match instance
            .runtime
            .run_once(request, event_sink, control_sink)
            .await
        {
            Ok(run) => run,
            Err(error) => {
                let _ = state.parent.cast(ProjectMessage::StepFinished {
                    execution_id: state.execution_id.clone(),
                    task_id: state.task_id.clone(),
                    result: StepResult::failed(None, format!("Failed to start harness: {error}")),
                });
                myself.stop(Some("harness start failed".into()));
                return Ok(());
            }
        };
        state.settings_guard = settings_guard;
        state.harness_run = Some(Arc::clone(&run));
        let actor_ref = myself;
        state.harness_outcome_handle = Some(tokio::spawn(async move {
            let result = run.await_outcome().await.map_err(|error| error.to_string());
            let _ = actor_ref.cast(StepExecutorMessage::HarnessSettled(Box::new(result)));
        }));
        Ok(())
    }

    async fn handle_cancel(
        &self,
        myself: ActorRef<StepExecutorMessage>,
        state: &mut StepExecutorState,
    ) {
        tracing::info!("Cancel requested for execution {}", state.execution_id);

        if let Some(run) = state.harness_run.as_ref() {
            match run.cancel().await {
                Ok(()) => {
                    // Interrupt persistence waits, but leave terminal status
                    // ownership to the harness RunOutcome.
                    let _ = state.harness_cancel_tx.send(true);
                }
                Err(error) => {
                    tracing::warn!(
                        "Failed to cancel Claude harness for execution {}: {}",
                        state.execution_id,
                        error
                    );
                }
            }
            // HarnessSettled is the single terminal boundary. The runtime
            // reaps the process and settles controls before publishing it.
            return;
        }

        let _ = state.parent.cast(ProjectMessage::StepFinished {
            execution_id: state.execution_id.clone(),
            task_id: state.task_id.clone(),
            result: StepResult::failed(None, "Cancelled"),
        });

        myself.stop(Some("cancelled".to_string()));
    }

    async fn handle_harness_settled(
        &self,
        result: Result<RunOutcome, String>,
        myself: ActorRef<StepExecutorMessage>,
        state: &mut StepExecutorState,
    ) {
        state.harness_run.take();
        state.harness_outcome_handle.take();

        let step_result = match result {
            Err(error) => StepResult::failed(None, error),
            Ok(outcome) => match outcome.status {
                CompletionStatus::Completed => {
                    match self.validate_output(
                        state,
                        outcome.structured_output.as_ref(),
                        outcome.result_text.as_deref(),
                    ) {
                        Err(error) => step_result_for_schema_error(error),
                        Ok(()) => {
                            let usage = state
                                .harness_usage
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            let normalized = if usage.turn_deltas > 0 {
                                Some((usage.input_tokens, usage.output_tokens, usage.cost_microusd))
                            } else {
                                usage.session_snapshot.as_ref().map(|snapshot| {
                                    (
                                        snapshot.tokens.input_tokens,
                                        snapshot.tokens.output_tokens,
                                        snapshot.cost_microusd,
                                    )
                                })
                            };
                            let metrics = normalized.map(|(input, output, cost)| {
                                crate::stream_json::StreamMetrics {
                                    input_tokens: i64::try_from(input).unwrap_or(i64::MAX),
                                    output_tokens: i64::try_from(output).unwrap_or(i64::MAX),
                                    cost_usd: outcome
                                        .metrics
                                        .total_cost_usd
                                        .unwrap_or(cost as f64 / 1_000_000.0),
                                    duration_ms: outcome
                                        .metrics
                                        .duration_ms
                                        .map(|value| i64::try_from(value).unwrap_or(i64::MAX))
                                        .unwrap_or_default(),
                                }
                            });
                            drop(usage);
                            let output = outcome
                                .structured_output
                                .as_ref()
                                .and_then(|value| serde_json::to_string_pretty(value).ok())
                                .or(outcome.result_text);
                            StepResult::Completed {
                                exit_code: 0,
                                metrics,
                                output,
                            }
                        }
                    }
                }
                CompletionStatus::Cancelled => StepResult::failed(None, "Cancelled"),
                CompletionStatus::Interrupted => StepResult::failed(None, "Interrupted"),
                CompletionStatus::Failed => StepResult::failed(
                    None,
                    outcome
                        .error
                        .or(outcome.result_text)
                        .unwrap_or_else(|| "Claude harness failed".into()),
                ),
            },
        };

        let _ = state.parent.cast(ProjectMessage::StepFinished {
            execution_id: state.execution_id.clone(),
            task_id: state.task_id.clone(),
            result: step_result,
        });
        myself.stop(Some("harness settled".into()));
    }
}
