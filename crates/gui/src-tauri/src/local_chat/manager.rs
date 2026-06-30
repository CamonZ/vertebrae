use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::claude_session::ClaudeSessionManager;
use crate::local_chat::harnesses::claude::ClaudeLocalChatHarness;
use crate::local_chat::harnesses::codex::CodexLocalChatHarness;
use crate::local_chat::permissions::PermissionBridge;
use crate::local_chat::{
    CreateLocalChatSessionInput, LocalChatHarness, LocalChatHarnessCatalog, LocalChatHarnessKind,
    LocalChatRuntime, LocalChatSessionError,
};

pub struct LocalChatSessionManager {
    harnesses: HashMap<LocalChatHarnessKind, Arc<dyn LocalChatHarness>>,
    session_registry: RwLock<HashMap<String, LocalChatHarnessKind>>,
    permission_bridge: PermissionBridge,
}

impl LocalChatSessionManager {
    pub fn new() -> Self {
        Self::with_default_harnesses(ClaudeSessionManager::new())
    }

    pub fn with_default_harnesses(claude_manager: ClaudeSessionManager) -> Self {
        let permission_bridge = claude_manager.permission_bridge();
        Self::with_harnesses_and_permission_bridge(
            vec![
                Arc::new(ClaudeLocalChatHarness::new(claude_manager)),
                Arc::new(CodexLocalChatHarness::new()),
            ],
            permission_bridge,
        )
    }

    #[cfg(test)]
    pub(crate) fn with_harnesses_for_tests(harnesses: Vec<Arc<dyn LocalChatHarness>>) -> Self {
        Self::with_harnesses_and_permission_bridge(harnesses, PermissionBridge::new())
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
            permission_bridge,
        }
    }

    pub fn catalog(&self) -> LocalChatHarnessCatalog {
        let mut harnesses: Vec<_> = self
            .harnesses
            .values()
            .map(|harness| harness.info())
            .collect();
        harnesses.sort_by_key(|info| info.harness);
        let default_harness = if self.harnesses.contains_key(&LocalChatHarnessKind::Claude) {
            LocalChatHarnessKind::Claude
        } else {
            harnesses
                .first()
                .map(|info| info.harness)
                .unwrap_or(LocalChatHarnessKind::Claude)
        };

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
        let harness_kind = input.harness;
        let backend_session_id = input.backend_session_id.clone();
        let harness = self.harness(harness_kind)?;
        let info = harness.info();
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
        let harness_kind = self.registry_harness(backend_session_id).await?;
        let harness = self.harness(harness_kind)?;
        let result = harness.close_session(backend_session_id).await;
        if result.is_ok() || matches!(result, Err(LocalChatSessionError::SessionNotFound(_))) {
            self.remove_registry_entry(backend_session_id, harness_kind)
                .await;
        }
        result
    }

    pub async fn has_session(&self, backend_session_id: &str) -> bool {
        let Ok(harness_kind) = self.registry_harness(backend_session_id).await else {
            return false;
        };
        let Ok(harness) = self.harness(harness_kind) else {
            return false;
        };
        harness.has_session(backend_session_id).await
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
