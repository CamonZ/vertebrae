use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vertebrae_harness_core::{
    HarnessError, ProviderThreadRef, RequestConfig, SessionId, SpeedTier,
};

pub const DEFAULT_CLAUDE_MODELS: &[(&str, &str)] = &[
    ("sonnet", "Sonnet"),
    ("opus", "Opus"),
    ("haiku", "Haiku"),
    ("fable", "Fable"),
    ("claude-opus-5", "Claude Opus 5"),
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-opus-4-8", "Claude Opus 4.8"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
];

pub(crate) fn claude_model_supports_fast_mode(model: &str) -> bool {
    matches!(model, "opus" | "claude-opus-5" | "claude-opus-4-8")
        || model.starts_with("claude-opus-5-")
        || model.starts_with("claude-opus-4-8-")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClaudePermissionMode {
    Default,
    AcceptEdits,
    Auto,
    Plan,
    BypassPermissions,
    DontAsk,
}

impl ClaudePermissionMode {
    pub fn as_cli_value(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Auto => "auto",
            Self::Plan => "plan",
            Self::BypassPermissions => "bypassPermissions",
            Self::DontAsk => "dontAsk",
        }
    }
}

/// Claude-only construction policy. Portable per-request values remain in
/// `harness_core::RequestConfig`.
/// Resolves the canonical opaque root transcript locator after Claude reveals
/// its conversation id. Surface crates own live-session locator resolution;
/// the replay adapter owns durable transcript discovery and decoding.
pub trait ClaudeRootLocatorResolver: Send + Sync {
    fn resolve(&self, session_id: &SessionId) -> Result<Option<ProviderThreadRef>, String>;
}

impl<F> ClaudeRootLocatorResolver for F
where
    F: Fn(&SessionId) -> Result<Option<ProviderThreadRef>, String> + Send + Sync,
{
    fn resolve(&self, session_id: &SessionId) -> Result<Option<ProviderThreadRef>, String> {
        self(session_id)
    }
}

/// A custom Anthropic-compatible endpoint that Claude Code should talk to
/// instead of its default account. The adapter owns the translation into
/// Claude Code's launch environment; secrets never appear in Debug output.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ClaudeProviderEndpoint {
    pub base_url: Option<String>,
    /// Exported as `ANTHROPIC_AUTH_TOKEN`. `ANTHROPIC_API_KEY` is cleared so
    /// an ambient Anthropic key is never sent to the custom endpoint.
    pub auth_token: Option<String>,
    /// Additional launch environment, applied after the translated values.
    pub environment: BTreeMap<String, String>,
}

impl ClaudeProviderEndpoint {
    pub fn launch_environment(&self) -> BTreeMap<String, String> {
        let mut environment = BTreeMap::new();
        if let Some(base_url) = &self.base_url {
            environment.insert("ANTHROPIC_BASE_URL".into(), base_url.clone());
        }
        if let Some(auth_token) = &self.auth_token {
            environment.insert("ANTHROPIC_AUTH_TOKEN".into(), auth_token.clone());
            environment.insert("ANTHROPIC_API_KEY".into(), String::new());
        }
        environment.extend(self.environment.clone());
        environment
    }
}

impl fmt::Debug for ClaudeProviderEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeProviderEndpoint")
            .field("base_url", &self.base_url)
            .field(
                "auth_token",
                &self.auth_token.as_ref().map(|_| "<redacted>"),
            )
            .field("environment", &self.environment.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// Provider arguments which must precede request/config overrides.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeProviderPrelude {
    /// Synthesized Claude settings bundle. Later CLI flags intentionally win.
    pub settings_path: Option<PathBuf>,
    /// Other provider-owned leading arguments, preserved verbatim.
    pub args: Vec<String>,
}

#[derive(Clone)]
pub struct ClaudeProviderConfig {
    /// An explicit executable takes precedence over environment/PATH lookup.
    pub executable: Option<PathBuf>,
    /// Environment variable used for compatibility with existing surfaces.
    pub executable_environment_key: String,
    /// PATH used for both executable lookup and the child process.
    pub search_path: Option<OsString>,
    pub environment: BTreeMap<String, String>,
    /// Custom endpoint profile; `None` uses Claude Code's own account.
    pub endpoint: Option<ClaudeProviderEndpoint>,
    pub prelude: ClaudeProviderPrelude,
    /// Provider arguments appended after all structured configuration.
    pub extra_args: Vec<String>,
    pub plugin_roots: Vec<PathBuf>,
    pub installed_skills_roots: Vec<PathBuf>,
    pub agent_paths: Vec<PathBuf>,
    pub permission_mode: Option<ClaudePermissionMode>,
    pub permission_prompt_tool: Option<String>,
    pub mcp_config: Option<Value>,
    pub cleanup_timeout: Duration,
    /// Maximum time a persistent session waits for Claude's canonical init
    /// record after its first turn is written.
    pub initialization_timeout: Duration,
    /// Grace allowed for a one-shot process to exit after its terminal result.
    pub terminal_exit_timeout: Duration,
    /// Surface-owned canonical locator discovery used when real init records
    /// omit transcript_path. `None` requires a later explicit decoder locator.
    pub root_locator_resolver: Option<Arc<dyn ClaudeRootLocatorResolver>>,
}

impl fmt::Debug for ClaudeProviderConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeProviderConfig")
            .field("executable", &self.executable)
            .field(
                "executable_environment_key",
                &self.executable_environment_key,
            )
            .field("search_path", &self.search_path)
            .field("environment", &self.environment)
            .field("endpoint", &self.endpoint)
            .field("prelude", &self.prelude)
            .field("extra_args", &self.extra_args)
            .field("plugin_roots", &self.plugin_roots)
            .field("installed_skills_roots", &self.installed_skills_roots)
            .field("agent_paths", &self.agent_paths)
            .field("permission_mode", &self.permission_mode)
            .field("permission_prompt_tool", &self.permission_prompt_tool)
            .field("mcp_config", &self.mcp_config)
            .field("cleanup_timeout", &self.cleanup_timeout)
            .field("initialization_timeout", &self.initialization_timeout)
            .field("terminal_exit_timeout", &self.terminal_exit_timeout)
            .field(
                "root_locator_resolver",
                &self.root_locator_resolver.as_ref().map(|_| "<configured>"),
            )
            .finish()
    }
}

impl Default for ClaudeProviderConfig {
    fn default() -> Self {
        Self {
            executable: None,
            executable_environment_key: "CLAUDE_CODE_PATH".to_string(),
            search_path: env::var_os("PATH"),
            environment: BTreeMap::new(),
            endpoint: None,
            prelude: ClaudeProviderPrelude::default(),
            extra_args: Vec::new(),
            plugin_roots: Vec::new(),
            installed_skills_roots: Vec::new(),
            agent_paths: Vec::new(),
            permission_mode: None,
            permission_prompt_tool: None,
            mcp_config: None,
            cleanup_timeout: Duration::from_secs(3),
            initialization_timeout: Duration::from_secs(10),
            terminal_exit_timeout: Duration::from_millis(250),
            root_locator_resolver: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeLaunchMode<'a> {
    /// Stream-json session that resumes `resume_id`, or starts a conversation
    /// whose id Claude assigns when it emits `system/init`.
    Persistent {
        resume_id: Option<&'a str>,
    },
    /// Stream-json session that starts a conversation with a caller-chosen
    /// id, so the id is known before the first turn.
    PersistentNew {
        session_id: &'a str,
    },
    /// Stream-json session that starts conversation `session_id` as a copy
    /// of `source_id`, leaving the source unchanged.
    PersistentFork {
        source_id: &'a str,
        session_id: &'a str,
    },
    OneShot {
        prompt: &'a str,
    },
}

#[derive(Clone, PartialEq, Eq)]
pub struct ClaudeCommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub environment: BTreeMap<String, String>,
}

impl fmt::Debug for ClaudeCommandSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeCommandSpec")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("current_dir", &self.current_dir)
            .field("environment", &self.environment.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl ClaudeProviderConfig {
    pub fn resolve_executable(&self) -> Result<PathBuf, HarnessError> {
        if let Some(path) = &self.executable {
            return validate_executable(path);
        }
        if let Some(path) = self
            .environment
            .get(&self.executable_environment_key)
            .map(PathBuf::from)
            .or_else(|| env::var_os(&self.executable_environment_key).map(PathBuf::from))
        {
            return validate_executable(&path);
        }
        let search_path = self.search_path.as_deref().unwrap_or_default();
        for directory in env::split_paths(search_path) {
            let candidate = directory.join(executable_name());
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(HarnessError::Unavailable(format!(
            "Claude Code executable was not found; set {} or install claude in PATH",
            self.executable_environment_key
        )))
    }

    pub fn command_spec(
        &self,
        mode: ClaudeLaunchMode<'_>,
        request: &RequestConfig,
    ) -> Result<ClaudeCommandSpec, HarnessError> {
        if let Some(directory) = &request.working_directory
            && !directory.is_dir()
        {
            return Err(HarnessError::InvalidRequest(format!(
                "working directory is not a directory: {}",
                directory.display()
            )));
        }
        if request.verbosity.is_some() {
            return Err(HarnessError::InvalidRequest(
                "output verbosity is not supported by the Claude provider".into(),
            ));
        }
        let program = self.resolve_executable()?;
        let mut args = Vec::new();
        if let Some(personality) = request
            .personality
            .as_deref()
            .map(str::trim)
            .filter(|personality| !personality.is_empty())
        {
            args.push("--settings".into());
            args.push(json!({ "outputStyle": personality }).to_string());
        } else if let Some(path) = &self.prelude.settings_path {
            args.push("--settings".into());
            args.push(path.to_string_lossy().into_owned());
        }
        if let Some(speed_tier) = request.speed_tier {
            args.push("--settings".into());
            args.push(json!({"fastMode": speed_tier == SpeedTier::Fast}).to_string());
        }
        args.extend(self.prelude.args.clone());
        match mode {
            ClaudeLaunchMode::Persistent { .. }
            | ClaudeLaunchMode::PersistentNew { .. }
            | ClaudeLaunchMode::PersistentFork { .. } => {
                args.extend([
                    "--print".into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--input-format".into(),
                    "stream-json".into(),
                    "--verbose".into(),
                    "--include-partial-messages".into(),
                ]);
            }
            ClaudeLaunchMode::OneShot { .. } => {}
        }
        if let Some(mcp_config) = &self.mcp_config {
            args.push("--mcp-config".into());
            args.push(mcp_config.to_string());
        }
        if let Some(tool) = &self.permission_prompt_tool {
            args.push("--permission-prompt-tool".into());
            args.push(tool.clone());
        }
        for root in self.plugin_roots.iter().chain(&self.installed_skills_roots) {
            args.push("--plugin-dir".into());
            args.push(root.to_string_lossy().into_owned());
        }
        for path in &self.agent_paths {
            args.push("--agent".into());
            args.push(path.to_string_lossy().into_owned());
        }
        if let Some(model) = request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            args.push("--model".into());
            args.push(model.into());
        }
        if let Some(mode) = self.permission_mode {
            args.push("--permission-mode".into());
            args.push(mode.as_cli_value().into());
        }
        if let Some(schema) = &request.output_schema {
            args.push("--json-schema".into());
            args.push(schema.to_string());
        }
        // Claude pins the system prompt when a conversation is created and
        // ignores --append-system-prompt on --resume, forks included.
        let resuming = matches!(
            mode,
            ClaudeLaunchMode::Persistent { resume_id: Some(_) }
                | ClaudeLaunchMode::PersistentFork { .. }
        );
        if let Some(instructions) = request
            .developer_instructions
            .as_deref()
            .map(str::trim)
            .filter(|instructions| !instructions.is_empty() && !resuming)
        {
            args.push("--append-system-prompt".into());
            args.push(instructions.into());
        }
        match mode {
            ClaudeLaunchMode::Persistent { resume_id } => {
                if let Some(resume_id) = resume_id {
                    args.push(format!("--resume={resume_id}"));
                }
            }
            ClaudeLaunchMode::PersistentNew { session_id } => {
                args.push("--session-id".into());
                args.push(session_id.into());
            }
            ClaudeLaunchMode::PersistentFork {
                source_id,
                session_id,
            } => {
                args.push(format!("--resume={source_id}"));
                args.push("--fork-session".into());
                args.push("--session-id".into());
                args.push(session_id.into());
            }
            ClaudeLaunchMode::OneShot { prompt } => {
                args.extend([
                    "--print".into(),
                    prompt.into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--verbose".into(),
                    "--include-partial-messages".into(),
                ]);
            }
        }
        args.extend(self.extra_args.clone());
        let mut environment = self.environment.clone();
        if let Some(endpoint) = &self.endpoint {
            environment.extend(endpoint.launch_environment());
        }
        if let Some(search_path) = &self.search_path {
            environment.insert("PATH".into(), search_path.to_string_lossy().into_owned());
        }
        environment.extend(request.environment.clone());
        Ok(ClaudeCommandSpec {
            program,
            args,
            current_dir: request.working_directory.clone(),
            environment,
        })
    }
}

fn validate_executable(path: &Path) -> Result<PathBuf, HarnessError> {
    if path.is_file() {
        Ok(path.to_path_buf())
    } else {
        Err(HarnessError::Unavailable(format!(
            "Claude Code executable does not exist: {}",
            path.display()
        )))
    }
}

#[cfg(windows)]
fn executable_name() -> &'static str {
    "claude.exe"
}

#[cfg(not(windows))]
fn executable_name() -> &'static str {
    "claude"
}

#[cfg(test)]
mod tests {
    use std::fs::File;

    use tempfile::tempdir;
    use vertebrae_harness_core::RequestConfig;

    use super::{
        ClaudeLaunchMode, ClaudeProviderConfig, ClaudeProviderEndpoint, DEFAULT_CLAUDE_MODELS,
        claude_model_supports_fast_mode,
    };

    #[test]
    fn default_model_catalog_includes_opus_5_5() {
        assert!(DEFAULT_CLAUDE_MODELS.contains(&("claude-opus-5-5", "Claude Opus 5.5")));
    }

    #[test]
    fn default_model_catalog_includes_sonnet_5_5() {
        assert!(DEFAULT_CLAUDE_MODELS.contains(&("claude-sonnet-5-5", "Claude Sonnet 5.5")));
    }

    #[test]
    fn fast_mode_only_matches_current_supported_opus_models() {
        for model in [
            "opus",
            "claude-opus-5",
            "claude-opus-5-5",
            "claude-opus-5-20260101",
            "claude-opus-4-8",
            "claude-opus-4-8-20260101",
        ] {
            assert!(claude_model_supports_fast_mode(model), "{model}");
        }
        for model in [
            "sonnet",
            "claude-sonnet-5-5",
            "haiku",
            "claude-haiku-5-5",
            "claude-opus-4-6",
            "claude-opus-4-7",
        ] {
            assert!(!claude_model_supports_fast_mode(model), "{model}");
        }
    }

    #[test]
    fn custom_endpoint_exports_base_url_auth_token_and_environment() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("claude");
        File::create(&executable).expect("placeholder executable");
        let config = ClaudeProviderConfig {
            executable: Some(executable),
            environment: [("ANTHROPIC_API_KEY".to_string(), "ambient-key".to_string())].into(),
            endpoint: Some(ClaudeProviderEndpoint {
                base_url: Some("https://openrouter.ai/api".into()),
                auth_token: Some("provider-secret".into()),
                environment: [("API_TIMEOUT_MS".to_string(), "600000".to_string())].into(),
            }),
            ..Default::default()
        };

        let spec = config
            .command_spec(
                ClaudeLaunchMode::OneShot { prompt: "hi" },
                &RequestConfig::default(),
            )
            .expect("command spec");

        assert_eq!(
            spec.environment
                .get("ANTHROPIC_BASE_URL")
                .map(String::as_str),
            Some("https://openrouter.ai/api")
        );
        assert_eq!(
            spec.environment
                .get("ANTHROPIC_AUTH_TOKEN")
                .map(String::as_str),
            Some("provider-secret")
        );
        assert_eq!(
            spec.environment
                .get("ANTHROPIC_API_KEY")
                .map(String::as_str),
            Some("")
        );
        assert_eq!(
            spec.environment.get("API_TIMEOUT_MS").map(String::as_str),
            Some("600000")
        );
        assert!(!format!("{spec:?}").contains("provider-secret"));
        assert!(!format!("{config:?}").contains("provider-secret"));
    }

    #[test]
    fn appends_developer_instructions_without_replacing_provider_defaults() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("claude");
        File::create(&executable).expect("placeholder executable");
        let config = ClaudeProviderConfig {
            executable: Some(executable),
            ..Default::default()
        };
        let request = RequestConfig {
            verbosity: None,
            developer_instructions: Some("reference contract".into()),
            ..Default::default()
        };

        let spec = config
            .command_spec(ClaudeLaunchMode::Persistent { resume_id: None }, &request)
            .expect("command spec");

        let flag = spec
            .args
            .iter()
            .position(|arg| arg == "--append-system-prompt")
            .expect("append-system-prompt flag");
        assert_eq!(spec.args[flag + 1], "reference contract");
        assert!(spec.args.iter().any(|arg| arg == "--output-format"));
    }

    #[test]
    fn command_spec_forwards_opus_5_5_for_one_shot_execution() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("claude");
        File::create(&executable).expect("placeholder executable");
        let config = ClaudeProviderConfig {
            executable: Some(executable),
            ..Default::default()
        };
        let request = RequestConfig {
            model: Some("claude-opus-5-5".into()),
            ..Default::default()
        };

        let spec = config
            .command_spec(ClaudeLaunchMode::OneShot { prompt: "do work" }, &request)
            .expect("command spec");

        let model_flag = spec
            .args
            .iter()
            .position(|arg| arg == "--model")
            .expect("model flag");
        assert_eq!(spec.args[model_flag + 1], "claude-opus-5-5");
    }

    #[test]
    fn command_spec_forwards_sonnet_5_5_for_one_shot_execution() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("claude");
        File::create(&executable).expect("placeholder executable");
        let config = ClaudeProviderConfig {
            executable: Some(executable),
            ..Default::default()
        };
        let request = RequestConfig {
            model: Some("claude-sonnet-5-5".into()),
            ..Default::default()
        };

        let spec = config
            .command_spec(ClaudeLaunchMode::OneShot { prompt: "do work" }, &request)
            .expect("command spec");

        let model_flag = spec
            .args
            .iter()
            .position(|arg| arg == "--model")
            .expect("model flag");
        assert_eq!(spec.args[model_flag + 1], "claude-sonnet-5-5");
    }

    #[test]
    fn command_spec_preserves_haiku_5_5_in_daemon_and_chat_launches() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("claude");
        File::create(&executable).expect("placeholder executable");
        let config = ClaudeProviderConfig {
            executable: Some(executable),
            ..Default::default()
        };
        let request = RequestConfig {
            model: Some("claude-haiku-5-5".into()),
            ..Default::default()
        };

        for mode in [
            ClaudeLaunchMode::OneShot { prompt: "do work" },
            ClaudeLaunchMode::Persistent { resume_id: None },
            ClaudeLaunchMode::Persistent {
                resume_id: Some("existing-session"),
            },
        ] {
            let spec = config.command_spec(mode, &request).expect("command spec");
            let model_flag = spec
                .args
                .iter()
                .position(|arg| arg == "--model")
                .expect("model flag");
            assert_eq!(spec.args[model_flag + 1], "claude-haiku-5-5");
            if let ClaudeLaunchMode::Persistent {
                resume_id: Some(resume_id),
            } = mode
            {
                assert!(spec.args.contains(&format!("--resume={resume_id}")));
            } else {
                assert!(!spec.args.iter().any(|arg| arg.starts_with("--resume=")));
            }
        }
    }
}
