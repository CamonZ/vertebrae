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
use serde_json::Value;
use vertebrae_harness_core::{HarnessError, ProviderThreadRef, RequestConfig, SessionId};

pub const DEFAULT_CLAUDE_MODELS: &[(&str, &str)] = &[
    ("sonnet", "Sonnet"),
    ("opus", "Opus"),
    ("haiku", "Haiku"),
    ("fable", "Fable"),
];

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
    Persistent { resume_id: Option<&'a str> },
    OneShot { prompt: &'a str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub environment: BTreeMap<String, String>,
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
        let program = self.resolve_executable()?;
        let mut args = Vec::new();
        if let Some(path) = &self.prelude.settings_path {
            args.push("--settings".into());
            args.push(path.to_string_lossy().into_owned());
        }
        args.extend(self.prelude.args.clone());
        match mode {
            ClaudeLaunchMode::Persistent { .. } => {
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
        match mode {
            ClaudeLaunchMode::Persistent { resume_id } => {
                if let Some(resume_id) = resume_id {
                    args.push(format!("--resume={resume_id}"));
                }
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
