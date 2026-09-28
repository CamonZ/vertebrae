use std::collections::{BTreeMap, HashMap};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use tokio::sync::RwLock;
use vertebrae_core::{BuiltinProvider, ProviderId, ProviderProfile, StepHarness};

use crate::local_chat::harnesses::claude::{ClaudeLocalChatHarness, ClaudeStartupCapabilities};
use crate::local_chat::harnesses::codex::CodexLocalChatHarness;
use crate::local_chat::permissions::{
    LocalPermissionDecision, PermissionBridge, PermissionBridgeError,
};
use crate::local_chat::{
    CreateLocalChatSessionInput, LocalChatHarness, LocalChatHarnessCatalog, LocalChatHarnessInfo,
    LocalChatHarnessKind, LocalChatModelOption, LocalChatProviderInfo, LocalChatProviderSelection,
    LocalChatRuntime, LocalChatSessionError,
};

pub struct LocalChatSessionManager {
    harnesses: HashMap<LocalChatHarnessKind, Arc<dyn LocalChatHarness>>,
    session_registry: RwLock<HashMap<String, LocalChatHarnessKind>>,
    lifecycle_gate: RwLock<()>,
    permission_bridge: PermissionBridge,
    shutdown_started: AtomicBool,
    /// Custom `[providers.<id>]` profiles loaded from config.toml at startup.
    provider_profiles: BTreeMap<ProviderId, ProviderProfile>,
}

const LOCAL_CHAT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct ProjectSwitchGuard<'a> {
    _lifecycle: tokio::sync::RwLockWriteGuard<'a, ()>,
}

impl LocalChatSessionManager {
    pub fn new() -> Self {
        Self::with_harnesses_and_permission_bridge(
            vec![
                Arc::new(ClaudeLocalChatHarness::new()),
                Arc::new(CodexLocalChatHarness::new()),
            ],
            PermissionBridge::new(),
        )
    }

    pub(crate) fn with_claude_startup_capabilities(
        startup_capabilities: ClaudeStartupCapabilities,
        provider_profiles: BTreeMap<ProviderId, ProviderProfile>,
    ) -> Self {
        let mut manager = Self::with_harnesses_and_permission_bridge(
            vec![
                Arc::new(ClaudeLocalChatHarness::with_startup_capabilities(
                    startup_capabilities.clone(),
                )),
                Arc::new(CodexLocalChatHarness::with_shell_environment(
                    startup_capabilities.shell_environment.clone(),
                )),
            ],
            PermissionBridge::new(),
        );
        manager.provider_profiles = provider_profiles;
        manager
    }

    #[cfg(test)]
    pub(crate) fn with_provider_profiles_for_tests(
        mut self,
        provider_profiles: BTreeMap<ProviderId, ProviderProfile>,
    ) -> Self {
        self.provider_profiles = provider_profiles;
        self
    }

    /// Custom provider profiles shared with title inference.
    pub(crate) fn provider_profiles(&self) -> &BTreeMap<ProviderId, ProviderProfile> {
        &self.provider_profiles
    }

    #[cfg(test)]
    pub(crate) fn with_harnesses_for_tests(harnesses: Vec<Arc<dyn LocalChatHarness>>) -> Self {
        Self::with_harnesses_and_permission_bridge(harnesses, PermissionBridge::new())
    }

    #[cfg(test)]
    pub(crate) fn with_permission_bridge_for_tests(permission_bridge: PermissionBridge) -> Self {
        Self::with_harnesses_and_permission_bridge(Vec::new(), permission_bridge)
    }

    fn with_harnesses_and_permission_bridge(
        harnesses: Vec<Arc<dyn LocalChatHarness>>,
        permission_bridge: PermissionBridge,
    ) -> Self {
        let harnesses = harnesses
            .into_iter()
            .map(|harness| (harness.kind(), harness))
            .collect();
        Self {
            harnesses,
            session_registry: RwLock::new(HashMap::new()),
            lifecycle_gate: RwLock::new(()),
            permission_bridge,
            shutdown_started: AtomicBool::new(false),
            provider_profiles: BTreeMap::new(),
        }
    }

    pub async fn catalog(&self) -> LocalChatHarnessCatalog {
        let mut harnesses = Vec::with_capacity(self.harnesses.len());
        for harness in self.harnesses.values() {
            harnesses.push(harness.info().await);
        }
        harnesses.sort_by_key(|info| info.harness);
        let default_harness = harnesses
            .iter()
            .find(|info| info.available)
            .map(|info| info.harness)
            .or_else(|| harnesses.first().map(|info| info.harness))
            .unwrap_or(LocalChatHarnessKind::Claude);

        let providers = provider_catalog(&harnesses, &self.provider_profiles);
        let default_provider = providers
            .iter()
            .find(|provider| !provider.custom && provider.harness == default_harness)
            .map(|provider| provider.id.clone())
            .unwrap_or_else(|| BuiltinProvider::Anthropic.as_str().to_string());

        LocalChatHarnessCatalog {
            default_harness,
            harnesses,
            default_provider,
            providers,
        }
    }

    /// Resolve the picker's provider for a session on `harness`. Built-in IDs
    /// (or none) use the harness's own provider; custom IDs must be valid
    /// profiles bound to the same harness.
    fn provider_selection(
        &self,
        harness: LocalChatHarnessKind,
        provider_id: Option<&str>,
    ) -> Result<Option<LocalChatProviderSelection>, LocalChatSessionError> {
        let Some(provider_id) = provider_id.map(str::trim).filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let id = ProviderId::new(provider_id).map_err(LocalChatSessionError::StartFailed)?;
        let expected = step_harness(harness);
        if let Some(builtin) = id.builtin() {
            if builtin.harness() != expected {
                return Err(LocalChatSessionError::StartFailed(format!(
                    "provider '{id}' does not run on the {expected} harness"
                )));
            }
            return Ok(None);
        }
        let profile = self.provider_profiles.get(&id).ok_or_else(|| {
            LocalChatSessionError::StartFailed(format!(
                "provider '{id}' is not configured; add [providers.{id}] to config.toml"
            ))
        })?;
        profile
            .validate(&id)
            .map_err(LocalChatSessionError::StartFailed)?;
        if profile.harness != expected {
            return Err(LocalChatSessionError::StartFailed(format!(
                "provider '{id}' is configured for the {} harness, not {expected}",
                profile.harness
            )));
        }
        Ok(Some(LocalChatProviderSelection {
            id,
            profile: profile.clone(),
        }))
    }

    pub async fn create_session(
        &self,
        input: CreateLocalChatSessionInput,
        app_handle: tauri::AppHandle,
    ) -> Result<(), LocalChatSessionError> {
        let runtime = LocalChatRuntime::new(app_handle, self.permission_bridge.clone());
        self.create_session_with_runtime(input, runtime).await
    }

    pub(crate) async fn create_session_with_runtime(
        &self,
        input: CreateLocalChatSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        let _lifecycle = self.lifecycle_gate.read().await;
        if self.shutdown_started.load(Ordering::Acquire) {
            return Err(LocalChatSessionError::StartFailed(
                "cannot create a local chat session while the application is shutting down".into(),
            ));
        }
        let harness_kind = input.harness;
        let backend_session_id = input.backend_session_id.clone();
        let provider = self.provider_selection(harness_kind, input.provider_id.as_deref())?;
        let harness = self.harness(harness_kind)?;
        let info = harness.info().await;
        if !info.available {
            return Err(LocalChatSessionError::UnavailableHarness {
                harness: harness_kind,
                reason: info.unavailable_reason,
            });
        }

        {
            let mut registry = self.session_registry.write().await;
            if registry.contains_key(&backend_session_id) {
                return Err(LocalChatSessionError::SessionExists(backend_session_id));
            }
            registry.insert(backend_session_id.clone(), harness_kind);
        }

        match harness
            .create_session(input.into_harness_input(provider), runtime)
            .await
        {
            Ok(()) => Ok(()),
            Err(err) => {
                self.remove_registry_entry(&backend_session_id, harness_kind)
                    .await;
                Err(err)
            }
        }
    }

    pub async fn send_message(
        &self,
        backend_session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let harness_kind = self.registry_harness(backend_session_id).await?;
        let harness = self.harness(harness_kind)?;
        let result = harness.send_message(backend_session_id, content).await;
        if matches!(result, Err(LocalChatSessionError::SessionNotFound(_))) {
            self.remove_registry_entry(backend_session_id, harness_kind)
                .await;
        }
        result
    }

    pub async fn close_session(
        &self,
        backend_session_id: &str,
    ) -> Result<(), LocalChatSessionError> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let harness_kind = self.registry_harness(backend_session_id).await?;
        let harness = self.harness(harness_kind)?;
        let result = harness.close_session(backend_session_id).await;
        self.remove_registry_entry(backend_session_id, harness_kind)
            .await;
        result
    }

    pub async fn has_session(&self, backend_session_id: &str) -> bool {
        let _lifecycle = self.lifecycle_gate.read().await;
        let Ok(harness_kind) = self.registry_harness(backend_session_id).await else {
            return false;
        };
        let Ok(harness) = self.harness(harness_kind) else {
            return false;
        };
        harness.has_session(backend_session_id).await
    }

    pub async fn close_all_sessions(&self) {
        self.close_all_sessions_with_reason(
            "Local chat session ended because its project is being changed",
        )
        .await;
    }

    pub(crate) async fn begin_project_switch(&self) -> ProjectSwitchGuard<'_> {
        let lifecycle = self.lifecycle_gate.write().await;
        self.close_all_sessions_locked(
            "Local chat session ended because its project is being changed",
        )
        .await;
        ProjectSwitchGuard {
            _lifecycle: lifecycle,
        }
    }

    async fn close_all_sessions_with_reason(&self, permission_message: &str) {
        let _lifecycle = self.lifecycle_gate.write().await;
        self.close_all_sessions_locked(permission_message).await;
    }

    async fn close_all_sessions_locked(&self, permission_message: &str) {
        let session_entries = self
            .session_registry
            .read()
            .await
            .iter()
            .map(|(session_id, harness)| (session_id.clone(), *harness))
            .collect::<Vec<_>>();
        let session_count = session_entries.len();

        if session_entries.is_empty() {
            log::debug!("[LOCAL_CHAT] close_all_sessions: no live sessions");
            return;
        }

        for (session_id, _) in &session_entries {
            self.permission_bridge
                .fail_pending_permissions_for_session(session_id, permission_message);
        }

        let results = futures::future::join_all(session_entries.into_iter().map(
            |(session_id, harness_kind)| async move {
                let Ok(harness) = self.harness(harness_kind) else {
                    log::error!(
                        "[LOCAL_CHAT] close_all_sessions cannot resolve harness {harness_kind:?} for session {session_id}"
                    );
                    return true;
                };
                match tokio::time::timeout(
                    LOCAL_CHAT_SHUTDOWN_TIMEOUT,
                    harness.close_session(&session_id),
                )
                .await
                {
                Ok(Ok(())) | Ok(Err(LocalChatSessionError::SessionNotFound(_))) => {
                    log::debug!(
                        "[LOCAL_CHAT] close_all_sessions closed session {session_id} via {harness_kind:?}"
                    );
                    false
                }
                Ok(Err(error)) => {
                    log::warn!(
                        "[LOCAL_CHAT] close_all_sessions failed for session {session_id} via {harness_kind:?}: {error}"
                    );
                    true
                }
                Err(_) => {
                    log::error!(
                        "[LOCAL_CHAT] close_all_sessions timed out closing session {session_id} via {harness_kind:?}"
                    );
                    true
                }
                }
            },
        ))
        .await;
        let failures = results.into_iter().filter(|failed| *failed).count();

        self.session_registry.write().await.clear();
        log::info!(
            "[LOCAL_CHAT] close_all_sessions finished: {} session(s), {} close failure(s)",
            session_count,
            failures
        );
    }

    /// Gracefully close all provider sessions before the Tauri process exits.
    ///
    /// Tauri can deliver more than one exit-related event while a shutdown is
    /// in progress, so this operation is intentionally idempotent.
    pub async fn shutdown(&self) {
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return;
        }
        self.close_all_sessions_with_reason(
            "Local chat session ended because the application is shutting down",
        )
        .await;
    }

    /// Resolve a permission request through the neutral permission bridge.
    pub(crate) fn resolve_permission_request(
        &self,
        request_id: &str,
        decision: LocalPermissionDecision,
    ) -> Result<serde_json::Value, PermissionBridgeError> {
        self.permission_bridge
            .resolve_permission_request(request_id, decision)
    }

    fn harness(
        &self,
        harness: LocalChatHarnessKind,
    ) -> Result<Arc<dyn LocalChatHarness>, LocalChatSessionError> {
        self.harnesses
            .get(&harness)
            .cloned()
            .ok_or(LocalChatSessionError::UnsupportedHarness(harness))
    }

    async fn registry_harness(
        &self,
        backend_session_id: &str,
    ) -> Result<LocalChatHarnessKind, LocalChatSessionError> {
        self.session_registry
            .read()
            .await
            .get(backend_session_id)
            .copied()
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(backend_session_id.to_string()))
    }

    async fn remove_registry_entry(
        &self,
        backend_session_id: &str,
        harness_kind: LocalChatHarnessKind,
    ) {
        let mut registry = self.session_registry.write().await;
        if registry
            .get(backend_session_id)
            .is_some_and(|registered| *registered == harness_kind)
        {
            registry.remove(backend_session_id);
        }
    }
}

impl Default for LocalChatSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests;

fn step_harness(harness: LocalChatHarnessKind) -> StepHarness {
    match harness {
        LocalChatHarnessKind::Claude => StepHarness::Claude,
        LocalChatHarnessKind::Codex => StepHarness::Codex,
    }
}

fn local_chat_harness(harness: StepHarness) -> Option<LocalChatHarnessKind> {
    match harness {
        StepHarness::Claude => Some(LocalChatHarnessKind::Claude),
        StepHarness::Codex => Some(LocalChatHarnessKind::Codex),
        StepHarness::Typesafe => None,
    }
}

/// Built-in Anthropic/OpenAI choices followed by custom Claude/Codex
/// providers. TypeSafe providers are step-only and never listed.
fn provider_catalog(
    harnesses: &[LocalChatHarnessInfo],
    profiles: &BTreeMap<ProviderId, ProviderProfile>,
) -> Vec<LocalChatProviderInfo> {
    let harness_info = |kind| harnesses.iter().find(|info| info.harness == kind);
    let mut providers = Vec::new();
    for (builtin, label) in [
        (BuiltinProvider::Anthropic, "Anthropic"),
        (BuiltinProvider::Openai, "OpenAI"),
    ] {
        let Some(kind) = local_chat_harness(builtin.harness()) else {
            continue;
        };
        let Some(info) = harness_info(kind) else {
            continue;
        };
        providers.push(LocalChatProviderInfo {
            id: builtin.as_str().to_string(),
            label: label.to_string(),
            harness: kind,
            custom: false,
            available: info.available,
            unavailable_reason: info.unavailable_reason.clone(),
            models: None,
            default_model_id: info.default_model_id.clone(),
        });
    }
    for (id, profile) in profiles {
        let Some(kind) = local_chat_harness(profile.harness) else {
            continue;
        };
        let harness = harness_info(kind);
        let (available, unavailable_reason) = match (profile.validate(id), harness) {
            (Err(error), _) => (false, Some(error)),
            (Ok(()), Some(info)) if !info.available => (false, info.unavailable_reason.clone()),
            (Ok(()), Some(_)) => (true, None),
            (Ok(()), None) => (
                false,
                Some(format!("{} harness is unavailable", profile.harness)),
            ),
        };
        let harness_speed_tiers = |model: &str| {
            harness
                .and_then(|info| info.models.iter().find(|option| option.id == model))
                .and_then(|option| option.supported_speed_tier_ids.clone())
        };
        providers.push(LocalChatProviderInfo {
            id: id.to_string(),
            label: id.to_string(),
            harness: kind,
            custom: true,
            available,
            unavailable_reason,
            models: Some(
                profile
                    .models
                    .iter()
                    .map(|model| LocalChatModelOption {
                        id: model.clone(),
                        label: model.clone(),
                        supported_reasoning_effort_ids: None,
                        supported_speed_tier_ids: harness_speed_tiers(model),
                        supports_personality: None,
                    })
                    .collect(),
            ),
            default_model_id: profile.resolve_model(id, None).ok(),
        });
    }
    providers
}
