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
use vertebrae_core::{
    AgentConfig, BuiltinProvider, PermissionMode, ProviderId, ProviderProfile, StepHarness,
};
use vertebrae_harness_claude::{
    ClaudePermissionMode, ClaudeProviderConfig, ClaudeProviderEndpoint, ClaudeProviderPrelude,
    ClaudeRootLocatorResolver, ClaudeRuntime, ClaudeTranscriptReplay,
};
use vertebrae_harness_codex::{
    CodexCustomModelProvider, CodexPermissionConfig, CodexProviderConfig, CodexRuntime,
    CodexTranscriptReplay,
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
    /// Optional server-owned full TypeSafe System One endpoint URL.
    pub typesafe_url: Option<String>,
    pub provider_profiles: BTreeMap<ProviderId, ProviderProfile>,
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
            .field(
                "typesafe_url",
                &self.typesafe_url.as_ref().map(|_| "<redacted>"),
            )
            .field("provider_profiles", &self.provider_profiles)
            .finish()
    }
}

impl HarnessFactoryConfig {
    /// Capture server startup configuration once. Explicit struct fields may
    /// still be supplied by an embedding server and take precedence when the
    /// factory constructs a TypeSafe client.
    pub fn from_environment() -> Self {
        Self::from_environment_with_typesafe_configured_settings(None, None)
    }

    /// Capture environment configuration while using the shared app config as
    /// the TypeSafe key fallback. A nonblank environment key takes precedence.
    pub fn from_environment_with_typesafe_configured_api_key(
        configured_api_key: Option<String>,
    ) -> Self {
        Self::from_environment_with_typesafe_configured_settings(configured_api_key, None)
    }

    /// Capture environment configuration while using shared app config as
    /// fallbacks for the TypeSafe key and full endpoint URL. The legacy base
    /// URL environment override takes precedence over the configured URL.
    pub fn from_environment_with_typesafe_configured_settings(
        configured_api_key: Option<String>,
        configured_url: Option<String>,
    ) -> Self {
        let environment_api_key = env::var("TYPESAFE_API_KEY").ok();
        Self {
            typesafe_api_key: resolve_typesafe_api_key(configured_api_key, environment_api_key),
            typesafe_base_url: env::var("TYPESAFE_BASE_URL").ok(),
            typesafe_url: configured_url,
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
    pub provider: ProviderId,
    pub harness: StepHarness,
    pub runtime: Arc<dyn HarnessRuntime>,
    pub request_config: RequestConfig,
}

/// The provider a request resolved to and the harness that runs it. Custom
/// providers carry their validated config.toml profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProvider {
    pub id: ProviderId,
    pub harness: StepHarness,
    pub profile: Option<ProviderProfile>,
}

impl ResolvedProvider {
    fn builtin(builtin: BuiltinProvider) -> Self {
        Self {
            id: builtin.id(),
            harness: builtin.harness(),
            profile: None,
        }
    }

    /// The built-in provider, or `None` for a custom provider.
    pub fn builtin_provider(&self) -> Option<BuiltinProvider> {
        self.profile.is_none().then(|| self.id.builtin()).flatten()
    }
}

/// Resolve the provider and harness for an optional step harness selector
/// and `AgentConfig.provider`.
///
/// - No provider: the harness's built-in provider, or Anthropic/Claude when
///   no harness is selected either.
/// - A built-in provider runs on its own harness.
/// - A custom provider must have a valid profile in `profiles`; its harness
///   comes from the profile.
///
/// An explicit harness that disagrees with the provider's harness fails
/// instead of silently switching runtimes.
pub fn resolve_provider(
    harness: Option<StepHarness>,
    agent_config: &AgentConfig,
    profiles: &BTreeMap<ProviderId, ProviderProfile>,
) -> Result<ResolvedProvider, HarnessError> {
    let resolved = match &agent_config.provider {
        None => ResolvedProvider::builtin(
            harness.map_or(BuiltinProvider::Anthropic, BuiltinProvider::for_harness),
        ),
        Some(id) => match id.builtin() {
            Some(builtin) => ResolvedProvider::builtin(builtin),
            None => {
                let profile = profiles.get(id).ok_or_else(|| {
                    HarnessError::InvalidRequest(format!(
                        "provider '{id}' is not configured on this machine; add [providers.{id}] to config.toml"
                    ))
                })?;
                profile.validate(id).map_err(HarnessError::InvalidRequest)?;
                ResolvedProvider {
                    id: id.clone(),
                    harness: profile.harness,
                    profile: Some(profile.clone()),
                }
            }
        },
    };
    if let Some(harness) = harness
        && harness != resolved.harness
    {
        return Err(HarnessError::InvalidRequest(format!(
            "step harness '{}' conflicts with agent_config.provider '{}', which runs on the '{}' harness",
            harness, resolved.id, resolved.harness
        )));
    }
    Ok(resolved)
}

/// Environment, arguments, and model that point a one-off provider CLI
/// invocation (for example `claude --print` or `codex exec`) at a custom
/// provider. Produced by the adapters' own translation; Debug output lists
/// environment keys only.
#[derive(Clone, PartialEq, Eq)]
pub struct CustomProviderProcessLaunch {
    pub environment: BTreeMap<String, String>,
    pub args: Vec<String>,
    pub model: String,
}

impl fmt::Debug for CustomProviderProcessLaunch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomProviderProcessLaunch")
            .field("environment", &self.environment.keys().collect::<Vec<_>>())
            .field("args", &self.args)
            .field("model", &self.model)
            .finish()
    }
}

#[derive(Clone, Default)]
pub struct HarnessRuntimeFactory {
    config: HarnessFactoryConfig,
}

impl HarnessRuntimeFactory {
    pub fn new(config: HarnessFactoryConfig) -> Self {
        Self { config }
    }

    pub fn resolve_provider(
        &self,
        harness: Option<StepHarness>,
        agent_config: &AgentConfig,
    ) -> Result<ResolvedProvider, HarnessError> {
        resolve_provider(harness, agent_config, &self.config.provider_profiles)
    }

    pub fn create(
        &self,
        options: HarnessRuntimeOptions,
    ) -> Result<HarnessRuntimeInstance, HarnessError> {
        self.create_for_harness(None, options)
    }

    /// Construct the runtime selected by a workflow step. An absent selector
    /// resolves the harness from the provider (Anthropic when unset).
    pub fn create_for_harness(
        &self,
        harness: Option<StepHarness>,
        options: HarnessRuntimeOptions,
    ) -> Result<HarnessRuntimeInstance, HarnessError> {
        let resolved = self.resolve_provider(harness, &options.agent_config)?;
        let selected_harness = resolved.harness;
        self.create_for_resolved(resolved, options)
            .map_err(|error| match (harness, error) {
                (Some(_), HarnessError::Unavailable(reason)) => HarnessError::Unavailable(format!(
                    "selected '{}' harness is unavailable: {reason}",
                    selected_harness
                )),
                (_, error) => error,
            })
    }

    fn create_for_resolved(
        &self,
        resolved: ResolvedProvider,
        options: HarnessRuntimeOptions,
    ) -> Result<HarnessRuntimeInstance, HarnessError> {
        vertebrae_core::validate_harness_agent_config(resolved.harness, &options.agent_config)
            .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        if resolved.profile.is_some() && options.agent_config.codex_model_provider.is_some() {
            return Err(HarnessError::InvalidRequest(format!(
                "codex_model_provider cannot be combined with custom provider '{}'; the provider's config.toml entry selects the upstream",
                resolved.id
            )));
        }
        let request_config =
            normalized_request_config(&resolved, &options.agent_config, options.request_config)?;
        let runtime: Arc<dyn HarnessRuntime> = match resolved.harness {
            StepHarness::Claude => {
                Arc::new(self.build_claude(&resolved, &options.agent_config, &request_config)?)
            }
            StepHarness::Codex => {
                Arc::new(self.build_codex(&resolved, &options.agent_config, &request_config)?)
            }
            StepHarness::Typesafe => Arc::new(self.build_typesafe(&resolved, &request_config)?),
        };
        Ok(HarnessRuntimeInstance {
            provider: resolved.id,
            harness: resolved.harness,
            runtime,
            request_config,
        })
    }

    /// Translate a configured custom Claude/Codex provider into the launch
    /// settings for a one-off CLI process that runs its default model.
    pub fn custom_provider_process_launch(
        &self,
        id: &ProviderId,
    ) -> Result<CustomProviderProcessLaunch, HarnessError> {
        let resolved =
            self.resolve_provider(None, &AgentConfig::new().with_provider(id.clone()))?;
        let Some(profile) = &resolved.profile else {
            return Err(HarnessError::InvalidRequest(format!(
                "provider '{id}' is built in, not a custom provider"
            )));
        };
        let model = profile
            .resolve_model(id, None)
            .map_err(HarnessError::InvalidRequest)?;
        let api_key = self.custom_provider_api_key(&resolved, profile)?;
        match resolved.harness {
            StepHarness::Claude => Ok(CustomProviderProcessLaunch {
                environment: ClaudeProviderEndpoint {
                    base_url: profile.base_url.clone(),
                    auth_token: api_key,
                    environment: profile.env.clone(),
                }
                .launch_environment(),
                args: Vec::new(),
                model,
            }),
            StepHarness::Codex => {
                let provider = CodexCustomModelProvider {
                    id: id.to_string(),
                    base_url: profile.base_url.clone(),
                    api_key,
                    wire_api: profile
                        .wire_api
                        .map(|wire_api| wire_api.as_str().to_string()),
                    environment: profile.env.clone(),
                };
                let mut args = provider.config_overrides();
                args.extend(["-c".to_string(), format!("model_provider=\"{id}\"")]);
                Ok(CustomProviderProcessLaunch {
                    environment: provider.launch_environment(),
                    args,
                    model,
                })
            }
            StepHarness::Typesafe => Err(HarnessError::Unsupported(format!(
                "provider '{id}' runs on the typesafe harness, which has no CLI process"
            ))),
        }
    }

    /// Read a credential environment variable, preferring the factory's
    /// captured environment over the process environment.
    fn lookup_environment(&self, name: &str) -> Option<String> {
        self.config
            .environment
            .get(name)
            .cloned()
            .or_else(|| env::var(name).ok())
    }

    /// Resolve a custom provider credential. A configured but missing
    /// `api_key_env` fails instead of silently sending no credential.
    fn custom_provider_api_key(
        &self,
        resolved: &ResolvedProvider,
        profile: &ProviderProfile,
    ) -> Result<Option<String>, HarnessError> {
        let api_key = profile.resolve_api_key(|name| self.lookup_environment(name));
        if api_key.is_none()
            && let Some(name) = &profile.api_key_env
        {
            return Err(HarnessError::Unavailable(format!(
                "provider '{}' credential is not configured; set {} in the environment or api_key in [providers.{}]",
                resolved.id,
                name.trim(),
                resolved.id
            )));
        }
        Ok(api_key)
    }

    /// Discover and replay a durable provider transcript without exposing
    /// provider-specific JSONL formats to the caller.
    pub fn replay_transcript(
        &self,
        harness: StepHarness,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError> {
        match harness {
            StepHarness::Claude => {
                ClaudeTranscriptReplay::new(self.config.transcript_home_dir.clone()).replay(request)
            }
            StepHarness::Codex => {
                CodexTranscriptReplay::new(self.config.transcript_home_dir.clone()).replay(request)
            }
            StepHarness::Typesafe => Ok(None),
        }
    }

    /// Discover and load one page of a durable provider transcript while
    /// keeping provider-specific indexing and decoding inside its adapter.
    pub fn replay_transcript_page(
        &self,
        harness: StepHarness,
        request: &TranscriptReplayRequest,
        page: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        match harness {
            StepHarness::Claude => {
                ClaudeTranscriptReplay::new(self.config.transcript_home_dir.clone())
                    .replay_page(request, page)
            }
            StepHarness::Codex => {
                CodexTranscriptReplay::new(self.config.transcript_home_dir.clone())
                    .replay_page(request, page)
            }
            StepHarness::Typesafe => Ok(None),
        }
    }

    fn build_claude(
        &self,
        resolved: &ResolvedProvider,
        agent_config: &AgentConfig,
        request_config: &RequestConfig,
    ) -> Result<ClaudeRuntime, HarnessError> {
        let endpoint = match &resolved.profile {
            Some(profile) => Some(ClaudeProviderEndpoint {
                base_url: profile.base_url.clone(),
                auth_token: self.custom_provider_api_key(resolved, profile)?,
                environment: profile.env.clone(),
            }),
            None => {
                vertebrae_core::model_catalog::validate_provider_model(
                    BuiltinProvider::Anthropic,
                    request_config.model.as_deref(),
                )
                .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
                None
            }
        };
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
            endpoint,
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
        resolved: &ResolvedProvider,
        agent_config: &AgentConfig,
        request_config: &RequestConfig,
    ) -> Result<CodexRuntime, HarnessError> {
        let custom_model_provider = match &resolved.profile {
            Some(profile) => Some(CodexCustomModelProvider {
                id: resolved.id.to_string(),
                base_url: profile.base_url.clone(),
                api_key: self.custom_provider_api_key(resolved, profile)?,
                wire_api: profile
                    .wire_api
                    .map(|wire_api| wire_api.as_str().to_string()),
                environment: profile.env.clone(),
            }),
            None => {
                vertebrae_core::model_catalog::validate_provider_model_with_codex_provider(
                    BuiltinProvider::Openai,
                    request_config.model.as_deref(),
                    agent_config.codex_model_provider.as_deref(),
                )
                .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
                None
            }
        };
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
            custom_model_provider,
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
        resolved: &ResolvedProvider,
        request_config: &RequestConfig,
    ) -> Result<TypeSafeRuntime, HarnessError> {
        validate_typesafe_request_config(request_config)?;

        if let Some(profile) = &resolved.profile {
            // A custom TypeSafe provider replaces the [typesafe] section and
            // the TYPESAFE_* environment overrides for this step.
            let api_key = self.custom_provider_api_key(resolved, profile)?;
            let mut config = TypeSafeClientConfig::new(api_key.unwrap_or_default());
            if let Some(url) = &profile.url {
                config = config.with_url(url.clone());
            }
            return TypeSafeRuntime::from_config(config).map_err(|error| match error {
                TypeSafeError::MissingApiKey => HarnessError::Unavailable(format!(
                    "provider '{}' API key is not configured; set api_key_env or api_key in [providers.{}]",
                    resolved.id, resolved.id
                )),
                error => map_typesafe_configuration_error(error),
            });
        }

        vertebrae_core::validate_provider_model(
            BuiltinProvider::Typesafe,
            request_config.model.as_deref(),
        )
        .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        let mut config =
            TypeSafeClientConfig::new(self.config.typesafe_api_key.clone().unwrap_or_default());
        if let Some(base_url) = &self.config.typesafe_base_url {
            config = config.with_base_url(base_url.clone());
        } else if let Some(url) = &self.config.typesafe_url {
            config = config.with_url(url.clone());
        }
        TypeSafeRuntime::from_config(config).map_err(map_typesafe_configuration_error)
    }
}

fn normalized_request_config(
    resolved: &ResolvedProvider,
    agent_config: &AgentConfig,
    mut request_config: RequestConfig,
) -> Result<RequestConfig, HarnessError> {
    let harness = resolved.harness;
    if request_config.model.is_none() {
        request_config.model = agent_config.model.clone();
    }
    match &resolved.profile {
        // Custom providers accept exactly their configured models; built-in
        // catalog prefix rules never apply to them.
        Some(profile) => {
            request_config.model = Some(
                profile
                    .resolve_model(&resolved.id, request_config.model.as_deref())
                    .map_err(HarnessError::InvalidRequest)?,
            );
        }
        None if request_config.model.is_none() => {
            request_config.model = resolved
                .builtin_provider()
                .and_then(BuiltinProvider::default_model)
                .map(str::to_owned);
        }
        None => {}
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
    request_config.reasoning_effort = vertebrae_core::normalize_harness_reasoning_effort(
        harness,
        request_config.reasoning_effort.as_deref(),
    )
    .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
    request_config.personality = vertebrae_core::normalize_harness_personality(
        harness,
        request_config.personality.as_deref(),
    )
    .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
    request_config.verbosity =
        vertebrae_core::normalize_harness_verbosity(harness, request_config.verbosity)
            .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
    if harness == StepHarness::Typesafe {
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

fn resolve_typesafe_api_key(
    configured_api_key: Option<String>,
    environment_api_key: Option<String>,
) -> Option<String> {
    let nonblank = |value: String| (!value.trim().is_empty()).then_some(value);
    environment_api_key
        .and_then(nonblank)
        .or_else(|| configured_api_key.and_then(nonblank))
}

fn map_typesafe_configuration_error(error: TypeSafeError) -> HarnessError {
    match error {
        TypeSafeError::MissingApiKey => HarnessError::Unavailable(
            "TypeSafe provider API key is not configured; set [typesafe].api_key in config.toml or TYPESAFE_API_KEY on the server".into(),
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
    fn typesafe_environment_key_overrides_config_and_blank_values_fall_back() {
        assert_eq!(
            resolve_typesafe_api_key(Some("toml-key".into()), Some("environment-key".into())),
            Some("environment-key".into())
        );
        assert_eq!(
            resolve_typesafe_api_key(Some("toml-key".into()), None),
            Some("toml-key".into())
        );
        assert_eq!(
            resolve_typesafe_api_key(Some("toml-key".into()), Some(" \t".into())),
            Some("toml-key".into())
        );
        assert_eq!(
            resolve_typesafe_api_key(None, Some("environment-key".into())),
            Some("environment-key".into())
        );
        assert_eq!(resolve_typesafe_api_key(None, Some(" ".into())), None);
    }

    #[test]
    fn step_harness_selects_its_builtin_provider_when_provider_is_unset() {
        let profiles = BTreeMap::new();
        for (harness, provider) in [
            (StepHarness::Claude, ProviderId::anthropic()),
            (StepHarness::Codex, ProviderId::openai()),
            (StepHarness::Typesafe, ProviderId::typesafe()),
        ] {
            let resolved = resolve_provider(Some(harness), &AgentConfig::default(), &profiles)
                .expect("built-in selection");
            assert_eq!((resolved.id, resolved.harness), (provider, harness));
        }
        let resolved = resolve_provider(None, &AgentConfig::default(), &profiles).unwrap();
        assert_eq!(resolved.id, ProviderId::anthropic());
        assert_eq!(resolved.harness, StepHarness::Claude);

        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            typesafe_api_key: Some("typesafe-secret".into()),
            typesafe_base_url: Some("https://typesafe.example.test".into()),
            ..HarnessFactoryConfig::default()
        });
        let instance = factory
            .create_for_harness(
                Some(StepHarness::Typesafe),
                HarnessRuntimeOptions {
                    agent_config: AgentConfig::default(),
                    request_config: RequestConfig::default(),
                },
            )
            .expect("the explicit TypeSafe step harness should be constructed");
        assert_eq!(instance.provider, ProviderId::typesafe());
        assert_eq!(instance.harness, StepHarness::Typesafe);
        assert_eq!(
            instance.request_config.model.as_deref(),
            Some(vertebrae_core::DEFAULT_TYPESAFE_MODEL)
        );
    }

    fn custom_id(id: &str) -> ProviderId {
        ProviderId::new(id).unwrap()
    }

    fn custom_profile(harness: StepHarness, models: &[&str]) -> ProviderProfile {
        ProviderProfile {
            models: models.iter().map(|model| model.to_string()).collect(),
            ..ProviderProfile::new(harness)
        }
    }

    fn custom_factory(
        profiles: impl IntoIterator<Item = (&'static str, ProviderProfile)>,
    ) -> HarnessRuntimeFactory {
        HarnessRuntimeFactory::new(HarnessFactoryConfig {
            anthropic_executable: Some(executable()),
            openai_executable: Some(executable()),
            search_path: Some(OsString::new()),
            provider_profiles: profiles
                .into_iter()
                .map(|(id, profile)| (custom_id(id), profile))
                .collect(),
            ..HarnessFactoryConfig::default()
        })
    }

    fn create_error(
        factory: &HarnessRuntimeFactory,
        harness: Option<StepHarness>,
        agent_config: AgentConfig,
    ) -> HarnessError {
        match factory.create_for_harness(
            harness,
            HarnessRuntimeOptions {
                agent_config,
                request_config: RequestConfig::default(),
            },
        ) {
            Err(error) => error,
            Ok(_) => panic!("runtime construction must fail"),
        }
    }

    #[test]
    fn custom_provider_runs_on_its_configured_harness_with_listed_models_only() {
        let factory = custom_factory([
            (
                "openrouter",
                custom_profile(StepHarness::Claude, &["moonshotai/kimi-k2", "z-ai/glm-5"]),
            ),
            (
                "local",
                custom_profile(StepHarness::Codex, &["qwen3-coder"]),
            ),
        ]);

        let claude = factory
            .create(HarnessRuntimeOptions {
                agent_config: AgentConfig::new()
                    .with_provider(custom_id("openrouter"))
                    .with_model("z-ai/glm-5"),
                request_config: RequestConfig::default(),
            })
            .expect("custom Claude provider");
        assert_eq!(claude.provider, custom_id("openrouter"));
        assert_eq!(claude.harness, StepHarness::Claude);
        assert_eq!(claude.request_config.model.as_deref(), Some("z-ai/glm-5"));

        let codex = factory
            .create_for_harness(
                Some(StepHarness::Codex),
                HarnessRuntimeOptions {
                    agent_config: AgentConfig::new()
                        .with_provider(custom_id("local"))
                        .with_reasoning_effort("high"),
                    request_config: RequestConfig::default(),
                },
            )
            .expect("custom Codex provider");
        assert_eq!(codex.harness, StepHarness::Codex);
        assert_eq!(codex.request_config.model.as_deref(), Some("qwen3-coder"));
        assert_eq!(
            codex.request_config.reasoning_effort.as_deref(),
            Some("high")
        );
    }

    #[test]
    fn custom_provider_failures_are_descriptive() {
        let factory = custom_factory([(
            "openrouter",
            custom_profile(StepHarness::Claude, &["moonshotai/kimi-k2"]),
        )]);

        let unknown = create_error(
            &factory,
            None,
            AgentConfig::new().with_provider(custom_id("bedrock")),
        );
        assert!(
            unknown
                .to_string()
                .contains("provider 'bedrock' is not configured on this machine"),
            "{unknown}"
        );

        let mismatch = create_error(
            &factory,
            Some(StepHarness::Codex),
            AgentConfig::new().with_provider(custom_id("openrouter")),
        );
        assert!(
            mismatch.to_string().contains(
                "step harness 'codex' conflicts with agent_config.provider 'openrouter', which runs on the 'claude' harness"
            ),
            "{mismatch}"
        );

        let model = create_error(
            &factory,
            None,
            AgentConfig::new()
                .with_provider(custom_id("openrouter"))
                .with_model("claude-sonnet-5-5"),
        );
        assert!(
            model
                .to_string()
                .contains("model 'claude-sonnet-5-5' is not configured for provider 'openrouter'"),
            "{model}"
        );

        let effort = create_error(
            &factory,
            None,
            AgentConfig::new()
                .with_provider(custom_id("openrouter"))
                .with_reasoning_effort("high"),
        );
        assert!(effort.to_string().contains("codex harness"), "{effort}");
    }

    #[test]
    fn custom_provider_missing_credential_environment_is_unavailable() {
        let factory = custom_factory([(
            "openrouter",
            ProviderProfile {
                api_key_env: Some("VTB_TEST_UNSET_PROVIDER_KEY_7F3A".into()),
                ..custom_profile(StepHarness::Claude, &["kimi-k2"])
            },
        )]);
        let error = create_error(
            &factory,
            None,
            AgentConfig::new().with_provider(custom_id("openrouter")),
        );
        assert!(matches!(error, HarnessError::Unavailable(_)));
        assert!(
            error
                .to_string()
                .contains("VTB_TEST_UNSET_PROVIDER_KEY_7F3A"),
            "{error}"
        );
    }

    #[test]
    fn custom_typesafe_provider_uses_profile_credentials_instead_of_typesafe_section() {
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            environment: BTreeMap::from([(
                "CUSTOM_TYPESAFE_API_KEY".to_string(),
                "profile-secret".to_string(),
            )]),
            provider_profiles: BTreeMap::from([(
                custom_id("staging"),
                ProviderProfile {
                    url: Some("https://staging.typesafe.test/v1/systemone".into()),
                    api_key_env: Some("CUSTOM_TYPESAFE_API_KEY".into()),
                    api_key: Some("literal-profile-secret".into()),
                    ..custom_profile(StepHarness::Typesafe, &["jev-staging"])
                },
            )]),
            ..HarnessFactoryConfig::default()
        });

        let instance = factory
            .create(HarnessRuntimeOptions {
                agent_config: AgentConfig::new().with_provider(custom_id("staging")),
                request_config: RequestConfig::default(),
            })
            .expect("the profile credential replaces the missing [typesafe] key");
        assert_eq!(instance.harness, StepHarness::Typesafe);
        assert_eq!(
            instance.request_config.model.as_deref(),
            Some("jev-staging")
        );

        let builtin = create_error(
            &factory,
            None,
            AgentConfig::new().with_provider(ProviderId::typesafe()),
        );
        assert!(
            builtin.to_string().contains("[typesafe].api_key"),
            "the built-in provider keeps using the [typesafe] section: {builtin}"
        );
        let debug = format!("{:?}", factory.config);
        assert!(!debug.contains("profile-secret"), "{debug}");
        assert!(!debug.contains("staging.typesafe.test"), "{debug}");
    }

    #[test]
    fn custom_provider_process_launch_uses_adapter_translation() {
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            provider_profiles: BTreeMap::from([
                (
                    custom_id("openrouter"),
                    ProviderProfile {
                        base_url: Some("https://openrouter.ai/api".into()),
                        api_key: Some("claude-profile-secret".into()),
                        default_model: Some("z-ai/glm-5".into()),
                        ..custom_profile(StepHarness::Claude, &["kimi-k2", "z-ai/glm-5"])
                    },
                ),
                (
                    custom_id("local"),
                    ProviderProfile {
                        base_url: Some("http://localhost:8080/v1".into()),
                        ..custom_profile(StepHarness::Codex, &["qwen3-coder"])
                    },
                ),
            ]),
            ..HarnessFactoryConfig::default()
        });

        let claude = factory
            .custom_provider_process_launch(&custom_id("openrouter"))
            .unwrap();
        assert_eq!(claude.model, "z-ai/glm-5");
        assert_eq!(
            claude
                .environment
                .get("ANTHROPIC_AUTH_TOKEN")
                .map(String::as_str),
            Some("claude-profile-secret")
        );
        assert!(!format!("{claude:?}").contains("claude-profile-secret"));

        let codex = factory
            .custom_provider_process_launch(&custom_id("local"))
            .unwrap();
        assert_eq!(codex.model, "qwen3-coder");
        assert!(codex.args.contains(&"model_provider=\"local\"".to_string()));
        assert!(
            codex.args.contains(
                &"model_providers.local.base_url=\"http://localhost:8080/v1\"".to_string()
            )
        );
        assert!(
            factory
                .custom_provider_process_launch(&ProviderId::anthropic())
                .is_err()
        );
    }

    #[test]
    fn custom_provider_cannot_be_combined_with_codex_model_provider() {
        let factory = custom_factory([("local", custom_profile(StepHarness::Codex, &["qwen"]))]);
        let error = create_error(
            &factory,
            None,
            AgentConfig::new()
                .with_provider(custom_id("local"))
                .with_codex_model_provider("openrouter"),
        );
        assert!(
            error.to_string().contains("codex_model_provider"),
            "{error}"
        );
    }

    #[test]
    fn explicit_harness_mismatch_and_unavailability_fail_without_fallback() {
        let factory = HarnessRuntimeFactory::new(HarnessFactoryConfig {
            search_path: Some(OsString::new()),
            ..HarnessFactoryConfig::default()
        });
        let mismatch = match factory.create_for_harness(
            Some(StepHarness::Codex),
            HarnessRuntimeOptions {
                agent_config: AgentConfig::new().with_provider(ProviderId::anthropic()),
                request_config: RequestConfig::default(),
            },
        ) {
            Err(error) => error,
            Ok(_) => panic!("a conflicting agent_config.provider must fail"),
        };
        assert!(
            mismatch
                .to_string()
                .contains("step harness 'codex' conflicts")
        );

        let unavailable = match factory.create_for_harness(
            Some(StepHarness::Codex),
            HarnessRuntimeOptions {
                agent_config: AgentConfig::default(),
                request_config: RequestConfig::default(),
            },
        ) {
            Err(error) => error,
            Ok(_) => panic!("Codex must not silently fall back when unavailable"),
        };
        assert!(matches!(unavailable, HarnessError::Unavailable(_)));
        assert!(
            unavailable
                .to_string()
                .contains("selected 'codex' harness is unavailable")
        );
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
                    .with_provider(ProviderId::anthropic())
                    .with_model("sonnet"),
                request_config: RequestConfig::default(),
            })
            .expect("Claude runtime should be selected");
        assert_eq!(claude.provider, ProviderId::anthropic());
        assert_eq!(claude.request_config.model.as_deref(), Some("sonnet"));

        let codex = factory
            .create(HarnessRuntimeOptions {
                agent_config: AgentConfig::new()
                    .with_provider(ProviderId::openai())
                    .with_model("gpt-5.5")
                    .with_reasoning_effort(" HIGH "),
                request_config: RequestConfig::default(),
            })
            .expect("Codex runtime should be selected");
        assert_eq!(codex.provider, ProviderId::openai());
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
                    .with_provider(ProviderId::anthropic())
                    .with_model("fable"),
                request_config: RequestConfig::default(),
            })
            .expect("Fable should be accepted by the Anthropic harness");

        assert_eq!(claude.provider, ProviderId::anthropic());
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
                    .with_provider(ProviderId::openai())
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
                .with_provider(ProviderId::anthropic())
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
            agent_config: AgentConfig::new().with_provider(ProviderId::openai()),
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
                .with_provider(ProviderId::anthropic())
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
            agent_config: AgentConfig::new().with_provider(ProviderId::typesafe()),
            request_config: RequestConfig::default(),
        });
        let instance = instance.expect("TypeSafe runtime should be selected");
        assert_eq!(instance.provider, ProviderId::typesafe());
        assert_eq!(
            instance.request_config.model.as_deref(),
            Some(vertebrae_core::DEFAULT_TYPESAFE_MODEL)
        );
    }

    #[test]
    fn typesafe_base_url_override_takes_precedence_over_configured_full_url() {
        let config = HarnessFactoryConfig {
            typesafe_api_key: Some("typesafe-secret".into()),
            typesafe_base_url: Some("https://typesafe.example.test".into()),
            typesafe_url: Some("not a valid URL".into()),
            ..HarnessFactoryConfig::default()
        };

        let instance = HarnessRuntimeFactory::new(config).create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new().with_provider(ProviderId::typesafe()),
            request_config: RequestConfig::default(),
        });

        assert!(
            instance.is_ok(),
            "the legacy base URL override should be used instead of the configured full URL"
        );
    }

    #[test]
    fn missing_typesafe_api_key_is_unavailable_without_cli_lookup() {
        let result = HarnessRuntimeFactory::new(HarnessFactoryConfig::default()).create(
            HarnessRuntimeOptions {
                agent_config: AgentConfig::new().with_provider(ProviderId::typesafe()),
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
                .with_provider(ProviderId::typesafe())
                .with_tools(vec!["Bash".into()]),
            request_config: RequestConfig::default(),
        });
        assert!(matches!(
            result,
            Err(HarnessError::InvalidRequest(message)) if message.contains("AgentConfig.tools")
        ));

        let result = factory.create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new().with_provider(ProviderId::typesafe()),
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
            agent_config: AgentConfig::new().with_provider(ProviderId::typesafe()),
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
