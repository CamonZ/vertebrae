use std::{collections::HashMap, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use tokio::sync::RwLock;
use vertebrae_harness_codex::{CodexPermissionConfig, CodexProviderConfig, CodexRuntime};
use vertebrae_harness_core::{
    EventSink, HarnessError, HarnessRuntime, SendTurnRequest, SessionHandle, SessionId,
    StartSessionRequest, StreamId, TurnId,
};

use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatHarness, LocalChatHarnessInfo,
    LocalChatHarnessKind, LocalChatRuntime, LocalChatSessionError, LocalChatSessionErrorEvent,
};

use crate::local_chat::harnesses::shared::{LocalChatControlSink, LocalChatHarnessEventSink};

use super::models::{
    codex_model_options, codex_reasoning_effort_options, requested_model_override,
    requested_reasoning_effort, CODEX_DEFAULT_MODEL_ID, CODEX_DEFAULT_REASONING_EFFORT,
};

#[derive(Clone)]
pub(crate) struct CodexLocalChatHarness {
    sessions: Arc<RwLock<HashMap<String, Arc<CodexLocalChatSession>>>>,
    installed_skills_root_override: Option<PathBuf>,
}

impl CodexLocalChatHarness {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            installed_skills_root_override: None,
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

    fn info(&self) -> LocalChatHarnessInfo {
        let binary = crate::helpers::find_codex_binary();
        LocalChatHarnessInfo {
            harness: LocalChatHarnessKind::Codex,
            label: "Codex".into(),
            available: binary.is_ok(),
            unavailable_reason: binary.err(),
            default_model_id: Some(CODEX_DEFAULT_MODEL_ID.into()),
            models: codex_model_options(),
            default_reasoning_effort: Some(CODEX_DEFAULT_REASONING_EFFORT.into()),
            reasoning_efforts: codex_reasoning_effort_options(),
            supports_resume: true,
        }
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
        let provider = CodexProviderConfig {
            installed_skills_roots: vec![skills_root],
            permission: permission_config(input.permission_mode.as_ref()),
            search_path: Some(std::env::var_os("PATH").unwrap_or_default()),
            ..CodexProviderConfig::default()
        };
        let request = StartSessionRequest {
            session_id: SessionId::new(backend_session_id.clone()),
            stream_id: StreamId::new(format!("local-chat:{backend_session_id}")),
            resume_id: input.provider_resume_id.map(Into::into),
            config: vertebrae_harness_core::RequestConfig {
                working_directory: input.working_dir.map(PathBuf::from),
                model: requested_model_override(input.model_id.as_deref()).map(str::to_owned),
                reasoning_effort: requested_reasoning_effort(input.reasoning_effort.as_deref())
                    .map(str::to_owned),
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
        let session = CodexRuntime::new(provider)
            .start_session(request, event_sink, control_sink)
            .await
            .map_err(|error| {
                let error = error.to_string();
                emit_error(&runtime, &backend_session_id, error.clone());
                LocalChatSessionError::StartFailed(error)
            })?;
        let session = Arc::new(CodexLocalChatSession { adapter, session });
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
        session
            .session
            .close()
            .await
            .map_err(|error| LocalChatSessionError::StartFailed(error.to_string()))?;
        Ok(())
    }

    async fn has_session(&self, backend_session_id: &str) -> bool {
        self.sessions.read().await.contains_key(backend_session_id)
    }
}

struct CodexLocalChatSession {
    adapter: Arc<LocalChatHarnessEventSink>,
    session: Arc<dyn SessionHandle>,
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
        turn.await_outcome().await.map(|_| ())
    }
}

fn permission_config(mode: Option<&crate::types::PermissionMode>) -> CodexPermissionConfig {
    use crate::types::PermissionMode;
    match mode {
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
        Some(PermissionMode::Default) => CodexPermissionConfig {
            approval_policy: Some("on-request".into()),
            permissions: Some(":read-only".into()),
            ..Default::default()
        },
        None => CodexPermissionConfig::default(),
    }
}

fn emit_error(runtime: &LocalChatRuntime, backend_session_id: &str, error: String) {
    runtime
        .event_sink()
        .emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
            backend_session_id: backend_session_id.into(),
            harness: LocalChatHarnessKind::Codex,
            error,
        }));
}
