//! GUI-owned Claude session registry backed by the reusable Claude harness.

use std::{
    collections::{BTreeMap, HashMap},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use async_trait::async_trait;
use tauri::Manager;
use tokio::sync::RwLock;
use vertebrae_harness_claude::{ClaudePermissionMode, ClaudeProviderConfig, ClaudeRuntime};
use vertebrae_harness_core::{
    CompletionStatus, ControlRequestEnvelope, ControlResolution, ControlSink, EventSink,
    HarnessError, HarnessEventPayloadV1, HarnessEventV1, HarnessRuntime, ProviderResumeId,
    ProviderThreadRef, RequestConfig, SendTurnRequest, SessionCloseStatus, SessionHandle,
    SessionId, StartSessionRequest, StreamId, TurnId, UpdateSemantics,
};

use crate::commands::AppState;
use crate::helpers::{build_augmented_path, find_claude_binary, find_vtb_gate_binary};
use crate::local_chat::harnesses::claude::args::resolve_requested_claude_model;
use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatEventSink, LocalChatHarnessKind,
    LocalChatRuntime, LocalChatSessionEndEvent, LocalChatSessionError, LocalChatSessionErrorEvent,
    LocalChatSessionInitEvent, LocalChatSessionUsageEvent, LocalChatSessionWarningEvent,
    LocalChatTextEvent, LocalChatToolCallEvent, LocalChatToolResultEvent,
};
use crate::types::PermissionMode;
use vertebrae_installer::{resolve_claude_plugin_dir, ClaudePluginDirResolution};

type RuntimeFactory =
    dyn Fn(ClaudeProviderConfig) -> Arc<dyn HarnessRuntime> + Send + Sync + 'static;

const DEFAULT_CLAUDE_CONTEXT_WINDOW: u32 = 200_000;

struct ActiveSession {
    handle: Arc<dyn SessionHandle>,
    active_turn: Arc<Mutex<Option<Arc<dyn vertebrae_harness_core::TurnHandle>>>>,
    #[cfg(unix)]
    _permission_socket: Option<crate::local_chat::permissions::PermissionSocketGuard>,
}

#[derive(Default)]
struct CompatibilityState {
    model: String,
    context_tokens: u32,
    context_window: u32,
    turn_count: u32,
}

#[derive(Clone)]
struct ClaudeGuiEventSink {
    backend_session_id: String,
    event_sink: LocalChatEventSink,
    sessions: Arc<RwLock<HashMap<String, ActiveSession>>>,
    state: Arc<Mutex<CompatibilityState>>,
    permission_bridge: crate::local_chat::permissions::PermissionBridge,
    closed: Arc<AtomicBool>,
    lifecycle_gate: Arc<tokio::sync::Mutex<()>>,
}

impl ClaudeGuiEventSink {
    fn new(
        backend_session_id: String,
        event_sink: LocalChatEventSink,
        sessions: Arc<RwLock<HashMap<String, ActiveSession>>>,
        initial_model: Option<String>,
        permission_bridge: crate::local_chat::permissions::PermissionBridge,
        lifecycle_gate: Arc<tokio::sync::Mutex<()>>,
    ) -> Self {
        Self {
            backend_session_id,
            event_sink,
            sessions,
            state: Arc::new(Mutex::new(CompatibilityState {
                model: initial_model.unwrap_or_default(),
                ..CompatibilityState::default()
            })),
            permission_bridge,
            closed: Arc::new(AtomicBool::new(false)),
            lifecycle_gate,
        }
    }

    fn emit_local(&self, event: LocalChatEvent) -> Result<(), HarnessError> {
        self.event_sink
            .try_emit(event)
            .map_err(HarnessError::EventSink)
    }

    fn emit_error(&self, error: impl Into<String>) -> Result<(), HarnessError> {
        self.emit_local(LocalChatEvent::Error(LocalChatSessionErrorEvent {
            backend_session_id: self.backend_session_id.clone(),
            harness: LocalChatHarnessKind::Claude,
            error: error.into(),
        }))
    }

    fn parent_tool_use_id(event: &HarnessEventV1) -> Option<String> {
        event
            .correlation
            .parent_tool_call_id
            .as_ref()
            .map(ToString::to_string)
    }

    fn value_text(value: &serde_json::Value) -> String {
        match value {
            serde_json::Value::String(value) => value.clone(),
            value => serde_json::to_string(value).unwrap_or_default(),
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn is_root_stream(&self, event: &HarnessEventV1) -> bool {
        event.stream_id.as_str() == format!("local-chat:{}", self.backend_session_id)
    }
}

#[async_trait]
impl EventSink for ClaudeGuiEventSink {
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError> {
        let parent_tool_use_id = Self::parent_tool_use_id(&event);
        let is_root_stream = self.is_root_stream(&event);
        match event.payload {
            HarnessEventPayloadV1::SessionStarted(started) => {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| HarnessError::EventSink("GUI event state is poisoned".into()))?;
                if let Some(model) = started.model {
                    state.model = model;
                }
                self.emit_local(LocalChatEvent::Init(LocalChatSessionInitEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Claude,
                    provider_resume_id: started
                        .provider_resume_id
                        .as_ref()
                        .map(ToString::to_string),
                    model: state.model.clone(),
                    tools: started.tools,
                }))?;
            }
            HarnessEventPayloadV1::Text(text) => {
                self.emit_local(LocalChatEvent::Text(LocalChatTextEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Claude,
                    text: text.text,
                    is_partial: event.semantics == UpdateSemantics::Delta,
                    parent_tool_use_id,
                }))?;
            }
            HarnessEventPayloadV1::ToolCall(tool) => {
                if tool.name == crate::local_chat::permissions::ASK_USER_QUESTION_TOOL {
                    return Ok(());
                }
                self.emit_local(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Claude,
                    tool_id: tool.tool_call_id.to_string(),
                    tool_name: tool.name,
                    input: serde_json::to_string(&tool.input).unwrap_or_default(),
                    parent_tool_use_id,
                }))?;
            }
            HarnessEventPayloadV1::ToolOutput(output) => {
                self.emit_local(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Claude,
                    tool_id: output.tool_call_id.to_string(),
                    result: Self::value_text(&output.output),
                    is_error: matches!(
                        output.status,
                        vertebrae_harness_core::ToolStatus::Failed
                            | vertebrae_harness_core::ToolStatus::Declined
                            | vertebrae_harness_core::ToolStatus::Cancelled
                    ),
                    parent_tool_use_id,
                }))?;
            }
            HarnessEventPayloadV1::Usage(usage) => {
                // Agent records have their own canonical stream. Their usage may
                // omit `parent_tool_call_id`, so stream identity is the reliable
                // boundary for the root conversation's context meter.
                if !is_root_stream {
                    return Ok(());
                }
                if let Some(snapshot) = usage.session_snapshot {
                    let mut state = self.state.lock().map_err(|_| {
                        HarnessError::EventSink("GUI event state is poisoned".into())
                    })?;
                    state.context_tokens = snapshot
                        .context_tokens
                        .unwrap_or_default()
                        .min(u64::from(u32::MAX)) as u32;
                    state.context_window = snapshot
                        .context_window
                        .unwrap_or_default()
                        .min(u64::from(u32::MAX)) as u32;
                    self.emit_local(LocalChatEvent::Usage(LocalChatSessionUsageEvent {
                        backend_session_id: self.backend_session_id.clone(),
                        harness: LocalChatHarnessKind::Claude,
                        model: state.model.clone(),
                        context_tokens: state.context_tokens,
                        context_window: state.context_window,
                    }))?;
                }
            }
            HarnessEventPayloadV1::TurnFinished(outcome) => {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| HarnessError::EventSink("GUI event state is poisoned".into()))?;
                // These defaults intentionally mirror the legacy Claude JSONL
                // compatibility contract. A result is authoritative and must
                // not inherit a previous per-turn usage snapshot.
                state.turn_count = outcome
                    .metrics
                    .turn_count
                    .unwrap_or_default()
                    .min(u64::from(u32::MAX)) as u32;
                state.context_tokens = outcome
                    .metrics
                    .context_tokens
                    .unwrap_or_default()
                    .min(u64::from(u32::MAX)) as u32;
                state.context_window = outcome
                    .metrics
                    .context_window
                    .unwrap_or(u64::from(DEFAULT_CLAUDE_CONTEXT_WINDOW))
                    .min(u64::from(u32::MAX)) as u32;
                let cost_usd = outcome.metrics.total_cost_usd.unwrap_or_default();
                self.emit_local(LocalChatEvent::End(LocalChatSessionEndEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Claude,
                    duration_ms: outcome
                        .metrics
                        .duration_ms
                        .unwrap_or_default()
                        .min(u64::from(u32::MAX)) as u32,
                    cost_usd,
                    num_turns: state.turn_count,
                    result: outcome.result_text.unwrap_or_default(),
                    is_error: outcome.status != CompletionStatus::Completed,
                    context_tokens: state.context_tokens,
                    context_window: state.context_window,
                }))?;
            }
            HarnessEventPayloadV1::Warning(warning) => {
                self.emit_local(LocalChatEvent::Warning(LocalChatSessionWarningEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Claude,
                    warning: warning.message,
                }))?;
            }
            HarnessEventPayloadV1::Error(error) => self.emit_error(error.message)?,
            HarnessEventPayloadV1::SessionClosed(outcome) => {
                let _lifecycle = self.lifecycle_gate.lock().await;
                self.closed.store(true, Ordering::Release);
                self.sessions.write().await.remove(&self.backend_session_id);
                self.permission_bridge.fail_pending_permissions_for_session(
                    &self.backend_session_id,
                    "Claude session ended before the permission request was resolved",
                );
                match outcome.status {
                    SessionCloseStatus::Closed => {}
                    SessionCloseStatus::ProcessLost => self.emit_error(
                        outcome
                            .error
                            .unwrap_or_else(|| "Claude session process was lost".into()),
                    )?,
                    SessionCloseStatus::Failed => self.emit_error(
                        outcome
                            .error
                            .unwrap_or_else(|| "Claude session failed while closing".into()),
                    )?,
                }
            }
            HarnessEventPayloadV1::Reasoning(_)
            | HarnessEventPayloadV1::Plan(_)
            | HarnessEventPayloadV1::FileChange(_)
            | HarnessEventPayloadV1::ThreadDeclared(_)
            | HarnessEventPayloadV1::TurnStarted(_)
            | HarnessEventPayloadV1::TurnInput(_)
            | HarnessEventPayloadV1::ControlRequested(_)
            | HarnessEventPayloadV1::ControlResolved(_)
            | HarnessEventPayloadV1::RunFinished(_)
            | HarnessEventPayloadV1::Unknown { .. } => {}
        }
        Ok(())
    }
}

#[derive(Clone)]
struct ClaudeGuiControlSink {
    backend_session_id: String,
    runtime: LocalChatRuntime,
}

#[async_trait]
impl ControlSink for ClaudeGuiControlSink {
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

/// GUI adapter that owns backend-session routing and provider-neutral handles.
#[derive(Clone)]
pub(crate) struct ClaudeSessionRuntime {
    sessions: Arc<RwLock<HashMap<String, ActiveSession>>>,
    runtime_factory: Arc<RuntimeFactory>,
    #[cfg(test)]
    registry_insert_hook: Option<RegistryInsertHook>,
}

#[cfg(test)]
#[derive(Clone)]
struct RegistryInsertHook {
    reached: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

impl ClaudeSessionRuntime {
    pub(crate) fn new() -> Self {
        Self::with_runtime_factory(|config| Arc::new(ClaudeRuntime::new(config)))
    }

    fn with_runtime_factory(
        runtime_factory: impl Fn(ClaudeProviderConfig) -> Arc<dyn HarnessRuntime>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            runtime_factory: Arc::new(runtime_factory),
            #[cfg(test)]
            registry_insert_hook: None,
        }
    }

    pub(crate) async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        let backend_session_id = input.backend_session_id.clone();
        if self.sessions.read().await.contains_key(&backend_session_id) {
            return Err(LocalChatSessionError::SessionExists(backend_session_id));
        }

        let prepared = match PreparedSession::new(&input, &runtime) {
            Ok(prepared) => prepared,
            Err(error) => {
                emit_start_error(
                    &runtime.event_sink(),
                    &backend_session_id,
                    error.to_string(),
                );
                return Err(error);
            }
        };
        self.create_prepared_session(input, runtime, prepared).await
    }

    async fn create_prepared_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
        prepared: PreparedSession,
    ) -> Result<(), LocalChatSessionError> {
        let backend_session_id = input.backend_session_id.clone();
        if let Some(warning) = &prepared.model_warning {
            emit_warning(&runtime.event_sink(), &backend_session_id, warning.clone());
        }
        report_plugin_dir_resolution(
            &runtime.event_sink(),
            &backend_session_id,
            &prepared.plugin_resolution,
        );

        let lifecycle_gate = Arc::new(tokio::sync::Mutex::new(()));
        let event_sink = Arc::new(ClaudeGuiEventSink::new(
            backend_session_id.clone(),
            runtime.event_sink(),
            self.sessions.clone(),
            prepared.model.clone(),
            runtime.permission_bridge(),
            lifecycle_gate.clone(),
        ));
        let control_sink = Arc::new(ClaudeGuiControlSink {
            backend_session_id: backend_session_id.clone(),
            runtime: runtime.clone(),
        });
        let harness = (self.runtime_factory)(prepared.provider_config);
        let request = StartSessionRequest {
            session_id: SessionId::new(backend_session_id.clone()),
            stream_id: StreamId::new(format!("local-chat:{backend_session_id}")),
            resume_id: input.provider_resume_id.clone().map(ProviderResumeId::new),
            config: RequestConfig {
                working_directory: Some(prepared.working_dir),
                model: prepared.model,
                reasoning_effort: input.reasoning_effort,
                ..RequestConfig::default()
            },
        };
        let handle = match harness
            .start_session(request, event_sink.clone(), control_sink)
            .await
        {
            Ok(handle) => handle,
            Err(error) => {
                let _ = event_sink.emit_error(error.to_string());
                return Err(start_error(error));
            }
        };

        let _lifecycle = lifecycle_gate.lock().await;
        if event_sink.is_closed() {
            return Err(LocalChatSessionError::StartFailed(
                "Claude session ended during initialization".into(),
            ));
        }

        let active_turn = Arc::new(Mutex::new(None));
        #[cfg(test)]
        if let Some(hook) = &self.registry_insert_hook {
            hook.reached.notify_one();
            hook.release.notified().await;
        }
        self.sessions.write().await.insert(
            backend_session_id.clone(),
            ActiveSession {
                handle: handle.clone(),
                active_turn: active_turn.clone(),
                #[cfg(unix)]
                _permission_socket: prepared.permission_socket,
            },
        );
        drop(_lifecycle);

        if let Some(prompt) = input
            .initial_prompt
            .filter(|prompt| !prompt.trim().is_empty())
        {
            if let Err(error) = send_turn(&handle, &active_turn, prompt).await {
                self.sessions.write().await.remove(&backend_session_id);
                let _ = handle.close().await;
                let _ = event_sink.emit_error(error.to_string());
                return Err(send_error(error));
            }
        }

        log::info!("Claude harness session {} created", backend_session_id);
        Ok(())
    }

    pub(crate) async fn send_message(
        &self,
        session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError> {
        let (handle, active_turn) = self
            .sessions
            .read()
            .await
            .get(session_id)
            .map(|session| (session.handle.clone(), session.active_turn.clone()))
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(session_id.to_string()))?;
        send_turn(&handle, &active_turn, content.to_string())
            .await
            .map_err(send_error)
    }

    pub(crate) async fn close_session(
        &self,
        session_id: &str,
    ) -> Result<(), LocalChatSessionError> {
        let session = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or_else(|| LocalChatSessionError::SessionNotFound(session_id.to_string()))?;
        // Closing the GUI handle also cancels any permission dialog that was
        // waiting on either the legacy vtb-gate transport or a harness control.
        // The harness emits SessionClosed too, so this operation is idempotent.
        //
        // Keep the socket guard alive until `close` finishes by retaining
        // `session` for the duration of the await.
        let active_turn = session
            .active_turn
            .lock()
            .map_err(|_| LocalChatSessionError::SendFailed("Claude turn state is poisoned".into()))?
            .take();
        let interrupt_error = if let Some(turn) = active_turn {
            turn.interrupt().await.err()
        } else {
            None
        };
        let close_result = session.handle.close().await;
        match (interrupt_error, close_result) {
            (_, Ok(_)) => Ok(()),
            (None, Err(error)) => Err(LocalChatSessionError::SendFailed(error.to_string())),
            (Some(interrupt), Err(close)) => Err(LocalChatSessionError::SendFailed(format!(
                "failed to interrupt active Claude turn: {interrupt}; failed to close Claude session: {close}"
            ))),
        }
    }

    pub(crate) async fn has_session(&self, session_id: &str) -> bool {
        self.sessions.read().await.contains_key(session_id)
    }
}

impl Default for ClaudeSessionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

struct PreparedSession {
    working_dir: PathBuf,
    model: Option<String>,
    model_warning: Option<String>,
    provider_config: ClaudeProviderConfig,
    plugin_resolution: ClaudePluginDirResolution,
    #[cfg(unix)]
    permission_socket: Option<crate::local_chat::permissions::PermissionSocketGuard>,
}

impl PreparedSession {
    fn new(
        input: &HarnessCreateSessionInput,
        runtime: &LocalChatRuntime,
    ) -> Result<Self, LocalChatSessionError> {
        let app_handle = runtime.app_handle().ok_or_else(|| {
            LocalChatSessionError::SpawnFailed(
                "Tauri app handle is required to start a Claude session".into(),
            )
        })?;
        let working_dir = resolve_working_dir(input.working_dir.clone(), &app_handle)
            .map(PathBuf::from)
            .ok_or_else(|| {
                LocalChatSessionError::StartFailed(
                    "Cannot start Claude session without a selected project path".into(),
                )
            })?;
        if !working_dir.is_dir() {
            return Err(LocalChatSessionError::StartFailed(format!(
                "Working directory does not exist or is not a directory: {}",
                working_dir.display()
            )));
        }

        let claude_binary = find_claude_binary().map_err(LocalChatSessionError::SpawnFailed)?;
        let augmented_path = build_augmented_path();
        let plugin_resolution =
            resolve_claude_plugin_dir(&claude_binary, &working_dir, &augmented_path);
        let gate = find_vtb_gate_binary().map_err(LocalChatSessionError::StartFailed)?;
        #[cfg(unix)]
        let permission_socket = runtime
            .permission_bridge()
            .start_socket(&input.backend_session_id, app_handle)
            .map_err(LocalChatSessionError::StartFailed)?;

        let resolved_model = resolve_requested_claude_model(
            input.model_id.clone(),
            input.provider_resume_id.is_some(),
        );
        let root_locator_dir = claude_project_directory(&working_dir);
        let provider_config = build_provider_config(
            claude_binary,
            &augmented_path,
            &plugin_resolution,
            gate,
            &input.backend_session_id,
            input.permission_mode.as_ref(),
            root_locator_dir,
            #[cfg(unix)]
            Some(permission_socket.path()),
            #[cfg(not(unix))]
            None,
        );

        Ok(Self {
            working_dir,
            model: resolved_model.model_id,
            model_warning: resolved_model.warning,
            provider_config,
            plugin_resolution,
            #[cfg(unix)]
            permission_socket: Some(permission_socket),
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn build_provider_config(
    claude_binary: PathBuf,
    augmented_path: &str,
    plugin_resolution: &ClaudePluginDirResolution,
    gate: PathBuf,
    backend_session_id: &str,
    permission_mode: Option<&PermissionMode>,
    root_locator_dir: PathBuf,
    permission_socket: Option<&Path>,
) -> ClaudeProviderConfig {
    let mut environment = BTreeMap::from([(
        "VTB_CLAUDE_SESSION_ID".to_string(),
        backend_session_id.to_string(),
    )]);
    if let Some(permission_socket) = permission_socket {
        environment.insert(
            "VTB_GATE_SOCKET".to_string(),
            permission_socket.to_string_lossy().into_owned(),
        );
    }
    ClaudeProviderConfig {
        executable: Some(claude_binary),
        search_path: Some(OsString::from(augmented_path)),
        environment,
        plugin_roots: plugin_resolution.plugin_root.clone().into_iter().collect(),
        permission_mode: permission_mode.map(claude_permission_mode),
        permission_prompt_tool: Some("mcp__vtb-gate__permission_prompt".into()),
        mcp_config: Some(serde_json::json!({
            "mcpServers": { "vtb-gate": { "command": gate } }
        })),
        root_locator_resolver: Some(Arc::new(move |session_id: &SessionId| {
            Ok(Some(ProviderThreadRef::new(
                root_locator_dir
                    .join(format!("{}.jsonl", session_id.as_str()))
                    .to_string_lossy()
                    .into_owned(),
            )))
        })),
        ..ClaudeProviderConfig::default()
    }
}

async fn send_turn(
    handle: &Arc<dyn SessionHandle>,
    active_turn: &Arc<Mutex<Option<Arc<dyn vertebrae_harness_core::TurnHandle>>>>,
    content: String,
) -> Result<(), HarnessError> {
    let turn = handle
        .send(SendTurnRequest {
            turn_id: TurnId::new(uuid::Uuid::new_v4().to_string()),
            content,
            output_schema: None,
        })
        .await?;
    active_turn
        .lock()
        .map_err(|_| HarnessError::Operation("Claude turn state is poisoned".into()))?
        .replace(turn.clone());
    let active_turn = active_turn.clone();
    let turn_id = turn.turn_id().clone();
    tokio::spawn(async move {
        if let Err(error) = turn.await_outcome().await {
            log::warn!("Claude harness turn ended without an outcome: {}", error);
        }
        if let Ok(mut active) = active_turn.lock() {
            if active
                .as_ref()
                .is_some_and(|candidate| candidate.turn_id() == &turn_id)
            {
                active.take();
            }
        }
    });
    Ok(())
}

fn start_error(error: HarnessError) -> LocalChatSessionError {
    match error {
        HarnessError::Unavailable(message) => LocalChatSessionError::SpawnFailed(message),
        error => LocalChatSessionError::StartFailed(error.to_string()),
    }
}

fn send_error(error: HarnessError) -> LocalChatSessionError {
    LocalChatSessionError::SendFailed(error.to_string())
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

fn current_project_path<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> Option<String> {
    let state = app_handle.try_state::<AppState>()?;
    let slug = state.project_config.get_current_project()?;
    match vertebrae_sacrum_client::load_config_file() {
        Ok(config) => config
            .projects
            .get(&slug)
            .map(|project| project.path.clone()),
        Err(error) => {
            log::warn!(
                "Failed to load config while resolving current project path: {}",
                error
            );
            None
        }
    }
}

fn resolve_working_dir<R: tauri::Runtime>(
    working_dir: Option<String>,
    app_handle: &tauri::AppHandle<R>,
) -> Option<String> {
    working_dir
        .filter(|dir| !dir.trim().is_empty())
        .or_else(|| current_project_path(app_handle))
        .filter(|dir| !dir.trim().is_empty())
}

fn claude_project_directory(working_dir: &Path) -> PathBuf {
    let encoded = working_dir
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
        .join(encoded)
}

fn report_plugin_dir_resolution(
    event_sink: &LocalChatEventSink,
    session_id: &str,
    resolution: &ClaudePluginDirResolution,
) {
    if let Some(warning) = &resolution.warning {
        log::warn!("{}", warning);
        emit_warning(event_sink, session_id, warning.clone());
    } else if let Some(plugin_root) = &resolution.plugin_root {
        log::info!(
            "Loading Vertebrae-installed Claude skills from plugin root: {}",
            plugin_root.display()
        );
    }
}

fn emit_start_error(event_sink: &LocalChatEventSink, session_id: &str, error: String) {
    event_sink.emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
        backend_session_id: session_id.to_string(),
        harness: LocalChatHarnessKind::Claude,
        error,
    }));
}

fn emit_warning(event_sink: &LocalChatEventSink, session_id: &str, warning: String) {
    event_sink.emit(LocalChatEvent::Warning(LocalChatSessionWarningEvent {
        backend_session_id: session_id.to_string(),
        harness: LocalChatHarnessKind::Claude,
        warning,
    }));
}

#[cfg(test)]
mod tests;
