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
    TranscriptReplayAdapter, TranscriptReplayPage, TranscriptReplayPageRequest,
    TranscriptReplayRequest,
};

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
        let request_config =
            normalized_request_config(provider, &options.agent_config, options.request_config)?;
        let runtime: Arc<dyn HarnessRuntime> = match provider {
            Provider::Anthropic => {
                Arc::new(self.build_claude(&options.agent_config, &request_config)?)
            }
            Provider::Openai => Arc::new(self.build_codex(&options.agent_config, &request_config)?),
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
}

fn normalized_request_config(
    provider: Provider,
    agent_config: &AgentConfig,
    mut request_config: RequestConfig,
) -> Result<RequestConfig, HarnessError> {
    if request_config.model.is_none() {
        request_config.model = agent_config.model.clone();
    }
    if request_config.reasoning_effort.is_none() {
        request_config.reasoning_effort = agent_config.reasoning_effort.clone();
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
    Ok(request_config)
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
}
