//! Built-in execution provider resolver for the daemon.
//!
//! Resolves a step's `agent_config.provider` to a concrete child-process
//! invocation. `None` and `Anthropic` map to the Claude Code stream-json
//! command; `Openai` maps to `codex exec --json`. Validation runs before
//! spawn so an inconsistent `(provider, model)` pair fails the step with a
//! clear error instead of launching a harness.

use std::path::Path;

use tokio::process::Command;
use vertebrae_core::Provider;
use vertebrae_core::model_catalog::validate_provider_model;

use crate::actors::step_executor::{
    StepExecutorConfig, build_claude_command_with_settings, log_built_argv,
};

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderResolutionError {
    /// The persisted `agent_config.provider`/`model` pair is internally
    /// inconsistent (e.g. provider=openai with a `claude-*` model).
    InvalidProviderModel(String),
}

impl std::fmt::Display for ProviderResolutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderResolutionError::InvalidProviderModel(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for ProviderResolutionError {}

/// Resolve which built-in provider should run this step. `None` defaults to
/// Anthropic to preserve pre-refactor behavior.
pub fn resolve_provider(config: &StepExecutorConfig) -> Provider {
    config
        .step_config
        .agent_config
        .provider
        .unwrap_or(Provider::Anthropic)
}

/// Resolve the full provider invocation for a step. Must be called before
/// spawning a child process: validates the `(provider, model)` pair against
/// the catalog so an inconsistent `agent_config` fails before any harness is
/// launched. `settings_path` is threaded into the Anthropic builder.
pub fn resolve_provider_command(
    config: &StepExecutorConfig,
    settings_path: Option<&Path>,
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

    let (command, parser_kind) = match provider {
        Provider::Anthropic => (
            build_claude_command_with_settings(config, settings_path),
            ParserKind::StreamJson,
        ),
        Provider::Openai => (build_codex_command(config), ParserKind::CodexJsonl),
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
fn build_codex_command(config: &StepExecutorConfig) -> Command {
    let mut cmd = Command::new(&config.claude_binary);

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

    if let Some(schema) = agent_config.json_schema.as_ref() {
        cmd.arg("--output-schema").arg(schema.to_string());
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

    cmd
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use vertebrae_core::execution_service::ExecutionService;
    use vertebrae_core::models::AgentConfig;
    use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig, SacrumExecutionService};

    use crate::actors::step_executor::{DEFAULT_MODEL, StepConfig, StepExecutorConfig};

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

    fn make_config(agent_config: AgentConfig, prompt: &str, binary: &str) -> StepExecutorConfig {
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
            claude_binary: PathBuf::from(binary),
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
        let baseline = build_claude_command_with_settings(&config, None);
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
        let baseline_argv = argv_strings(&build_claude_command_with_settings(&config, None));
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
    fn openai_provider_forwards_json_schema_as_output_schema() {
        let schema = serde_json::json!({"type": "object"});
        let agent_config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-4o")
            .with_json_schema(schema.clone());
        let config = make_config(agent_config, "p", "/usr/local/bin/codex");
        let resolved = resolve_provider_command(&config, None).expect("ok");
        let argv = argv_strings(&resolved.command);
        let idx = argv
            .iter()
            .position(|a| a == "--output-schema")
            .expect("--output-schema must be present when json_schema set");
        let parsed: serde_json::Value =
            serde_json::from_str(&argv[idx + 1]).expect("schema arg must be valid JSON");
        assert_eq!(parsed, schema);
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
        let settings = PathBuf::from("/tmp/vtb-daemon-fake/settings.json");
        let resolved = resolve_provider_command(&config, Some(&settings)).expect("ok");
        let argv = argv_strings(&resolved.command);
        let idx = argv
            .iter()
            .position(|a| a == "--settings")
            .expect("--settings must be threaded through");
        assert_eq!(argv[idx + 1], settings.to_string_lossy());
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
    fn provider_resolution_error_display() {
        let e = ProviderResolutionError::InvalidProviderModel("bad combo".to_string());
        assert_eq!(format!("{e}"), "bad combo");
    }
}
