use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;
use vertebrae_core::{AgentConfig, ProviderId, ProviderProfile};
use vertebrae_harness::HarnessFactoryConfig;

use crate::local_chat::events::LocalChatEventSink;
use crate::local_chat::permissions::PermissionBridge;
use crate::types::PermissionMode;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "snake_case")]
pub enum LocalChatHarnessKind {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatModelOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    #[specta(optional)]
    pub supported_reasoning_effort_ids: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub supported_speed_tier_ids: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub supports_personality: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatSpeedTierOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatReasoningEffortOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatPermissionModeOption {
    pub id: PermissionMode,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatPersonalityOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatHarnessInfo {
    pub harness: LocalChatHarnessKind,
    pub label: String,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub default_model_id: Option<String>,
    pub models: Vec<LocalChatModelOption>,
    pub default_reasoning_effort: Option<String>,
    pub reasoning_efforts: Vec<LocalChatReasoningEffortOption>,
    #[serde(default)]
    #[specta(optional)]
    pub speed_tiers: Vec<LocalChatSpeedTierOption>,
    #[serde(default)]
    #[specta(optional)]
    pub permission_modes: Option<Vec<LocalChatPermissionModeOption>>,
    #[serde(default)]
    #[specta(optional)]
    pub personality_options: Option<Vec<LocalChatPersonalityOption>>,
    pub supports_resume: bool,
}

/// A provider choice in the local chat picker. Built-in providers reuse their
/// harness's model catalog; custom providers list exactly their configured
/// models.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatProviderInfo {
    pub id: String,
    pub label: String,
    pub harness: LocalChatHarnessKind,
    pub custom: bool,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    /// `None` means "use the harness's model catalog".
    pub models: Option<Vec<LocalChatModelOption>>,
    pub default_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct LocalChatHarnessCatalog {
    pub default_harness: LocalChatHarnessKind,
    pub harnesses: Vec<LocalChatHarnessInfo>,
    pub default_provider: String,
    pub providers: Vec<LocalChatProviderInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct CreateLocalChatSessionInput {
    pub harness: LocalChatHarnessKind,
    pub backend_session_id: String,
    pub working_dir: Option<String>,
    pub initial_prompt: Option<String>,
    pub provider_resume_id: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub speed_tier: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub personality: Option<String>,
    /// Provider ID selected in the picker. Absent or built-in IDs use the
    /// harness's built-in provider; custom IDs must be configured in
    /// config.toml for `harness`.
    #[serde(default)]
    #[specta(optional)]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalChatProviderSelection {
    pub(crate) id: ProviderId,
    pub(crate) profile: ProviderProfile,
}

impl LocalChatProviderSelection {
    pub(crate) fn apply(
        &self,
        factory_config: &mut HarnessFactoryConfig,
        agent_config: &mut AgentConfig,
    ) {
        agent_config.provider = Some(self.id.clone());
        factory_config
            .provider_profiles
            .insert(self.id.clone(), self.profile.clone());
    }

    /// Use the requested model when the provider lists it; otherwise fall
    /// back to the provider's default model with a warning.
    pub(crate) fn resolve_model(&self, requested: Option<&str>) -> (String, Option<String>) {
        let fallback = || {
            self.profile
                .resolve_model(&self.id, None)
                .expect("validated custom providers list at least one model")
        };
        match requested.map(str::trim).filter(|model| !model.is_empty()) {
            None => (fallback(), None),
            Some(model) => match self.profile.resolve_model(&self.id, Some(model)) {
                Ok(model) => (model, None),
                Err(_) => {
                    let fallback = fallback();
                    let warning = format!(
                        "Model '{}' is not configured for provider '{}'; using '{}'.",
                        model.escape_default(),
                        self.id,
                        fallback
                    );
                    (fallback, Some(warning))
                }
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HarnessCreateSessionInput {
    pub(crate) backend_session_id: String,
    pub(crate) working_dir: Option<String>,
    pub(crate) initial_prompt: Option<String>,
    pub(crate) provider_resume_id: Option<String>,
    pub(crate) model_id: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) speed_tier: Option<String>,
    pub(crate) permission_mode: Option<PermissionMode>,
    pub(crate) personality: Option<String>,
    pub(crate) provider: Option<LocalChatProviderSelection>,
}

impl CreateLocalChatSessionInput {
    pub(crate) fn into_harness_input(
        self,
        provider: Option<LocalChatProviderSelection>,
    ) -> HarnessCreateSessionInput {
        HarnessCreateSessionInput {
            backend_session_id: self.backend_session_id,
            working_dir: self.working_dir,
            initial_prompt: self.initial_prompt,
            provider_resume_id: self.provider_resume_id,
            model_id: self.model_id,
            reasoning_effort: self.reasoning_effort,
            speed_tier: self.speed_tier,
            permission_mode: self.permission_mode,
            personality: self.personality,
            provider,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, thiserror::Error, PartialEq, Eq)]
pub enum LocalChatSessionError {
    #[error("Session already exists: {0}")]
    SessionExists(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Failed to send message: {0}")]
    SendFailed(String),
    #[error("Failed to spawn local chat session: {0}")]
    SpawnFailed(String),
    #[error("Failed to start local chat session: {0}")]
    StartFailed(String),
    #[error("Local chat harness is unavailable: {harness:?}")]
    UnavailableHarness {
        harness: LocalChatHarnessKind,
        reason: Option<String>,
    },
    #[error("Unsupported local chat harness: {0:?}")]
    UnsupportedHarness(LocalChatHarnessKind),
}

#[derive(Clone)]
pub(crate) struct LocalChatRuntime {
    app_handle: Option<tauri::AppHandle>,
    event_sink: LocalChatEventSink,
    permission_bridge: PermissionBridge,
}

impl LocalChatRuntime {
    pub(crate) fn new(app_handle: tauri::AppHandle, permission_bridge: PermissionBridge) -> Self {
        Self {
            app_handle: Some(app_handle.clone()),
            event_sink: LocalChatEventSink::tauri(app_handle),
            permission_bridge,
        }
    }

    #[cfg(test)]
    pub(crate) fn inert_for_tests() -> Self {
        Self {
            app_handle: None,
            event_sink: LocalChatEventSink::inert_for_tests(),
            permission_bridge: PermissionBridge::new(),
        }
    }

    pub(crate) fn app_handle(&self) -> Option<tauri::AppHandle> {
        self.app_handle.clone()
    }

    pub(crate) fn event_sink(&self) -> LocalChatEventSink {
        self.event_sink.clone()
    }

    #[cfg(test)]
    pub(crate) fn capturing_for_tests() -> (
        Self,
        std::sync::Arc<std::sync::Mutex<Vec<crate::local_chat::LocalChatEvent>>>,
    ) {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        (
            Self {
                app_handle: None,
                event_sink,
                permission_bridge: PermissionBridge::new(),
            },
            events,
        )
    }

    pub(crate) fn permission_bridge(&self) -> PermissionBridge {
        self.permission_bridge.clone()
    }
}

#[async_trait]
pub(crate) trait LocalChatHarness: Send + Sync {
    fn kind(&self) -> LocalChatHarnessKind;

    async fn info(&self) -> LocalChatHarnessInfo;

    async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError>;

    async fn send_message(
        &self,
        backend_session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError>;

    async fn close_session(&self, backend_session_id: &str) -> Result<(), LocalChatSessionError>;

    async fn has_session(&self, backend_session_id: &str) -> bool;
}
