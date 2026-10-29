use std::collections::{BTreeMap, HashMap};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use tokio::sync::RwLock;
use vertebrae_core::{BuiltinProvider, ProviderId, ProviderProfile, StepHarness};

use crate::local_chat::annotations::validate_session_id;
use crate::local_chat::harnesses::claude::{ClaudeLocalChatHarness, ClaudeStartupCapabilities};
use crate::local_chat::harnesses::codex::CodexLocalChatHarness;
use crate::local_chat::permissions::{
    LocalPermissionDecision, PermissionBridge, PermissionBridgeError,
};
use crate::local_chat::worktree_delta::{resolve_recording_worktree, RecorderConfig, RecordingTap};
use crate::local_chat::{
    CreateLocalChatSessionInput, LocalChatAnnotationStore, LocalChatHarness,
    LocalChatHarnessCatalog, LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatModelOption,
    LocalChatProviderInfo, LocalChatProviderSelection, LocalChatRuntime, LocalChatSessionError,
};

pub struct LocalChatSessionManager {
    harnesses: HashMap<LocalChatHarnessKind, Arc<dyn LocalChatHarness>>,
    session_registry: RwLock<HashMap<String, LocalChatHarnessKind>>,
    lifecycle_gate: RwLock<()>,
    permission_bridge: PermissionBridge,
    shutdown_started: AtomicBool,
    provider_profiles: BTreeMap<ProviderId, ProviderProfile>,
    provider_config_path: Option<std::path::PathBuf>,
    annotation_store: Option<LocalChatAnnotationStore>,
    recorder_config: RecorderConfig,
    recordings: std::sync::Mutex<HashMap<String, RuntimeRecording>>,
}

/// What the manager knows about a live runtime beyond its harness: the
/// persistent chat session it serves and its worktree recorder.
struct RuntimeRecording {
    chat_session_id: String,
    project_root: Option<String>,
    tap: RecordingTap,
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
        manager.provider_config_path = vertebrae_sacrum_client::config_path();
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

    /// Run a per-request operation against one locked file snapshot. Active
    /// harness sessions retain their existing owned provider configuration.
    pub(crate) async fn with_provider_profiles<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&BTreeMap<ProviderId, ProviderProfile>) -> Result<T, LocalChatSessionError>
            + Send
            + 'static,
    ) -> Result<T, LocalChatSessionError> {
        let path = self.provider_config_path.clone();
        let fixed = self.provider_profiles.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(path) = path {
                let snapshot = vertebrae_sacrum_client::config::lock_config_snapshot_at(&path)
                    .map_err(|_| {
                        LocalChatSessionError::StartFailed(
                            "Could not read provider settings. Check config.toml and retry.".into(),
                        )
                    })?;
                operation(&snapshot.config().providers)
            } else {
                operation(&fixed)
            }
        })
        .await
        .map_err(|_| {
            LocalChatSessionError::StartFailed("Could not load provider settings.".into())
        })?
    }

    #[cfg(test)]
    fn with_provider_config_path_for_tests(mut self, path: std::path::PathBuf) -> Self {
        self.provider_config_path = Some(path);
        self
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
            provider_config_path: None,
            annotation_store: None,
            recorder_config: RecorderConfig::default(),
            recordings: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Store that worktree recorders append their annotations to; without
    /// one, recording stays off.
    pub(crate) fn with_annotation_store(mut self, store: LocalChatAnnotationStore) -> Self {
        self.annotation_store = Some(store);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_recorder_config_for_tests(mut self, config: RecorderConfig) -> Self {
        self.recorder_config = config;
        self
    }

    pub async fn catalog(&self) -> Result<LocalChatHarnessCatalog, LocalChatSessionError> {
        let profiles = self
            .with_provider_profiles(|profiles| Ok(profiles.clone()))
            .await?;
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

        let providers = provider_catalog(&harnesses, &profiles);
        let default_provider = providers
            .iter()
            .find(|provider| !provider.custom && provider.harness == default_harness)
            .map(|provider| provider.id.clone())
            .unwrap_or_else(|| BuiltinProvider::Anthropic.as_str().to_string());

        Ok(LocalChatHarnessCatalog {
            default_harness,
            harnesses,
            default_provider,
            providers,
        })
    }

    /// Resolve the picker's provider for a session on `harness`. Built-in IDs
    /// (or none) use the harness's own provider; custom IDs must be valid
    /// profiles bound to the same harness.
    async fn provider_selection(
        &self,
        harness: LocalChatHarnessKind,
        provider_id: Option<&str>,
    ) -> Result<Option<LocalChatProviderSelection>, LocalChatSessionError> {
        let provider_id = provider_id.map(str::to_owned);
        self.with_provider_profiles(move |profiles| {
            Self::provider_selection_from_profiles(profiles, harness, provider_id.as_deref())
        })
        .await
    }

    fn provider_selection_from_profiles(
        profiles: &BTreeMap<ProviderId, ProviderProfile>,
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
        let profile = profiles.get(&id).ok_or_else(|| {
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
        let mut profile = profile.clone();
        if profile.api_key_secret.is_some() {
            let agent = vertebrae_core::AgentConfig::new().with_provider(id.clone());
            let mut factory = vertebrae_harness::HarnessFactoryConfig {
                environment: crate::shell_environment::user_shell_environment().variables,
                provider_profiles: BTreeMap::from([(id.clone(), profile)]),
                ..Default::default()
            };
            factory
                .resolve_request_credentials(Some(expected), &agent)
                .map_err(|error| LocalChatSessionError::StartFailed(error.to_string()))?;
            profile = factory.provider_profiles.remove(&id).ok_or_else(|| {
                LocalChatSessionError::StartFailed(
                    "Provider settings changed during selection.".into(),
                )
            })?;
        }
        Ok(Some(LocalChatProviderSelection { id, profile }))
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
        validate_session_id(&input.chat_session_id).map_err(|_| {
            LocalChatSessionError::InvalidChatSessionId(input.chat_session_id.clone())
        })?;
        let provider = self
            .provider_selection(harness_kind, input.provider_id.as_deref())
            .await?;
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

        // Bound before the harness starts: the initial turn may already
        // submit the gate's resolution, or run tools worth recording.
        let permission_bridge = runtime.permission_bridge();
        if let Some(gate) = &input.gate {
            permission_bridge.bind_gate(&backend_session_id, gate.clone());
        }
        let tap = runtime.recording();
        self.lock_recordings().insert(
            backend_session_id.clone(),
            RuntimeRecording {
                chat_session_id: input.chat_session_id.clone(),
                project_root: input.working_dir.clone(),
                tap: tap.clone(),
            },
        );
        if let Some(worktree) = input.recording_worktree.clone() {
            if let Err(error) = self
                .apply_recording_worktree(&backend_session_id, Some(worktree))
                .await
            {
                log::warn!(
                    "[LOCAL_CHAT] recording stays off for session {backend_session_id}: {error}"
                );
            }
        }
        match harness
            .create_session(input.into_harness_input(provider), runtime)
            .await
        {
            Ok(()) => Ok(()),
            Err(err) => {
                permission_bridge.unbind_gate(&backend_session_id);
                self.remove_registry_entry(&backend_session_id, harness_kind)
                    .await;
                Err(err)
            }
        }
    }

    fn lock_recordings(&self) -> std::sync::MutexGuard<'_, HashMap<String, RuntimeRecording>> {
        self.recordings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Set, replace or clear the worktree a live runtime records into. A
    /// changed target stops the old recorder (dropping its open windows) and
    /// starts a fresh one; an invalid target leaves recording off.
    pub async fn set_recording_worktree(
        &self,
        backend_session_id: &str,
        worktree_path: Option<String>,
    ) -> Result<(), LocalChatSessionError> {
        let _lifecycle = self.lifecycle_gate.read().await;
        self.registry_harness(backend_session_id).await?;
        self.apply_recording_worktree(backend_session_id, worktree_path)
            .await
            .inspect_err(|error| {
                log::warn!(
                    "[LOCAL_CHAT] recording stopped for session {backend_session_id}: {error}"
                );
            })
    }

    async fn apply_recording_worktree(
        &self,
        backend_session_id: &str,
        worktree_path: Option<String>,
    ) -> Result<(), LocalChatSessionError> {
        let (chat_session_id, project_root, tap) = {
            let recordings = self.lock_recordings();
            let recording = recordings.get(backend_session_id).ok_or_else(|| {
                LocalChatSessionError::SessionNotFound(backend_session_id.to_string())
            })?;
            (
                recording.chat_session_id.clone(),
                recording.project_root.clone(),
                recording.tap.clone(),
            )
        };
        let Some(worktree_path) = worktree_path else {
            log::info!("[LOCAL_CHAT] recording cleared for session {backend_session_id}");
            tap.stop();
            return Ok(());
        };
        let resolved = tokio::task::spawn_blocking(move || {
            resolve_recording_worktree(project_root.as_deref(), &worktree_path)
        })
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
        let worktree = match resolved {
            Ok(worktree) => worktree,
            Err(error) => {
                log::warn!(
                    "[LOCAL_CHAT] recording target rejected for session {backend_session_id}: {error}"
                );
                tap.stop();
                return Err(LocalChatSessionError::InvalidRecordingWorktree(error));
            }
        };
        if tap.worktree().as_ref() == Some(&worktree) {
            log::info!(
                "[LOCAL_CHAT] recording already targets {} for session {backend_session_id}",
                worktree.display()
            );
            return Ok(());
        }
        let Some(store) = self.annotation_store.clone() else {
            log::warn!("[LOCAL_CHAT] no annotation store; worktree recording is off");
            return Ok(());
        };
        // A runtime closed while the target was resolving stays stopped.
        if !self.lock_recordings().contains_key(backend_session_id) {
            log::info!("[LOCAL_CHAT] runtime {backend_session_id} closed before recording started");
            return Ok(());
        }
        log::info!(
            "[LOCAL_CHAT] recording started for session {backend_session_id} (chat {chat_session_id}) in {}",
            worktree.display()
        );
        tap.start(chat_session_id, worktree, store, self.recorder_config);
        Ok(())
    }

    fn stop_recording(&self, backend_session_id: &str) {
        if let Some(recording) = self.lock_recordings().remove(backend_session_id) {
            recording.tap.stop();
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

    /// Rebind a live gate chat and deliver a hidden protocol refresh turn.
    /// Returns whether a turn was sent: a refresh for the execution the chat
    /// is already bound to sends nothing, so duplicate realtime updates
    /// inject one turn.
    pub async fn refresh_gate(
        &self,
        backend_session_id: &str,
        gate: crate::local_chat::LocalChatGateBinding,
    ) -> Result<bool, LocalChatSessionError> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let harness_kind = self.registry_harness(backend_session_id).await?;
        self.harness(harness_kind)?;
        if !self
            .permission_bridge
            .rebind_gate(backend_session_id, gate.clone())
        {
            return Ok(false);
        }
        self.send_message(
            backend_session_id,
            &crate::local_chat::gate::gate_refresh_turn(&gate),
        )
        .await?;
        Ok(true)
    }

    pub async fn compact_session(
        &self,
        backend_session_id: &str,
    ) -> Result<(), LocalChatSessionError> {
        let harness_kind = self.registry_harness(backend_session_id).await?;
        let harness = self.harness(harness_kind)?;
        let result = harness.compact_session(backend_session_id).await;
        if result.is_err() && !harness.has_session(backend_session_id).await {
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

    /// Persistent chat session ids that currently own a registered runtime.
    pub(crate) async fn live_chat_session_ids(&self) -> std::collections::HashSet<String> {
        let registry = self.session_registry.read().await;
        self.lock_recordings()
            .iter()
            .filter(|(backend_session_id, _)| registry.contains_key(*backend_session_id))
            .map(|(_, recording)| recording.chat_session_id.clone())
            .collect()
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
            self.permission_bridge.unbind_gate(session_id);
        }
        for (_, recording) in self.lock_recordings().drain() {
            recording.tap.stop();
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
            self.permission_bridge.unbind_gate(backend_session_id);
            self.stop_recording(backend_session_id);
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
        StepHarness::Typesafe | StepHarness::MistralVibe => None,
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
