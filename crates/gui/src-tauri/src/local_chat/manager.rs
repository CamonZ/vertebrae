use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use tokio::sync::RwLock;

use crate::local_chat::harnesses::claude::{ClaudeLocalChatHarness, ClaudeStartupCapabilities};
use crate::local_chat::harnesses::codex::CodexLocalChatHarness;
use crate::local_chat::permissions::{
    LocalPermissionDecision, PermissionBridge, PermissionBridgeError,
};
use crate::local_chat::{
    CreateLocalChatSessionInput, LocalChatHarness, LocalChatHarnessCatalog, LocalChatHarnessKind,
    LocalChatRuntime, LocalChatSessionError,
};

pub struct LocalChatSessionManager {
    harnesses: HashMap<LocalChatHarnessKind, Arc<dyn LocalChatHarness>>,
    session_registry: RwLock<HashMap<String, LocalChatHarnessKind>>,
    lifecycle_gate: RwLock<()>,
    permission_bridge: PermissionBridge,
    shutdown_started: AtomicBool,
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
    ) -> Self {
        Self::with_harnesses_and_permission_bridge(
            vec![
                Arc::new(ClaudeLocalChatHarness::with_startup_capabilities(
                    startup_capabilities,
                )),
                Arc::new(CodexLocalChatHarness::new()),
            ],
            PermissionBridge::new(),
        )
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

        LocalChatHarnessCatalog {
            default_harness,
            harnesses,
        }
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
            .create_session(input.into_harness_input(), runtime)
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
