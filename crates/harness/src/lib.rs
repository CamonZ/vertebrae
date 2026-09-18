//! Provider selection and construction for the existing V1 harness contract.
//!
//! Surface crates provide `AgentConfig` plus portable request options and
//! consume the `HarnessRuntime` trait and V1 events. Provider wire protocols,
//! launch configuration, and permission translation stay here and in the
//! provider adapter crates.

use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fmt,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::{Value, json};
use vertebrae_core::{AgentConfig, PermissionMode, Provider};
use vertebrae_harness_claude::{
    ClaudePermissionMode, ClaudeProviderConfig, ClaudeProviderPrelude, ClaudeRootLocatorResolver,
    ClaudeRuntime, ClaudeTranscriptReplay,
};
use vertebrae_harness_codex::{
    CodexPermissionConfig, CodexProviderConfig, CodexRuntime, CodexTranscriptReplay,
};
use vertebrae_harness_core::{
    HarnessError, HarnessRuntime, ProviderThreadRef, RequestConfig, SessionId, TranscriptReplay,
    TranscriptReplayPage, TranscriptReplayPageRequest, TranscriptReplayRequest,
};
use vertebrae_harness_typesafe::{TypeSafeClientConfig, TypeSafeError, TypeSafeRuntime};

/// Construction inputs owned by the surface or deployment environment.
///
/// This contains paths and surface hooks, not provider wire requests. The
/// factory translates these inputs into Claude or Codex adapter configuration.
#[derive(Clone, Default)]
pub struct HarnessFactoryConfig {
    pub anthropic_executable: Option<PathBuf>,
    pub openai_executable: Option<PathBuf>,
    /// Startup discovery diagnostics. When present with a missing executable,
    /// the factory returns that cached error without probing PATH again.
    pub anthropic_executable_diagnostic: Option<String>,
    pub openai_executable_diagnostic: Option<String>,
    /// Whether executable resolution was completed by a startup snapshot.
    /// When false, preserve the factory's legacy eager validation behavior.
    pub provider_resolution_cached: bool,
    pub search_path: Option<OsString>,
    pub environment: BTreeMap<String, String>,
    pub installed_skills_roots: Vec<PathBuf>,
    pub claude_settings_path: Option<PathBuf>,
    pub claude_agent_paths: Vec<PathBuf>,
    pub claude_permission_prompt_tool: Option<String>,
    pub claude_mcp_config: Option<Value>,
    pub claude_root_locator_resolver: Option<Arc<dyn ClaudeRootLocatorResolver>>,
    pub claude_plugin_roots: Vec<PathBuf>,
    /// Cached daemon compatibility root to merge into AgentConfig exactly
    /// once, preserving the daemon's pre-snapshot argv behavior.
    pub claude_managed_plugin_root: Option<PathBuf>,
    /// Optional home directory override for provider-owned transcript replay.
    /// Runtime launch still uses the process environment as before.
    pub transcript_home_dir: Option<PathBuf>,
    pub default_permission_mode: Option<PermissionMode>,
    /// Server-owned TypeSafe API credential. It is never copied into an
    /// `AgentConfig` or provider-neutral `RequestConfig`.
    pub typesafe_api_key: Option<String>,
    /// Optional server-owned TypeSafe endpoint override.
    pub typesafe_base_url: Option<String>,
}

impl fmt::Debug for HarnessFactoryConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HarnessFactoryConfig")
            .field("anthropic_executable", &self.anthropic_executable)
            .field("openai_executable", &self.openai_executable)
            .field(
                "anthropic_executable_diagnostic",
                &self.anthropic_executable_diagnostic,
            )
            .field(
                "openai_executable_diagnostic",
                &self.openai_executable_diagnostic,
            )
            .field(
                "provider_resolution_cached",
                &self.provider_resolution_cached,
            )
            .field("search_path", &self.search_path)
            .field("environment", &redacted_environment(&self.environment))
            .field("installed_skills_roots", &self.installed_skills_roots)
            .field("claude_settings_path", &self.claude_settings_path)
            .field("claude_agent_paths", &self.claude_agent_paths)
            .field(
                "claude_permission_prompt_tool",
                &self.claude_permission_prompt_tool,
            )
            .field("claude_mcp_config", &self.claude_mcp_config)
            .field(
                "claude_root_locator_resolver",
                &self
                    .claude_root_locator_resolver
                    .as_ref()
                    .map(|_| "<configured>"),
            )
            .field("claude_plugin_roots", &self.claude_plugin_roots)
            .field(
                "claude_managed_plugin_root",
                &self.claude_managed_plugin_root,
            )
            .field("transcript_home_dir", &self.transcript_home_dir)
            .field("default_permission_mode", &self.default_permission_mode)
            .field(
                "typesafe_api_key",
                &self.typesafe_api_key.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "typesafe_base_url",
                &redacted_base_url(&self.typesafe_base_url),
            )
            .finish()
    }
}

impl HarnessFactoryConfig {
    /// Capture server startup configuration once. Explicit struct fields may
    /// still be supplied by an embedding server and take precedence when the
    /// factory constructs a TypeSafe client.
    pub fn from_environment() -> Self {
        Self {
            typesafe_api_key: env::var("TYPESAFE_API_KEY").ok(),
            typesafe_base_url: env::var("TYPESAFE_BASE_URL").ok(),
            ..Self::default()
        }
    }
}

/// Options supplied for one runtime construction. `AgentConfig` is the
/// daemon's persisted input; local chat builds the same shape from its UI
/// options before calling the factory.
#[derive(Debug, Clone)]
pub struct HarnessRuntimeOptions {
    pub agent_config: AgentConfig,
    pub request_config: RequestConfig,
}

/// A selected runtime plus the normalized portable request options that must
/// be used with it.
pub struct HarnessRuntimeInstance {
    pub provider: Provider,
    pub runtime: Arc<dyn HarnessRuntime>,
    pub request_config: RequestConfig,
}

#[derive(Clone, Default)]
pub struct HarnessRuntimeFactory {
    config: HarnessFactoryConfig,
}

impl HarnessRuntimeFactory {
    pub fn new(config: HarnessFactoryConfig) -> Self {
        Self { config }
    }

    pub fn provider_for(agent_config: &AgentConfig) -> Provider {
        agent_config.provider.unwrap_or(Provider::Anthropic)
    }

    pub fn create(
        &self,
        options: HarnessRuntimeOptions,
    ) -> Result<HarnessRuntimeInstance, HarnessError> {
        let provider = Self::provider_for(&options.agent_config);
        vertebrae_core::validate_provider_agent_config(provider, &options.agent_config)
            .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        let request_config =
            normalized_request_config(provider, &options.agent_config, options.request_config)?;
        let runtime: Arc<dyn HarnessRuntime> = match provider {
            Provider::Anthropic => {
                Arc::new(self.build_claude(&options.agent_config, &request_config)?)
            }
            Provider::Openai => Arc::new(self.build_codex(&options.agent_config, &request_config)?),
            Provider::Typesafe => {
                Arc::new(self.build_typesafe(&options.agent_config, &request_config)?)
            }
        };
        Ok(HarnessRuntimeInstance {
            provider,
            runtime,
            request_config,
        })
    }

    /// Discover and replay a durable provider transcript without exposing
    /// provider-specific JSONL formats to the caller.
    pub fn replay_transcript(
        &self,
        provider: Provider,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError> {
        match provider {
            Provider::Anthropic => {
                ClaudeTranscriptReplay::new(self.config.transcript_home_dir.clone()).replay(request)
            }
            Provider::Openai => {
                CodexTranscriptReplay::new(self.config.transcript_home_dir.clone()).replay(request)
            }
            Provider::Typesafe => Ok(None),
        }
    }

    /// Discover and load one page of a durable provider transcript while
    /// keeping provider-specific indexing and decoding inside its adapter.
    pub fn replay_transcript_page(
        &self,
        provider: Provider,
        request: &TranscriptReplayRequest,
        page: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        match provider {
            Provider::Anthropic => {
                ClaudeTranscriptReplay::new(self.config.transcript_home_dir.clone())
                    .replay_page(request, page)
            }
            Provider::Openai => CodexTranscriptReplay::new(self.config.transcript_home_dir.clone())
                .replay_page(request, page),
            Provider::Typesafe => Ok(None),
        }
    }

    fn build_claude(
        &self,
        agent_config: &AgentConfig,
        request_config: &RequestConfig,
    ) -> Result<ClaudeRuntime, HarnessError> {
        vertebrae_core::model_catalog::validate_provider_model(
            Provider::Anthropic,
            request_config.model.as_deref(),
        )
        .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        let mut agent_config = agent_config.clone();
        if agent_config.model.is_none() {
            agent_config.model = request_config.model.clone();
        }
        let permission_mode = agent_config
            .permission_mode
            .as_ref()
            .or(self.config.default_permission_mode.as_ref())
            .map(claude_permission_mode);
        let executable = self.config.anthropic_executable.clone();
        let search_path = self.config.search_path.clone();
        let mut provider = ClaudeProviderConfig {
            executable,
            search_path: search_path.or_else(|| env::var_os("PATH")),
            environment: self.config.environment.clone(),
            prelude: ClaudeProviderPrelude {
                settings_path: self.config.claude_settings_path.clone(),
                args: Vec::new(),
            },
            plugin_roots: self.config.claude_plugin_roots.clone(),
            installed_skills_roots: self.config.installed_skills_roots.clone(),
            agent_paths: self.config.claude_agent_paths.clone(),
            permission_mode,
            permission_prompt_tool: self.config.claude_permission_prompt_tool.clone(),
            mcp_config: self.config.claude_mcp_config.clone(),
            root_locator_resolver: self.config.claude_root_locator_resolver.clone(),
            ..ClaudeProviderConfig::default()
        };

        if !self.config.provider_resolution_cached && provider.executable.is_some() {
            provider.resolve_executable()?;
        } else if provider.executable.is_none() {
            if let Some(diagnostic) = &self.config.anthropic_executable_diagnostic {
                return Err(HarnessError::Unavailable(diagnostic.clone()));
            }
            if self.config.provider_resolution_cached {
                return Err(HarnessError::Unavailable(
                    "Anthropic provider executable was not resolved at startup".into(),
                ));
            }
            provider.resolve_executable()?;
        }
        if let Some(working_directory) = request_config.working_directory.as_deref() {
            if !working_directory.is_dir() {
                return Err(HarnessError::InvalidRequest(format!(
                    "working directory is not a directory: {}",
                    working_directory.display()
                )));
            }
            // The daemon's cached managed root follows the same AgentConfig
            // path as the former lazy resolver. Provider-owned plugin roots
            // remain provider-specific flags and are not copied into the
            // persisted AgentConfig list.
            if let Some(plugin_root) = &self.config.claude_managed_plugin_root {
                merge_plugin_root(&mut agent_config, plugin_root);
            }
        }
        agent_config.json_schema = None;
        provider.prelude.args = agent_config.to_claude_cli_args();
        Ok(ClaudeRuntime::new(provider))
    }

    fn build_codex(
        &self,
        agent_config: &AgentConfig,
        request_config: &RequestConfig,
    ) -> Result<CodexRuntime, HarnessError> {
        vertebrae_core::model_catalog::validate_provider_model_with_codex_provider(
            Provider::Openai,
            request_config.model.as_deref(),
            agent_config.codex_model_provider.as_deref(),
        )
        .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        let permission_mode = agent_config
            .permission_mode
            .as_ref()
            .or(self.config.default_permission_mode.as_ref());
        let provider = CodexProviderConfig {
            executable: self.config.openai_executable.clone(),
            search_path: self
                .config
                .search_path
                .clone()
                .or_else(|| env::var_os("PATH")),
            environment: self.config.environment.clone(),
            model_provider: agent_config.codex_model_provider.clone(),
            permission: codex_permission_config(permission_mode, &agent_config.disallowed_tools),
            installed_skills_roots: self.config.installed_skills_roots.clone(),
            ..CodexProviderConfig::default()
        };
        if !self.config.provider_resolution_cached && provider.executable.is_some() {
            provider.resolve_executable()?;
        } else if provider.executable.is_none() {
            if let Some(diagnostic) = &self.config.openai_executable_diagnostic {
                return Err(HarnessError::Unavailable(diagnostic.clone()));
            }
            if self.config.provider_resolution_cached {
                return Err(HarnessError::Unavailable(
                    "OpenAI provider executable was not resolved at startup".into(),
                ));
            }
            provider.resolve_executable()?;
        }
        Ok(CodexRuntime::new(provider))
    }

    fn build_typesafe(
        &self,
        _agent_config: &AgentConfig,
        request_config: &RequestConfig,
    ) -> Result<TypeSafeRuntime, HarnessError> {
        vertebrae_core::validate_provider_model(
            Provider::Typesafe,
            request_config.model.as_deref(),
        )
        .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        validate_typesafe_request_config(request_config)?;

        let mut config =
            TypeSafeClientConfig::new(self.config.typesafe_api_key.clone().unwrap_or_default());
        if let Some(base_url) = &self.config.typesafe_base_url {
            config = config.with_base_url(base_url.clone());
        }
        TypeSafeRuntime::from_config(config).map_err(map_typesafe_configuration_error)
    }
}

fn normalized_request_config(
    provider: Provider,
    agent_config: &AgentConfig,
    mut request_config: RequestConfig,
) -> Result<RequestConfig, HarnessError> {
    if request_config.model.is_none() {
        request_config.model = agent_config.model.clone();
    }
    if request_config.model.is_none() {
        request_config.model = provider.default_model().map(str::to_owned);
    }
    if request_config.reasoning_effort.is_none() {
        request_config.reasoning_effort = agent_config.reasoning_effort.clone();
    }
    if request_config.speed_tier.is_none() {
        request_config.speed_tier = agent_config.speed_tier;
    }
    if request_config.personality.is_none() {
        request_config.personality = agent_config.personality.clone();
    }
    if request_config.verbosity.is_none() {
        request_config.verbosity = agent_config.verbosity;
    }
    if request_config.output_schema.is_none() {
        request_config.output_schema = agent_config.json_schema.clone();
    }
    request_config.reasoning_effort =
        vertebrae_core::model_catalog::normalize_provider_reasoning_effort(
            provider,
            request_config.reasoning_effort.as_deref(),
        )
        .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
    request_config.personality = vertebrae_core::normalize_provider_personality(
        provider,
        request_config.personality.as_deref(),
    )
    .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
    request_config.verbosity =
        vertebrae_core::normalize_provider_verbosity(provider, request_config.verbosity)
            .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
    if provider == Provider::Typesafe {
        validate_typesafe_request_config(&request_config)?;
    }
    Ok(request_config)
}

fn validate_typesafe_request_config(config: &RequestConfig) -> Result<(), HarnessError> {
    let unsupported = [
        ("working_directory", config.working_directory.is_some()),
        ("speed_tier", config.speed_tier.is_some()),
        ("output_schema", config.output_schema.is_some()),
        (
            "developer_instructions",
            config.developer_instructions.is_some(),
        ),
        ("environment", !config.environment.is_empty()),
    ];
    if let Some((option, true)) = unsupported.into_iter().find(|(_, present)| *present) {
        return Err(HarnessError::Unsupported(format!(
            "TypeSafe does not support RequestConfig.{option}"
        )));
    }
    Ok(())
}

fn redacted_environment(environment: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    environment
        .iter()
        .map(|(key, value)| {
            let value = if key == "TYPESAFE_API_KEY"
                || key.ends_with("_API_KEY")
                || key.ends_with("_TOKEN")
                || key.ends_with("_SECRET")
                || key.ends_with("_PASSWORD")
            {
                "<redacted>".to_string()
            } else {
                value.clone()
            };
            (key.clone(), value)
        })
        .collect()
}

fn redacted_base_url(base_url: &Option<String>) -> Option<String> {
    base_url.as_ref().map(|value| {
        if value.contains('@') || value.contains('?') || value.contains('#') {
            "<redacted>".to_string()
        } else {
            value.clone()
        }
    })
}

fn map_typesafe_configuration_error(error: TypeSafeError) -> HarnessError {
    match error {
        TypeSafeError::MissingApiKey => HarnessError::Unavailable(
            "TypeSafe provider API key is not configured; set TYPESAFE_API_KEY on the server"
                .into(),
        ),
        TypeSafeError::InvalidConfiguration(message) => HarnessError::InvalidRequest(message),
        error => HarnessError::Unavailable(format!("TypeSafe provider is unavailable: {error}")),
    }
}

fn merge_plugin_root(agent_config: &mut AgentConfig, plugin_root: &Path) {
    if !agent_config
        .plugin_dirs
        .iter()
        .any(|configured| Path::new(configured) == plugin_root)
    {
        agent_config
            .plugin_dirs
            .push(plugin_root.to_string_lossy().into_owned());
    }
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

fn codex_permission_config(
    mode: Option<&PermissionMode>,
    disallowed_tools: &[String],
) -> CodexPermissionConfig {
    let mut permission = match mode {
        Some(PermissionMode::AcceptEdits) => CodexPermissionConfig {
            approval_policy: Some("on-request".into()),
            permissions: Some(":workspace".into()),
            ..Default::default()
        },
        Some(PermissionMode::Auto) => CodexPermissionConfig {
            approval_policy: Some("on-request".into()),
            approvals_reviewer: Some("auto_review".into()),
            permissions: Some(":workspace".into()),
            ..Default::default()
        },
        Some(PermissionMode::BypassPermissions) => CodexPermissionConfig {
            approval_policy: Some("never".into()),
            permissions: Some(":danger-full-access".into()),
            ..Default::default()
        },
        Some(PermissionMode::DontAsk) | Some(PermissionMode::Plan) => CodexPermissionConfig {
            approval_policy: Some("never".into()),
            permissions: Some(":workspace".into()),
            ..Default::default()
        },
        Some(PermissionMode::Default) | None => CodexPermissionConfig::default(),
    };
    let prefix_rules = disallowed_tools
        .iter()
        .filter_map(|tool| {
            tool.strip_prefix("Bash(")
                .and_then(|tool| tool.strip_suffix(')'))
        })
        .filter_map(|command| {
            let words = command
                .trim_end_matches('*')
                .split_whitespace()
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            (!words.is_empty()).then(|| json!({"prefix_rule": words, "decision": "deny"}))
        })
        .collect::<Vec<_>>();
    if !prefix_rules.is_empty() {
        permission.prefix_rules = Some(json!(prefix_rules));
    }
    permission
}

pub fn daemon_opaque_claude_locator(
    session_id: &SessionId,
) -> Result<Option<ProviderThreadRef>, String> {
    Ok(Some(ProviderThreadRef::new(format!(
        "claude://session/{}",
        session_id.as_str()
    ))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executable() -> PathBuf {
        std::env::current_exe().expect("the test executable should exist")
    }

    #[test]
    fn selects_provider_and_normalizes_request_options() {
        let binary = executable();
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            anthropic_executable: Some(binary.clone()),
            openai_executable: Some(binary),
            search_path: Some(OsString::new()),
            ..HarnessFactoryConfig::default()
        });

        let claude = factory
            .create(HarnessRuntimeOptions {
                agent_config: AgentConfig::new()
                    .with_provider(Provider::Anthropic)
                    .with_model("sonnet"),
                request_config: RequestConfig::default(),
            })
            .expect("Claude runtime should be selected");
        assert_eq!(claude.provider, Provider::Anthropic);
        assert_eq!(claude.request_config.model.as_deref(), Some("sonnet"));

        let codex = factory
            .create(HarnessRuntimeOptions {
                agent_config: AgentConfig::new()
                    .with_provider(Provider::Openai)
                    .with_model("gpt-5.5")
                    .with_reasoning_effort(" HIGH "),
                request_config: RequestConfig::default(),
            })
            .expect("Codex runtime should be selected");
        assert_eq!(codex.provider, Provider::Openai);
        assert_eq!(
            codex.request_config.reasoning_effort.as_deref(),
            Some("high")
        );
    }

    #[test]
    fn accepts_fable_as_an_anthropic_model() {
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            anthropic_executable: Some(executable()),
            search_path: Some(OsString::new()),
            ..HarnessFactoryConfig::default()
        });

        let claude = factory
            .create(HarnessRuntimeOptions {
                agent_config: AgentConfig::new()
                    .with_provider(Provider::Anthropic)
                    .with_model("fable"),
                request_config: RequestConfig::default(),
            })
            .expect("Fable should be accepted by the Anthropic harness");

        assert_eq!(claude.provider, Provider::Anthropic);
        assert_eq!(claude.request_config.model.as_deref(), Some("fable"));
    }

    #[test]
    fn request_settings_override_agent_config_settings() {
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            openai_executable: Some(executable()),
            search_path: Some(OsString::new()),
            ..HarnessFactoryConfig::default()
        });

        let codex = factory
            .create(HarnessRuntimeOptions {
                agent_config: AgentConfig::new()
                    .with_provider(Provider::Openai)
                    .with_model("gpt-5.5")
                    .with_speed_tier(vertebrae_core::SpeedTier::Default)
                    .with_personality("friendly")
                    .with_verbosity(vertebrae_core::OutputVerbosity::Low),
                request_config: RequestConfig {
                    speed_tier: Some(vertebrae_harness_core::SpeedTier::Fast),
                    personality: Some("pragmatic".into()),
                    verbosity: Some(vertebrae_harness_core::OutputVerbosity::High),
                    ..Default::default()
                },
            })
            .expect("Codex runtime should be selected");

        assert_eq!(
            codex.request_config.speed_tier,
            Some(vertebrae_harness_core::SpeedTier::Fast)
        );
        assert_eq!(
            codex.request_config.personality.as_deref(),
            Some("pragmatic")
        );
        assert_eq!(
            codex.request_config.verbosity,
            Some(vertebrae_core::OutputVerbosity::High)
        );
    }

    #[test]
    fn rejects_verbosity_for_claude_before_starting_runtime() {
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            anthropic_executable: Some(executable()),
            search_path: Some(OsString::new()),
            ..HarnessFactoryConfig::default()
        });

        let result = factory.create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new()
                .with_provider(Provider::Anthropic)
                .with_model("sonnet")
                .with_verbosity(vertebrae_core::OutputVerbosity::Low),
            request_config: RequestConfig::default(),
        });

        assert!(matches!(
            result,
            Err(HarnessError::InvalidRequest(message))
                if message.contains("output verbosity")
        ));
    }

    #[test]
    fn reports_unavailable_provider_from_factory_configuration() {
        let result = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            openai_executable: Some(PathBuf::from("/definitely/missing/codex")),
            ..HarnessFactoryConfig::default()
        })
        .create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new().with_provider(Provider::Openai),
            request_config: RequestConfig::default(),
        });

        assert!(matches!(result, Err(HarnessError::Unavailable(_))));
    }

    #[test]
    fn cached_provider_resolution_does_not_reprobe_executable_path() {
        let result = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            anthropic_executable: Some(PathBuf::from("/definitely/missing/claude")),
            provider_resolution_cached: true,
            ..HarnessFactoryConfig::default()
        })
        .create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new()
                .with_provider(Provider::Anthropic)
                .with_model("sonnet"),
            request_config: RequestConfig::default(),
        });

        assert!(
            result.is_ok(),
            "cached construction must not re-probe the path"
        );
    }

    #[test]
    fn selects_typesafe_with_server_configuration_and_default_model() {
        let config = HarnessFactoryConfig {
            typesafe_api_key: Some("typesafe-secret".into()),
            typesafe_base_url: Some("https://typesafe.example.test".into()),
            ..HarnessFactoryConfig::default()
        };
        let debug = format!("{config:?}");
        assert!(!debug.contains("typesafe-secret"));
        assert!(debug.contains("<redacted>"));

        let instance = HarnessRuntimeFactory::new(config).create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new().with_provider(Provider::Typesafe),
            request_config: RequestConfig::default(),
        });
        let instance = instance.expect("TypeSafe runtime should be selected");
        assert_eq!(instance.provider, Provider::Typesafe);
        assert_eq!(
            instance.request_config.model.as_deref(),
            Some(vertebrae_core::DEFAULT_TYPESAFE_MODEL)
        );
    }

    #[test]
    fn missing_typesafe_api_key_is_unavailable_without_cli_lookup() {
        let result = HarnessRuntimeFactory::new(HarnessFactoryConfig::default()).create(
            HarnessRuntimeOptions {
                agent_config: AgentConfig::new().with_provider(Provider::Typesafe),
                request_config: RequestConfig::default(),
            },
        );

        assert!(matches!(
            result,
            Err(HarnessError::Unavailable(message))
                if message.contains("TYPESAFE_API_KEY") && !message.contains("executable")
        ));
    }

    #[test]
    fn rejects_typesafe_agent_and_request_options_before_runtime_creation() {
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            typesafe_api_key: Some("typesafe-secret".into()),
            ..HarnessFactoryConfig::default()
        });

        let result = factory.create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new()
                .with_provider(Provider::Typesafe)
                .with_tools(vec!["Bash".into()]),
            request_config: RequestConfig::default(),
        });
        assert!(matches!(
            result,
            Err(HarnessError::InvalidRequest(message)) if message.contains("AgentConfig.tools")
        ));

        let result = factory.create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new().with_provider(Provider::Typesafe),
            request_config: RequestConfig {
                environment: BTreeMap::from([(String::from("SECRET"), String::from("value"))]),
                ..RequestConfig::default()
            },
        });
        assert!(matches!(
            result,
            Err(HarnessError::Unsupported(message)) if message.contains("RequestConfig.environment")
        ));

        let result = factory.create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new().with_provider(Provider::Typesafe),
            request_config: RequestConfig {
                model: Some("gpt-5.5".into()),
                ..RequestConfig::default()
            },
        });
        assert!(matches!(
            result,
            Err(HarnessError::InvalidRequest(message)) if message.contains("gpt-5.5")
        ));
    }
}
