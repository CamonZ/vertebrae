//! StepExecutor - per-step actor that runs Claude Code CLI for a single workflow step.
//!
//! Spawned by ProjectSupervisor upon receiving an execute_step channel event from Sacrum.
//! Each StepExecutor:
//! - Receives step config (prompt, model), execution_id, and task_id from its parent
//! - Spawns `claude -p <prompt> --output-format stream-json --verbose` as a child process
//! - Streams stdout line by line, posting each line as a SessionLog to the ExecutionService
//! - Reports StepCompleted or StepFailed to the parent ProjectSupervisor on exit
//! - Kills the child process on Cancel or actor stop
//!
//! Orchestration (step ordering, parallel vs serial, retry logic) lives entirely
//! in Sacrum/Elixir -- the daemon just executes what it is told.

use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;

use ractor::{Actor, ActorProcessingErr, ActorRef};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use vertebrae_core::Provider;
use vertebrae_core::execution_service::ExecutionService;
use vertebrae_core::models::{AgentConfig, PermissionMode, SessionLog};

use crate::actors::project_supervisor::{ProjectMessage, VERBOSE_LOG_TARGET};
use crate::helpers::ProviderBinaries;
use crate::output_validator::{CompiledSchema, SchemaError, SchemaValidationError};
use crate::provider::{ParserKind, ProviderResolutionError, resolve_provider_command};
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
}

impl std::fmt::Debug for StepExecutorMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Execute => write!(f, "Execute"),
            Self::Cancel => write!(f, "Cancel"),
            Self::ProcessExited(result) => f.debug_tuple("ProcessExited").field(result).finish(),
        }
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
        if state.child_process.is_some() {
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
                    // Structured-result extraction dispatches on parser_kind;
                    // raw lines are always stored as logs.
                    let mut codex_aggregate =
                        crate::codex_jsonl::CodexAggregate::with_output_schema(
                            codex_output_schema_used,
                        );
                    if let Some(stdout) = stdout {
                        let reader = BufReader::new(stdout);
                        let mut lines = reader.lines();

                        while let Ok(Some(line)) = lines.next_line().await {
                            match parser_kind {
                                ParserKind::StreamJson => {
                                    if let Some(parsed) =
                                        crate::stream_json::parse_stream_json_line(&line)
                                        && let Ok(mut slot) = result_slot.lock()
                                    {
                                        slot.metrics = parsed.metrics;
                                        slot.result_text = parsed.result_text;
                                        slot.structured_output = parsed.structured_output;
                                    }

                                    // Verbose checkpoint 5: parse and log the stream-json
                                    // system/init line — its `tools` array is the source of
                                    // the StructuredOutput-advertisement metric (0/39 vs 39/39).
                                    if verbose
                                        && let Some(init) =
                                            crate::stream_json::parse_stream_json_init_line(&line)
                                    {
                                        tracing::info!(
                                            target: VERBOSE_LOG_TARGET,
                                            execution_id = %execution_id,
                                            task_id = %task_id,
                                            checkpoint = CHECKPOINT_STREAM_JSON_INIT,
                                            session_id = ?init.session_id,
                                            tools = ?init.tools,
                                            structured_output_advertised = init.structured_output_advertised(),
                                            "verbose: claude system/init line"
                                        );
                                    }
                                }
                                ParserKind::CodexJsonl => {
                                    if crate::codex_jsonl::apply_codex_line(
                                        &line,
                                        &mut codex_aggregate,
                                    ) && let Ok(mut slot) = result_slot.lock()
                                    {
                                        slot.metrics = codex_aggregate
                                            .usage
                                            .as_ref()
                                            .map(codex_usage_to_metrics);
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
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Captured `StepFinished` payloads `(execution_id, task_id, result)` shared
    /// from a test parent actor back to the assertion site.
    type CapturedResults = Arc<std::sync::Mutex<Vec<(String, String, StepResult)>>>;

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
