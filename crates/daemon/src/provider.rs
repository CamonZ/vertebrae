//! Built-in execution provider resolver for the daemon.
//!
//! Resolves a step's `agent_config.provider` to a concrete child-process
//! invocation. `None` and `Anthropic` map to the Claude Code stream-json
//! command; `Openai` maps to `codex exec --json`. Validation runs before
//! spawn so an inconsistent `(provider, model)` pair fails the step with a
//! clear error instead of launching a harness.

use tokio::process::Command;
use vertebrae_core::Provider;
use vertebrae_core::model_catalog::{normalize_provider_reasoning_effort, validate_provider_model};
use vertebrae_core::models::AgentConfig;

use crate::actors::step_executor::{
    StepExecutorConfig, build_claude_command_with_settings, log_built_argv,
};
use crate::settings_synthesis::SyntheticSettings;

/// How to interpret the child process's stdout stream.
///
/// The daemon always stores raw stdout lines as `SessionLog` records; the
/// parser kind only controls *which* structured-result extractor (if any) is
/// applied to each line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParserKind {
    /// Claude Code `--output-format stream-json` JSONL.
    StreamJson,
    /// Codex `exec --json` JSONL. Currently no structured-result extraction is
    /// performed -- raw lines are still stored as `SessionLog` records.
    CodexJsonl,
}

/// A fully resolved provider invocation, ready to be spawned.
pub struct ResolvedProviderCommand {
    pub provider: Provider,
    pub command: Command,
    pub parser_kind: ParserKind,
}

impl std::fmt::Debug for ResolvedProviderCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedProviderCommand")
            .field("provider", &self.provider)
            .field("parser_kind", &self.parser_kind)
            .finish()
    }
}

/// Reasons provider resolution can fail before any child is spawned.
#[derive(Debug)]
pub enum ProviderResolutionError {
    /// The persisted `agent_config.provider`/`model` pair is internally
    /// inconsistent (e.g. provider=openai with a `claude-*` model).
    InvalidProviderModel(String),
    /// The persisted `agent_config.reasoning_effort` is invalid for the
    /// resolved provider or unsupported by the OpenAI/Codex allowlist.
    InvalidReasoningEffort(String),
    /// Failed to materialize a provider-side artefact on disk -- e.g. the
    /// JSON schema file Codex requires for `--output-schema`.
    SchemaFileWrite(String),
    /// The step requested a provider whose binary was not resolved at
    /// daemon startup. The daemon doesn't crash for a missing provider --
    /// only the step that needs it fails, with this hint.
    MissingProviderBinary { provider: Provider, hint: String },
}

impl std::fmt::Display for ProviderResolutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderResolutionError::InvalidProviderModel(msg) => f.write_str(msg),
            ProviderResolutionError::InvalidReasoningEffort(msg) => f.write_str(msg),
            ProviderResolutionError::SchemaFileWrite(msg) => {
                write!(f, "failed to write Codex output_schema file: {msg}")
            }
            ProviderResolutionError::MissingProviderBinary { provider, hint } => {
                write!(
                    f,
                    "{provider} provider requested but its CLI binary was not resolved at daemon startup. {hint}"
                )
            }
        }
    }
}

impl std::error::Error for ProviderResolutionError {}

/// Build a `MissingProviderBinary` error for `provider`, pulling the
/// hint string from the corresponding `find_*_binary` resolver so we
/// don't duplicate the install-help copy.
fn missing_provider_binary_error(provider: Provider) -> ProviderResolutionError {
    // Re-run the lookup with an empty shell PATH so we get the canonical
    // "not found" message from the resolver. The actual binary search
    // happened at startup; we only need the help text here.
    let hint = match provider {
        Provider::Anthropic => crate::helpers::find_claude_binary("")
            .err()
            .unwrap_or_else(|| "Set CLAUDE_CODE_PATH or install claude in PATH.".to_string()),
        Provider::Openai => crate::helpers::find_codex_binary("")
            .err()
            .unwrap_or_else(|| "Set CODEX_PATH or install codex in PATH.".to_string()),
    };
    ProviderResolutionError::MissingProviderBinary { provider, hint }
}

/// Resolve which built-in provider should run this step. `None` defaults to
/// Anthropic to preserve pre-refactor behavior.
pub fn resolve_provider(config: &StepExecutorConfig) -> Provider {
    resolve_provider_from_agent_config(&config.step_config.agent_config)
}

/// Same as [`resolve_provider`] but takes the inner [`AgentConfig`] directly,
/// for callers that don't have a full [`StepExecutorConfig`] in hand.
pub fn resolve_provider_from_agent_config(agent_config: &AgentConfig) -> Provider {
    agent_config.provider.unwrap_or(Provider::Anthropic)
}

/// Resolve the full provider invocation for a step. Must be called before
/// spawning a child process: validates the `(provider, model)` pair against
/// the catalog so an inconsistent `agent_config` fails before any harness is
/// launched.
///
/// The `settings_bundle` carries both the synthesized `--settings` file path
/// (consumed by Anthropic) and a writable temp dir (used by Codex to
/// materialize the `--output-schema` file). Passing `None` skips both, and
/// the resolver falls back to inline behavior where appropriate.
pub fn resolve_provider_command(
    config: &StepExecutorConfig,
    settings_bundle: Option<&SyntheticSettings>,
) -> Result<ResolvedProviderCommand, ProviderResolutionError> {
    let provider = resolve_provider(config);

    if let Some(model) = config.step_config.agent_config.model.as_deref()
        && !model.trim().is_empty()
        && let Err(mismatch) = validate_provider_model(provider, Some(model))
    {
        return Err(ProviderResolutionError::InvalidProviderModel(
            mismatch.to_string(),
        ));
    }
    let reasoning_effort = normalize_provider_reasoning_effort(
        provider,
        config.step_config.agent_config.reasoning_effort.as_deref(),
    )
    .map_err(|mismatch| ProviderResolutionError::InvalidReasoningEffort(mismatch.to_string()))?;

    let (command, parser_kind) = match provider {
        Provider::Anthropic => {
            let settings_path = settings_bundle.map(|b| b.settings_path());
            (
                build_claude_command_with_settings(config, settings_path.as_deref())?,
                ParserKind::StreamJson,
            )
        }
        Provider::Openai => (
            build_codex_command(config, settings_bundle, reasoning_effort.as_deref())?,
            ParserKind::CodexJsonl,
        ),
    };

    Ok(ResolvedProviderCommand {
        provider,
        command,
        parser_kind,
    })
}

/// Build the Codex `exec --json` invocation for OpenAI provider steps. Emits
/// JSONL events to stdout, one per line. The prompt is the trailing
/// positional arg, matching `codex exec [OPTIONS] [PROMPT]`. No default model
/// is imposed -- when unset, Codex picks its own.
///
/// When `agent_config.json_schema` is set, the schema is written to a file
/// inside `settings_bundle` and passed as `--output-schema <path>` (Codex
/// expects a path, not inline JSON). If no bundle is provided, the schema is
/// silently skipped to keep the call inert in tests; production callers
/// always supply one via `resolve_provider_command`.
fn build_codex_command(
    config: &StepExecutorConfig,
    settings_bundle: Option<&SyntheticSettings>,
    reasoning_effort: Option<&str>,
) -> Result<Command, ProviderResolutionError> {
    let binary = config
        .provider_binaries
        .get(Provider::Openai)
        .ok_or_else(|| missing_provider_binary_error(Provider::Openai))?;
    let mut cmd = Command::new(binary);

    let step = &config.step_config;
    let agent_config = &step.agent_config;

    cmd.arg("exec").arg("--json");

    if let Some(model) = agent_config
        .model
        .as_deref()
        .filter(|m| !m.trim().is_empty())
    {
        cmd.arg("--model").arg(model);
    }

    if let Some(reasoning_effort) = reasoning_effort {
        cmd.arg("-c")
            .arg(format!("model_reasoning_effort=\"{reasoning_effort}\""));
    }

    if let Some(schema) = agent_config.json_schema.as_ref()
        && let Some(bundle) = settings_bundle
    {
        let schema_path = bundle
            .write_codex_output_schema(schema)
            .map_err(|e| ProviderResolutionError::SchemaFileWrite(e.to_string()))?;
        cmd.arg("--output-schema").arg(schema_path);
    }

    cmd.arg(&step.prompt);

    cmd.current_dir(config.working_dir())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    cmd.env("PATH", &config.shell_path);

    if step.verbose_daemon_logging {
        let _ = log_built_argv(
            &cmd,
            config,
            Provider::Openai,
            "verbose: built codex CLI command",
        );
    }

    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use vertebrae_core::execution_service::ExecutionService;
    use vertebrae_core::models::AgentConfig;
    use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig, SacrumExecutionService};

    use crate::actors::step_executor::{DEFAULT_MODEL, StepConfig, StepExecutorConfig};
    use crate::helpers::ProviderBinaries;

    use super::*;

    fn test_execution_service() -> Arc<dyn ExecutionService> {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = GraphqlClient::new(config);
        Arc::new(SacrumExecutionService::new(client))
    }

    fn make_config(agent_config: AgentConfig, prompt: &str, _binary: &str) -> StepExecutorConfig {
        // Pre-refactor, this helper threaded a single `binary` PathBuf into
        // `claude_binary` to control which mock binary the command builder
        // picked up. The new `ProviderBinaries` struct holds both resolved
        // binaries simultaneously, so we hardcode both well-known paths and
        // let each test select the provider via `agent_config.provider` --
        // matching how the daemon now behaves at runtime.
        StepExecutorConfig {
            execution_id: "exec-prov".to_string(),
            task_id: "task-prov".to_string(),
            step_config: StepConfig {
                prompt: prompt.to_string(),
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
        }
    }

    fn make_config_with_binaries(
        agent_config: AgentConfig,
        prompt: &str,
        provider_binaries: ProviderBinaries,
    ) -> StepExecutorConfig {
        StepExecutorConfig {
            execution_id: "exec-prov".to_string(),
            task_id: "task-prov".to_string(),
            step_config: StepConfig {
                prompt: prompt.to_string(),
                agent_config,
                agents: Vec::new(),
                skills: Vec::new(),
                verbose_daemon_logging: false,
            },
            project_root: PathBuf::from("/tmp"),
            worktree: None,
            provider_binaries,
            shell_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
            execution_service: test_execution_service(),
        }
    }

    fn argv_strings(cmd: &Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn resolve_provider_defaults_to_anthropic_when_unspecified() {
        let config = make_config(AgentConfig::default(), "do x", "/usr/local/bin/claude");
        assert_eq!(resolve_provider(&config), Provider::Anthropic);
    }

    #[test]
    fn resolve_provider_honors_explicit_anthropic() {
        let config = make_config(
            AgentConfig::new().with_provider(Provider::Anthropic),
            "do x",
            "/usr/local/bin/claude",
        );
        assert_eq!(resolve_provider(&config), Provider::Anthropic);
    }

    #[test]
    fn resolve_provider_honors_explicit_openai() {
        let config = make_config(
            AgentConfig::new().with_provider(Provider::Openai),
            "do x",
            "/usr/local/bin/codex",
        );
        assert_eq!(resolve_provider(&config), Provider::Openai);
    }

    #[test]
    fn anthropic_provider_resolves_to_default_claude_command() {
        // Constraint: anthropic provider selection must produce the same
        // command as the legacy build_claude_command_with_settings path.
        let agent_config = AgentConfig::new().with_provider(Provider::Anthropic);
        let config = make_config(agent_config, "Implement feature Y", "/usr/local/bin/claude");

        let resolved =
            resolve_provider_command(&config, None).expect("anthropic resolution should succeed");
        assert_eq!(resolved.provider, Provider::Anthropic);
        assert_eq!(resolved.parser_kind, ParserKind::StreamJson);
        assert_eq!(
            resolved.command.as_std().get_program(),
            "/usr/local/bin/claude"
        );

        let resolved_argv = argv_strings(&resolved.command);

        // Same argv as the existing builder produces.
        let baseline = build_claude_command_with_settings(&config, None)
            .expect("baseline anthropic builder must succeed");
        let baseline_argv = argv_strings(&baseline);
        assert_eq!(resolved_argv, baseline_argv);

        // And the well-known stream-json knobs are still there.
        assert!(resolved_argv.contains(&"--output-format".to_string()));
        assert!(resolved_argv.contains(&"stream-json".to_string()));
        assert!(resolved_argv.contains(&"-p".to_string()));
        assert!(resolved_argv.contains(&"Implement feature Y".to_string()));
        assert!(resolved_argv.contains(&"--model".to_string()));
        assert!(resolved_argv.contains(&DEFAULT_MODEL.to_string()));
    }

    #[test]
    fn anthropic_provider_default_when_provider_field_absent_matches_legacy_path() {
        // Same expectation but with provider=None on the agent_config: the
        // pre-refactor default must be byte-identical.
        let config = make_config(AgentConfig::default(), "Do work", "/usr/local/bin/claude");
        let resolved = resolve_provider_command(&config, None).expect("default resolution");
        assert_eq!(resolved.provider, Provider::Anthropic);
        assert_eq!(resolved.parser_kind, ParserKind::StreamJson);

        let resolved_argv = argv_strings(&resolved.command);
        let baseline_argv = argv_strings(
            &build_claude_command_with_settings(&config, None)
                .expect("baseline anthropic builder must succeed"),
        );
        assert_eq!(resolved_argv, baseline_argv);
    }

    #[test]
    fn openai_provider_builds_codex_exec_command() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-4o");
        let config = make_config(agent_config, "Refactor X", "/usr/local/bin/codex");

        let resolved =
            resolve_provider_command(&config, None).expect("openai resolution should succeed");
        assert_eq!(resolved.provider, Provider::Openai);
        assert_eq!(resolved.parser_kind, ParserKind::CodexJsonl);
        assert_eq!(
            resolved.command.as_std().get_program(),
            "/usr/local/bin/codex"
        );

        let argv = argv_strings(&resolved.command);
        // First two args define the exec mode.
        assert_eq!(argv.first().map(String::as_str), Some("exec"));
        assert_eq!(argv.get(1).map(String::as_str), Some("--json"));
        // Model comes through.
        let model_idx = argv
            .iter()
            .position(|a| a == "--model")
            .expect("--model must be present");
        assert_eq!(argv[model_idx + 1], "gpt-4o");
        // Prompt is the trailing positional.
        assert_eq!(argv.last().map(String::as_str), Some("Refactor X"));

        // We must NOT borrow Anthropic-only flags into Codex argv.
        assert!(!argv.contains(&"-p".to_string()));
        assert!(!argv.contains(&"--output-format".to_string()));
        assert!(!argv.contains(&"stream-json".to_string()));
        assert!(!argv.contains(&"--permission-mode".to_string()));
        assert!(
            !argv
                .iter()
                .any(|arg| arg.contains("model_reasoning_effort"))
        );
    }

    #[test]
    fn openai_provider_includes_reasoning_effort_config_before_prompt() {
        let schema = serde_json::json!({"type": "object"});
        let mut agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-5.5")
            .with_reasoning_effort("high")
            .with_json_schema(schema);
        agent_config.reasoning_effort = Some(" HIGH ".to_string());
        let config = make_config(agent_config, "Reason deeply", "/usr/local/bin/codex");
        let bundle = SyntheticSettings::create("reasoning-effort-test").expect("bundle creates");

        let resolved =
            resolve_provider_command(&config, Some(&bundle)).expect("openai resolution succeeds");
        let argv = argv_strings(&resolved.command);

        let model_idx = argv
            .iter()
            .position(|a| a == "--model")
            .expect("--model must be present");
        let config_idx = argv
            .iter()
            .position(|a| a == "-c")
            .expect("-c must be present");
        let schema_idx = argv
            .iter()
            .position(|a| a == "--output-schema")
            .expect("--output-schema must be present");
        let prompt_idx = argv
            .iter()
            .position(|a| a == "Reason deeply")
            .expect("prompt must be present");

        assert_eq!(argv[model_idx + 1], "gpt-5.5");
        assert_eq!(argv[config_idx + 1], "model_reasoning_effort=\"high\"");
        assert!(
            model_idx < config_idx,
            "--model should remain before Codex config override"
        );
        assert!(config_idx < prompt_idx, "-c must appear before prompt");
        assert!(
            schema_idx < prompt_idx,
            "--output-schema must remain before prompt"
        );
        assert_eq!(argv.last().map(String::as_str), Some("Reason deeply"));
    }

    #[test]
    fn openai_provider_without_model_omits_model_flag() {
        let config = make_config(
            AgentConfig::new().with_provider(Provider::Openai),
            "no model",
            "/usr/local/bin/codex",
        );
        let resolved = resolve_provider_command(&config, None).expect("openai resolution");
        let argv = argv_strings(&resolved.command);
        assert!(!argv.contains(&"--model".to_string()));
        assert_eq!(argv.last().map(String::as_str), Some("no model"));
    }

    #[test]
    fn openai_provider_writes_json_schema_to_temp_file_and_passes_path() {
        // Codex requires --output-schema to point at a *file*, not inline JSON.
        // The resolver must materialize the schema in the per-execution
        // settings bundle and pass the resulting path.
        let schema = serde_json::json!({
            "type": "object",
            "properties": {"verdict": {"type": "string"}},
            "required": ["verdict"]
        });
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-4o")
            .with_json_schema(schema.clone());
        let config = make_config(agent_config, "p", "/usr/local/bin/codex");
        let bundle = SyntheticSettings::create("schema-test").expect("bundle creates");

        let resolved = resolve_provider_command(&config, Some(&bundle)).expect("ok");
        let argv = argv_strings(&resolved.command);
        let idx = argv
            .iter()
            .position(|a| a == "--output-schema")
            .expect("--output-schema must be present when json_schema set");
        let path_arg = std::path::Path::new(&argv[idx + 1]);
        assert!(
            path_arg.is_file(),
            "--output-schema arg must be an existing file, got {path_arg:?}"
        );
        // The file must round-trip the schema verbatim.
        let body = std::fs::read_to_string(path_arg).expect("schema file readable");
        let parsed: serde_json::Value =
            serde_json::from_str(&body).expect("schema file must contain valid JSON");
        assert_eq!(parsed, schema);
        // And it must live under the bundle's temp dir, not in some other
        // location that would outlive the run.
        assert!(
            path_arg.starts_with(bundle.dir()),
            "schema file must live inside the per-execution bundle"
        );
    }

    #[test]
    fn openai_provider_omits_output_schema_when_no_bundle_provided() {
        // Without a bundle (e.g. unit tests that don't synthesize one), the
        // resolver silently skips the --output-schema flag rather than
        // fabricating a path the caller can't clean up.
        let schema = serde_json::json!({"type": "object"});
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_json_schema(schema);
        let config = make_config(agent_config, "p", "/usr/local/bin/codex");
        let resolved = resolve_provider_command(&config, None).expect("ok");
        let argv = argv_strings(&resolved.command);
        assert!(!argv.contains(&"--output-schema".to_string()));
    }

    #[test]
    fn invalid_provider_model_pair_fails_before_spawn() {
        // openai provider + claude-* model is rejected so no child is spawned.
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("claude-opus-4-5");
        let config = make_config(agent_config, "p", "/usr/local/bin/codex");
        let err = resolve_provider_command(&config, None)
            .expect_err("openai+claude pair must be rejected");
        match err {
            ProviderResolutionError::InvalidProviderModel(msg) => {
                assert!(msg.contains("claude-opus-4-5"), "got: {msg}");
                assert!(
                    msg.to_ascii_lowercase().contains("openai")
                        || msg.to_ascii_lowercase().contains("anthropic"),
                    "expected provider names in error, got: {msg}"
                );
            }
            other => panic!("expected InvalidProviderModel, got: {other:?}"),
        }
    }

    #[test]
    fn invalid_reasoning_effort_fails_before_spawn() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-5.5")
            .with_reasoning_effort("minimal");
        let config = make_config(agent_config, "p", "/usr/local/bin/codex");
        let err = resolve_provider_command(&config, None)
            .expect_err("unsupported reasoning effort must be rejected");
        match err {
            ProviderResolutionError::InvalidReasoningEffort(msg) => {
                assert!(msg.contains("minimal"), "got: {msg}");
                assert!(msg.contains("xhigh"), "got: {msg}");
            }
            other => panic!("expected InvalidReasoningEffort, got: {other:?}"),
        }
    }

    #[test]
    fn anthropic_reasoning_effort_fails_before_spawn() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Anthropic)
            .with_model("opus")
            .with_reasoning_effort("high");
        let config = make_config(agent_config, "p", "/usr/local/bin/claude");
        let err = resolve_provider_command(&config, None)
            .expect_err("anthropic reasoning effort must be rejected");
        match err {
            ProviderResolutionError::InvalidReasoningEffort(msg) => {
                assert!(msg.contains("high"), "got: {msg}");
                assert!(msg.contains("openai"), "got: {msg}");
                assert!(msg.contains("anthropic"), "got: {msg}");
            }
            other => panic!("expected InvalidReasoningEffort, got: {other:?}"),
        }
    }

    #[test]
    fn unknown_model_for_provider_fails_before_spawn() {
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Anthropic)
            .with_model("kimi2.6");
        let config = make_config(agent_config, "p", "/usr/local/bin/claude");
        let err =
            resolve_provider_command(&config, None).expect_err("unknown model must be rejected");
        match err {
            ProviderResolutionError::InvalidProviderModel(msg) => {
                assert!(msg.contains("kimi2.6"), "got: {msg}");
            }
            other => panic!("expected InvalidProviderModel, got: {other:?}"),
        }
    }

    #[test]
    fn provider_resolution_passes_through_when_model_is_none() {
        // No model -> no validation needed, command still resolves.
        let config = make_config(
            AgentConfig::new().with_provider(Provider::Openai),
            "p",
            "/usr/local/bin/codex",
        );
        let resolved = resolve_provider_command(&config, None).expect("ok");
        assert_eq!(resolved.provider, Provider::Openai);
    }

    #[test]
    fn anthropic_resolution_uses_settings_path_when_provided() {
        let agent_config = AgentConfig::new().with_provider(Provider::Anthropic);
        let config = make_config(agent_config, "p", "/usr/local/bin/claude");
        let bundle = SyntheticSettings::create("settings-test").expect("bundle creates");
        let resolved = resolve_provider_command(&config, Some(&bundle)).expect("ok");
        let argv = argv_strings(&resolved.command);
        let idx = argv
            .iter()
            .position(|a| a == "--settings")
            .expect("--settings must be threaded through");
        assert_eq!(argv[idx + 1], bundle.settings_path().to_string_lossy());
    }

    #[test]
    fn parser_kind_is_copy_and_eq() {
        let a = ParserKind::StreamJson;
        let b = a;
        assert_eq!(a, b);
        assert_ne!(ParserKind::StreamJson, ParserKind::CodexJsonl);
    }

    #[test]
    fn resolved_command_debug_does_not_leak_command_internals() {
        let config = make_config(
            AgentConfig::new().with_provider(Provider::Openai),
            "p",
            "/usr/local/bin/codex",
        );
        let resolved = resolve_provider_command(&config, None).expect("ok");
        let dbg = format!("{:?}", resolved);
        assert!(dbg.contains("ResolvedProviderCommand"));
        assert!(dbg.contains("Openai"));
        assert!(dbg.contains("CodexJsonl"));
    }

    #[test]
    fn missing_openai_binary_fails_with_clear_error() {
        // When the daemon starts and codex isn't installed, OpenAI steps must
        // fail with MissingProviderBinary -- not a panic, not a generic spawn
        // error after the fact. The Anthropic binary is still resolved so the
        // daemon stays up for other workflows.
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-5");
        let binaries = ProviderBinaries {
            anthropic: Some(PathBuf::from("/usr/local/bin/claude")),
            openai: None,
        };
        let config = make_config_with_binaries(agent_config, "p", binaries);
        let err = resolve_provider_command(&config, None)
            .expect_err("openai step must fail when codex binary is missing");
        match err {
            ProviderResolutionError::MissingProviderBinary { provider, hint } => {
                assert_eq!(provider, Provider::Openai);
                assert!(
                    !hint.is_empty(),
                    "MissingProviderBinary must carry a non-empty install hint"
                );
            }
            other => panic!("expected MissingProviderBinary, got: {other:?}"),
        }
    }

    #[test]
    fn missing_anthropic_binary_fails_with_clear_error() {
        let agent_config = AgentConfig::new().with_provider(Provider::Anthropic);
        let binaries = ProviderBinaries {
            anthropic: None,
            openai: Some(PathBuf::from("/usr/local/bin/codex")),
        };
        let config = make_config_with_binaries(agent_config, "p", binaries);
        let err = resolve_provider_command(&config, None)
            .expect_err("anthropic step must fail when claude binary is missing");
        assert!(matches!(
            err,
            ProviderResolutionError::MissingProviderBinary {
                provider: Provider::Anthropic,
                ..
            }
        ));
    }

    #[test]
    fn provider_resolution_error_display() {
        let e = ProviderResolutionError::InvalidProviderModel("bad combo".to_string());
        assert_eq!(format!("{e}"), "bad combo");

        let e = ProviderResolutionError::InvalidReasoningEffort("bad effort".to_string());
        assert_eq!(format!("{e}"), "bad effort");

        let e = ProviderResolutionError::SchemaFileWrite("disk full".to_string());
        let rendered = format!("{e}");
        assert!(
            rendered.contains("Codex output_schema"),
            "should mention Codex schema, got: {rendered}"
        );
        assert!(
            rendered.contains("disk full"),
            "should include cause: {rendered}"
        );

        let e = ProviderResolutionError::MissingProviderBinary {
            provider: Provider::Openai,
            hint: "Set CODEX_PATH or install codex in PATH.".to_string(),
        };
        let rendered = format!("{e}");
        assert!(
            rendered.contains("openai"),
            "should mention provider name, got: {rendered}"
        );
        assert!(
            rendered.contains("CODEX_PATH"),
            "should carry the install hint, got: {rendered}"
        );
    }
}
