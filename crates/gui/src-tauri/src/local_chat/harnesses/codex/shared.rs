use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use tokio::sync::RwLock;
use vertebrae_harness_codex::{CodexPermissionConfig, CodexProviderConfig, CodexRuntime};
use vertebrae_harness_core::{
    CompletionStatus, ControlRequestEnvelope, ControlResolution, ControlSink, EventSink,
    HarnessError, HarnessEventPayloadV1, HarnessRuntime, SendTurnRequest, SessionHandle, SessionId,
    StartSessionRequest, StreamId, ToolStatus, TurnId,
};

use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatEventSink, LocalChatHarness,
    LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatRuntime, LocalChatSessionEndEvent,
    LocalChatSessionError, LocalChatSessionErrorEvent, LocalChatSessionInitEvent,
    LocalChatSessionUsageEvent, LocalChatSessionWarningEvent, LocalChatTextEvent,
    LocalChatToolCallEvent, LocalChatToolResultEvent,
};

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
            models: codex_model_options(None),
            default_reasoning_effort: Some(CODEX_DEFAULT_REASONING_EFFORT.into()),
            reasoning_efforts: codex_reasoning_effort_options(None),
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
            emit_error(&runtime.event_sink(), &backend_session_id, error.clone());
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
            stream_id: StreamId::new(backend_session_id.clone()),
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
            runtime.event_sink(),
        ));
        let event_sink: Arc<dyn EventSink> = adapter.clone();
        let control_sink: Arc<dyn ControlSink> = Arc::new(LocalChatControlSink {
            backend_session_id: backend_session_id.clone(),
            runtime: runtime.clone(),
        });
        let session = CodexRuntime::new(provider)
            .start_session(request, event_sink, control_sink)
            .await
            .map_err(|error| {
                let error = error.to_string();
                emit_error(&runtime.event_sink(), &backend_session_id, error.clone());
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
                    session.adapter.emit_error(error.to_string());
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
                session.adapter.emit_error(error.to_string());
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
        let turn_number = {
            let mut stats = self
                .adapter
                .stats
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            stats.turns = stats.turns.saturating_add(1);
            stats.turns
        };
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

#[derive(Default)]
struct SessionStats {
    turns: u32,
    context_tokens: u32,
    context_window: u32,
}

struct LocalChatHarnessEventSink {
    backend_session_id: String,
    sink: LocalChatEventSink,
    stats: Arc<Mutex<SessionStats>>,
}

impl LocalChatHarnessEventSink {
    fn new(backend_session_id: String, sink: LocalChatEventSink) -> Self {
        Self {
            backend_session_id,
            sink,
            stats: Arc::new(Mutex::new(SessionStats::default())),
        }
    }

    fn emit_error(&self, error: String) {
        emit_error(&self.sink, &self.backend_session_id, error);
    }

    fn emit_end(
        &self,
        status: CompletionStatus,
        result: Option<String>,
        context_tokens: Option<u64>,
        context_window: Option<u64>,
    ) {
        let stats = self
            .stats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.sink
            .emit(LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                duration_ms: 0,
                cost_usd: 0.0,
                num_turns: stats.turns,
                result: result.unwrap_or_default(),
                is_error: status != CompletionStatus::Completed,
                context_tokens: context_tokens
                    .unwrap_or(stats.context_tokens as u64)
                    .min(u32::MAX as u64) as u32,
                context_window: context_window
                    .unwrap_or(stats.context_window as u64)
                    .min(u32::MAX as u64) as u32,
            }));
    }
}

#[async_trait]
impl EventSink for LocalChatHarnessEventSink {
    async fn emit(
        &self,
        event: vertebrae_harness_core::HarnessEventV1,
    ) -> Result<(), HarnessError> {
        let backend = self.backend_session_id.clone();
        match event.payload {
            HarnessEventPayloadV1::SessionStarted(value) => {
                self.sink
                    .emit(LocalChatEvent::Init(LocalChatSessionInitEvent {
                        backend_session_id: backend,
                        harness: LocalChatHarnessKind::Codex,
                        provider_resume_id: value.provider_resume_id.map(|value| value.to_string()),
                        model: value.model.unwrap_or_else(|| "Codex default".into()),
                        tools: value.tools,
                    }))
            }
            HarnessEventPayloadV1::Text(value) => {
                self.sink.emit(LocalChatEvent::Text(LocalChatTextEvent {
                    backend_session_id: backend,
                    harness: LocalChatHarnessKind::Codex,
                    text: value.text,
                    is_partial: event.semantics == vertebrae_harness_core::UpdateSemantics::Delta,
                    parent_tool_use_id: event
                        .correlation
                        .parent_tool_call_id
                        .map(|value| value.to_string()),
                }))
            }
            HarnessEventPayloadV1::ToolCall(value) => {
                self.sink
                    .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                        backend_session_id: backend,
                        harness: LocalChatHarnessKind::Codex,
                        tool_id: value.tool_call_id.to_string(),
                        tool_name: value.name,
                        input: value.input.to_string(),
                        parent_tool_use_id: event
                            .correlation
                            .parent_tool_call_id
                            .map(|value| value.to_string()),
                    }))
            }
            HarnessEventPayloadV1::ToolOutput(value) => {
                self.sink
                    .emit(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                        backend_session_id: backend,
                        harness: LocalChatHarnessKind::Codex,
                        tool_id: value.tool_call_id.to_string(),
                        result: value.output.to_string(),
                        is_error: matches!(
                            value.status,
                            ToolStatus::Failed | ToolStatus::Declined | ToolStatus::Cancelled
                        ),
                        parent_tool_use_id: event
                            .correlation
                            .parent_tool_call_id
                            .map(|value| value.to_string()),
                    }))
            }
            HarnessEventPayloadV1::Usage(value) => {
                if let Some(snapshot) = value.session_snapshot {
                    let mut stats = self
                        .stats
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    stats.context_tokens =
                        snapshot.context_tokens.unwrap_or(0).min(u32::MAX as u64) as u32;
                    stats.context_window =
                        snapshot.context_window.unwrap_or(0).min(u32::MAX as u64) as u32;
                    self.sink
                        .emit(LocalChatEvent::Usage(LocalChatSessionUsageEvent {
                            backend_session_id: backend,
                            harness: LocalChatHarnessKind::Codex,
                            model: "Codex".into(),
                            context_tokens: stats.context_tokens,
                            context_window: stats.context_window,
                        }));
                }
            }
            HarnessEventPayloadV1::TurnFinished(outcome) => self.emit_end(
                outcome.status,
                outcome.result_text,
                outcome.metrics.context_tokens,
                outcome.metrics.context_window,
            ),
            HarnessEventPayloadV1::RunFinished(outcome) => self.emit_end(
                outcome.status,
                outcome.result_text,
                outcome.metrics.context_tokens,
                outcome.metrics.context_window,
            ),
            HarnessEventPayloadV1::Warning(value) => {
                self.sink
                    .emit(LocalChatEvent::Warning(LocalChatSessionWarningEvent {
                        backend_session_id: backend,
                        harness: LocalChatHarnessKind::Codex,
                        warning: value.message,
                    }))
            }
            HarnessEventPayloadV1::Error(value) => {
                self.sink
                    .emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
                        backend_session_id: backend,
                        harness: LocalChatHarnessKind::Codex,
                        error: value.message,
                    }))
            }
            _ => {}
        }
        Ok(())
    }
}

struct LocalChatControlSink {
    backend_session_id: String,
    runtime: LocalChatRuntime,
}

#[async_trait]
impl ControlSink for LocalChatControlSink {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError> {
        self.runtime
            .permission_bridge()
            .request_harness_control(&self.backend_session_id, self.runtime.app_handle(), request)
            .await
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

fn emit_error(sink: &LocalChatEventSink, backend_session_id: &str, error: String) {
    sink.emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
        backend_session_id: backend_session_id.into(),
        harness: LocalChatHarnessKind::Codex,
        error,
    }));
}
