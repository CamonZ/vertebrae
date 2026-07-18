//! StepExecutor - per-step actor that runs a provider harness for one workflow step.
//!
//! Spawned by ProjectSupervisor upon receiving an execute_step channel event from Sacrum.
//! Each StepExecutor:
//! - Receives step config (prompt, model), execution_id, and task_id from its parent
//! - Runs Claude through `harness-claude` and persists normalized harness events
//! - Retains the legacy direct process path for providers not yet migrated
//! - Reports StepCompleted or StepFailed to the parent ProjectSupervisor on exit
//! - Cancels the active harness/process and awaits process settlement
//!
//! Orchestration (step ordering, parallel vs serial, retry logic) lives entirely
//! in Sacrum/Elixir -- the daemon just executes what it is told.

use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;

use async_trait::async_trait;
use ractor::{Actor, ActorProcessingErr, ActorRef};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use vertebrae_core::Provider;
use vertebrae_core::execution_service::ExecutionService;
use vertebrae_core::models::{AgentConfig, PermissionMode, SessionLog};
use vertebrae_harness_claude::{
    ClaudeLaunchMode, ClaudePermissionMode, ClaudeProviderConfig, ClaudeProviderPrelude,
    ClaudeRuntime,
};
use vertebrae_harness_core::{
    CompletionStatus, ControlDecision, ControlRequest, ControlRequestEnvelope, ControlResolution,
    ControlSink, EventSink, GrantScope, HarnessError, HarnessEventPayloadV1, HarnessEventV1,
    HarnessRuntime, RequestConfig, ResolutionSource, RunHandle, RunId, RunOutcome, RunRequest,
    SessionUsage, StreamId,
};

use crate::actors::project_supervisor::{ProjectMessage, VERBOSE_LOG_TARGET};
use crate::helpers::ProviderBinaries;
use crate::output_validator::{CompiledSchema, SchemaError, SchemaValidationError};
use crate::provider::{ParserKind, ProviderResolutionError, resolve_provider_command};
use crate::session_log_event_sink::SessionLogEventSink;
use crate::settings_synthesis::SyntheticSettings;

/// Default model used when agent_config does not specify one.
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";

pub const CHECKPOINT_CLAUDE_ARGV: &str = "claude_argv";
pub const CHECKPOINT_CLAUDE_STDERR: &str = "claude_stderr";
pub const CHECKPOINT_STREAM_JSON_INIT: &str = "stream_json_init";

/// Reported when a child process exits without a numeric exit code (e.g.
/// killed by a signal on Unix, where `ExitStatus::code()` returns `None`).
pub const PROCESS_EXIT_CODE_UNKNOWN: i32 = -1;

fn merge_managed_plugin_root(agent_config: &mut AgentConfig, plugin_root: &Path) {
    let mut managed_root_seen = false;
    agent_config.plugin_dirs.retain(|configured| {
        if Path::new(configured) != plugin_root {
            return true;
        }
        if managed_root_seen {
            return false;
        }
        managed_root_seen = true;
        true
    });

    if !managed_root_seen {
        agent_config
            .plugin_dirs
            .push(plugin_root.to_string_lossy().into_owned());
    }
}

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
    /// `Some` when the binary was found; `None` when it was not. Per-step
    /// resolution looks up the binary for the step's resolved provider and
    /// fails the step with `MissingProviderBinary` if it's absent.
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
    ProcessExited(Result<ExitStatus, String>),
    HarnessSettled(Result<RunOutcome, String>),
}

impl std::fmt::Debug for StepExecutorMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Execute => write!(f, "Execute"),
            Self::Cancel => write!(f, "Cancel"),
            Self::ProcessExited(result) => f.debug_tuple("ProcessExited").field(result).finish(),
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
    cancel_notify: Arc<tokio::sync::Notify>,
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
        tokio::select! {
            result = self.persistence.emit(event) => result?,
            () = self.cancel_notify.notified() => {
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

/// Build the `claude` invocation. When `settings_path` is `Some`, emits
/// `--settings <path>` before `agent_config` flags so CLI overrides win.
/// Compatibility probing is intentionally handled by provider resolution so
/// this public builder is deterministic and independent of host state.
///
/// Returns an error when the Anthropic provider binary wasn't resolved at
/// daemon startup -- the daemon stays up for other workflows, but this step
/// fails before spawn.
pub fn build_claude_command_with_settings(
    config: &StepExecutorConfig,
    settings_path: Option<&Path>,
) -> Result<Command, ProviderResolutionError> {
    build_claude_command_with_settings_and_managed_root(config, settings_path, None)
}

pub(crate) fn build_claude_command_with_settings_and_managed_root(
    config: &StepExecutorConfig,
    settings_path: Option<&Path>,
    managed_plugin_root: Option<&Path>,
) -> Result<Command, ProviderResolutionError> {
    let binary = config
        .provider_binaries
        .get(Provider::Anthropic)
        .ok_or_else(|| {
            // Pull the hint from the canonical resolver so we don't drift
            // from the install-help text used elsewhere.
            let hint = crate::helpers::find_claude_binary("")
                .err()
                .unwrap_or_else(|| "Set CLAUDE_CODE_PATH or install claude in PATH.".to_string());
            ProviderResolutionError::MissingProviderBinary {
                provider: Provider::Anthropic,
                hint,
            }
        })?;
    let mut cmd = Command::new(binary);

    let step = &config.step_config;

    if let Some(path) = settings_path {
        cmd.arg("--settings").arg(path);
    }

    // Ensure a default model when agent_config doesn't specify one.
    let mut agent_config = step.agent_config.clone();
    if agent_config.model.is_none() {
        agent_config = agent_config.with_model(DEFAULT_MODEL);
    }

    // Merge skills into allowed_tools (skills activate tool access).
    if !step.skills.is_empty() {
        let mut tools = agent_config.allowed_tools.clone();
        for skill in &step.skills {
            if !tools.contains(skill) {
                tools.push(skill.clone());
            }
        }
        agent_config = agent_config.with_allowed_tools(tools);
    }

    // Daemon runs autonomously -- default to bypass permissions.
    if agent_config.permission_mode.is_none() {
        agent_config = agent_config.with_permission_mode(PermissionMode::BypassPermissions);
    }

    if let Some(plugin_root) = managed_plugin_root {
        merge_managed_plugin_root(&mut agent_config, plugin_root);
    }

    let cli_args = agent_config.to_claude_cli_args();
    for arg in &cli_args {
        cmd.arg(arg);
    }

    // Add --agent flags for each agent path.
    for agent in &step.agents {
        cmd.arg("--agent").arg(agent);
    }

    // Prompt and output format. Claude Code requires --verbose whenever
    // --print is combined with --output-format=stream-json.
    cmd.arg("-p")
        .arg(&step.prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .current_dir(config.working_dir())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    // Set PATH from the user's login shell so the child process can find
    // tools like `mix`, `node`, `vtb`, etc. that aren't in launchd's minimal PATH.
    cmd.env("PATH", &config.shell_path);

    // Verbose checkpoint: final argv confirms every resolved flag (including
    // --json-schema and the rendered prompt) reaches the child verbatim.
    if step.verbose_daemon_logging {
        let _ = log_built_argv(
            &cmd,
            config,
            Provider::Anthropic,
            "verbose: built claude CLI command",
        );
    }

    Ok(cmd)
}

fn claude_permission_mode(mode: &PermissionMode) -> ClaudePermissionMode {
    match mode {
        PermissionMode::AcceptEdits => ClaudePermissionMode::AcceptEdits,
        PermissionMode::Auto => ClaudePermissionMode::Auto,
        PermissionMode::BypassPermissions => ClaudePermissionMode::BypassPermissions,
        PermissionMode::Default => ClaudePermissionMode::Default,
        PermissionMode::DontAsk => ClaudePermissionMode::DontAsk,
        PermissionMode::Plan => ClaudePermissionMode::Plan,
    }
}

fn build_claude_harness(
    config: &StepExecutorConfig,
    settings: &SyntheticSettings,
) -> Result<(ClaudeRuntime, RunRequest), ProviderResolutionError> {
    vertebrae_core::model_catalog::validate_provider_model_with_codex_provider(
        Provider::Anthropic,
        config.step_config.agent_config.model.as_deref(),
        config
            .step_config
            .agent_config
            .codex_model_provider
            .as_deref(),
    )
    .map_err(|error| ProviderResolutionError::InvalidProviderModel(error.to_string()))?;
    vertebrae_core::model_catalog::normalize_provider_reasoning_effort(
        Provider::Anthropic,
        config.step_config.agent_config.reasoning_effort.as_deref(),
    )
    .map_err(|error| ProviderResolutionError::InvalidReasoningEffort(error.to_string()))?;

    let binary = config
        .provider_binaries
        .get(Provider::Anthropic)
        .ok_or_else(|| ProviderResolutionError::MissingProviderBinary {
            provider: Provider::Anthropic,
            hint: crate::helpers::find_claude_binary("")
                .err()
                .unwrap_or_else(|| "Set CLAUDE_CODE_PATH or install claude in PATH.".into()),
        })?;

    let resolution = vertebrae_installer::resolve_claude_plugin_dir(
        binary,
        config.working_dir(),
        &config.shell_path,
    );
    if let Some(warning) = resolution.warning {
        tracing::warn!(
            execution_id = %config.execution_id,
            task_id = %config.task_id,
            claude_binary = %binary.display(),
            "{}",
            warning,
        );
    }

    let mut agent_config = config.step_config.agent_config.clone();
    if agent_config.model.is_none() {
        agent_config.model = Some(DEFAULT_MODEL.into());
    }
    for skill in &config.step_config.skills {
        if !agent_config.allowed_tools.contains(skill) {
            agent_config.allowed_tools.push(skill.clone());
        }
    }
    if agent_config.permission_mode.is_none() {
        agent_config.permission_mode = Some(PermissionMode::BypassPermissions);
    }
    if let Some(root) = resolution.plugin_root.as_deref() {
        merge_managed_plugin_root(&mut agent_config, root);
    }

    let model = agent_config.model.take();
    let permission_mode = agent_config
        .permission_mode
        .take()
        .as_ref()
        .map(claude_permission_mode);
    let output_schema = agent_config.json_schema.take();
    let plugin_roots = std::mem::take(&mut agent_config.plugin_dirs)
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let provider = ClaudeProviderConfig {
        executable: Some(binary.to_path_buf()),
        search_path: Some(config.shell_path.clone().into()),
        prelude: ClaudeProviderPrelude {
            settings_path: Some(settings.settings_path()),
            // These are daemon-owned Claude flags not represented in the
            // portable RequestConfig contract.
            args: agent_config.to_claude_cli_args(),
        },
        plugin_roots,
        agent_paths: config
            .step_config
            .agents
            .iter()
            .map(PathBuf::from)
            .collect(),
        permission_mode,
        ..ClaudeProviderConfig::default()
    };
    let request = RunRequest {
        run_id: RunId::new(config.execution_id.clone()),
        stream_id: StreamId::new(config.execution_id.clone()),
        prompt: config.step_config.prompt.clone(),
        config: RequestConfig {
            working_directory: Some(config.working_dir().to_path_buf()),
            model,
            output_schema,
            ..RequestConfig::default()
        },
    };
    if config.step_config.verbose_daemon_logging
        && let Ok(spec) = provider.command_spec(
            ClaudeLaunchMode::OneShot {
                prompt: &request.prompt,
            },
            &request.config,
        )
    {
        tracing::info!(
            target: VERBOSE_LOG_TARGET,
            execution_id = %config.execution_id,
            task_id = %config.task_id,
            checkpoint = CHECKPOINT_CLAUDE_ARGV,
            program = %spec.program.display(),
            argv = ?spec.args,
            provider = %Provider::Anthropic,
            "verbose: built Claude harness command",
        );
    }
    Ok((ClaudeRuntime::new(provider), request))
}

/// Convert a Codex `turn.completed` usage into the daemon's [`StreamMetrics`].
///
/// Codex's `input_tokens` already includes the cached portion —
/// `cached_input_tokens` is a *subset* of it (see codex-rs
/// `TokenUsage::non_cached_input`, which derives non-cached as
/// `input_tokens - cached_input_tokens`). So `input_tokens` maps straight
/// across as the total input; adding `cached_input_tokens` on top would
/// double-count the cache. Codex emits neither `cost_usd` nor `duration_ms`.
fn codex_usage_to_metrics(
    usage: &crate::codex_jsonl::CodexUsage,
) -> crate::stream_json::StreamMetrics {
    crate::stream_json::StreamMetrics {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: 0.0,
        duration_ms: 0,
    }
}

fn session_log_for_provider_line(
    execution_id: &str,
    line: String,
    parser_kind: ParserKind,
) -> SessionLog {
    let log_format = match parser_kind {
        ParserKind::CodexJsonl => "openai",
        ParserKind::StreamJson => "anthropic",
    };
    let mut log = SessionLog::new(execution_id, line).with_format(log_format);

    if let ParserKind::StreamJson = parser_kind
        && let Some(parsed) = crate::stream_json::parse_stream_log_line(&log.content)
        && let crate::stream_json::StreamLogPersistence::Ephemeral { logical_key } =
            crate::stream_json::classify_stream_log_line(&parsed)
    {
        log = log.with_logical_key(logical_key);
    }

    log
}

/// Emit the verbose `claude_argv` checkpoint with the resolved program/argv
/// and selected provider; returns the formatted argv so call sites and tests
/// can observe what was logged. Shared by every built-in provider command
/// builder.
pub(crate) fn log_built_argv(
    cmd: &Command,
    config: &StepExecutorConfig,
    provider: Provider,
    msg: &'static str,
) -> Vec<String> {
    let program = cmd.as_std().get_program().to_string_lossy().to_string();
    let argv: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    tracing::info!(
        target: VERBOSE_LOG_TARGET,
        execution_id = %config.execution_id,
        task_id = %config.task_id,
        checkpoint = CHECKPOINT_CLAUDE_ARGV,
        program = %program,
        argv = ?argv,
        provider = %provider,
        "{}",
        msg,
    );
    argv
}

/// Provider-agnostic aggregate of what the streaming task observed on the
/// child process's stdout. The actor uses this to build the final
/// `StepResult` regardless of which harness ran.
#[derive(Debug, Clone, Default)]
pub(crate) struct HarnessStreamResult {
    pub metrics: Option<crate::stream_json::StreamMetrics>,
    pub result_text: Option<String>,
    pub structured_output: Option<serde_json::Value>,
    /// Provider-reported failure reason (e.g. Codex `turn.failed.error.message`).
    /// Surfaced when the child also exited non-zero so the user gets the
    /// human-readable cause instead of a bare exit code.
    pub provider_error: Option<String>,
    /// Underlying `serde_json::Error` rendering when Codex `--output-schema`
    /// was set but the final `agent_message.text` was not valid JSON.
    pub schema_parse_error: Option<String>,
    /// True when `structured_output` came from Codex's `--output-schema`
    /// enforcement. Suppresses the daemon-side schema validator (Codex is
    /// trusted; only the JSON parse is verified).
    pub structured_output_from_codex: bool,
}

pub struct StepExecutorState {
    execution_id: String,
    task_id: String,
    config: StepExecutorConfig,
    parent: ActorRef<ProjectMessage>,
    child_process: Option<Child>,
    harness_run: Option<Arc<dyn RunHandle>>,
    harness_outcome_handle: Option<tokio::task::JoinHandle<()>>,
    harness_usage: Arc<std::sync::Mutex<HarnessUsageMetrics>>,
    harness_cancel_notify: Arc<tokio::sync::Notify>,
    stream_handle: Option<tokio::task::JoinHandle<()>>,
    /// Shared slot for the harness-agnostic aggregate (metrics + result text +
    /// structured output + provider error). Written by the streaming task,
    /// read by the actor on process exit.
    stream_result: std::sync::Arc<std::sync::Mutex<HarnessStreamResult>>,
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

        Ok(StepExecutorState {
            execution_id: config.execution_id.clone(),
            task_id: config.task_id.clone(),
            config,
            parent,
            child_process: None,
            harness_run: None,
            harness_outcome_handle: None,
            harness_usage: Arc::new(std::sync::Mutex::new(HarnessUsageMetrics::default())),
            harness_cancel_notify: Arc::new(tokio::sync::Notify::new()),
            stream_handle: None,
            stream_result: std::sync::Arc::new(std::sync::Mutex::new(
                HarnessStreamResult::default(),
            )),
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
            StepExecutorMessage::ProcessExited(result) => {
                self.handle_process_exited(result, myself, state).await;
            }
            StepExecutorMessage::HarnessSettled(result) => {
                self.handle_harness_settled(result, myself, state).await;
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

        if let Some(ref mut child) = state.child_process {
            tracing::warn!(
                "Killing orphaned child process for execution {}",
                state.execution_id
            );
            let _ = child.kill().await;
        }

        if let Some(handle) = state.stream_handle.take() {
            handle.abort();
        }

        state.harness_cancel_notify.notify_waiters();
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

        // Drop the settings guard only after killing the child, so the hook
        // script outlives claude.
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
        if state.child_process.is_some() || state.harness_run.is_some() {
            tracing::warn!(
                "Execute received but process already running for execution {}",
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

        let settings_guard = match SyntheticSettings::create(&state.execution_id) {
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
        };

        if crate::provider::resolve_provider(&state.config) == Provider::Anthropic {
            let settings = settings_guard
                .as_ref()
                .expect("successful settings synthesis returns a guard");
            let (runtime, request) = match build_claude_harness(&state.config, settings) {
                Ok(value) => value,
                Err(err) => {
                    let _ = state.parent.cast(ProjectMessage::StepFinished {
                        execution_id: state.execution_id.clone(),
                        task_id: state.task_id.clone(),
                        result: StepResult::failed(
                            None,
                            format!("Provider resolution failed: {err}"),
                        ),
                    });
                    myself.stop(Some("provider resolution failed".into()));
                    return Ok(());
                }
            };
            let usage = Arc::clone(&state.harness_usage);
            let event_sink: Arc<dyn EventSink> = Arc::new(DaemonHarnessEventSink {
                persistence: Arc::new(SessionLogEventSink::new(
                    &state.execution_id,
                    Arc::clone(&state.config.execution_service),
                )),
                root_stream_id: request.stream_id.clone(),
                usage,
                cancel_notify: state.harness_cancel_notify.clone(),
                execution_id: state.execution_id.clone(),
                task_id: state.task_id.clone(),
                verbose: state.config.step_config.verbose_daemon_logging,
            });
            let control_sink: Arc<dyn ControlSink> = Arc::new(
                DaemonControlSink::from_agent_config(&state.config.step_config.agent_config),
            );
            let run = match runtime.run_once(request, event_sink, control_sink).await {
                Ok(run) => run,
                Err(error) => {
                    let _ = state.parent.cast(ProjectMessage::StepFinished {
                        execution_id: state.execution_id.clone(),
                        task_id: state.task_id.clone(),
                        result: StepResult::failed(
                            None,
                            format!("Failed to start Claude harness: {error}"),
                        ),
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
                let _ = actor_ref.cast(StepExecutorMessage::HarnessSettled(result));
            }));
            return Ok(());
        }

        let resolved = match resolve_provider_command(&state.config, settings_guard.as_ref()) {
            Ok(resolved) => resolved,
            Err(err) => {
                tracing::error!(
                    "Provider resolution failed for execution {}: {}",
                    state.execution_id,
                    err
                );
                let _ = state.parent.cast(ProjectMessage::StepFinished {
                    execution_id: state.execution_id.clone(),
                    task_id: state.task_id.clone(),
                    result: StepResult::failed(None, format!("Provider resolution failed: {err}")),
                });
                myself.stop(Some("provider resolution failed".to_string()));
                return Ok(());
            }
        };

        state.settings_guard = settings_guard;
        let parser_kind = resolved.parser_kind;
        debug_assert_eq!(parser_kind, ParserKind::CodexJsonl);
        let mut cmd = resolved.command;

        match cmd.spawn() {
            Ok(mut child) => {
                // Take stdout and stderr before storing child — the streaming task
                // reads from them while the actor retains the Child handle for kill().
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                state.child_process = Some(child);

                let actor_ref = myself;
                let execution_id = state.execution_id.clone();
                let task_id = state.task_id.clone();
                let verbose = state.config.step_config.verbose_daemon_logging;
                let execution_service = Arc::clone(&state.config.execution_service);
                let result_slot = Arc::clone(&state.stream_result);

                let codex_output_schema_used =
                    state.config.step_config.agent_config.json_schema.is_some();

                let stream_handle = tokio::spawn(async move {
                    // Stream stdout line by line, posting each as a SessionLog.
                    // Anthropic returns above through harness-claude. This
                    // compatibility process loop now handles Codex only.
                    let mut codex_aggregate =
                        crate::codex_jsonl::CodexAggregate::with_output_schema(
                            codex_output_schema_used,
                        );
                    if let Some(stdout) = stdout {
                        let reader = BufReader::new(stdout);
                        let mut lines = reader.lines();

                        while let Ok(Some(line)) = lines.next_line().await {
                            if crate::codex_jsonl::apply_codex_line(&line, &mut codex_aggregate)
                                && let Ok(mut slot) = result_slot.lock()
                            {
                                slot.metrics =
                                    codex_aggregate.usage.as_ref().map(codex_usage_to_metrics);
                                slot.result_text = codex_aggregate.final_output.clone();
                                slot.provider_error = codex_aggregate.error.clone();
                                if codex_aggregate.output_schema_used {
                                    slot.structured_output =
                                        codex_aggregate.final_output_json.clone();
                                    slot.schema_parse_error =
                                        codex_aggregate.schema_parse_error.clone();
                                    slot.structured_output_from_codex =
                                        slot.structured_output.is_some();
                                }
                            }

                            let log =
                                session_log_for_provider_line(&execution_id, line, parser_kind);

                            if let Err(e) = execution_service.add_log(log).await {
                                tracing::warn!(
                                    "Failed to post log for execution {}: {}",
                                    execution_id,
                                    e
                                );
                            }
                        }
                    }

                    // Drain stderr and log it (not posted to Sacrum).
                    // Verbose checkpoint 4: mirror stderr verbatim to the verbose
                    // target so init-time schema-rejection messages are captured.
                    if let Some(stderr) = stderr {
                        let reader = BufReader::new(stderr);
                        let mut lines = reader.lines();

                        while let Ok(Some(line)) = lines.next_line().await {
                            if verbose {
                                tracing::info!(
                                    target: VERBOSE_LOG_TARGET,
                                    execution_id = %execution_id,
                                    task_id = %task_id,
                                    checkpoint = CHECKPOINT_CLAUDE_STDERR,
                                    parser_kind = ?parser_kind,
                                    line = %line,
                                    "verbose: provider stderr"
                                );
                            } else {
                                tracing::warn!("stderr [{}]: {}", execution_id, line);
                            }
                        }
                    }

                    // stdout EOF means the process has closed its output.
                    // Notify the actor so it can wait() for the exit status.
                    let _ = actor_ref.cast(StepExecutorMessage::ProcessExited(Ok(
                        // Placeholder — the real exit status is obtained via child.wait() in the actor.
                        // We send a synthetic success here; the actor overrides it from wait().
                        std::process::ExitStatus::default(),
                    )));
                });

                state.stream_handle = Some(stream_handle);
            }
            Err(e) => {
                tracing::error!(
                    "Failed to spawn provider CLI for execution {}: {}",
                    state.execution_id,
                    e
                );

                let _ = state.parent.cast(ProjectMessage::StepFinished {
                    execution_id: state.execution_id.clone(),
                    task_id: state.task_id.clone(),
                    result: StepResult::failed(None, format!("Failed to spawn process: {e}")),
                });

                myself.stop(Some("spawn failed".to_string()));
            }
        }

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
                    state.harness_cancel_notify.notify_waiters();
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

        // Kill the child process explicitly.
        if let Some(ref mut child) = state.child_process {
            let _ = child.kill().await;
        }

        if let Some(handle) = state.stream_handle.take() {
            handle.abort();
        }

        let _ = state.parent.cast(ProjectMessage::StepFinished {
            execution_id: state.execution_id.clone(),
            task_id: state.task_id.clone(),
            result: StepResult::failed(None, "Cancelled"),
        });

        myself.stop(Some("cancelled".to_string()));
    }

    async fn handle_process_exited(
        &self,
        _stream_result: Result<ExitStatus, String>,
        myself: ActorRef<StepExecutorMessage>,
        state: &mut StepExecutorState,
    ) {
        // The streaming task has finished reading stdout/stderr.
        // Now call child.wait() to get the real exit status.
        let stream_result = state
            .stream_result
            .lock()
            .ok()
            .map(|mut guard| std::mem::take(&mut *guard))
            .unwrap_or_default();

        let metrics = stream_result.metrics;
        let result_text = stream_result.result_text;
        let structured_output = stream_result.structured_output;
        let provider_error = stream_result.provider_error;
        let schema_parse_error = stream_result.schema_parse_error;
        let structured_output_from_codex = stream_result.structured_output_from_codex;

        let step_result = if let Some(ref mut child) = state.child_process {
            match child.wait().await {
                Ok(status) => {
                    let code = status.code().unwrap_or(PROCESS_EXIT_CODE_UNKNOWN);
                    if status.success() {
                        tracing::info!(
                            "Process completed successfully for execution {} (exit code {}, metrics={:?}, has_output={}, has_structured_output={}, schema_parse_error={:?})",
                            state.execution_id,
                            code,
                            metrics,
                            result_text.is_some(),
                            structured_output.is_some(),
                            schema_parse_error,
                        );
                        if let Some(parse_err) = schema_parse_error {
                            tracing::warn!(
                                "Codex agent_message JSON parse failed for execution {}: {}",
                                state.execution_id,
                                parse_err
                            );
                            StepResult::failed_schema(
                                format!(
                                    "step output_schema was set but agent_message text was not valid JSON: {parse_err}"
                                ),
                                vec![SchemaValidationError {
                                    instance_path: String::new(),
                                    schema_path: String::new(),
                                    message: parse_err,
                                }],
                            )
                        } else {
                            // Codex's --output-schema is trusted; only the
                            // Anthropic path runs the daemon-side validator.
                            let validation = if structured_output_from_codex {
                                Ok(())
                            } else {
                                self.validate_output(
                                    state,
                                    structured_output.as_ref(),
                                    result_text.as_deref(),
                                )
                            };
                            match validation {
                                Ok(()) => {
                                    // Re-serialize so existing text-based consumers (Sacrum
                                    // output field) keep working when structured_output is the
                                    // source of truth.
                                    let output = match &structured_output {
                                        Some(value) => {
                                            serde_json::to_string_pretty(value).ok().or(result_text)
                                        }
                                        None => result_text,
                                    };
                                    StepResult::Completed {
                                        exit_code: code,
                                        metrics,
                                        output,
                                    }
                                }
                                Err(err) => {
                                    tracing::warn!(
                                        "Output-schema validation failed for execution {}: {}",
                                        state.execution_id,
                                        err
                                    );
                                    step_result_for_schema_error(err)
                                }
                            }
                        }
                    } else {
                        tracing::warn!(
                            "Process failed for execution {} (exit code {}, provider_error={:?})",
                            state.execution_id,
                            code,
                            provider_error,
                        );
                        // Prefer the provider's structured failure message
                        // (e.g. Codex `turn.failed.error.message`) over a bare
                        // exit-code string so the user sees the cause.
                        let error = match provider_error {
                            Some(msg) => format!("Process exited with code {code}: {msg}"),
                            None => format!("Process exited with code {code}"),
                        };
                        StepResult::failed(Some(code), error)
                    }
                }
                Err(e) => {
                    tracing::error!(
                        "Process wait error for execution {}: {}",
                        state.execution_id,
                        e
                    );
                    StepResult::failed(None, e.to_string())
                }
            }
        } else {
            tracing::error!(
                "ProcessExited received but no child process for execution {}",
                state.execution_id
            );
            StepResult::failed(None, "No child process")
        };

        let _ = state.parent.cast(ProjectMessage::StepFinished {
            execution_id: state.execution_id.clone(),
            task_id: state.task_id.clone(),
            result: step_result,
        });

        myself.stop(Some("process exited".to_string()));
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use super::*;
    use vertebrae_core::{
        ServiceError, ServiceResult, StepExecution, StopRunTarget, TaskRun, TaskRunTrace,
        UpdateExecutionStatusParams,
    };

    #[derive(Default)]
    struct CapturingHarnessPersistence {
        events: std::sync::Mutex<Vec<HarnessEventV1>>,
        reject: std::sync::atomic::AtomicBool,
    }

    #[async_trait]
    impl EventSink for CapturingHarnessPersistence {
        async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
            if self.reject.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(HarnessError::EventSink("rejected durable event".into()));
            }
            self.events.lock().unwrap().push(event);
            Ok(())
        }
    }

    fn harness_usage_event(stream_id: &str, event_id: &str) -> HarnessEventV1 {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "event_id": event_id,
            "stream_id": stream_id,
            "sequence": 1,
            "correlation": {"run_id": "run-1"},
            "timestamp": "2026-07-18T00:00:00Z",
            "semantics": "delta",
            "type": "usage",
            "data": {
                "turn_delta": {
                    "tokens": {
                        "input_tokens": 13,
                        "cached_input_tokens": 3,
                        "output_tokens": 5,
                        "reasoning_tokens": 2
                    },
                    "cost_microusd": 250000
                }
            }
        }))
        .unwrap()
    }

    /// Captured `StepFinished` payloads `(execution_id, task_id, result)` shared
    /// from a test parent actor back to the assertion site.
    type CapturedResults = Arc<std::sync::Mutex<Vec<(String, String, StepResult)>>>;

    #[derive(Default)]
    struct CapturingExecutionService {
        logs: std::sync::Mutex<Vec<SessionLog>>,
        reject_on_call: AtomicUsize,
        add_calls: AtomicUsize,
        block_logs: AtomicBool,
        add_started: tokio::sync::Notify,
    }

    impl CapturingExecutionService {
        fn rejecting() -> Self {
            Self {
                // Preserve the first normalized event, then reject the next.
                reject_on_call: AtomicUsize::new(2),
                ..Self::default()
            }
        }

        fn blocking() -> Self {
            Self {
                block_logs: AtomicBool::new(true),
                ..Self::default()
            }
        }

        fn logs(&self) -> Vec<SessionLog> {
            self.logs.lock().unwrap().clone()
        }
    }

    fn unused<T>() -> ServiceResult<T> {
        Err(ServiceError::invalid_input("unused test service method"))
    }

    #[async_trait]
    impl ExecutionService for CapturingExecutionService {
        async fn create_execution(&self, _execution: StepExecution) -> ServiceResult<String> {
            unused()
        }
        async fn get_execution(&self, _id: &str) -> ServiceResult<Option<StepExecution>> {
            unused()
        }
        async fn list_executions_for_task(
            &self,
            _task_id: &str,
        ) -> ServiceResult<Vec<StepExecution>> {
            unused()
        }
        async fn add_log(&self, log: SessionLog) -> ServiceResult<String> {
            self.add_started.notify_one();
            if self.block_logs.load(Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            let call = self.add_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if self.reject_on_call.load(Ordering::SeqCst) == call {
                return Err(ServiceError::network_error(
                    "simulated persistence rejection",
                ));
            }
            self.logs.lock().unwrap().push(log);
            Ok("log-id".into())
        }
        async fn list_logs_for_execution(
            &self,
            _execution_id: &str,
        ) -> ServiceResult<Vec<SessionLog>> {
            unused()
        }
        async fn get_latest_execution_for_task(
            &self,
            _task_id: &str,
        ) -> ServiceResult<Option<StepExecution>> {
            unused()
        }
        async fn update_execution(
            &self,
            _execution_id: &str,
            _output: Option<String>,
            _transition_result: Option<String>,
        ) -> ServiceResult<()> {
            unused()
        }
        async fn run_step(&self, _task_id: &str, _step_id: &str) -> ServiceResult<StepExecution> {
            unused()
        }
        async fn update_execution_status(
            &self,
            _execution_id: &str,
            _params: UpdateExecutionStatusParams,
        ) -> ServiceResult<()> {
            unused()
        }
        async fn orchestrate_task(&self, _task_id: &str) -> ServiceResult<()> {
            unused()
        }
        async fn stop_orchestrator(&self, _task_id: &str) -> ServiceResult<()> {
            unused()
        }
        async fn active_run(&self, _task_id: &str) -> ServiceResult<Option<TaskRun>> {
            unused()
        }
        async fn task_runs(&self, _task_id: &str) -> ServiceResult<Vec<TaskRun>> {
            unused()
        }
        async fn task_run(&self, _task_run_id: &str) -> ServiceResult<Option<TaskRun>> {
            unused()
        }
        async fn task_run_trace(&self, _root_task_run_id: &str) -> ServiceResult<TaskRunTrace> {
            unused()
        }
        async fn run_workflow(&self, _task_id: &str) -> ServiceResult<TaskRun> {
            unused()
        }
        async fn stop_run(&self, _target: StopRunTarget) -> ServiceResult<Option<TaskRun>> {
            unused()
        }
    }

    struct HarnessParent;

    impl Actor for HarnessParent {
        type Msg = ProjectMessage;
        type State = CapturedResults;
        type Arguments = CapturedResults;

        async fn pre_start(
            &self,
            _myself: ActorRef<Self::Msg>,
            results: Self::Arguments,
        ) -> Result<Self::State, ActorProcessingErr> {
            Ok(results)
        }

        async fn handle(
            &self,
            _myself: ActorRef<Self::Msg>,
            message: Self::Msg,
            results: &mut Self::State,
        ) -> Result<(), ActorProcessingErr> {
            if let ProjectMessage::StepFinished {
                execution_id,
                task_id,
                result,
            } = message
            {
                results
                    .lock()
                    .unwrap()
                    .push((execution_id, task_id, result));
            }
            Ok(())
        }
    }

    struct CleanupFailingRun {
        run_id: RunId,
    }

    #[async_trait]
    impl RunHandle for CleanupFailingRun {
        fn run_id(&self) -> &RunId {
            &self.run_id
        }

        async fn cancel(&self) -> Result<(), HarnessError> {
            Ok(())
        }

        async fn await_outcome(&self) -> Result<RunOutcome, HarnessError> {
            Ok(RunOutcome {
                status: CompletionStatus::Failed,
                result_text: None,
                structured_output: None,
                usage: None,
                metrics: vertebrae_harness_core::OutcomeMetrics::default(),
                error: Some("cleanup sink failure".into()),
            })
        }
    }

    #[cfg(unix)]
    fn fake_claude_script() -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("claude");
        std::fs::write(
            &path,
            r##"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "2.1.0 (Claude Code)"
  exit 0
fi
printf '%s\n' '{"type":"system","subtype":"init","session_id":"daemon-session","transcript_path":"opaque://daemon-session.jsonl","tools":["Bash","StructuredOutput"]}'
printf '%s\n' '{"type":"assistant","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":2,"output_tokens":3},"content":[{"type":"text","text":"working"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"done","duration_ms":42,"total_cost_usd":0.125,"usage":{"input_tokens":11,"output_tokens":5}}'
"##,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        (directory, path)
    }

    #[cfg(unix)]
    fn fake_hanging_claude_script() -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("claude");
        std::fs::write(
            &path,
            r##"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "2.1.0 (Claude Code)"
  exit 0
fi
printf '%s\n' '{"type":"system","subtype":"init","session_id":"cancel-session","transcript_path":"opaque://cancel.jsonl"}'
exec sleep 30
"##,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        (directory, path)
    }

    #[cfg(unix)]
    fn fake_claude_with_body(body: &str) -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("claude");
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo \"2.1.0 (Claude Code)\"\n  exit 0\nfi\n{body}\n"
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        (directory, path)
    }

    #[cfg(unix)]
    async fn execute_harness_fixture(
        binary: PathBuf,
        agent_config: AgentConfig,
        service: Arc<CapturingExecutionService>,
    ) -> CapturedResults {
        let results: CapturedResults = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (parent, _parent_handle) = Actor::spawn(None, HarnessParent, results.clone())
            .await
            .unwrap();
        let mut config = test_config("harness-fixture");
        config.project_root = binary.parent().unwrap().to_path_buf();
        config.provider_binaries.anthropic = Some(binary);
        config.step_config.agent_config = agent_config;
        config.execution_service = service;
        let (executor, executor_handle) =
            Actor::spawn(None, StepExecutor, (config, parent.clone()))
                .await
                .unwrap();
        executor.cast(StepExecutorMessage::Execute).unwrap();
        tokio::time::timeout(Duration::from_secs(3), executor_handle)
            .await
            .expect("harness fixture should settle")
            .expect("executor actor should join");
        tokio::task::yield_now().await;
        parent.stop(None);
        results
    }

    fn test_execution_service() -> Arc<dyn ExecutionService> {
        use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig, SacrumExecutionService};

        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = GraphqlClient::new(config);
        Arc::new(SacrumExecutionService::new(client))
    }

    fn make_step_config(prompt: &str) -> StepConfig {
        StepConfig {
            prompt: prompt.to_string(),
            agent_config: AgentConfig::default(),
            agents: Vec::new(),
            skills: Vec::new(),
            verbose_daemon_logging: false,
        }
    }

    fn test_config(execution_id: &str) -> StepExecutorConfig {
        StepExecutorConfig {
            execution_id: execution_id.to_string(),
            task_id: "task-test".to_string(),
            step_config: make_step_config("test"),
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn claude_harness_preserves_daemon_provider_policy_without_duplicate_structured_flags() {
        let (directory, binary) = fake_claude_script();
        let settings = SyntheticSettings::create("harness-policy").unwrap();
        let mut config = test_config("harness-policy");
        config.project_root = PathBuf::from("/");
        config.worktree = Some(directory.path().to_path_buf());
        config.provider_binaries.anthropic = Some(binary.clone());
        config.step_config.prompt = "exact prompt".into();
        config.step_config.agents = vec!["agents/reviewer.md".into()];
        config.step_config.skills = vec!["SkillOne".into()];
        config.step_config.agent_config = AgentConfig::new()
            .with_model("claude-opus")
            .with_fallback_model("claude-sonnet")
            .with_system_prompt("system")
            .with_append_system_prompt("append")
            .with_tools(vec!["Bash".into()])
            .with_allowed_tools(vec!["Read".into()])
            .with_disallowed_tools(vec!["Bash(rm *)".into()])
            .with_permission_mode(PermissionMode::Plan)
            .with_max_budget_usd(2.5)
            .with_mcp_config(vec!["mcp.json".into()])
            .with_plugin_dirs(vec!["custom-plugin".into()])
            .with_json_schema(serde_json::json!({"type": "object"}));

        let (runtime, request) = build_claude_harness(&config, &settings).unwrap();
        let spec = runtime
            .config()
            .command_spec(
                ClaudeLaunchMode::OneShot {
                    prompt: &request.prompt,
                },
                &request.config,
            )
            .unwrap();

        assert_eq!(spec.program, binary);
        assert_eq!(spec.current_dir.as_deref(), Some(directory.path()));
        assert_eq!(spec.environment.get("PATH"), Some(&config.shell_path));
        assert_eq!(request.run_id.as_str(), "harness-policy");
        assert_eq!(request.stream_id.as_str(), "harness-policy");
        assert_eq!(request.prompt, "exact prompt");
        assert_eq!(request.config.model.as_deref(), Some("claude-opus"));
        assert_eq!(
            request.config.output_schema,
            Some(serde_json::json!({"type": "object"}))
        );
        for flag in ["--model", "--permission-mode", "--json-schema"] {
            assert_eq!(
                spec.args.iter().filter(|arg| arg.as_str() == flag).count(),
                1,
                "{flag} must be represented exactly once"
            );
        }
        for value in [
            "claude-opus",
            "claude-sonnet",
            "system",
            "append",
            "Bash",
            "Read",
            "SkillOne",
            "Bash(rm *)",
            "plan",
            "2.5",
            "mcp.json",
            "custom-plugin",
            "agents/reviewer.md",
            "exact prompt",
        ] {
            assert!(spec.args.iter().any(|arg| arg == value), "missing {value}");
        }
        let settings_path = settings.settings_path().to_string_lossy().into_owned();
        assert!(spec.args.iter().any(|arg| arg == &settings_path));
    }

    #[tokio::test]
    async fn daemon_control_sink_derives_resolution_from_permission_mode() {
        use vertebrae_harness_core::{
            ApprovalCategory, ApprovalRequest, ControlDecision, ControlRequestId, UserQuestion,
        };

        let sink = DaemonControlSink::from_agent_config(&AgentConfig::default());
        let bypass = sink
            .request(ControlRequestEnvelope {
                request_id: ControlRequestId::new("automatic"),
                session_id: None,
                turn_id: None,
                request: ControlRequest::Approval(ApprovalRequest {
                    category: ApprovalCategory::CommandExecution,
                    title: "run".into(),
                    details: None,
                    modification_supported: false,
                }),
                presentation: None,
                timeout_ms: None,
                automatic_resolution: None,
            })
            .await
            .unwrap();
        assert_eq!(bypass.decision, Some(ControlDecision::AllowOnce));
        assert_eq!(bypass.source, ResolutionSource::Consumer);

        let plan = DaemonControlSink::from_agent_config(
            &AgentConfig::new().with_permission_mode(PermissionMode::Plan),
        )
        .request(ControlRequestEnvelope {
            request_id: ControlRequestId::new("plan"),
            session_id: None,
            turn_id: None,
            request: ControlRequest::Approval(ApprovalRequest {
                category: ApprovalCategory::CommandExecution,
                title: "run".into(),
                details: None,
                modification_supported: false,
            }),
            presentation: None,
            timeout_ms: None,
            automatic_resolution: None,
        })
        .await
        .unwrap();
        assert_eq!(plan.decision, Some(ControlDecision::Deny));

        let accept_edit = DaemonControlSink::from_agent_config(
            &AgentConfig::new().with_permission_mode(PermissionMode::AcceptEdits),
        )
        .request(ControlRequestEnvelope {
            request_id: ControlRequestId::new("edit"),
            session_id: None,
            turn_id: None,
            request: ControlRequest::Approval(ApprovalRequest {
                category: ApprovalCategory::FileChange,
                title: "edit".into(),
                details: None,
                modification_supported: false,
            }),
            presentation: None,
            timeout_ms: None,
            automatic_resolution: None,
        })
        .await
        .unwrap();
        assert_eq!(accept_edit.decision, Some(ControlDecision::Deny));

        let auto = DaemonControlSink::from_agent_config(
            &AgentConfig::new().with_permission_mode(PermissionMode::Auto),
        )
        .request(ControlRequestEnvelope {
            request_id: ControlRequestId::new("auto"),
            session_id: None,
            turn_id: None,
            request: ControlRequest::Approval(ApprovalRequest {
                category: ApprovalCategory::CommandExecution,
                title: "run".into(),
                details: None,
                modification_supported: false,
            }),
            presentation: None,
            timeout_ms: None,
            automatic_resolution: None,
        })
        .await
        .unwrap();
        assert_eq!(auto.decision, Some(ControlDecision::Deny));

        let question = sink
            .request(ControlRequestEnvelope {
                request_id: ControlRequestId::new("question"),
                session_id: None,
                turn_id: None,
                request: ControlRequest::UserQuestion {
                    questions: vec![UserQuestion {
                        id: "q".into(),
                        prompt: "choose".into(),
                        header: None,
                        options: Vec::new(),
                        multiple: false,
                        free_form: true,
                    }],
                },
                presentation: None,
                timeout_ms: None,
                automatic_resolution: None,
            })
            .await
            .unwrap_err();
        assert!(question.to_string().contains("cannot answer interactive"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn anthropic_execute_uses_harness_runtime_and_persists_only_normalized_events() {
        let (directory, binary) = fake_claude_script();
        let service = Arc::new(CapturingExecutionService::default());
        let results: CapturedResults = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (parent, _parent_handle) = Actor::spawn(
            Some("harness-normalized-parent".into()),
            HarnessParent,
            Arc::clone(&results),
        )
        .await
        .unwrap();
        let mut config = test_config("harness-normalized");
        config.project_root = directory.path().to_path_buf();
        config.provider_binaries.anthropic = Some(binary);
        config.execution_service = service.clone();

        let (executor, executor_handle) = Actor::spawn(
            Some("harness-normalized-executor".into()),
            StepExecutor,
            (config, parent.clone()),
        )
        .await
        .unwrap();
        executor.cast(StepExecutorMessage::Execute).unwrap();
        tokio::time::timeout(Duration::from_secs(5), executor_handle)
            .await
            .expect("Claude harness actor must settle")
            .expect("actor task must join");

        let results = results.lock().unwrap();
        assert_eq!(results.len(), 1, "execution must settle exactly once");
        match &results[0].2 {
            StepResult::Completed {
                exit_code,
                metrics: Some(metrics),
                output,
            } => {
                assert_eq!(*exit_code, 0);
                assert_eq!(metrics.input_tokens, 11);
                assert_eq!(metrics.output_tokens, 5);
                assert_eq!(metrics.duration_ms, 42);
                assert!((metrics.cost_usd - 0.125).abs() < f64::EPSILON);
                assert_eq!(output.as_deref(), Some("done"));
            }
            other => panic!("expected completed harness result, got {other:?}"),
        }
        drop(results);

        let logs = service.logs();
        assert!(!logs.is_empty());
        assert!(
            logs.iter()
                .all(|log| log.format.as_deref() == Some("harness"))
        );
        assert!(logs.iter().all(|log| {
            let event: HarnessEventV1 = serde_json::from_str(&log.content).unwrap();
            log.logical_key.as_deref() == Some(&format!("harness:{}", event.event_id))
        }));
        let events = logs
            .iter()
            .map(|log| serde_json::from_str::<HarnessEventV1>(&log.content).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.payload, HarnessEventPayloadV1::RunFinished(_)))
                .count(),
            1
        );
        assert!(
            logs.iter()
                .all(|log| log.format.as_deref() != Some("anthropic"))
        );
        parent.stop(Some("done".into()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn harness_persistence_rejection_fails_execution_without_raw_fallback() {
        let (directory, binary) = fake_claude_script();
        let service = Arc::new(CapturingExecutionService::rejecting());
        let results: CapturedResults = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (parent, _parent_handle) = Actor::spawn(
            Some("harness-reject-parent".into()),
            HarnessParent,
            Arc::clone(&results),
        )
        .await
        .unwrap();
        let mut config = test_config("harness-reject");
        config.project_root = directory.path().to_path_buf();
        config.provider_binaries.anthropic = Some(binary);
        config.execution_service = service.clone();
        let (executor, executor_handle) = Actor::spawn(
            Some("harness-reject-executor".into()),
            StepExecutor,
            (config, parent.clone()),
        )
        .await
        .unwrap();
        executor.cast(StepExecutorMessage::Execute).unwrap();
        tokio::time::timeout(Duration::from_secs(5), executor_handle)
            .await
            .expect("rejected sink must settle")
            .expect("actor task must join");

        let results = results.lock().unwrap();
        assert_eq!(results.len(), 1);
        assert!(matches!(results[0].2, StepResult::Failed { .. }));
        let logs = service.logs();
        assert_eq!(logs.len(), 1, "the prior durable event must remain");
        assert_eq!(logs[0].format.as_deref(), Some("harness"));
        let event: HarnessEventV1 = serde_json::from_str(&logs[0].content).unwrap();
        assert_eq!(
            logs[0].logical_key.as_deref(),
            Some(format!("harness:{}", event.event_id).as_str())
        );
        assert!(
            logs.iter()
                .all(|log| log.format.as_deref() != Some("anthropic"))
        );
        parent.stop(Some("done".into()));
    }

    #[test]
    fn codex_usage_to_metrics_does_not_double_count_cached_input() {
        // codex-rs `input_tokens` already includes `cached_input_tokens` (the
        // cached tokens are a subset of total input). The metric must pass
        // `input_tokens` through as-is — adding cached on top double-counts.
        let usage = crate::codex_jsonl::CodexUsage {
            input_tokens: 1500,
            cached_input_tokens: 200,
            output_tokens: 800,
            reasoning_output_tokens: 120,
        };
        let metrics = codex_usage_to_metrics(&usage);
        assert_eq!(metrics.input_tokens, 1500); // not 1700
        assert_eq!(metrics.output_tokens, 800);
        assert_eq!(metrics.cost_usd, 0.0);
        assert_eq!(metrics.duration_ms, 0);
    }

    #[tokio::test]
    async fn normalized_usage_is_counted_once_only_after_durable_root_persistence() {
        let persistence = Arc::new(CapturingHarnessPersistence::default());
        let usage = Arc::new(std::sync::Mutex::new(HarnessUsageMetrics::default()));
        let sink = DaemonHarnessEventSink {
            persistence: persistence.clone(),
            root_stream_id: StreamId::new("root"),
            usage: usage.clone(),
            cancel_notify: Arc::new(tokio::sync::Notify::new()),
            execution_id: "exec-1".into(),
            task_id: "task-1".into(),
            verbose: false,
        };

        sink.emit(harness_usage_event("root", "root-usage"))
            .await
            .unwrap();
        sink.emit(harness_usage_event("root/agent/child", "child-usage"))
            .await
            .unwrap();

        {
            let observed = usage.lock().unwrap();
            assert_eq!(observed.input_tokens, 13);
            assert_eq!(observed.output_tokens, 5);
            assert_eq!(observed.cost_microusd, 250_000);
            assert_eq!(observed.turn_deltas, 1);
        }
        assert_eq!(persistence.events.lock().unwrap().len(), 2);

        persistence
            .reject
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let error = sink
            .emit(harness_usage_event("root", "rejected-usage"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("rejected durable event"));
        let observed = usage.lock().unwrap();
        assert_eq!(observed.input_tokens, 13);
        assert_eq!(observed.turn_deltas, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_harness_cancellation_awaits_cleanup_and_settles_once() {
        let (_directory, binary) = fake_hanging_claude_script();
        let service = Arc::new(CapturingExecutionService::default());
        let results: CapturedResults = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (parent, _parent_handle) = Actor::spawn(None, HarnessParent, results.clone())
            .await
            .unwrap();
        let mut config = test_config("exec-harness-cancel");
        config.provider_binaries.anthropic = Some(binary);
        config.execution_service = service.clone();

        let (executor, executor_handle) =
            Actor::spawn(None, StepExecutor, (config, parent.clone()))
                .await
                .unwrap();
        executor.cast(StepExecutorMessage::Execute).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while service.logs().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("harness should emit an event before cancellation");
        executor.cast(StepExecutorMessage::Cancel).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(3), executor_handle)
            .await
            .expect("cancellation should reap Claude and settle");
        tokio::task::yield_now().await;

        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1, "cancellation must settle exactly once");
        let StepResult::Failed { error, .. } = &captured[0].2 else {
            panic!("expected cancelled failure, got {:?}", captured[0].2)
        };
        assert_eq!(error, "Cancelled");
        parent.stop(None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn decoded_claude_control_uses_daemon_permission_policy() {
        let response_directory = tempfile::tempdir().unwrap();
        let response_path = response_directory.path().join("control-response.jsonl");
        let body = format!(
            r#"printf '%s\n' '{{"type":"system","subtype":"init","session_id":"control-session","transcript_path":"opaque://control.jsonl"}}'
printf '%s\n' '{{"type":"control_request","request_id":"control-1","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"pwd"}},"tool_use_id":"tool-1"}}}}'
IFS= read -r response
printf '%s\n' "$response" > '{}'
printf '%s\n' '{{"type":"result","subtype":"success","result":"done"}}'"#,
            response_path.display()
        );
        let (_directory, binary) = fake_claude_with_body(&body);
        let service = Arc::new(CapturingExecutionService::default());
        let results =
            execute_harness_fixture(binary, AgentConfig::default(), service.clone()).await;
        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert!(matches!(captured[0].2, StepResult::Completed { .. }));
        drop(captured);

        let response: serde_json::Value =
            serde_json::from_str(std::fs::read_to_string(response_path).unwrap().trim()).unwrap();
        assert_eq!(response["response"]["request_id"], "control-1");
        assert_eq!(response["response"]["response"]["behavior"], "allow");
        let logs = service.logs();
        let events = logs
            .iter()
            .map(|log| serde_json::from_str::<HarnessEventV1>(&log.content).unwrap())
            .collect::<Vec<_>>();
        assert!(
            events
                .iter()
                .any(|event| matches!(event.payload, HarnessEventPayloadV1::ControlRequested(_)))
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event.payload, HarnessEventPayloadV1::ControlResolved(_)))
        );
        assert!(
            logs.iter()
                .all(|log| log.format.as_deref() == Some("harness"))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn decoded_interactive_control_failure_settles_actor_once() {
        let body = r#"printf '%s\n' '{"type":"system","subtype":"init","session_id":"question-session","transcript_path":"opaque://question.jsonl"}'
printf '%s\n' '{"type":"control_request","request_id":"question-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Choose?","header":"Choice","options":[],"multiSelect":false}]}}}'
exec sleep 30"#;
        let (_directory, binary) = fake_claude_with_body(body);
        let service = Arc::new(CapturingExecutionService::default());
        let results =
            execute_harness_fixture(binary, AgentConfig::default(), service.clone()).await;
        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let StepResult::Failed { error, .. } = &captured[0].2 else {
            panic!("expected control failure, got {:?}", captured[0].2)
        };
        assert!(error.contains("cannot answer interactive"));
        assert!(
            service
                .logs()
                .iter()
                .all(|log| log.format.as_deref() == Some("harness"))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nonzero_provider_outcome_settles_actor_once() {
        let body = r#"printf '%s\n' '{"type":"system","subtype":"init","session_id":"failed-session","transcript_path":"opaque://failed.jsonl"}'
printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"provider rejected the run"}'
exit 7"#;
        let (_directory, binary) = fake_claude_with_body(body);
        let results = execute_harness_fixture(
            binary,
            AgentConfig::default(),
            Arc::new(CapturingExecutionService::default()),
        )
        .await;
        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let StepResult::Failed { error, .. } = &captured[0].2 else {
            panic!("expected provider failure, got {:?}", captured[0].2)
        };
        assert!(error.contains("provider rejected the run"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provider_process_loss_settles_actor_once() {
        let body = r#"printf '%s\n' '{"type":"system","subtype":"init","session_id":"lost-session","transcript_path":"opaque://lost.jsonl"}'
exit 9"#;
        let (_directory, binary) = fake_claude_with_body(body);
        let results = execute_harness_fixture(
            binary,
            AgentConfig::default(),
            Arc::new(CapturingExecutionService::default()),
        )
        .await;
        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let StepResult::Failed { error, .. } = &captured[0].2 else {
            panic!("expected process loss, got {:?}", captured[0].2)
        };
        assert!(error.contains("without a result record"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn harness_schema_mismatch_preserves_structured_validation_errors() {
        let body = r#"printf '%s\n' '{"type":"system","subtype":"init","session_id":"schema-session","transcript_path":"opaque://schema.jsonl"}'
printf '%s\n' '{"type":"result","subtype":"success","result":"done","structured_output":{"answer":42}}'"#;
        let (_directory, binary) = fake_claude_with_body(body);
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"]
        });
        let results = execute_harness_fixture(
            binary,
            AgentConfig::new().with_json_schema(schema),
            Arc::new(CapturingExecutionService::default()),
        )
        .await;
        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let StepResult::Failed {
            schema_errors: Some(errors),
            ..
        } = &captured[0].2
        else {
            panic!("expected schema failure, got {:?}", captured[0].2)
        };
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].instance_path, "/answer");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_harness_cancellation_interrupts_blocked_persistence() {
        let (_directory, binary) = fake_hanging_claude_script();
        let service = Arc::new(CapturingExecutionService::blocking());
        let results: CapturedResults = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (parent, _parent_handle) = Actor::spawn(None, HarnessParent, results.clone())
            .await
            .unwrap();
        let mut config = test_config("exec-harness-blocked-persistence");
        config.provider_binaries.anthropic = Some(binary);
        config.execution_service = service.clone();

        let (executor, executor_handle) =
            Actor::spawn(None, StepExecutor, (config, parent.clone()))
                .await
                .unwrap();
        executor.cast(StepExecutorMessage::Execute).unwrap();
        tokio::time::timeout(Duration::from_secs(2), service.add_started.notified())
            .await
            .expect("harness should attempt durable persistence");

        executor.cast(StepExecutorMessage::Cancel).unwrap();
        tokio::time::timeout(Duration::from_secs(3), executor_handle)
            .await
            .expect("cancellation must interrupt blocked persistence")
            .expect("actor task must join");
        tokio::task::yield_now().await;

        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1, "cancellation must settle exactly once");
        let StepResult::Failed { error, .. } = &captured[0].2 else {
            panic!("expected terminal failure, got {:?}", captured[0].2)
        };
        assert!(
            error.contains("event sink failed"),
            "runtime failure must remain authoritative, got {error}"
        );
        assert!(service.logs().is_empty());
        parent.stop(None);
    }

    #[tokio::test]
    async fn accepted_cancel_does_not_mask_later_cleanup_failure() {
        let results: CapturedResults = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (parent, _parent_handle) = Actor::spawn(None, HarnessParent, results.clone())
            .await
            .unwrap();
        let mut state = build_state(AgentConfig::default()).await;
        state.parent = parent.clone();
        let run: Arc<dyn RunHandle> = Arc::new(CleanupFailingRun {
            run_id: RunId::new("cleanup-failure-run"),
        });
        state.harness_run = Some(run.clone());
        let (actor_ref, actor_handle) = Actor::spawn(
            None,
            StepExecutor,
            (test_config("late-cancel-probe"), state.parent.clone()),
        )
        .await
        .unwrap();

        StepExecutor
            .handle_cancel(actor_ref.clone(), &mut state)
            .await;
        let outcome = run.await_outcome().await.unwrap();
        StepExecutor
            .handle_harness_settled(Ok(outcome), actor_ref.clone(), &mut state)
            .await;
        let _ = actor_handle.await;
        tokio::task::yield_now().await;

        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let StepResult::Failed { error, .. } = &captured[0].2 else {
            panic!("expected cleanup failure, got {:?}", captured[0].2)
        };
        assert_eq!(error, "cleanup sink failure");
        parent.stop(None);
    }

    #[tokio::test]
    async fn harness_settlement_before_late_cancel_reports_failure_exactly_once() {
        let results: CapturedResults = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (parent, _parent_handle) = Actor::spawn(None, HarnessParent, results.clone())
            .await
            .unwrap();
        let (executor, executor_handle) = Actor::spawn(
            None,
            StepExecutor,
            (test_config("settled-before-cancel"), parent.clone()),
        )
        .await
        .unwrap();

        executor
            .cast(StepExecutorMessage::HarnessSettled(Err(
                "settled provider failure".into(),
            )))
            .unwrap();
        executor.cast(StepExecutorMessage::Cancel).unwrap();
        let _ = executor_handle.await;
        tokio::task::yield_now().await;

        let captured = results.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let StepResult::Failed { error, .. } = &captured[0].2 else {
            panic!("expected settled failure, got {:?}", captured[0].2)
        };
        assert!(error.contains("settled provider failure"));
        parent.stop(None);
    }

    #[test]
    fn stream_json_session_log_line_adds_logical_key_for_ephemeral_snapshot() {
        let log = session_log_for_provider_line(
            "exec-1",
            r#"{"type":"system","subtype":"task_progress","tool_use_id":"toolu-1"}"#.to_string(),
            ParserKind::StreamJson,
        );

        assert_eq!(log.step_execution_id, "exec-1");
        assert_eq!(log.format.as_deref(), Some("anthropic"));
        assert_eq!(log.logical_key.as_deref(), Some("task_progress:toolu-1"));
    }

    #[test]
    fn stream_json_session_log_line_keeps_durable_lines_append_only() {
        let log = session_log_for_provider_line(
            "exec-1",
            r#"{"type":"assistant","message":{}}"#.to_string(),
            ParserKind::StreamJson,
        );

        assert_eq!(log.format.as_deref(), Some("anthropic"));
        assert!(log.logical_key.is_none());
    }

    #[test]
    fn codex_jsonl_session_log_line_never_adds_logical_key() {
        let log = session_log_for_provider_line(
            "exec-1",
            r#"{"type":"system","subtype":"thinking_tokens","session_id":"sess-1"}"#.to_string(),
            ParserKind::CodexJsonl,
        );

        assert_eq!(log.format.as_deref(), Some("openai"));
        assert!(log.logical_key.is_none());
    }

    #[test]
    fn step_config_debug_format() {
        let config = StepConfig {
            prompt: "Implement feature X".to_string(),
            agent_config: AgentConfig::new().with_model("claude-sonnet-4-20250514"),
            agents: vec!["reviewer.md".to_string()],
            skills: vec!["search".to_string()],
            verbose_daemon_logging: false,
        };
        let debug = format!("{:?}", config);
        assert!(debug.contains("Implement feature X"));
        assert!(debug.contains("claude-sonnet-4-20250514"));
        assert!(debug.contains("reviewer.md"));
        assert!(debug.contains("search"));
    }

    #[test]
    fn step_config_clone() {
        let config = StepConfig {
            prompt: "Do something".to_string(),
            agent_config: AgentConfig::new().with_model("claude-sonnet-4-20250514"),
            agents: vec!["agent.md".to_string()],
            skills: Vec::new(),
            verbose_daemon_logging: false,
        };
        let cloned = config.clone();
        assert_eq!(cloned.prompt, "Do something");
        assert_eq!(
            cloned.agent_config.model,
            Some("claude-sonnet-4-20250514".to_string())
        );
        assert_eq!(cloned.agents, vec!["agent.md"]);
    }

    #[test]
    fn step_executor_config_debug_format() {
        let config = StepExecutorConfig {
            execution_id: "exec-123".to_string(),
            task_id: "task-abc".to_string(),
            step_config: make_step_config("test prompt"),
            project_root: PathBuf::from("/home/user/project"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };
        let debug = format!("{:?}", config);
        assert!(debug.contains("exec-123"));
        assert!(debug.contains("task-abc"));
        assert!(debug.contains("test prompt"));
        assert!(debug.contains("/home/user/project"));
        assert!(debug.contains("ExecutionService"));
    }

    #[test]
    fn step_result_completed_debug() {
        let result = StepResult::Completed {
            exit_code: 0,
            metrics: None,
            output: None,
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("Completed"));
        assert!(debug.contains("0"));
    }

    #[test]
    fn step_result_completed_with_output_debug() {
        let result = StepResult::Completed {
            exit_code: 0,
            metrics: None,
            output: Some("Implementation finished".to_string()),
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("Completed"));
        assert!(debug.contains("Implementation finished"));
    }

    #[test]
    fn step_result_completed_without_output() {
        let result = StepResult::Completed {
            exit_code: 0,
            metrics: Some(crate::stream_json::StreamMetrics {
                input_tokens: 100,
                output_tokens: 50,
                cost_usd: 0.01,
                duration_ms: 500,
            }),
            output: None,
        };
        match result {
            StepResult::Completed {
                exit_code,
                metrics,
                output,
            } => {
                assert_eq!(exit_code, 0);
                assert!(metrics.is_some());
                assert!(output.is_none());
            }
            _ => panic!("Expected Completed"),
        }
    }

    #[test]
    fn step_result_completed_with_metrics_and_output() {
        let result = StepResult::Completed {
            exit_code: 0,
            metrics: Some(crate::stream_json::StreamMetrics {
                input_tokens: 1500,
                output_tokens: 800,
                cost_usd: 0.003,
                duration_ms: 5432,
            }),
            output: Some("All tests pass".to_string()),
        };
        match result {
            StepResult::Completed {
                exit_code,
                metrics,
                output,
            } => {
                assert_eq!(exit_code, 0);
                let m = metrics.expect("metrics should be present");
                assert_eq!(m.input_tokens, 1500);
                assert_eq!(m.output_tokens, 800);
                assert_eq!(output.as_deref(), Some("All tests pass"));
            }
            _ => panic!("Expected Completed"),
        }
    }

    #[test]
    fn step_result_failed_debug() {
        let result = StepResult::failed(Some(1), "something went wrong");
        let debug = format!("{:?}", result);
        assert!(debug.contains("Failed"));
        assert!(debug.contains("something went wrong"));
    }

    #[test]
    fn step_result_failed_no_exit_code_debug() {
        let result = StepResult::failed(None, "spawn error");
        let debug = format!("{:?}", result);
        assert!(debug.contains("None"));
        assert!(debug.contains("spawn error"));
    }

    #[test]
    fn step_result_clone() {
        let result = StepResult::Completed {
            exit_code: 42,
            metrics: None,
            output: Some("test output".to_string()),
        };
        let cloned = result.clone();
        match cloned {
            StepResult::Completed {
                exit_code, output, ..
            } => {
                assert_eq!(exit_code, 42);
                assert_eq!(output.as_deref(), Some("test output"));
            }
            _ => panic!("Expected Completed"),
        }
    }

    #[test]
    fn message_debug_execute() {
        let msg = StepExecutorMessage::Execute;
        assert_eq!(format!("{:?}", msg), "Execute");
    }

    #[test]
    fn message_debug_cancel() {
        let msg = StepExecutorMessage::Cancel;
        assert_eq!(format!("{:?}", msg), "Cancel");
    }

    #[test]
    fn message_debug_process_exited_ok() {
        let msg = StepExecutorMessage::ProcessExited(Err("io error".to_string()));
        let debug = format!("{:?}", msg);
        assert!(debug.contains("ProcessExited"));
        assert!(debug.contains("io error"));
    }

    #[test]
    fn build_command_has_correct_program() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: make_step_config("Write tests"),
            project_root: PathBuf::from("/home/user/myproject"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let program = cmd.as_std().get_program();
        assert_eq!(program, "/usr/local/bin/claude");
    }

    #[test]
    fn build_command_default_config_includes_model_and_permission_mode() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: make_step_config("Implement feature Y"),
            project_root: PathBuf::from("/projects/test"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        // Default model should be applied when agent_config has no model.
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&DEFAULT_MODEL.to_string()));

        // Default permission mode should be bypassPermissions.
        assert!(args.contains(&"--permission-mode".to_string()));
        assert!(args.contains(&"bypassPermissions".to_string()));

        // Prompt and output format always present.
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"Implement feature Y".to_string()));
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));

        // --print + stream-json requires --verbose on Claude Code >= 2.x.
        assert!(args.contains(&"--verbose".to_string()));
    }

    #[test]
    fn build_command_with_explicit_model_uses_it() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new().with_model("claude-opus-4-20250514"),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"claude-opus-4-20250514".to_string()));
        assert!(!args.contains(&DEFAULT_MODEL.to_string()));
    }

    #[test]
    fn build_command_with_agents_produces_agent_flags() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::default(),
                agents: vec!["reviewer.md".to_string(), "coder.md".to_string()],
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        let agent_indices: Vec<usize> = args
            .iter()
            .enumerate()
            .filter(|(_, a)| *a == "--agent")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(agent_indices.len(), 2);
        assert_eq!(args[agent_indices[0] + 1], "reviewer.md");
        assert_eq!(args[agent_indices[1] + 1], "coder.md");
    }

    #[test]
    fn build_command_with_skills_produces_allowed_tools() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::default(),
                agents: Vec::new(),
                skills: vec!["WebSearch".to_string(), "Read".to_string()],
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"--allowed-tools".to_string()));
        assert!(args.contains(&"WebSearch".to_string()));
        assert!(args.contains(&"Read".to_string()));
    }

    #[test]
    fn build_command_skills_merge_with_existing_allowed_tools() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new()
                    .with_allowed_tools(vec!["Bash".to_string(), "WebSearch".to_string()]),
                agents: Vec::new(),
                skills: vec!["WebSearch".to_string(), "Edit".to_string()],
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        // WebSearch should appear once (not duplicated).
        let ws_count = args.iter().filter(|a| *a == "WebSearch").count();
        assert_eq!(ws_count, 1, "WebSearch should not be duplicated");

        // Both Bash and Edit should be present.
        assert!(args.contains(&"Bash".to_string()));
        assert!(args.contains(&"Edit".to_string()));
    }

    #[test]
    fn build_command_with_full_agent_config() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new()
                    .with_model("claude-opus-4-20250514")
                    .with_max_budget_usd(5.0)
                    .with_append_system_prompt("Be careful".to_string())
                    .with_disallowed_tools(vec!["Bash(rm*)".to_string()]),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"claude-opus-4-20250514".to_string()));
        assert!(args.contains(&"--max-budget-usd".to_string()));
        assert!(args.contains(&"5".to_string()));
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert!(args.contains(&"Be careful".to_string()));
        assert!(args.contains(&"--disallowed-tools".to_string()));
        assert!(args.contains(&"Bash(rm*)".to_string()));
    }

    #[test]
    fn build_command_explicit_permission_mode_not_overridden() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new().with_permission_mode(PermissionMode::Plan),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"plan".to_string()));
        assert!(!args.contains(&"bypassPermissions".to_string()));
    }

    #[test]
    fn build_command_has_correct_working_directory() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: make_step_config("Do work"),
            project_root: PathBuf::from("/home/user/code"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let cwd = cmd.as_std().get_current_dir().unwrap();
        assert_eq!(cwd, PathBuf::from("/home/user/code"));
    }

    #[test]
    fn build_command_prompt_with_special_characters() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "Fix the bug in `src/main.rs` where the \"parser\" fails".to_string(),
                agent_config: AgentConfig::default(),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(
            args.contains(&"Fix the bug in `src/main.rs` where the \"parser\" fails".to_string())
        );
    }

    #[test]
    fn build_command_includes_json_schema_flag_when_output_schema_provided() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "summary": { "type": "string" },
                "passed": { "type": "boolean" }
            },
            "required": ["summary", "passed"]
        });

        let config = StepExecutorConfig {
            execution_id: "exec-os".to_string(),
            task_id: "task-os".to_string(),
            step_config: StepConfig {
                prompt: "Evaluate this".to_string(),
                agent_config: AgentConfig::new().with_json_schema(schema.clone()),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(
            args.contains(&"--json-schema".to_string()),
            "CLI args should contain --json-schema when output_schema is provided"
        );

        let schema_idx = args
            .iter()
            .position(|a| a == "--json-schema")
            .expect("--json-schema flag should be present");
        let schema_value: serde_json::Value =
            serde_json::from_str(&args[schema_idx + 1]).expect("schema arg should be valid JSON");
        assert_eq!(schema_value["type"], "object");
        assert_eq!(schema_value["properties"]["summary"]["type"], "string");
        assert_eq!(schema_value["properties"]["passed"]["type"], "boolean");
        assert_eq!(
            schema_value["required"],
            serde_json::json!(["summary", "passed"])
        );
    }

    #[test]
    fn build_command_no_json_schema_flag_when_output_schema_absent() {
        let cmd = build_claude_command_with_settings(&test_config("exec-no-os"), None)
            .expect("anthropic builder must succeed in tests");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(
            !args.contains(&"--json-schema".to_string()),
            "CLI args should NOT contain --json-schema when output_schema is absent"
        );
    }

    #[tokio::test]
    async fn step_executor_spawn_failure_reports_to_parent() {
        use ractor::Actor;

        struct MockParent;

        impl Actor for MockParent {
            type Msg = ProjectMessage;
            type State = Vec<ProjectMessage>;
            type Arguments = ();

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(Vec::new())
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                message: Self::Msg,
                state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                state.push(message);
                Ok(())
            }
        }

        let (parent_ref, _parent_handle) =
            Actor::spawn(Some("mock-parent".to_string()), MockParent, ())
                .await
                .expect("Failed to spawn mock parent");

        let mut config = test_config("exec-fail");
        config.project_root = PathBuf::from("/nonexistent/path/that/does/not/exist");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-fail".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        executor_ref
            .cast(StepExecutorMessage::Execute)
            .expect("Failed to send Execute");

        let _ = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        parent_ref.stop(Some("test done".to_string()));
    }

    #[tokio::test]
    async fn step_executor_cancel_stops_actor() {
        use ractor::Actor;

        struct MockParent;

        impl Actor for MockParent {
            type Msg = ProjectMessage;
            type State = ();
            type Arguments = ();

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(())
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                _message: Self::Msg,
                _state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                Ok(())
            }
        }

        let (parent_ref, _parent_handle) =
            Actor::spawn(Some("mock-parent-cancel".to_string()), MockParent, ())
                .await
                .expect("Failed to spawn mock parent");

        let config = test_config("exec-cancel");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-cancel".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        executor_ref
            .cast(StepExecutorMessage::Cancel)
            .expect("Failed to send Cancel");

        let result = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        assert!(
            result.is_ok(),
            "StepExecutor should have stopped after Cancel"
        );

        parent_ref.stop(Some("test done".to_string()));
    }

    #[tokio::test]
    async fn step_executor_successful_process_reports_completed() {
        use ractor::Actor;
        use std::sync::Mutex;

        struct CapturingParent;

        impl Actor for CapturingParent {
            type Msg = ProjectMessage;
            type State = Arc<Mutex<Vec<(String, String, StepResult)>>>;
            type Arguments = Arc<Mutex<Vec<(String, String, StepResult)>>>;

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(args)
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                message: Self::Msg,
                state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                if let ProjectMessage::StepFinished {
                    execution_id,
                    task_id,
                    result,
                } = message
                {
                    state.lock().unwrap().push((execution_id, task_id, result));
                }
                Ok(())
            }
        }

        let captured: Arc<Mutex<Vec<(String, String, StepResult)>>> =
            Arc::new(Mutex::new(Vec::new()));

        let (parent_ref, _parent_handle) = Actor::spawn(
            Some("capturing-parent".to_string()),
            CapturingParent,
            Arc::clone(&captured),
        )
        .await
        .expect("Failed to spawn capturing parent");

        let config = test_config("exec-success");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-success".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        executor_ref
            .cast(StepExecutorMessage::Execute)
            .expect("Failed to send Execute");

        let _ = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let messages = captured.lock().unwrap();
        assert_eq!(
            messages.len(),
            1,
            "Parent should have received exactly one StepFinished"
        );
        assert_eq!(messages[0].0, "exec-success");
        assert_eq!(messages[0].1, "task-test");

        match &messages[0].2 {
            StepResult::Failed { error, .. } => {
                assert!(!error.is_empty());
            }
            StepResult::Completed { exit_code, .. } => {
                assert!(*exit_code >= 0);
            }
        }

        parent_ref.stop(Some("test done".to_string()));
    }

    #[tokio::test]
    async fn step_executor_cancel_reports_failed_with_task_id() {
        use ractor::Actor;
        use std::sync::Mutex;

        struct CapturingParent;

        static CANCEL_RESULTS: std::sync::LazyLock<CapturedResults> =
            std::sync::LazyLock::new(|| Arc::new(Mutex::new(Vec::new())));

        impl Actor for CapturingParent {
            type Msg = ProjectMessage;
            type State = ();
            type Arguments = ();

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(())
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                message: Self::Msg,
                _state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                if let ProjectMessage::StepFinished {
                    execution_id,
                    task_id,
                    result,
                } = message
                {
                    CANCEL_RESULTS
                        .lock()
                        .unwrap()
                        .push((execution_id, task_id, result));
                }
                Ok(())
            }
        }

        CANCEL_RESULTS.lock().unwrap().clear();

        let (parent_ref, _parent_handle) = Actor::spawn(
            Some("cancel-capture-parent".to_string()),
            CapturingParent,
            (),
        )
        .await
        .expect("Failed to spawn parent");

        let config = test_config("exec-cancel-capture");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-cancel-capture".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        executor_ref
            .cast(StepExecutorMessage::Cancel)
            .expect("Failed to send Cancel");

        let _ = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let results = CANCEL_RESULTS.lock().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "exec-cancel-capture");
        assert_eq!(results[0].1, "task-test");
        match &results[0].2 {
            StepResult::Failed { error, .. } => {
                assert_eq!(error, "Cancelled");
            }
            other => panic!("Expected StepResult::Failed, got {:?}", other),
        }

        parent_ref.stop(Some("test done".to_string()));
    }

    #[tokio::test]
    async fn step_executor_process_exited_with_no_child_reports_failed() {
        use ractor::Actor;
        use std::sync::Mutex;

        struct CapturingParent;

        static NO_CHILD_RESULTS: std::sync::LazyLock<CapturedResults> =
            std::sync::LazyLock::new(|| Arc::new(Mutex::new(Vec::new())));

        impl Actor for CapturingParent {
            type Msg = ProjectMessage;
            type State = ();
            type Arguments = ();

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(())
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                message: Self::Msg,
                _state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                if let ProjectMessage::StepFinished {
                    execution_id,
                    task_id,
                    result,
                } = message
                {
                    NO_CHILD_RESULTS
                        .lock()
                        .unwrap()
                        .push((execution_id, task_id, result));
                }
                Ok(())
            }
        }

        NO_CHILD_RESULTS.lock().unwrap().clear();

        let (parent_ref, _parent_handle) =
            Actor::spawn(Some("no-child-parent".to_string()), CapturingParent, ())
                .await
                .expect("Failed to spawn parent");

        let config = test_config("exec-no-child");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-no-child".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        // Send ProcessExited without having spawned a child process.
        executor_ref
            .cast(StepExecutorMessage::ProcessExited(Ok(
                std::process::ExitStatus::default(),
            )))
            .expect("Failed to send ProcessExited");

        let _ = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let results = NO_CHILD_RESULTS.lock().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "exec-no-child");
        assert_eq!(results[0].1, "task-test");
        match &results[0].2 {
            StepResult::Failed { error, .. } => {
                assert!(error.contains("No child process"));
            }
            other => panic!("Expected StepResult::Failed, got {:?}", other),
        }

        parent_ref.stop(Some("test done".to_string()));
    }

    // ===== Worktree override tests =====

    #[test]
    fn build_command_uses_worktree_as_working_directory_when_set() {
        let config = StepExecutorConfig {
            execution_id: "exec-wt-1".to_string(),
            task_id: "task-wt-1".to_string(),
            step_config: make_step_config("Do work in worktree"),
            project_root: PathBuf::from("/home/user/code"),
            worktree: Some(PathBuf::from("/home/user/code-worktree-abc")),
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let cwd = cmd.as_std().get_current_dir().unwrap();
        assert_eq!(
            cwd,
            PathBuf::from("/home/user/code-worktree-abc"),
            "current_dir should be the worktree path, not the project_root"
        );
    }

    #[test]
    fn build_command_falls_back_to_project_root_when_worktree_is_none() {
        let config = StepExecutorConfig {
            execution_id: "exec-wt-2".to_string(),
            task_id: "task-wt-2".to_string(),
            step_config: make_step_config("Do work without worktree"),
            project_root: PathBuf::from("/home/user/code"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let cwd = cmd.as_std().get_current_dir().unwrap();
        assert_eq!(
            cwd,
            PathBuf::from("/home/user/code"),
            "current_dir should be the project_root when worktree is None"
        );
    }

    #[test]
    fn step_executor_config_debug_includes_worktree() {
        let config = StepExecutorConfig {
            execution_id: "exec-wt-dbg".to_string(),
            task_id: "task-wt-dbg".to_string(),
            step_config: make_step_config("test"),
            project_root: PathBuf::from("/home/user/project"),
            worktree: Some(PathBuf::from("/home/user/project-wt-abc")),
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };
        let debug = format!("{:?}", config);
        assert!(
            debug.contains("project-wt-abc"),
            "Debug output should include the worktree path"
        );
    }

    // ===== Integration tests for schema-validation plumbing =====

    async fn spawn_dummy_parent() -> ActorRef<ProjectMessage> {
        struct DummyParent;
        impl Actor for DummyParent {
            type Msg = ProjectMessage;
            type State = ();
            type Arguments = ();
            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(())
            }
            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                _message: Self::Msg,
                _state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                Ok(())
            }
        }
        let (parent_ref, _handle) = Actor::spawn(None, DummyParent, ())
            .await
            .expect("dummy parent spawn");
        parent_ref
    }

    async fn build_state(agent_config: AgentConfig) -> StepExecutorState {
        let parent = spawn_dummy_parent().await;
        let config = StepExecutorConfig {
            execution_id: "exec-validate".to_string(),
            task_id: "task-validate".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config,
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };
        let compiled_schema = config
            .step_config
            .agent_config
            .json_schema
            .as_ref()
            .map(crate::output_validator::CompiledSchema::compile);
        StepExecutorState {
            execution_id: config.execution_id.clone(),
            task_id: config.task_id.clone(),
            config,
            parent,
            child_process: None,
            harness_run: None,
            harness_outcome_handle: None,
            harness_usage: Arc::new(std::sync::Mutex::new(HarnessUsageMetrics::default())),
            harness_cancel_notify: Arc::new(tokio::sync::Notify::new()),
            stream_handle: None,
            stream_result: std::sync::Arc::new(std::sync::Mutex::new(
                HarnessStreamResult::default(),
            )),
            compiled_schema,
            settings_guard: None,
        }
    }

    #[tokio::test]
    async fn validate_output_skipped_when_no_schema_declared() {
        let state = build_state(AgentConfig::default()).await;
        assert!(state.compiled_schema.is_none());
        let executor = StepExecutor;
        assert_eq!(executor.validate_output(&state, None, None), Ok(()));
        assert_eq!(
            executor.validate_output(&state, None, Some("not json")),
            Ok(())
        );
        assert_eq!(
            executor.validate_output(&state, None, Some("```json\n{\"x\":1}\n```")),
            Ok(())
        );
    }

    #[tokio::test]
    async fn validate_output_accepts_valid_fenced_json_matching_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"]
        });
        let state = build_state(AgentConfig::new().with_json_schema(schema)).await;
        assert!(
            matches!(state.compiled_schema, Some(Ok(_))),
            "schema should have compiled"
        );
        let executor = StepExecutor;
        let output = "Here:\n```json\n{\"summary\":\"all good\"}\n```";
        assert_eq!(executor.validate_output(&state, None, Some(output)), Ok(()));
    }

    #[tokio::test]
    async fn validate_output_rejects_violating_output_with_structured_errors() {
        use crate::output_validator::SchemaError;
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"]
        });
        let state = build_state(AgentConfig::new().with_json_schema(schema)).await;
        let executor = StepExecutor;
        let output = "```json\n{\"summary\":42}\n```";
        match executor.validate_output(&state, None, Some(output)) {
            Err(SchemaError::SchemaViolation(errors)) => {
                assert!(!errors.is_empty());
                assert!(
                    errors.iter().any(|e| e.instance_path.contains("summary")),
                    "expected path to mention summary, got {errors:?}"
                );
            }
            other => panic!("expected SchemaViolation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn validate_output_rejects_missing_output_when_schema_declared() {
        use crate::output_validator::SchemaError;
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"x": {"type": "integer"}},
            "required": ["x"]
        });
        let state = build_state(AgentConfig::new().with_json_schema(schema)).await;
        let executor = StepExecutor;
        assert_eq!(
            executor.validate_output(&state, None, None),
            Err(SchemaError::MissingOutput)
        );
        assert_eq!(
            executor.validate_output(&state, None, Some("")),
            Err(SchemaError::MissingOutput)
        );
        assert_eq!(
            executor.validate_output(&state, None, Some("no fence here at all")),
            Err(SchemaError::MissingOutput)
        );
    }

    #[tokio::test]
    async fn validate_output_rejects_invalid_json_inside_fence() {
        use crate::output_validator::SchemaError;
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"x": {"type": "integer"}}
        });
        let state = build_state(AgentConfig::new().with_json_schema(schema)).await;
        let executor = StepExecutor;
        let output = "```json\n{not json}\n```";
        match executor.validate_output(&state, None, Some(output)) {
            Err(SchemaError::InvalidJson(msg)) => assert!(!msg.is_empty()),
            other => panic!("expected InvalidJson, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn validate_output_surfaces_malformed_schema_as_compile_error() {
        use crate::output_validator::SchemaError;
        // `type` must be a string or array of strings.
        let bad_schema = serde_json::json!({"type": {"nested": "wrong"}});
        let state = build_state(AgentConfig::new().with_json_schema(bad_schema)).await;
        assert!(
            matches!(state.compiled_schema, Some(Err(_))),
            "malformed schema should be recorded as compile error"
        );
        let executor = StepExecutor;
        match executor.validate_output(&state, None, Some("```json\n{}\n```")) {
            Err(SchemaError::SchemaCompile(msg)) => assert!(!msg.is_empty()),
            other => panic!("expected SchemaCompile, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn validate_output_accepts_prose_on_both_sides_of_fence() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"result": {"type": "string"}},
            "required": ["result"]
        });
        let state = build_state(AgentConfig::new().with_json_schema(schema)).await;
        let executor = StepExecutor;
        let output = "Some preamble about the analysis.\n\n```json\n{\"result\":\"yay\"}\n```\n\nTrailing thoughts.";
        assert_eq!(executor.validate_output(&state, None, Some(output)), Ok(()));
    }

    // ===== Synthesized --settings injection tests =====

    fn collect_args(cmd: &Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn build_command_with_settings_injects_flag_before_agent_config() {
        let config = test_config("exec-settings");
        let settings = PathBuf::from("/tmp/vtb-daemon-fake/settings.json");
        let cmd = build_claude_command_with_settings(&config, Some(&settings))
            .expect("anthropic builder must succeed in tests");
        let args = collect_args(&cmd);

        let settings_idx = args
            .iter()
            .position(|a| a == "--settings")
            .expect("--settings flag must be present when path is provided");
        assert_eq!(
            args[settings_idx + 1],
            settings.to_string_lossy(),
            "--settings must be followed by the synthesized path"
        );

        let model_idx = args
            .iter()
            .position(|a| a == "--model")
            .expect("agent_config should still emit --model");
        assert!(
            settings_idx < model_idx,
            "--settings must appear before agent_config flags so later flags can override JSON values"
        );

        // agent_config still wins on permission mode (bypassPermissions auto-injected).
        assert!(args.contains(&"--permission-mode".to_string()));
        assert!(args.contains(&"bypassPermissions".to_string()));
    }

    #[test]
    fn build_command_without_settings_does_not_emit_flag() {
        let config = test_config("exec-no-settings");
        let cmd = build_claude_command_with_settings(&config, None)
            .expect("anthropic builder must succeed in tests");
        let args = collect_args(&cmd);
        assert!(
            !args.contains(&"--settings".to_string()),
            "--settings must not be emitted when no path is supplied"
        );
    }

    #[test]
    fn build_command_with_settings_preserves_explicit_permission_mode() {
        // Composition: step sets permission_mode=plan, daemon still ships
        // --settings for the deny hook. Both must appear.
        let config = StepExecutorConfig {
            execution_id: "exec-compose".to_string(),
            task_id: "task-compose".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new().with_permission_mode(PermissionMode::Plan),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };
        let settings = PathBuf::from("/tmp/vtb-daemon-compose/settings.json");
        let cmd = build_claude_command_with_settings(&config, Some(&settings))
            .expect("anthropic builder must succeed in tests");
        let args = collect_args(&cmd);

        // Settings flag present.
        assert!(args.contains(&"--settings".to_string()));
        assert!(args.contains(&settings.to_string_lossy().to_string()));

        // Explicit permission_mode=plan is NOT overridden by default bypass injection.
        assert!(args.contains(&"plan".to_string()));
        assert!(
            !args.contains(&"bypassPermissions".to_string()),
            "explicit permission_mode=plan must not be replaced with bypassPermissions"
        );
    }

    #[test]
    fn build_command_with_settings_preserves_disallowed_tools_from_agent_config() {
        // Composition: deny hook + per-step disallowed_tools. Both must reach
        // the CLI independently.
        let config = StepExecutorConfig {
            execution_id: "exec-deny".to_string(),
            task_id: "task-deny".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new()
                    .with_disallowed_tools(vec!["Bash(rm -rf *)".to_string()]),
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        };
        let settings = PathBuf::from("/tmp/vtb-daemon-deny/settings.json");
        let cmd = build_claude_command_with_settings(&config, Some(&settings))
            .expect("anthropic builder must succeed in tests");
        let args = collect_args(&cmd);

        assert!(args.contains(&"--settings".to_string()));
        assert!(args.contains(&"--disallowed-tools".to_string()));
        assert!(args.contains(&"Bash(rm -rf *)".to_string()));
    }

    // ===== verbose_daemon_logging tests =====

    fn argv_of(cmd: &Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn verbose_step_config(verbose: bool) -> StepConfig {
        StepConfig {
            prompt: "Implement Z".to_string(),
            agent_config: AgentConfig::new()
                .with_model("claude-sonnet-4-20250514")
                .with_json_schema(serde_json::json!({
                    "type": "object",
                    "properties": {"verdict": {"type": "string"}}
                })),
            agents: Vec::new(),
            skills: Vec::new(),
            verbose_daemon_logging: verbose,
        }
    }

    fn verbose_test_config(verbose: bool) -> StepExecutorConfig {
        StepExecutorConfig {
            execution_id: "exec-vrb".to_string(),
            task_id: "task-vrb".to_string(),
            step_config: verbose_step_config(verbose),
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries: ProviderBinaries {
                anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
                openai: Some(PathBuf::from("/usr/local/bin/codex")),
            },
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        }
    }

    #[test]
    fn build_command_argv_is_identical_regardless_of_verbose_flag() {
        // Constraint #1: when the flag is absent or false, the non-verbose path
        // must remain byte-identical. Toggling the flag may emit a log line but
        // must not alter the resolved argv passed to the child process.
        let off = build_claude_command_with_settings(&verbose_test_config(false), None)
            .expect("anthropic builder must succeed in tests");
        let on = build_claude_command_with_settings(&verbose_test_config(true), None)
            .expect("anthropic builder must succeed in tests");
        assert_eq!(
            argv_of(&off),
            argv_of(&on),
            "verbose flag must not alter the claude argv"
        );
    }

    #[test]
    fn build_command_with_verbose_includes_full_json_schema_in_argv() {
        // Sanity: the argv we promise to log under verbose actually contains
        // --json-schema with the full schema JSON.
        let cmd = build_claude_command_with_settings(&verbose_test_config(true), None)
            .expect("anthropic builder must succeed in tests");
        let args = argv_of(&cmd);
        let idx = args
            .iter()
            .position(|a| a == "--json-schema")
            .expect("--json-schema flag should be present when json_schema set");
        let schema_str = &args[idx + 1];
        let parsed: serde_json::Value =
            serde_json::from_str(schema_str).expect("schema arg must be valid JSON");
        assert_eq!(parsed["type"], "object");
        assert_eq!(parsed["properties"]["verdict"]["type"], "string");
    }

    #[test]
    fn process_exit_code_unknown_is_negative_one() {
        // Wire-protocol contract with downstream consumers (Sacrum + GUI):
        // -1 is the sentinel for "child exited without a numeric code".
        assert_eq!(PROCESS_EXIT_CODE_UNKNOWN, -1);
    }

    #[test]
    fn log_built_argv_returns_resolved_argv_for_anthropic() {
        let cfg = test_config("exec-log-anthropic");
        let cmd = build_claude_command_with_settings(&cfg, None)
            .expect("anthropic builder must succeed in tests");
        let argv = log_built_argv(&cmd, &cfg, Provider::Anthropic, "test");
        assert!(!argv.is_empty(), "argv must not be empty");
        assert!(argv.contains(&"-p".to_string()));
        assert!(argv.contains(&"--output-format".to_string()));
        assert!(argv.contains(&"stream-json".to_string()));
        assert!(argv.contains(&"--verbose".to_string()));
    }

    #[test]
    fn log_built_argv_mirrors_command_args_in_order() {
        // The returned argv must match the Command's argv exactly, in order.
        let cfg = test_config("exec-log-mirror");
        let cmd = build_claude_command_with_settings(&cfg, None)
            .expect("anthropic builder must succeed in tests");
        let baseline = argv_of(&cmd);
        let returned = log_built_argv(&cmd, &cfg, Provider::Anthropic, "test");
        assert_eq!(returned, baseline);
    }

    #[test]
    fn step_result_for_schema_violation_returns_failed_schema_with_errors() {
        use crate::output_validator::SchemaValidationError;

        let errors = vec![SchemaValidationError {
            instance_path: "/foo".to_string(),
            schema_path: "#/properties/foo/type".to_string(),
            message: "is not of type 'string'".to_string(),
        }];
        let err = SchemaError::SchemaViolation(errors.clone());
        match step_result_for_schema_error(err) {
            StepResult::Failed {
                exit_code,
                error,
                schema_errors,
            } => {
                assert_eq!(exit_code, None);
                assert!(!error.is_empty(), "summary should be non-empty");
                let captured =
                    schema_errors.expect("schema_errors must be Some for SchemaViolation");
                assert_eq!(captured.len(), 1);
                assert_eq!(captured[0].instance_path, "/foo");
            }
            other => panic!("expected Failed with schema_errors, got {other:?}"),
        }
    }

    #[test]
    fn step_result_for_non_violation_returns_failed_without_errors() {
        // Any SchemaError variant other than SchemaViolation must take the
        // generic-failure arm with schema_errors = None.
        let err = SchemaError::MissingOutput;
        match step_result_for_schema_error(err) {
            StepResult::Failed {
                exit_code,
                schema_errors,
                ..
            } => {
                assert_eq!(exit_code, None);
                assert!(
                    schema_errors.is_none(),
                    "non-violation errors must NOT carry structured entries"
                );
            }
            other => panic!("expected Failed without schema_errors, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn step_executor_post_stop_completes_cleanly_with_no_child() {
        use ractor::Actor;

        struct MockParent;
        impl Actor for MockParent {
            type Msg = ProjectMessage;
            type State = ();
            type Arguments = ();
            async fn pre_start(
                &self,
                _: ActorRef<Self::Msg>,
                _: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(())
            }
            async fn handle(
                &self,
                _: ActorRef<Self::Msg>,
                _: Self::Msg,
                _: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                Ok(())
            }
        }

        let (parent_ref, _ph) = Actor::spawn(Some("mp-poststop".to_string()), MockParent, ())
            .await
            .expect("spawn parent");

        let cfg = test_config("exec-poststop-clean");
        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-poststop".to_string()),
            StepExecutor,
            (cfg, parent_ref.clone()),
        )
        .await
        .expect("spawn executor");

        executor_ref
            .stop_and_wait(Some("test stop".to_string()), Some(Duration::from_secs(5)))
            .await
            .expect("executor stops cleanly");
        executor_handle.await.expect("executor task joins");

        parent_ref.stop(Some("done".to_string()));
    }
}
