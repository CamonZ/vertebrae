use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use tokio::sync::{Mutex, RwLock};

use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatEventSink, LocalChatHarness,
    LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatRuntime, LocalChatSessionError,
    LocalChatSessionErrorEvent, LocalChatSessionInitEvent,
};

use super::launcher::{CodexAppServerLauncher, ProcessCodexAppServerLauncher};
use super::models::{requested_model_override, requested_reasoning_effort};
use super::permissions::CodexPermissionSettings;
use super::rpc::{CodexRpcConnection, ThreadRequest};
use super::session::{stop_process, CodexLocalChatSession, SessionStats, TurnFailureSurface};
use super::thread_state::CodexThreadState;

#[derive(Clone)]
pub(crate) struct CodexLocalChatHarness {
    sessions: Arc<RwLock<HashMap<String, Arc<CodexLocalChatSession>>>>,
    launcher: Arc<dyn CodexAppServerLauncher>,
}

impl CodexLocalChatHarness {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            launcher: Arc::new(ProcessCodexAppServerLauncher),
        }
    }

    #[cfg(test)]
    pub(super) fn with_launcher_for_tests(launcher: Arc<dyn CodexAppServerLauncher>) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            launcher,
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
        self.launcher.info()
    }

    async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        let backend_session_id = input.backend_session_id.clone();
        log::info!(
            "[Codex local chat] create_session starting: backend_session_id={}, working_dir={:?}, resume={:?}, model={:?}, effort={:?}, permission_mode={:?}, has_initial_prompt={}",
            backend_session_id,
            input.working_dir,
            input.provider_resume_id,
            input.model_id,
            input.reasoning_effort,
            input.permission_mode,
            input.initial_prompt.is_some()
        );
        {
            let sessions = self.sessions.read().await;
            if sessions.contains_key(&backend_session_id) {
                return Err(LocalChatSessionError::SessionExists(backend_session_id));
            }
        }

        let event_sink = runtime.event_sink();
        let mut launched = match self.launcher.launch().await {
            Ok(launched) => launched,
            Err(err) => {
                let error = format!("Failed to start Codex app-server: {err}");
                log::error!(
                    "[Codex local chat] app-server launch failed for {}: {}",
                    backend_session_id,
                    error
                );
                emit_start_error(&event_sink, &backend_session_id, error.clone());
                return Err(LocalChatSessionError::SpawnFailed(error));
            }
        };
        log::info!(
            "[Codex local chat] app-server launched for {} at {}",
            backend_session_id,
            launched.ws_url
        );
        let thread_state = Arc::new(StdMutex::new(CodexThreadState::default()));
        let connection = match CodexRpcConnection::connect(
            &launched.ws_url,
            backend_session_id.clone(),
            event_sink.clone(),
            thread_state.clone(),
        )
        .await
        {
            Ok(connection) => connection,
            Err(error) => {
                stop_process(&mut launched.process).await;
                log::error!(
                    "[Codex local chat] websocket connect failed for {}: {}",
                    backend_session_id,
                    error
                );
                emit_start_error(&event_sink, &backend_session_id, error.clone());
                return Err(LocalChatSessionError::StartFailed(error));
            }
        };
        log::info!(
            "[Codex local chat] websocket connected for {}",
            backend_session_id
        );
        if let Err(error) = connection.initialize().await {
            stop_process(&mut launched.process).await;
            log::error!(
                "[Codex local chat] initialize failed for {}: {}",
                backend_session_id,
                error
            );
            emit_start_error(&event_sink, &backend_session_id, error.clone());
            return Err(LocalChatSessionError::StartFailed(error));
        }
        log::info!(
            "[Codex local chat] initialized app-server for {}",
            backend_session_id
        );

        let model_override = requested_model_override(input.model_id.as_deref());
        let reasoning_effort = requested_reasoning_effort(input.reasoning_effort.as_deref());
        let permission_settings =
            CodexPermissionSettings::from_permission_mode(input.permission_mode.as_ref());
        let initial_prompt = input.initial_prompt.clone();
        log::info!(
            "[Codex local chat] starting provider thread for {}: resume={:?}, model_override={:?}, effort={:?}",
            backend_session_id,
            input.provider_resume_id,
            model_override,
            reasoning_effort
        );
        let thread = match connection
            .start_or_resume_thread(ThreadRequest {
                provider_resume_id: input.provider_resume_id.as_deref(),
                working_dir: input.working_dir.as_deref(),
                model: model_override,
                reasoning_effort,
                permission_settings,
            })
            .await
        {
            Ok(thread) => thread,
            Err(error) => {
                stop_process(&mut launched.process).await;
                log::error!(
                    "[Codex local chat] provider thread start failed for {}: {}",
                    backend_session_id,
                    error
                );
                emit_start_error(&event_sink, &backend_session_id, error.clone());
                return Err(LocalChatSessionError::StartFailed(error));
            }
        };
        log::info!(
            "[Codex local chat] provider thread ready for {}: thread_id={}, model={}",
            backend_session_id,
            thread.thread_id,
            thread.model
        );

        emit_init(
            &event_sink,
            &backend_session_id,
            Some(thread.thread_id.clone()),
            thread.model.clone(),
        );

        let session = Arc::new(CodexLocalChatSession {
            backend_session_id: backend_session_id.clone(),
            thread_id: thread.thread_id,
            event_sink,
            connection,
            process: Mutex::new(launched.process),
            stats: Mutex::new(SessionStats::default()),
            permission_settings,
            turn_lock: Mutex::new(()),
        });

        let mut sessions = self.sessions.write().await;
        if sessions.contains_key(&backend_session_id) {
            drop(sessions);
            session.shutdown().await;
            return Err(LocalChatSessionError::SessionExists(backend_session_id));
        }
        sessions.insert(backend_session_id, session.clone());
        log::info!(
            "[Codex local chat] session registered for {}",
            session.backend_session_id
        );

        if let Some(initial_prompt) = initial_prompt {
            tokio::spawn(async move {
                if let Err(error) = session
                    .run_turn(&initial_prompt, TurnFailureSurface::Start)
                    .await
                {
                    log::error!(
                        "[Codex local chat] initial turn failed for {}: {}",
                        session.backend_session_id,
                        error
                    );
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
        let session = self.session(backend_session_id).await.ok_or_else(|| {
            LocalChatSessionError::SessionNotFound(backend_session_id.to_string())
        })?;
        let content = content.to_string();
        tokio::spawn(async move {
            if let Err(error) = session.run_turn(&content, TurnFailureSurface::Send).await {
                log::error!(
                    "[Codex local chat] send turn failed for {}: {}",
                    session.backend_session_id,
                    error
                );
            }
        });
        Ok(())
    }

    async fn close_session(&self, backend_session_id: &str) -> Result<(), LocalChatSessionError> {
        let session = {
            let mut sessions = self.sessions.write().await;
            sessions.remove(backend_session_id)
        }
        .ok_or_else(|| LocalChatSessionError::SessionNotFound(backend_session_id.to_string()))?;

        session.shutdown().await;
        Ok(())
    }

    async fn has_session(&self, backend_session_id: &str) -> bool {
        self.sessions.read().await.contains_key(backend_session_id)
    }
}

impl CodexLocalChatHarness {
    async fn session(&self, backend_session_id: &str) -> Option<Arc<CodexLocalChatSession>> {
        self.sessions.read().await.get(backend_session_id).cloned()
    }
}

fn emit_init(
    event_sink: &LocalChatEventSink,
    backend_session_id: &str,
    provider_resume_id: Option<String>,
    model: String,
) {
    event_sink.emit(LocalChatEvent::Init(LocalChatSessionInitEvent {
        backend_session_id: backend_session_id.to_string(),
        harness: LocalChatHarnessKind::Codex,
        provider_resume_id,
        model,
        tools: Vec::new(),
    }));
}

fn emit_start_error(event_sink: &LocalChatEventSink, backend_session_id: &str, error: String) {
    event_sink.emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
        backend_session_id: backend_session_id.to_string(),
        harness: LocalChatHarnessKind::Codex,
        error,
    }));
}
