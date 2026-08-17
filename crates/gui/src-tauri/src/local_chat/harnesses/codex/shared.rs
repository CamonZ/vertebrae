use std::{collections::HashMap, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use tokio::sync::{Mutex, OnceCell, RwLock};
use vertebrae_core::{AgentConfig, PermissionMode as CorePermissionMode, Provider};
use vertebrae_harness::{HarnessFactoryConfig, HarnessRuntimeFactory, HarnessRuntimeOptions};
use vertebrae_harness_core::{
    EventSink, HarnessError, SendTurnRequest, SessionHandle, SessionId, StartSessionRequest,
    StreamId, TurnHandle, TurnId,
};

use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatHarness, LocalChatHarnessInfo,
    LocalChatHarnessKind, LocalChatRuntime, LocalChatSessionError, LocalChatSessionErrorEvent,
    CHAT_REFERENCE_INSTRUCTIONS,
};

use crate::local_chat::harnesses::shared::{LocalChatControlSink, LocalChatHarnessEventSink};
use crate::local_chat::permissions::PermissionBridge;

use super::models::{
    local_chat_harness_info_from_capabilities, requested_model_override, requested_reasoning_effort,
};

#[derive(Clone)]
pub(crate) struct CodexLocalChatHarness {
    sessions: Arc<RwLock<HashMap<String, Arc<CodexLocalChatSession>>>>,
    installed_skills_root_override: Option<PathBuf>,
    catalog: Arc<OnceCell<LocalChatHarnessInfo>>,
}

impl CodexLocalChatHarness {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            installed_skills_root_override: None,
            catalog: Arc::new(OnceCell::new()),
        }
    }

    fn installed_skills_root(&self) -> Result<PathBuf, String> {
        let root = match &self.installed_skills_root_override {
            Some(root) => root.clone(),
            None => vertebrae_installer::installed_skills_dir().map_err(|error| {
                format!("Failed to resolve the installed skills directory: {error}")
            })?,
        };
        if root.is_dir() {
            Ok(root)
        } else {
            Err(format!(
                "Installed skills directory invariant violated; directory does not exist: {}",
                root.display()
            ))
        }
    }

    async fn discover_info(&self) -> LocalChatHarnessInfo {
        let binary = match crate::helpers::find_codex_binary() {
            Ok(binary) => binary,
            Err(error) => return unavailable_codex_info(error),
        };
        let factory = HarnessRuntimeFactory::new(codex_factory_config(binary, Vec::new()));
        let instance = match factory.create(HarnessRuntimeOptions {
            agent_config: AgentConfig::new().with_provider(Provider::Openai),
            request_config: Default::default(),
        }) {
            Ok(instance) => instance,
            Err(error) => return unavailable_codex_info(error.to_string()),
        };
        match instance.runtime.capabilities().await {
            Ok(capabilities) => local_chat_harness_info_from_capabilities(capabilities),
            Err(error) => unavailable_codex_info(error.to_string()),
        }
    }
}

impl Default for CodexLocalChatHarness {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl LocalChatHarness for CodexLocalChatHarness {
    fn kind(&self) -> LocalChatHarnessKind {
        LocalChatHarnessKind::Codex
    }

    async fn info(&self) -> LocalChatHarnessInfo {
        self.catalog
            .get_or_init(|| self.discover_info())
            .await
            .clone()
    }

    async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        let backend_session_id = input.backend_session_id.clone();
        if self.sessions.read().await.contains_key(&backend_session_id) {
            return Err(LocalChatSessionError::SessionExists(backend_session_id));
        }
        let skills_root = self.installed_skills_root().map_err(|error| {
            emit_error(&runtime, &backend_session_id, error.clone());
            LocalChatSessionError::StartFailed(error)
        })?;
        let initial_prompt = input.initial_prompt.clone();
        let model = requested_model_override(input.model_id.as_deref()).map(str::to_owned);
        let reasoning_effort =
            requested_reasoning_effort(input.reasoning_effort.as_deref()).map(str::to_owned);
        let agent_config = AgentConfig {
            provider: Some(Provider::Openai),
            model: model.clone(),
            reasoning_effort: reasoning_effort.clone(),
            permission_mode: input.permission_mode.as_ref().map(core_permission_mode),
            ..AgentConfig::default()
        };
        let mut request = StartSessionRequest {
            session_id: SessionId::new(backend_session_id.clone()),
            stream_id: StreamId::new(format!("local-chat:{backend_session_id}")),
            resume_id: input.provider_resume_id.map(Into::into),
            config: vertebrae_harness_core::RequestConfig {
                working_directory: input.working_dir.map(PathBuf::from),
                model,
                reasoning_effort,
                developer_instructions: Some(CHAT_REFERENCE_INSTRUCTIONS.to_string()),
                ..Default::default()
            },
        };
        let adapter = Arc::new(LocalChatHarnessEventSink::new(
            backend_session_id.clone(),
            LocalChatHarnessKind::Codex,
            runtime.event_sink(),
            requested_model_override(input.model_id.as_deref()).map(str::to_owned),
            0,
            true,
        ));
        let event_sink: Arc<dyn EventSink> = adapter.clone();
        let control_sink: Arc<dyn vertebrae_harness_core::ControlSink> = Arc::new(
            LocalChatControlSink::new(backend_session_id.clone(), runtime.clone()),
        );
        let binary = crate::helpers::find_codex_binary().map_err(|error| {
            emit_error(&runtime, &backend_session_id, error.clone());
            LocalChatSessionError::StartFailed(error)
        })?;
        let instance = HarnessRuntimeFactory::new(codex_factory_config(binary, vec![skills_root]))
            .create(HarnessRuntimeOptions {
                agent_config,
                request_config: request.config.clone(),
            })
            .map_err(|error| {
                let error = error.to_string();
                emit_error(&runtime, &backend_session_id, error.clone());
                LocalChatSessionError::StartFailed(error)
            })?;
        request.config = instance.request_config;
        let session = instance
            .runtime
            .start_session(request, event_sink, control_sink)
            .await
            .map_err(|error| {
                let error = error.to_string();
                emit_error(&runtime, &backend_session_id, error.clone());
                LocalChatSessionError::StartFailed(error)
            })?;
        let session = Arc::new(CodexLocalChatSession {
            adapter,
            session,
            permission_bridge: runtime.permission_bridge(),
            active_turn: Arc::new(Mutex::new(None)),
        });
        let mut sessions = self.sessions.write().await;
        if sessions.contains_key(&backend_session_id) {
            return Err(LocalChatSessionError::SessionExists(backend_session_id));
        }
        sessions.insert(backend_session_id, Arc::clone(&session));
        drop(sessions);
        if let Some(prompt) = initial_prompt {
            tokio::spawn(async move {
                if let Err(error) = session.send(&prompt).await {
                    let _ = session.adapter.emit_error(error.to_string());
                }
            });
        }
        Ok(())
    }

    async fn send_message(
        &self,
        backend_session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError> {
        let session = self
            .sessions
            .read()
            .await
            .get(backend_session_id)
            .cloned()
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(backend_session_id.into()))?;
        let content = content.to_owned();
        tokio::spawn(async move {
            if let Err(error) = session.send(&content).await {
                let _ = session.adapter.emit_error(error.to_string());
            }
        });
        Ok(())
    }

    async fn close_session(&self, backend_session_id: &str) -> Result<(), LocalChatSessionError> {
        let session = self
            .sessions
            .write()
            .await
            .remove(backend_session_id)
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(backend_session_id.into()))?;
        session.close().await?;
        Ok(())
    }

    async fn shutdown(&self) {
        let sessions = {
            let mut sessions = self.sessions.write().await;
            std::mem::take(&mut *sessions)
                .into_values()
                .collect::<Vec<_>>()
        };

        for session in sessions {
            if let Err(error) = session.close().await {
                log::warn!("Failed to close Codex local-chat session during GUI shutdown: {error}");
            }
        }
    }

    async fn has_session(&self, backend_session_id: &str) -> bool {
        self.sessions.read().await.contains_key(backend_session_id)
    }
}

fn codex_factory_config(
    binary: PathBuf,
    installed_skills_roots: Vec<PathBuf>,
) -> HarnessFactoryConfig {
    HarnessFactoryConfig {
        openai_executable: Some(binary),
        search_path: Some(crate::helpers::build_augmented_path().into()),
        installed_skills_roots,
        ..HarnessFactoryConfig::default()
    }
}

fn unavailable_codex_info(reason: String) -> LocalChatHarnessInfo {
    LocalChatHarnessInfo {
        harness: LocalChatHarnessKind::Codex,
        label: "Codex".into(),
        available: false,
        unavailable_reason: Some(reason),
        default_model_id: None,
        models: Vec::new(),
        default_reasoning_effort: None,
        reasoning_efforts: Vec::new(),
        permission_modes: Some(Vec::new()),
        supports_resume: true,
    }
}

struct CodexLocalChatSession {
    adapter: Arc<LocalChatHarnessEventSink>,
    session: Arc<dyn SessionHandle>,
    permission_bridge: PermissionBridge,
    active_turn: Arc<Mutex<Option<Arc<dyn TurnHandle>>>>,
}

impl CodexLocalChatSession {
    async fn send(&self, content: &str) -> Result<(), HarnessError> {
        let turn_number = self.adapter.record_turn();
        let turn = self
            .session
            .send(SendTurnRequest {
                turn_id: TurnId::new(format!("{}:{turn_number}", self.adapter.backend_session_id)),
                content: content.into(),
                output_schema: None,
            })
            .await?;
        let turn_id = turn.turn_id().clone();
        self.active_turn.lock().await.replace(turn.clone());
        let result = turn.await_outcome().await.map(|_| ());
        let mut active_turn = self.active_turn.lock().await;
        if active_turn
            .as_ref()
            .is_some_and(|candidate| candidate.turn_id() == &turn_id)
        {
            active_turn.take();
        }
        result
    }

    async fn close(&self) -> Result<(), LocalChatSessionError> {
        self.permission_bridge.fail_pending_permissions_for_session(
            &self.adapter.backend_session_id,
            "Codex session ended before the permission request was resolved",
        );
        if let Some(turn) = self.active_turn.lock().await.take() {
            let _ = turn.interrupt().await;
        }
        self.session
            .close()
            .await
            .map_err(|error| LocalChatSessionError::StartFailed(error.to_string()))?;
        Ok(())
    }
}

fn core_permission_mode(mode: &crate::types::PermissionMode) -> CorePermissionMode {
    match mode {
        crate::types::PermissionMode::AcceptEdits => CorePermissionMode::AcceptEdits,
        crate::types::PermissionMode::Auto => CorePermissionMode::Auto,
        crate::types::PermissionMode::BypassPermissions => CorePermissionMode::BypassPermissions,
        crate::types::PermissionMode::Default => CorePermissionMode::Default,
        crate::types::PermissionMode::DontAsk => CorePermissionMode::DontAsk,
        crate::types::PermissionMode::Plan => CorePermissionMode::Plan,
    }
}

fn emit_error(runtime: &LocalChatRuntime, backend_session_id: &str, error: String) {
    runtime
        .event_sink()
        .emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
            backend_session_id: backend_session_id.into(),
            harness: LocalChatHarnessKind::Codex,
            turn_id: None,
            thread_id: None,
            is_root: true,
            error,
        }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_factory_config_pins_binary_and_augments_gui_path() {
        let binary = PathBuf::from("/tmp/codex");
        let skills_root = PathBuf::from("/tmp/skills");

        let config = codex_factory_config(binary.clone(), vec![skills_root.clone()]);

        assert_eq!(config.openai_executable, Some(binary));
        assert_eq!(config.installed_skills_roots, vec![skills_root]);
        let search_path = config
            .search_path
            .expect("Codex factory should receive a search path")
            .to_string_lossy()
            .into_owned();
        let home_local_bin = dirs::home_dir()
            .expect("test environment should have a home directory")
            .join(".local/bin")
            .to_string_lossy()
            .into_owned();
        assert!(search_path.split(':').any(|entry| entry == home_local_bin));
    }
}
