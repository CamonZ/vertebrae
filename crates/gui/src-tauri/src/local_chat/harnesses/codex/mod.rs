use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, ToSocketAddrs};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio::time::{sleep, Instant};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tungstenite::Message;

use crate::helpers::find_codex_binary;
use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatEventSink, LocalChatHarness,
    LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatModelOption,
    LocalChatReasoningEffortOption, LocalChatRuntime, LocalChatSessionEndEvent,
    LocalChatSessionError, LocalChatSessionErrorEvent, LocalChatSessionInitEvent,
    LocalChatSessionUsageEvent, LocalChatSessionWarningEvent, LocalChatTextEvent,
    LocalChatToolCallEvent, LocalChatToolResultEvent,
};
use crate::types::PermissionMode;

const CODEX_DEFAULT_MODEL_ID: &str = "default";
const CODEX_DEFAULT_MODEL_LABEL: &str = "Codex default";
const CODEX_DEFAULT_REASONING_EFFORT: &str = "medium";
const APP_SERVER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const APP_SERVER_READY_POLL: Duration = Duration::from_millis(50);
const APP_SERVER_LAUNCH_ATTEMPTS: usize = 3;

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
    fn with_launcher_for_tests(launcher: Arc<dyn CodexAppServerLauncher>) -> Self {
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
        session.run_turn(content, TurnFailureSurface::Send).await
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

struct CodexLocalChatSession {
    backend_session_id: String,
    thread_id: String,
    event_sink: LocalChatEventSink,
    connection: CodexRpcConnection,
    process: Mutex<Option<Child>>,
    stats: Mutex<SessionStats>,
    permission_settings: CodexPermissionSettings,
    turn_lock: Mutex<()>,
}

impl CodexLocalChatSession {
    async fn run_turn(
        &self,
        content: &str,
        failure_surface: TurnFailureSurface,
    ) -> Result<(), LocalChatSessionError> {
        let num_turns = {
            let stats = self.stats.lock().await;
            stats.num_turns.saturating_add(1)
        };
        let _turn_lock = self.turn_lock.lock().await;
        let outcome = match self
            .connection
            .start_turn(TurnRequest {
                thread_id: &self.thread_id,
                content,
                num_turns,
                permission_settings: self.permission_settings,
            })
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                log::error!(
                    "[Codex local chat] turn RPC failed for {}: {}",
                    self.backend_session_id,
                    error
                );
                self.emit_error(error.clone());
                return Err(failure_surface.error(error));
            }
        };

        let mut stats = self.stats.lock().await;
        stats.num_turns = stats.num_turns.saturating_add(1);
        stats.context_tokens = outcome.context_tokens;
        stats.context_window = outcome.context_window;

        if let Some(error) = outcome.error {
            Err(failure_surface.error(error))
        } else {
            Ok(())
        }
    }

    async fn shutdown(&self) {
        let _ = self.connection.close().await;

        let mut process = self.process.lock().await;
        stop_process(&mut process).await;
    }

    fn emit_error(&self, error: String) {
        self.event_sink
            .emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                error,
            }));
    }
}

async fn stop_process(process: &mut Option<Child>) {
    if let Some(child) = process.as_mut() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    *process = None;
}

#[derive(Default)]
struct SessionStats {
    num_turns: u32,
    context_tokens: u32,
    context_window: u32,
}

#[derive(Default)]
struct CodexThreadState {
    child_thread_parents: HashMap<String, String>,
    parent_child_threads: HashMap<String, HashSet<String>>,
    parent_child_statuses: HashMap<String, HashMap<String, String>>,
    child_turn_results: HashMap<ChildTurnKey, String>,
    emitted_synthetic_spawn_tool_ids: HashSet<String>,
    completed_parent_spawn_tool_ids: HashSet<String>,
}

impl CodexThreadState {
    fn remember_child_thread_parents(&mut self, item: &Value, tool_id: &str) {
        let child_keys = collab_agent_identity_keys(item);
        let is_spawn_agent = item
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("spawnAgent")
            == "spawnAgent";
        if is_spawn_agent {
            let child_thread_ids = collab_receiver_thread_id_strings(item);
            if !child_thread_ids.is_empty() {
                self.parent_child_threads
                    .entry(tool_id.to_string())
                    .or_default()
                    .extend(child_thread_ids);
            }
        }
        for child_key in child_keys {
            if is_spawn_agent {
                self.child_thread_parents
                    .insert(child_key, tool_id.to_string());
            } else {
                self.child_thread_parents
                    .entry(child_key)
                    .or_insert_with(|| tool_id.to_string());
            }
        }
    }

    fn parent_tool_use_id_for_notification(&self, params: &Value) -> Option<String> {
        collab_agent_identity_keys(params)
            .into_iter()
            .find_map(|key| self.child_thread_parents.get(&key).cloned())
    }

    fn ensure_parent_for_child_notification(
        &mut self,
        params: &Value,
    ) -> Option<SyntheticSpawnParent> {
        if let Some(tool_id) = self.parent_tool_use_id_for_notification(params) {
            return Some(SyntheticSpawnParent {
                tool_id,
                should_emit: false,
            });
        }

        let keys = collab_agent_identity_keys(params);
        let agent_key = keys.first()?.to_string();
        let tool_id = format!("agent:{agent_key}");
        for key in keys {
            self.child_thread_parents
                .entry(key)
                .or_insert_with(|| tool_id.clone());
        }
        let should_emit = self
            .emitted_synthetic_spawn_tool_ids
            .insert(tool_id.clone());
        Some(SyntheticSpawnParent {
            tool_id,
            should_emit,
        })
    }

    fn remember_child_turn_result(&mut self, thread_id: &str, turn_id: Option<&str>, text: String) {
        self.child_turn_results
            .insert(ChildTurnKey::new(thread_id, turn_id), text);
    }

    fn take_child_turn_result(&mut self, thread_id: &str, turn_id: Option<&str>) -> Option<String> {
        self.child_turn_results
            .remove(&ChildTurnKey::new(thread_id, turn_id))
            .or_else(|| {
                if turn_id.is_some() {
                    self.child_turn_results
                        .remove(&ChildTurnKey::new(thread_id, None))
                } else {
                    None
                }
            })
    }

    fn record_child_thread_status(
        &mut self,
        parent_tool_use_id: &str,
        thread_id: &str,
        status: &str,
    ) -> Option<bool> {
        self.parent_child_threads
            .entry(parent_tool_use_id.to_string())
            .or_default()
            .insert(thread_id.to_string());
        self.parent_child_statuses
            .entry(parent_tool_use_id.to_string())
            .or_default()
            .insert(thread_id.to_string(), status.to_string());
        if !is_terminal_child_status(status) {
            return None;
        }
        let child_threads = self.parent_child_threads.get(parent_tool_use_id)?;
        let statuses = self.parent_child_statuses.get(parent_tool_use_id)?;
        let all_terminal = child_threads.iter().all(|thread_id| {
            statuses
                .get(thread_id)
                .is_some_and(|status| is_terminal_child_status(status))
        });
        if !all_terminal {
            return None;
        }
        if !self
            .completed_parent_spawn_tool_ids
            .insert(parent_tool_use_id.to_string())
        {
            return None;
        }
        Some(
            statuses
                .values()
                .any(|status| is_error_child_status(status)),
        )
    }
}

#[derive(Hash, Eq, PartialEq)]
struct ChildTurnKey {
    thread_id: String,
    turn_id: String,
}

impl ChildTurnKey {
    fn new(thread_id: &str, turn_id: Option<&str>) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.unwrap_or_default().to_string(),
        }
    }
}

struct SyntheticSpawnParent {
    tool_id: String,
    should_emit: bool,
}

#[derive(Clone, Copy)]
enum TurnFailureSurface {
    Start,
    Send,
}

impl TurnFailureSurface {
    fn error(self, message: String) -> LocalChatSessionError {
        match self {
            TurnFailureSurface::Start => LocalChatSessionError::StartFailed(message),
            TurnFailureSurface::Send => LocalChatSessionError::SendFailed(message),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct CodexPermissionSettings {
    approval_policy: Option<&'static str>,
    permissions: Option<&'static str>,
}

impl CodexPermissionSettings {
    fn from_permission_mode(permission_mode: Option<&PermissionMode>) -> Self {
        match permission_mode {
            Some(PermissionMode::AcceptEdits) => Self {
                approval_policy: Some("on-request"),
                permissions: Some(":workspace"),
            },
            Some(PermissionMode::Auto) => Self {
                approval_policy: Some("on-failure"),
                permissions: Some(":workspace"),
            },
            Some(PermissionMode::BypassPermissions) => Self {
                approval_policy: Some("never"),
                permissions: Some(":danger-full-access"),
            },
            Some(PermissionMode::Default) => Self {
                approval_policy: Some("on-request"),
                permissions: Some(":read-only"),
            },
            Some(PermissionMode::DontAsk) => Self {
                approval_policy: Some("never"),
                permissions: Some(":workspace"),
            },
            Some(PermissionMode::Plan) => Self {
                approval_policy: Some("never"),
                permissions: Some(":read-only"),
            },
            None => Self::default(),
        }
    }

    fn apply_to_params(self, params: &mut Value) {
        if let Some(approval_policy) = self.approval_policy {
            params["approvalPolicy"] = json!(approval_policy);
        }
        if let Some(permissions) = self.permissions {
            params["permissions"] = json!(permissions);
        }
    }
}

struct ThreadRequest<'a> {
    provider_resume_id: Option<&'a str>,
    working_dir: Option<&'a str>,
    model: Option<&'a str>,
    reasoning_effort: Option<&'a str>,
    permission_settings: CodexPermissionSettings,
}

struct ThreadStart {
    thread_id: String,
    model: String,
}

struct TurnRequest<'a> {
    thread_id: &'a str,
    content: &'a str,
    num_turns: u32,
    permission_settings: CodexPermissionSettings,
}

struct TurnOutcome {
    context_tokens: u32,
    context_window: u32,
    error: Option<String>,
}

type CodexWsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type CodexWsWriter = SplitSink<CodexWsStream, Message>;
type CodexWsReader = SplitStream<CodexWsStream>;
type PendingResponses = Arc<Mutex<HashMap<u64, PendingRpcResponse>>>;

struct PendingRpcResponse {
    method: &'static str,
    tx: oneshot::Sender<Result<Value, String>>,
}

struct CodexRpcConnection {
    writer: Arc<Mutex<CodexWsWriter>>,
    next_id: Mutex<u64>,
    pending_responses: PendingResponses,
    notification_handler: Arc<StdMutex<TurnNotificationHandler>>,
    reader_task: JoinHandle<()>,
}

impl CodexRpcConnection {
    async fn connect(
        ws_url: &str,
        backend_session_id: String,
        event_sink: LocalChatEventSink,
        thread_state: Arc<StdMutex<CodexThreadState>>,
    ) -> Result<Self, String> {
        log::info!(
            "[Codex local chat] connecting to app-server websocket: {}",
            ws_url
        );
        let (stream, _) = connect_async(ws_url)
            .await
            .map_err(|err| format!("Failed to connect to Codex app-server websocket: {err}"))?;
        let (writer, reader) = stream.split();
        let writer = Arc::new(Mutex::new(writer));
        let pending_responses = Arc::new(Mutex::new(HashMap::new()));
        let notification_handler = Arc::new(StdMutex::new(TurnNotificationHandler::new(
            backend_session_id,
            event_sink,
            thread_state,
        )));
        let reader_task = spawn_codex_reader(
            reader,
            writer.clone(),
            pending_responses.clone(),
            notification_handler.clone(),
        );
        Ok(Self {
            writer,
            next_id: Mutex::new(1),
            pending_responses,
            notification_handler,
            reader_task,
        })
    }

    async fn initialize(&self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "vertebrae_local_chat",
                    "title": "Vertebrae Local Chat",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true,
                },
            }),
        )
        .await?;
        self.notify("initialized", json!({})).await
    }

    async fn start_or_resume_thread(
        &self,
        request: ThreadRequest<'_>,
    ) -> Result<ThreadStart, String> {
        let (method, mut params) = if let Some(thread_id) = request.provider_resume_id {
            (
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "excludeTurns": true,
                }),
            )
        } else {
            (
                "thread/start",
                json!({
                    "serviceName": "vertebrae_local_chat",
                }),
            )
        };

        if let Some(working_dir) = request.working_dir {
            params["cwd"] = json!(working_dir);
        }
        if let Some(model) = request.model {
            params["model"] = json!(model);
        }
        if let Some(reasoning_effort) = request.reasoning_effort {
            params["effort"] = json!(reasoning_effort);
        }
        request.permission_settings.apply_to_params(&mut params);

        let response = self.request(method, params).await?;
        let thread_id = response
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{method} response did not include thread.id"))?
            .to_string();
        let model = response
            .get("model")
            .and_then(Value::as_str)
            .or(request.model)
            .unwrap_or(CODEX_DEFAULT_MODEL_LABEL)
            .to_string();
        self.notification_handler
            .lock()
            .expect("codex notification handler lock poisoned")
            .set_thread(thread_id.clone(), model.clone());

        Ok(ThreadStart { thread_id, model })
    }

    async fn start_turn(&self, request: TurnRequest<'_>) -> Result<TurnOutcome, String> {
        let mut params = json!({
            "threadId": request.thread_id,
            "input": [
                {
                    "type": "text",
                    "text": request.content,
                }
            ],
        });
        request.permission_settings.apply_to_params(&mut params);
        let (completion_tx, completion_rx) = oneshot::channel();
        self.notification_handler
            .lock()
            .expect("codex notification handler lock poisoned")
            .begin_turn(request.num_turns, completion_tx);
        let response = match self.request("turn/start", params).await {
            Ok(response) => response,
            Err(error) => {
                self.notification_handler
                    .lock()
                    .expect("codex notification handler lock poisoned")
                    .clear_active_turn();
                return Err(error);
            }
        };
        let turn_id = match response.pointer("/turn/id").and_then(Value::as_str) {
            Some(turn_id) => turn_id.to_string(),
            None => {
                self.notification_handler
                    .lock()
                    .expect("codex notification handler lock poisoned")
                    .clear_active_turn();
                return Err("turn/start response did not include turn.id".to_string());
            }
        };
        self.notification_handler
            .lock()
            .expect("codex notification handler lock poisoned")
            .set_expected_turn_id(&turn_id);

        completion_rx
            .await
            .map_err(|_| "Codex app-server turn completion channel closed".to_string())
    }

    async fn request(&self, method: &'static str, params: Value) -> Result<Value, String> {
        let id = {
            let mut next_id = self.next_id.lock().await;
            let id = *next_id;
            *next_id += 1;
            id
        };
        let (tx, rx) = oneshot::channel();
        self.pending_responses
            .lock()
            .await
            .insert(id, PendingRpcResponse { method, tx });
        if let Err(error) = self
            .send_json(&json!({
            "id": id,
            "method": method,
            "params": params,
            }))
            .await
        {
            self.pending_responses.lock().await.remove(&id);
            return Err(error);
        }
        log::info!("[Codex local chat] RPC request sent: method={method}, id={id}");

        let response = rx
            .await
            .map_err(|_| format!("Codex app-server response channel closed for {method}"))??;
        log::info!("[Codex local chat] RPC response received: method={method}, id={id}");
        Ok(response)
    }

    async fn notify(&self, method: &'static str, params: Value) -> Result<(), String> {
        self.send_json(&json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn close(&self) -> Result<(), String> {
        self.reader_task.abort();
        self.writer
            .lock()
            .await
            .close()
            .await
            .map_err(|err| format!("Failed to close Codex app-server websocket: {err}"))
    }

    async fn send_json(&self, value: &Value) -> Result<(), String> {
        send_codex_json(&self.writer, value).await
    }
}

fn spawn_codex_reader(
    mut reader: CodexWsReader,
    writer: Arc<Mutex<CodexWsWriter>>,
    pending_responses: PendingResponses,
    notification_handler: Arc<StdMutex<TurnNotificationHandler>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let failure = loop {
            let Some(frame) = reader.next().await else {
                break "Codex app-server websocket ended".to_string();
            };
            let frame = match frame {
                Ok(frame) => frame,
                Err(error) => {
                    break format!("Failed to read Codex app-server response: {error}");
                }
            };
            let Some(message) = decode_codex_websocket_frame(frame) else {
                continue;
            };
            match message {
                Ok(message) => {
                    handle_codex_reader_message(
                        message,
                        &writer,
                        &pending_responses,
                        &notification_handler,
                    )
                    .await;
                }
                Err(error) => break error,
            }
        };
        fail_pending_codex_responses(&pending_responses, &failure).await;
        notification_handler
            .lock()
            .expect("codex notification handler lock poisoned")
            .fail_active_turn(failure);
    })
}

fn decode_codex_websocket_frame(frame: Message) -> Option<Result<RpcMessage, String>> {
    match frame {
        Message::Text(text) => {
            let raw_text = text.to_string();
            log::debug!("[Codex local chat] received websocket message: {raw_text}");
            let json: Value = match serde_json::from_str(&raw_text) {
                Ok(json) => json,
                Err(error) => {
                    return Some(Err(format!("Invalid Codex app-server JSON frame: {error}")));
                }
            };
            Some(
                serde_json::from_value(json)
                    .map_err(|error| format!("Invalid Codex app-server JSON frame: {error}")),
            )
        }
        Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => None,
        Message::Close(_) => Some(Err("Codex app-server websocket closed".to_string())),
    }
}

async fn handle_codex_reader_message(
    message: RpcMessage,
    writer: &Arc<Mutex<CodexWsWriter>>,
    pending_responses: &PendingResponses,
    notification_handler: &Arc<StdMutex<TurnNotificationHandler>>,
) {
    if let Some(message_id) = message.id.as_ref().and_then(Value::as_u64) {
        if message.method.is_none() {
            let response = if let Some(error) = message.error {
                log::error!(
                    "[Codex local chat] RPC error response: id={}, code={}, message={}",
                    message_id,
                    error.code,
                    error.message
                );
                Err(format!("{} ({})", error.message, error.code))
            } else {
                Ok(message.result.unwrap_or(Value::Null))
            };
            if let Some(pending) = pending_responses.lock().await.remove(&message_id) {
                if let Ok(response_value) = &response {
                    remember_root_thread_from_response(
                        pending.method,
                        response_value,
                        notification_handler,
                    );
                }
                let _ = pending.tx.send(response);
            } else {
                log::debug!(
                    "[Codex local chat] ignoring response for unknown app-server request id={message_id}"
                );
            }
            return;
        }
    }

    if let (Some(id), Some(method)) = (message.id.as_ref(), message.method.as_deref()) {
        log::info!(
            "[Codex local chat] app-server request received asynchronously: method={method}, id={id}"
        );
        notification_handler
            .lock()
            .expect("codex notification handler lock poisoned")
            .emit_approval_warning(method);
        respond_to_codex_server_request(writer, id.clone(), method).await;
        return;
    }

    if let (Some(method), Some(params)) = (message.method.as_deref(), message.params.as_ref()) {
        notification_handler
            .lock()
            .expect("codex notification handler lock poisoned")
            .handle(method, params);
    }
}

fn remember_root_thread_from_response(
    method: &str,
    response: &Value,
    notification_handler: &Arc<StdMutex<TurnNotificationHandler>>,
) {
    if !matches!(method, "thread/start" | "thread/resume") {
        return;
    }
    let Some(thread_id) = response.pointer("/thread/id").and_then(Value::as_str) else {
        return;
    };
    let model = response
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(CODEX_DEFAULT_MODEL_LABEL);
    notification_handler
        .lock()
        .expect("codex notification handler lock poisoned")
        .set_thread(thread_id.to_string(), model.to_string());
}

async fn respond_to_codex_server_request(
    writer: &Arc<Mutex<CodexWsWriter>>,
    id: Value,
    method: &str,
) {
    let response = if let Some(result) = fallback_server_request_result(method) {
        json!({
            "id": id,
            "result": result,
        })
    } else {
        json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("Vertebrae local chat does not handle Codex server request '{method}' yet"),
            },
        })
    };
    if let Err(error) = send_codex_json(writer, &response).await {
        log::warn!("[Codex local chat] failed to respond to app-server request: {error}");
    }
}

async fn fail_pending_codex_responses(pending_responses: &PendingResponses, error: &str) {
    let pending = std::mem::take(&mut *pending_responses.lock().await);
    for (_id, pending) in pending {
        let _ = pending.tx.send(Err(error.to_string()));
    }
}

async fn send_codex_json(writer: &Arc<Mutex<CodexWsWriter>>, value: &Value) -> Result<(), String> {
    writer
        .lock()
        .await
        .send(Message::Text(value.to_string()))
        .await
        .map_err(|err| format!("Failed to send Codex app-server request: {err}"))
}

#[derive(serde::Deserialize)]
struct RpcMessage {
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<RpcError>,
}

#[derive(serde::Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

fn fallback_server_request_result(method: &str) -> Option<Value> {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            Some(json!({ "decision": "decline" }))
        }
        "item/permissions/requestApproval" => Some(json!({ "permissions": {}, "scope": "turn" })),
        _ => None,
    }
}

fn approval_request_kind(method: &str) -> Option<&'static str> {
    match method {
        "item/commandExecution/requestApproval" => Some("command execution"),
        "item/fileChange/requestApproval" => Some("file change"),
        "item/permissions/requestApproval" => Some("additional permission"),
        _ => None,
    }
}

fn is_turn_notification(method: &str) -> bool {
    matches!(
        method,
        "item/agentMessage/delta"
            | "item/started"
            | "item/completed"
            | "thread/tokenUsage/updated"
            | "turn/completed"
            | "error"
    )
}

fn useful_json_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
        _ => true,
    }
}

fn first_value_at(item: &Value, paths: &[&str]) -> Value {
    paths
        .iter()
        .filter_map(|path| item.pointer(path))
        .find(|value| useful_json_value(value))
        .cloned()
        .unwrap_or(Value::Null)
}

fn collab_agent_nickname(item: &Value) -> Value {
    first_value_at(
        item,
        &[
            "/newAgentNickname",
            "/receiverAgentNickname",
            "/agentNickname",
            "/nickname",
            "/name",
            "/newAgent/nickname",
            "/newAgent/agentNickname",
            "/receiverAgent/nickname",
            "/receiverAgent/agentNickname",
            "/agent/nickname",
            "/agent/agentNickname",
            "/result/nickname",
            "/result/agentNickname",
            "/result/agent_nickname",
            "/output/nickname",
            "/output/agentNickname",
            "/response/nickname",
            "/response/agentNickname",
        ],
    )
}

fn collab_agent_role(item: &Value) -> Value {
    first_value_at(
        item,
        &[
            "/newAgentRole",
            "/receiverAgentRole",
            "/agentRole",
            "/role",
            "/newAgent/role",
            "/newAgent/agentRole",
            "/receiverAgent/role",
            "/receiverAgent/agentRole",
            "/agent/role",
            "/agent/agentRole",
            "/result/role",
            "/result/agentRole",
            "/result/agent_role",
            "/output/role",
            "/output/agentRole",
            "/response/role",
            "/response/agentRole",
        ],
    )
}

fn collab_agent_thread_id(item: &Value) -> Value {
    first_value_at(
        item,
        &[
            "/receiverThreadIds/0",
            "/receiverThreadId",
            "/threadId",
            "/thread_id",
            "/agentId",
            "/agent_id",
            "/agentPath",
            "/agent_path",
            "/path",
            "/newAgent/threadId",
            "/newAgent/agentId",
            "/newAgent/agentPath",
            "/receiverAgent/threadId",
            "/receiverAgent/agentId",
            "/receiverAgent/agentPath",
            "/agent/threadId",
            "/agent/agentId",
            "/agent/agentPath",
            "/result/threadId",
            "/result/thread_id",
            "/result/agentId",
            "/result/agent_id",
            "/result/agentPath",
            "/result/agent_path",
            "/result/path",
            "/result/id",
            "/output/agentId",
            "/output/agentPath",
            "/response/agentId",
            "/response/agentPath",
        ],
    )
}

fn collab_receiver_thread_ids(item: &Value) -> Value {
    item.get("receiverThreadIds")
        .filter(|value| useful_json_value(value))
        .cloned()
        .unwrap_or_else(|| {
            let thread_id = collab_agent_thread_id(item);
            if useful_json_value(&thread_id) {
                json!([thread_id])
            } else {
                Value::Null
            }
        })
}

fn collab_receiver_thread_id_strings(item: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(values) = collab_receiver_thread_ids(item).as_array() {
        ids.extend(values.iter().filter_map(Value::as_str).filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        }));
    }
    ids.sort();
    ids.dedup();
    ids
}

fn collab_receiver_agents(item: &Value) -> Value {
    item.get("receiverAgents")
        .filter(|value| useful_json_value(value))
        .cloned()
        .unwrap_or_else(|| {
            let thread_id = collab_agent_thread_id(item);
            let nickname = collab_agent_nickname(item);
            let role = collab_agent_role(item);
            if useful_json_value(&thread_id)
                || useful_json_value(&nickname)
                || useful_json_value(&role)
            {
                json!([{
                    "threadId": thread_id,
                    "agentNickname": nickname,
                    "agentRole": role,
                }])
            } else {
                Value::Null
            }
        })
}

fn string_values_at(item: &Value, paths: &[&str]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| item.pointer(path).and_then(Value::as_str))
        .filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
        .collect()
}

fn is_terminal_child_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed"
            | "complete"
            | "succeeded"
            | "success"
            | "done"
            | "failed"
            | "error"
            | "system_error"
            | "systemerror"
            | "cancelled"
            | "canceled"
            | "timed_out"
            | "timedout"
    )
}

fn is_error_child_status(status: &str) -> bool {
    !matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "complete" | "succeeded" | "success" | "done"
    )
}

fn string_array_at(item: &Value, paths: &[&str]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| item.pointer(path).and_then(Value::as_array))
        .flat_map(|values| values.iter().filter_map(Value::as_str))
        .filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
        .collect()
}

fn collab_agent_identity_keys(item: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    keys.extend(string_array_at(
        item,
        &[
            "/receiverThreadIds",
            "/receiver_thread_ids",
            "/result/receiverThreadIds",
            "/result/receiver_thread_ids",
            "/output/receiverThreadIds",
            "/response/receiverThreadIds",
        ],
    ));
    keys.extend(string_values_at(
        item,
        &[
            "/threadId",
            "/thread_id",
            "/receiverThreadId",
            "/receiver_thread_id",
            "/agentId",
            "/agent_id",
            "/agentPath",
            "/agent_path",
            "/path",
            "/id",
            "/newAgent/threadId",
            "/newAgent/thread_id",
            "/newAgent/agentId",
            "/newAgent/agent_id",
            "/newAgent/agentPath",
            "/newAgent/agent_path",
            "/receiverAgent/threadId",
            "/receiverAgent/thread_id",
            "/receiverAgent/agentId",
            "/receiverAgent/agent_id",
            "/receiverAgent/agentPath",
            "/receiverAgent/agent_path",
            "/agent/threadId",
            "/agent/thread_id",
            "/agent/agentId",
            "/agent/agent_id",
            "/agent/agentPath",
            "/agent/agent_path",
            "/item/threadId",
            "/item/thread_id",
            "/item/agentId",
            "/item/agent_id",
            "/item/agentPath",
            "/item/agent_path",
            "/result/threadId",
            "/result/thread_id",
            "/result/agentId",
            "/result/agent_id",
            "/result/agentPath",
            "/result/agent_path",
            "/result/path",
            "/result/id",
            "/output/threadId",
            "/output/agentId",
            "/output/agentPath",
            "/response/threadId",
            "/response/agentId",
            "/response/agentPath",
        ],
    ));
    for path in [
        "/receiverAgents",
        "/receiver_agents",
        "/agentStatuses",
        "/agent_statuses",
        "/result/receiverAgents",
        "/result/agentStatuses",
    ] {
        let Some(values) = item.pointer(path).and_then(Value::as_array) else {
            continue;
        };
        for value in values {
            keys.extend(string_values_at(
                value,
                &[
                    "/threadId",
                    "/thread_id",
                    "/receiverThreadId",
                    "/receiver_thread_id",
                    "/agentId",
                    "/agent_id",
                    "/agentPath",
                    "/agent_path",
                    "/path",
                    "/id",
                ],
            ));
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

/// Derive a stable id for a `collabAgentToolCall` *spawn* (`tool ==
/// "spawnAgent"`) from the agent identity the item already carries --
/// `receiverThreadIds`, `agentId`/`threadId`, or the spawn result's
/// `agent_id`/`agent_path`/`id` (see [`collab_agent_thread_id`]).
///
/// This mirrors the `agent:${agentPath}` convention the TypeScript rollout
/// hydrator synthesizes for the same spawn (`agentToolId` in
/// `conversation.ts`). Before this, the live path used the app-server item
/// id as `tool_id`, which can never equal the hydration-synthesized id, so a
/// single real spawn produced two irreconcilable spawn cards once a session
/// was reloaded from its rollout file. Returns `None` when no identity is
/// resolvable yet (e.g. `item/started` fires before `receiverThreadIds`/
/// `result` are populated); callers should fall back to the item id in that
/// case so the call still gets *some* stable id for the remainder of its
/// (live-only) lifecycle.
fn collab_agent_spawn_id(item: &Value) -> Option<String> {
    collab_agent_thread_id(item)
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|agent_path| format!("agent:{agent_path}"))
}

fn unresolved_collab_spawn(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall")
        && item
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("spawnAgent")
            == "spawnAgent"
        && collab_agent_spawn_id(item).is_none()
}

fn codex_tool_call(item: &Value) -> Option<(String, String, String)> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let item_id = item.get("id").and_then(Value::as_str)?.to_string();
    let (id, tool_name, input) = match item_type {
        "commandExecution" => (
            item_id,
            "Bash".to_string(),
            json!({
                "command": item.get("command").and_then(Value::as_str).unwrap_or_default(),
                "cwd": item.get("cwd").and_then(Value::as_str),
            }),
        ),
        "fileChange" => (
            item_id,
            "apply_patch".to_string(),
            item.get("changes").cloned().unwrap_or(Value::Null),
        ),
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("mcp");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            (
                item_id,
                format!("{server}.{tool}"),
                item.get("arguments").cloned().unwrap_or(Value::Null),
            )
        }
        "dynamicToolCall" => {
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let namespace = item.get("namespace").and_then(Value::as_str);
            let tool_name = namespace
                .map(|namespace| format!("{namespace}.{tool}"))
                .unwrap_or_else(|| tool.to_string());
            (
                item_id,
                tool_name,
                item.get("arguments").cloned().unwrap_or(Value::Null),
            )
        }
        "webSearch" => (
            item_id,
            "web_search".to_string(),
            Value::Object(Default::default()),
        ),
        "collabAgentToolCall" => {
            let tool = item
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("spawnAgent");
            let tool_name = if tool == "spawnAgent" {
                "Agent"
            } else {
                "agent"
            };
            // Only the spawning call itself is reconciled with hydration;
            // wait_agent/close_agent calls are their own tool cards (see
            // `remember_child_thread_parents`'s `or_insert_with` for
            // non-spawn tools) and keep the item id.
            let id = if tool == "spawnAgent" {
                collab_agent_spawn_id(item).unwrap_or(item_id)
            } else {
                item_id
            };
            (
                id,
                tool_name.to_string(),
                json!({
                    "description": item.get("prompt").and_then(Value::as_str).unwrap_or(tool),
                    "collab_tool": tool,
                    "subagent_type": item.get("model").and_then(Value::as_str).unwrap_or("agent"),
                    "agent_nickname": collab_agent_nickname(item),
                    "agent_role": collab_agent_role(item),
                    "receiver_thread_ids": collab_receiver_thread_ids(item),
                    "receiver_agents": collab_receiver_agents(item),
                    "agent_statuses": item.get("agentStatuses").cloned().unwrap_or(Value::Null),
                    "agents_states": item.get("agentsStates").cloned().unwrap_or(Value::Null),
                }),
            )
        }
        // Plan/todo checklist items. Mirrors the daemon's `codex_jsonl`
        // parser and the exec-shape TS parser (`conversation.ts`'s
        // `todo_list` handling), which model these as `{"items":
        // [{"text","completed"}]}` under an `item.started`/`item.updated`/
        // `item.completed` envelope. Neither of those surfaces reasoning
        // items either, and this harness has no dedicated "plan" event
        // (only tool_call/tool_result), so we render the plan as a
        // `TodoWrite` tool call: at least the checklist shows up as a tool
        // row instead of being silently dropped. Accept both the app-server
        // camelCase spelling used by every other item type here and the
        // snake_case spelling documented upstream, since the exact wire
        // casing for this item hasn't been confirmed against a live server.
        "todoList" | "todo_list" => (
            item_id,
            "TodoWrite".to_string(),
            json!({ "todos": item.get("items").cloned().unwrap_or(Value::Null) }),
        ),
        _ => return None,
    };
    Some((
        id,
        tool_name,
        serde_json::to_string(&input).unwrap_or_default(),
    ))
}

fn codex_tool_result(item: &Value) -> Option<(String, String, bool)> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let item_id = item.get("id").and_then(Value::as_str)?.to_string();
    let (id, result, is_error) = match item_type {
        "commandExecution" => {
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                item_id,
                item.get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                matches!(status, "failed" | "declined"),
            )
        }
        "fileChange" => {
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                item_id,
                serde_json::to_string(item.get("changes").unwrap_or(&Value::Null))
                    .unwrap_or_default(),
                matches!(status, "failed" | "declined"),
            )
        }
        "mcpToolCall" => {
            if let Some(error) = item.get("error") {
                (
                    item_id,
                    serde_json::to_string(error).unwrap_or_default(),
                    true,
                )
            } else {
                (
                    item_id,
                    serde_json::to_string(item.get("result").unwrap_or(&Value::Null))
                        .unwrap_or_default(),
                    item.get("status").and_then(Value::as_str) == Some("failed"),
                )
            }
        }
        "dynamicToolCall" => (
            item_id,
            serde_json::to_string(item.get("contentItems").unwrap_or(&Value::Null))
                .unwrap_or_default(),
            item.get("success").and_then(Value::as_bool) == Some(false)
                || item.get("status").and_then(Value::as_str) == Some("failed"),
        ),
        "webSearch" => (item_id, "Web search completed".to_string(), false),
        "collabAgentToolCall" => {
            // Must resolve to the same id `codex_tool_call` assigned to the
            // matching spawn, or the ToolResult never reconciles with its
            // ToolCall in the GUI (see `collab_agent_spawn_id`).
            let tool = item
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("spawnAgent");
            let id = if tool == "spawnAgent" {
                collab_agent_spawn_id(item).unwrap_or(item_id)
            } else {
                item_id
            };
            (
                id,
                item.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed")
                    .to_string(),
                item.get("status").and_then(Value::as_str) == Some("failed"),
            )
        }
        // See the matching arm in `codex_tool_call` for why plan/todo items
        // are mapped to a tool row rather than dropped. A todo-list update
        // is a status snapshot, not a failure signal, so `is_error` is
        // always `false` here.
        "todoList" | "todo_list" => {
            let items = item
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let completed = items
                .iter()
                .filter(|entry| entry.get("completed").and_then(Value::as_bool) == Some(true))
                .count();
            (
                item_id,
                format!("{completed}/{} steps completed", items.len()),
                false,
            )
        }
        _ => return None,
    };
    Some((id, result, is_error))
}

struct TurnNotificationHandler {
    backend_session_id: String,
    thread_id: String,
    model: String,
    event_sink: LocalChatEventSink,
    active_turn: Option<ActiveTurnState>,
    pending_notifications: Vec<(String, Value)>,
    thread_state: Arc<StdMutex<CodexThreadState>>,
}

impl TurnNotificationHandler {
    fn new(
        backend_session_id: String,
        event_sink: LocalChatEventSink,
        thread_state: Arc<StdMutex<CodexThreadState>>,
    ) -> Self {
        Self {
            backend_session_id,
            thread_id: String::new(),
            model: CODEX_DEFAULT_MODEL_LABEL.to_string(),
            event_sink,
            active_turn: None,
            pending_notifications: Vec::new(),
            thread_state,
        }
    }

    fn set_thread(&mut self, thread_id: String, model: String) {
        self.thread_id = thread_id;
        self.model = model;
    }

    fn begin_turn(&mut self, num_turns: u32, completion_tx: oneshot::Sender<TurnOutcome>) {
        self.active_turn = Some(ActiveTurnState {
            num_turns,
            text: String::new(),
            context_tokens: 0,
            context_window: 0,
            expected_turn_id: None,
            completion_tx: Some(completion_tx),
        });
        self.pending_notifications.clear();
    }

    fn clear_active_turn(&mut self) {
        self.active_turn = None;
        self.pending_notifications.clear();
    }

    fn handle(&mut self, method: &str, params: &Value) {
        let notification_thread_id = params.get("threadId").and_then(Value::as_str);
        let mut parent_tool_use_id = self.parent_tool_use_id_for_notification(params);
        if notification_thread_id != Some(self.thread_id.as_str()) && parent_tool_use_id.is_none() {
            // A Codex session can contain multiple threads. If a child thread
            // races ahead of its parent spawn item, register a minimal stable
            // spawn parent immediately so status/result updates still have a
            // stable Agent row. Child work itself stays in the child thread.
            if notification_thread_id.is_some() {
                if let Some(parent) = self.ensure_parent_for_child_notification(params) {
                    if parent.should_emit {
                        self.emit_synthetic_spawn_parent(params, &parent.tool_id);
                    }
                    parent_tool_use_id = Some(parent.tool_id);
                } else {
                    return;
                }
            } else {
                return;
            }
        }
        if self
            .active_turn
            .as_ref()
            .is_some_and(|turn| turn.expected_turn_id.is_none())
            && parent_tool_use_id.is_none()
            && is_turn_notification(method)
        {
            self.pending_notifications
                .push((method.to_string(), params.clone()));
            return;
        }
        if parent_tool_use_id.is_none()
            && self.active_turn.is_some()
            && !self.matches_expected_turn(method, params)
        {
            return;
        }

        match method {
            "item/agentMessage/delta" => {
                self.handle_agent_delta(params, parent_tool_use_id.as_deref())
            }
            "item/started" => self.handle_item_started(params, parent_tool_use_id.as_deref()),
            "item/completed" => self.handle_item_completed(params, parent_tool_use_id.as_deref()),
            "thread/status/changed" => {
                if let Some(parent_tool_use_id) = parent_tool_use_id.as_deref() {
                    self.handle_child_thread_status(params, parent_tool_use_id);
                }
            }
            "thread/tokenUsage/updated" => {
                if parent_tool_use_id.is_none() {
                    self.handle_usage(params);
                }
            }
            "turn/completed" => {
                if let Some(parent_tool_use_id) = parent_tool_use_id.as_deref() {
                    self.handle_child_turn_completed(params, parent_tool_use_id);
                } else {
                    self.handle_turn_completed(params);
                }
            }
            "error" => self.handle_error(params),
            _ => {}
        }
    }

    fn set_expected_turn_id(&mut self, turn_id: &str) {
        let Some(active_turn) = self.active_turn.as_mut() else {
            return;
        };
        active_turn.expected_turn_id = Some(turn_id.to_string());
        let pending_notifications = std::mem::take(&mut self.pending_notifications);
        for (method, params) in pending_notifications {
            self.handle(&method, &params);
        }
    }

    fn matches_expected_turn(&self, method: &str, params: &Value) -> bool {
        let Some(expected_turn_id) = self
            .active_turn
            .as_ref()
            .and_then(|turn| turn.expected_turn_id.as_deref())
        else {
            return true;
        };
        let turn_id = match method {
            "turn/completed" => params.pointer("/turn/id").and_then(Value::as_str),
            _ => params.get("turnId").and_then(Value::as_str),
        };
        match turn_id {
            Some(turn_id) => turn_id == expected_turn_id,
            None => true,
        }
    }

    fn handle_agent_delta(&mut self, params: &Value, parent_tool_use_id: Option<&str>) {
        let Some(delta) = params.get("delta").and_then(Value::as_str) else {
            return;
        };
        if parent_tool_use_id.is_some() {
            return;
        }
        if parent_tool_use_id.is_none() {
            if let Some(active_turn) = self.active_turn.as_mut() {
                active_turn.text.push_str(delta);
            }
        }
        self.event_sink
            .emit(LocalChatEvent::Text(LocalChatTextEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                text: delta.to_string(),
                is_partial: true,
                parent_tool_use_id: parent_tool_use_id.map(str::to_string),
            }));
    }

    fn handle_item_started(&mut self, params: &Value, parent_tool_use_id: Option<&str>) {
        let Some(item) = params.get("item") else {
            return;
        };
        if parent_tool_use_id.is_some() {
            return;
        }
        if unresolved_collab_spawn(item) {
            return;
        }
        if let Some((tool_id, tool_name, input)) = codex_tool_call(item) {
            if item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall") {
                self.remember_child_thread_parents(item, &tool_id);
            }
            self.event_sink
                .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Codex,
                    tool_id,
                    tool_name,
                    input,
                    parent_tool_use_id: parent_tool_use_id.map(str::to_string),
                }));
        }
    }

    fn handle_item_completed(&mut self, params: &Value, parent_tool_use_id: Option<&str>) {
        let Some(item) = params.get("item") else {
            return;
        };
        if parent_tool_use_id.is_some() {
            self.handle_child_item_completed(params);
            return;
        }
        if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
            self.handle_agent_message_completed(item, parent_tool_use_id);
        }
        if item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall") {
            if let Some((tool_id, tool_name, input)) = codex_tool_call(item) {
                self.remember_child_thread_parents(item, &tool_id);
                self.event_sink
                    .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                        backend_session_id: self.backend_session_id.clone(),
                        harness: LocalChatHarnessKind::Codex,
                        tool_id,
                        tool_name,
                        input,
                        parent_tool_use_id: parent_tool_use_id.map(str::to_string),
                    }));
            }
        }
        if let Some((tool_id, result, is_error)) = codex_tool_result(item) {
            self.event_sink
                .emit(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                    backend_session_id: self.backend_session_id.clone(),
                    harness: LocalChatHarnessKind::Codex,
                    tool_id,
                    result,
                    is_error,
                    parent_tool_use_id: parent_tool_use_id.map(str::to_string),
                }));
        }
    }

    fn handle_child_item_completed(&mut self, params: &Value) {
        let Some(item) = params.get("item") else {
            return;
        };
        if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
            return;
        }
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let Some(text) = item.get("text").and_then(Value::as_str) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        let turn_id = params.get("turnId").and_then(Value::as_str);
        self.thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .remember_child_turn_result(thread_id, turn_id, text.to_string());
    }

    fn handle_agent_message_completed(&mut self, item: &Value, parent_tool_use_id: Option<&str>) {
        let Some(text) = item.get("text").and_then(Value::as_str) else {
            return;
        };
        if text.is_empty() {
            return;
        }
        self.event_sink
            .emit(LocalChatEvent::Text(LocalChatTextEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                text: text.to_string(),
                is_partial: false,
                parent_tool_use_id: parent_tool_use_id.map(str::to_string),
            }));
    }

    fn remember_child_thread_parents(&mut self, item: &Value, tool_id: &str) {
        self.thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .remember_child_thread_parents(item, tool_id);
    }

    fn parent_tool_use_id_for_notification(&self, params: &Value) -> Option<String> {
        self.thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .parent_tool_use_id_for_notification(params)
    }

    fn ensure_parent_for_child_notification(&self, params: &Value) -> Option<SyntheticSpawnParent> {
        self.thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .ensure_parent_for_child_notification(params)
    }

    fn emit_synthetic_spawn_parent(&self, params: &Value, tool_id: &str) {
        let thread_id = params
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or("child-thread");
        self.event_sink
            .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id: tool_id.to_string(),
                tool_name: "Agent".to_string(),
                input: serde_json::to_string(&json!({
                    "collab_tool": "spawnAgent",
                    "receiver_thread_ids": [thread_id],
                    "description": "Agent",
                }))
                .unwrap_or_default(),
                parent_tool_use_id: None,
            }));
    }

    fn handle_usage(&mut self, params: &Value) {
        let Some(active_turn) = self.active_turn.as_mut() else {
            return;
        };
        active_turn.context_tokens = value_to_u32(params.pointer("/tokenUsage/total/totalTokens"))
            .unwrap_or(active_turn.context_tokens);
        active_turn.context_window = value_to_u32(params.pointer("/tokenUsage/modelContextWindow"))
            .unwrap_or(active_turn.context_window);
        self.event_sink
            .emit(LocalChatEvent::Usage(LocalChatSessionUsageEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                model: self.model.clone(),
                context_tokens: active_turn.context_tokens,
                context_window: active_turn.context_window,
            }));
    }

    fn handle_child_thread_status(&self, params: &Value, parent_tool_use_id: &str) {
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let Some(status) = child_thread_status_from_params(params) else {
            return;
        };
        self.emit_child_agent_status(parent_tool_use_id, thread_id, status);
        let parent_done = self
            .thread_state
            .lock()
            .expect("codex local chat thread state lock poisoned")
            .record_child_thread_status(parent_tool_use_id, thread_id, status);
        if let Some(is_error) = parent_done {
            self.emit_parent_agent_completion(parent_tool_use_id, status, is_error);
        }
    }

    fn handle_child_turn_completed(&self, params: &Value, parent_tool_use_id: &str) {
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let turn_id = params.pointer("/turn/id").and_then(Value::as_str);
        let status = params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        self.emit_child_agent_status(parent_tool_use_id, thread_id, status);
        let (parent_done, result) = {
            let mut state = self
                .thread_state
                .lock()
                .expect("codex local chat thread state lock poisoned");
            (
                state.record_child_thread_status(parent_tool_use_id, thread_id, status),
                state.take_child_turn_result(thread_id, turn_id),
            )
        };
        if let Some(is_error) = parent_done {
            self.emit_parent_agent_completion(parent_tool_use_id, status, is_error);
        }
        if let Some(result) = result {
            self.emit_child_agent_result(parent_tool_use_id, thread_id, turn_id, status, result);
        }
    }

    fn emit_parent_agent_completion(&self, parent_tool_use_id: &str, status: &str, is_error: bool) {
        self.event_sink
            .emit(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id: parent_tool_use_id.to_string(),
                result: status.to_string(),
                is_error,
                parent_tool_use_id: None,
            }));
    }

    fn emit_child_agent_status(&self, parent_tool_use_id: &str, thread_id: &str, status: &str) {
        let mut agents_states = serde_json::Map::new();
        agents_states.insert(
            thread_id.to_string(),
            json!({
                "status": status,
                "message": Value::Null,
            }),
        );
        self.event_sink
            .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id: parent_tool_use_id.to_string(),
                tool_name: "Agent".to_string(),
                input: serde_json::to_string(&json!({
                    "collab_tool": "spawnAgent",
                    "receiver_thread_ids": [thread_id],
                    "agents_states": Value::Object(agents_states),
                }))
                .unwrap_or_default(),
                parent_tool_use_id: None,
            }));
    }

    fn emit_child_agent_result(
        &self,
        parent_tool_use_id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
        status: &str,
        result: String,
    ) {
        let tool_id = format!(
            "{parent_tool_use_id}:result:{}",
            turn_id.unwrap_or(thread_id)
        );
        self.event_sink
            .emit(LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id: tool_id.clone(),
                tool_name: "Agent Result".to_string(),
                input: serde_json::to_string(&json!({
                    "collab_tool": "agentResult",
                    "receiver_thread_ids": [thread_id],
                    "parent_tool_use_id": parent_tool_use_id,
                }))
                .unwrap_or_default(),
                parent_tool_use_id: None,
            }));
        self.event_sink
            .emit(LocalChatEvent::ToolResult(LocalChatToolResultEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                tool_id,
                result,
                is_error: status != "completed",
                parent_tool_use_id: None,
            }));
    }

    fn handle_turn_completed(&mut self, params: &Value) {
        let Some(mut active_turn) = self.active_turn.take() else {
            return;
        };
        let status = params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let duration_ms = value_to_u32(params.pointer("/turn/durationMs")).unwrap_or(0);
        let error = if status == "completed" {
            None
        } else {
            Some(codex_error_message(params).unwrap_or_else(|| status.to_string()))
        };

        if let Some(error) = &error {
            log::error!(
                "[Codex local chat] turn completed with error for {}: status={}, error={}, params={}",
                self.backend_session_id,
                status,
                error,
                params
            );
            self.emit_error(error.clone());
        }

        self.event_sink
            .emit(LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                duration_ms,
                cost_usd: 0.0,
                num_turns: active_turn.num_turns,
                result: active_turn.text.clone(),
                is_error: error.is_some(),
                context_tokens: active_turn.context_tokens,
                context_window: active_turn.context_window,
            }));

        let outcome = TurnOutcome {
            context_tokens: active_turn.context_tokens,
            context_window: active_turn.context_window,
            error,
        };
        if let Some(completion_tx) = active_turn.completion_tx.take() {
            let _ = completion_tx.send(outcome);
        }
    }

    fn handle_error(&mut self, params: &Value) {
        let error = codex_error_message(params)
            .unwrap_or_else(|| format!("Codex app-server error: {params}"));
        log::error!(
            "[Codex local chat] app-server error notification for {}: {}",
            self.backend_session_id,
            params
        );
        self.emit_error(error.clone());
        self.finish_active_turn_with_error(error);
    }

    fn emit_error(&self, error: String) {
        self.event_sink
            .emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                error,
            }));
    }

    fn emit_approval_warning(&self, method: &str) {
        let Some(request_kind) = approval_request_kind(method) else {
            return;
        };
        self.event_sink
            .emit(LocalChatEvent::Warning(LocalChatSessionWarningEvent {
                backend_session_id: self.backend_session_id.clone(),
                harness: LocalChatHarnessKind::Codex,
                warning: format!(
                    "Codex requested {request_kind} approval, but Vertebrae local chat does not have a Codex approval UI yet, so the request was denied."
                ),
            }));
    }

    fn fail_active_turn(&mut self, error: String) {
        self.emit_error(error.clone());
        self.finish_active_turn_with_error(error);
    }

    fn finish_active_turn_with_error(&mut self, error: String) {
        let Some(mut active_turn) = self.active_turn.take() else {
            return;
        };
        let outcome = TurnOutcome {
            context_tokens: active_turn.context_tokens,
            context_window: active_turn.context_window,
            error: Some(error),
        };
        if let Some(completion_tx) = active_turn.completion_tx.take() {
            let _ = completion_tx.send(outcome);
        }
    }
}

struct ActiveTurnState {
    num_turns: u32,
    text: String,
    context_tokens: u32,
    context_window: u32,
    expected_turn_id: Option<String>,
    completion_tx: Option<oneshot::Sender<TurnOutcome>>,
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

fn requested_model_override(model_id: Option<&str>) -> Option<&str> {
    match model_id {
        Some(CODEX_DEFAULT_MODEL_ID) | None => None,
        Some(model_id) => Some(model_id),
    }
}

fn requested_reasoning_effort(reasoning_effort: Option<&str>) -> Option<&str> {
    match reasoning_effort {
        Some(CODEX_DEFAULT_REASONING_EFFORT) | None => None,
        Some(reasoning_effort) => Some(reasoning_effort),
    }
}

fn child_thread_status_label(status: &str) -> Option<&'static str> {
    match status {
        "active" | "inProgress" | "in_progress" | "running" => Some("running"),
        "idle" | "notLoaded" | "not_loaded" => Some("pendingInit"),
        "systemError" | "system_error" | "error" => Some("failed"),
        "failed" => Some("failed"),
        "cancelled" | "canceled" => Some("cancelled"),
        "completed" => Some("completed"),
        _ => None,
    }
}

fn child_thread_status_from_params(params: &Value) -> Option<&'static str> {
    [
        "/status/type",
        "/status/status",
        "/status",
        "/thread/status/type",
        "/thread/status/status",
    ]
    .into_iter()
    .find_map(|path| {
        params
            .pointer(path)
            .and_then(Value::as_str)
            .and_then(child_thread_status_label)
    })
}

fn codex_error_message(params: &Value) -> Option<String> {
    [
        "/message",
        "/error/message",
        "/turn/error/message",
        "/error",
        "/turn/error",
    ]
    .into_iter()
    .find_map(|pointer| {
        let value = params.pointer(pointer)?;
        match value {
            Value::String(message) if !message.is_empty() => Some(message.clone()),
            Value::Object(_) | Value::Array(_) => Some(value.to_string()),
            _ => None,
        }
    })
}

fn codex_model_options() -> Vec<LocalChatModelOption> {
    [
        (CODEX_DEFAULT_MODEL_ID, CODEX_DEFAULT_MODEL_LABEL),
        ("gpt-5.5", "GPT-5.5"),
        ("gpt-5.4", "GPT-5.4"),
        ("gpt-5.4-mini", "GPT-5.4 Mini"),
        ("gpt-5.3-codex", "GPT-5.3 Codex"),
    ]
    .into_iter()
    .map(|(id, label)| LocalChatModelOption {
        id: id.to_string(),
        label: label.to_string(),
    })
    .collect()
}

fn codex_reasoning_effort_options() -> Vec<LocalChatReasoningEffortOption> {
    [
        ("low", "Low"),
        (CODEX_DEFAULT_REASONING_EFFORT, "Medium"),
        ("high", "High"),
        ("xhigh", "Extra high"),
    ]
    .into_iter()
    .map(|(id, label)| LocalChatReasoningEffortOption {
        id: id.to_string(),
        label: label.to_string(),
    })
    .collect()
}

fn value_to_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .map(|value| value.min(u32::MAX as u64) as u32)
}

#[async_trait]
trait CodexAppServerLauncher: Send + Sync {
    fn info(&self) -> LocalChatHarnessInfo;

    async fn launch(&self) -> Result<LaunchedCodexAppServer, String>;
}

struct LaunchedCodexAppServer {
    ws_url: String,
    process: Option<Child>,
}

struct ProcessCodexAppServerLauncher;

#[async_trait]
impl CodexAppServerLauncher for ProcessCodexAppServerLauncher {
    fn info(&self) -> LocalChatHarnessInfo {
        let availability = find_codex_binary();
        LocalChatHarnessInfo {
            harness: LocalChatHarnessKind::Codex,
            label: "Codex".to_string(),
            available: availability.is_ok(),
            unavailable_reason: availability.err(),
            default_model_id: Some(CODEX_DEFAULT_MODEL_ID.to_string()),
            models: codex_model_options(),
            default_reasoning_effort: Some(CODEX_DEFAULT_REASONING_EFFORT.to_string()),
            reasoning_efforts: codex_reasoning_effort_options(),
            supports_resume: true,
        }
    }

    async fn launch(&self) -> Result<LaunchedCodexAppServer, String> {
        let binary = find_codex_binary()?;
        let mut last_error = None;

        for _ in 0..APP_SERVER_LAUNCH_ATTEMPTS {
            let (ws_url, ready_addr) = reserve_local_ws_url()?;
            let mut process = spawn_codex_app_server(&binary, &ws_url)?;
            match wait_for_ready(ready_addr).await {
                Ok(()) => {
                    return Ok(LaunchedCodexAppServer {
                        ws_url,
                        process: Some(process),
                    });
                }
                Err(err) => {
                    let _ = process.kill().await;
                    let _ = process.wait().await;
                    last_error = Some(err);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            "Failed to start Codex app-server after all launch attempts".to_string()
        }))
    }
}

fn reserve_local_ws_url() -> Result<(String, SocketAddr), String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Failed to reserve local app-server port: {err}"))?;
    let addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to read local app-server port: {err}"))?;
    drop(listener);
    Ok((format!("ws://{addr}"), addr))
}

fn spawn_codex_app_server(binary: &PathBuf, ws_url: &str) -> Result<Child, String> {
    Command::new(binary)
        .arg("app-server")
        .arg("--listen")
        .arg(ws_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("Failed to spawn {}: {err}", binary.display()))
}

async fn wait_for_ready(addr: impl ToSocketAddrs + Copy) -> Result<(), String> {
    let deadline = Instant::now() + APP_SERVER_READY_TIMEOUT;
    while Instant::now() < deadline {
        if ready_probe(addr).await.unwrap_or(false) {
            return Ok(());
        }
        sleep(APP_SERVER_READY_POLL).await;
    }
    Err("Timed out waiting for Codex app-server /readyz".to_string())
}

async fn ready_probe(addr: impl ToSocketAddrs) -> Result<bool, String> {
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|err| format!("Codex app-server is not accepting connections yet: {err}"))?;
    stream
        .write_all(b"GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .map_err(|err| format!("Failed to write Codex app-server readiness probe: {err}"))?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 64];
    loop {
        let bytes = stream
            .read(&mut chunk)
            .await
            .map_err(|err| format!("Failed to read Codex app-server readiness probe: {err}"))?;
        if bytes == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..bytes]);
        if response.windows(4).any(|window| window == b"\r\n\r\n") || response.len() >= 1024 {
            break;
        }
    }

    Ok(std::str::from_utf8(&response).is_ok_and(|response| {
        response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_chat::{LocalChatEvent, LocalChatRuntime};
    use tokio::net::TcpListener;

    fn test_thread_state() -> Arc<StdMutex<CodexThreadState>> {
        Arc::new(StdMutex::new(CodexThreadState::default()))
    }

    fn test_handler(event_sink: &LocalChatEventSink) -> TurnNotificationHandler {
        let mut handler = TurnNotificationHandler::new(
            "backend-1".to_string(),
            event_sink.clone(),
            test_thread_state(),
        );
        handler.set_thread("parent-thread".to_string(), "gpt-5".to_string());
        handler
    }

    #[derive(Clone)]
    struct TestCodexAppServerLauncher {
        info_error: Option<String>,
        ws_url: String,
    }

    #[async_trait]
    impl CodexAppServerLauncher for TestCodexAppServerLauncher {
        fn info(&self) -> LocalChatHarnessInfo {
            LocalChatHarnessInfo {
                harness: LocalChatHarnessKind::Codex,
                label: "Codex".to_string(),
                available: self.info_error.is_none(),
                unavailable_reason: self.info_error.clone(),
                default_model_id: Some(CODEX_DEFAULT_MODEL_ID.to_string()),
                models: codex_model_options(),
                default_reasoning_effort: Some(CODEX_DEFAULT_REASONING_EFFORT.to_string()),
                reasoning_efforts: codex_reasoning_effort_options(),
                supports_resume: true,
            }
        }

        async fn launch(&self) -> Result<LaunchedCodexAppServer, String> {
            if let Some(error) = &self.info_error {
                return Err(error.clone());
            }
            Ok(LaunchedCodexAppServer {
                ws_url: self.ws_url.clone(),
                process: None,
            })
        }
    }

    #[derive(Clone)]
    struct MockScript {
        thread_id: &'static str,
        model: &'static str,
        rpc_error_method: Option<&'static str>,
        server_request_method: Option<&'static str>,
        stale_completion_before_turn_response: bool,
        child_status_after_parent_completion: bool,
        turn_response_delay: Duration,
        turn_status: &'static str,
        turn_error: Option<&'static str>,
    }

    impl Default for MockScript {
        fn default() -> Self {
            Self {
                thread_id: "codex-thread-1",
                model: "mock-codex-model",
                rpc_error_method: None,
                server_request_method: None,
                stale_completion_before_turn_response: false,
                child_status_after_parent_completion: false,
                turn_response_delay: Duration::from_millis(0),
                turn_status: "completed",
                turn_error: None,
            }
        }
    }

    #[test]
    fn codex_collab_tool_call_preserves_agent_outline_metadata() {
        let item = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "prompt": "Inspect the implementation",
            "model": "gpt-5-codex",
            "newAgentNickname": "Pasteur",
            "newAgentRole": "reviewer",
            "receiverThreadIds": ["thread-pasteur"],
            "receiverAgents": [
                {
                    "threadId": "thread-pasteur",
                    "agentNickname": "Pasteur",
                    "agentRole": "reviewer"
                }
            ],
            "agentStatuses": [
                {
                    "threadId": "thread-pasteur",
                    "agentNickname": "Pasteur",
                    "status": "running"
                }
            ],
            "agentsStates": {
                "thread-pasteur": {
                    "status": "running"
                }
            }
        });

        let (tool_id, tool_name, input) = codex_tool_call(&item).expect("tool call");
        let input: Value = serde_json::from_str(&input).expect("json input");

        // The spawn's tool_id is now derived from the agent identity
        // (`agent:{agent_path}`), not the raw item id, so it matches what
        // rollout hydration synthesizes for the same spawn (see
        // `collab_agent_spawn_id`).
        assert_eq!(tool_id, "agent:thread-pasteur");
        assert_eq!(tool_name, "Agent");
        assert_eq!(input["description"], "Inspect the implementation");
        assert_eq!(input["collab_tool"], "spawnAgent");
        assert_eq!(input["subagent_type"], "gpt-5-codex");
        assert_eq!(input["agent_nickname"], "Pasteur");
        assert_eq!(input["agent_role"], "reviewer");
        assert_eq!(input["receiver_thread_ids"][0], "thread-pasteur");
        assert_eq!(input["receiver_agents"][0]["agentNickname"], "Pasteur");
        assert_eq!(input["agent_statuses"][0]["agentNickname"], "Pasteur");
        assert_eq!(
            input["agents_states"]["thread-pasteur"]["status"],
            "running"
        );
    }

    #[test]
    fn codex_collab_tool_call_extracts_agent_nickname_from_spawn_result() {
        let item = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "prompt": "Inspect the implementation",
            "model": "gpt-5-codex",
            "result": {
                "agent_id": "019f1cae-6a6c-71f0-a082-9a2dbd0d074f",
                "nickname": "Faraday",
                "role": "explorer"
            }
        });

        let (_tool_id, _tool_name, input) = codex_tool_call(&item).expect("tool call");
        let input: Value = serde_json::from_str(&input).expect("json input");

        assert_eq!(input["agent_nickname"], "Faraday");
        assert_eq!(input["agent_role"], "explorer");
        assert_eq!(
            input["receiver_thread_ids"][0],
            "019f1cae-6a6c-71f0-a082-9a2dbd0d074f"
        );
        assert_eq!(input["receiver_agents"][0]["agentNickname"], "Faraday");
        assert_eq!(
            input["receiver_agents"][0]["threadId"],
            "019f1cae-6a6c-71f0-a082-9a2dbd0d074f"
        );
    }

    #[test]
    fn codex_collab_tool_call_derives_spawn_id_from_result_agent_id() {
        let item = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "result": {
                "agent_id": "019f1cae-6a6c-71f0-a082-9a2dbd0d074f",
                "nickname": "Faraday"
            }
        });

        let (tool_id, _tool_name, _input) = codex_tool_call(&item).expect("tool call");
        assert_eq!(tool_id, "agent:019f1cae-6a6c-71f0-a082-9a2dbd0d074f");
    }

    #[test]
    fn codex_collab_tool_call_falls_back_to_item_id_when_agent_identity_unresolvable() {
        // Mirrors a bare `item/started` for `spawnAgent`, before the
        // app-server has attached `receiverThreadIds`/`result` to the item.
        let item = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "prompt": "Inspect the implementation"
        });

        let (tool_id, _tool_name, _input) = codex_tool_call(&item).expect("tool call");
        assert_eq!(tool_id, "spawn-1");
    }

    #[test]
    fn codex_collab_tool_call_non_spawn_keeps_item_id() {
        // wait_agent/close_agent are their own tool cards; they must not
        // collide with the spawn's derived `agent:{agent_path}` id even
        // though they carry the same agent identity.
        let item = json!({
            "type": "collabAgentToolCall",
            "id": "wait-1",
            "tool": "wait_agent",
            "receiverThreadIds": ["child-thread"]
        });

        let (tool_id, tool_name, _input) = codex_tool_call(&item).expect("tool call");
        assert_eq!(tool_id, "wait-1");
        assert_eq!(tool_name, "agent");
    }

    #[test]
    fn codex_collab_spawn_tool_call_and_tool_result_share_the_same_derived_id() {
        // The same completed item feeds both `codex_tool_call` (re-emitted
        // on item/completed) and `codex_tool_result`; if either used a
        // different id derivation the ToolResult would never reconcile with
        // its ToolCall in the GUI.
        let item = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "status": "completed",
            "receiverThreadIds": ["thread-pasteur"]
        });

        let (call_tool_id, _, _) = codex_tool_call(&item).expect("tool call");
        let (result_tool_id, _, _) = codex_tool_result(&item).expect("tool result");
        assert_eq!(call_tool_id, "agent:thread-pasteur");
        assert_eq!(result_tool_id, call_tool_id);
    }

    #[test]
    fn codex_todo_list_item_maps_to_tool_call_and_result() {
        let item = json!({
            "type": "todoList",
            "id": "plan-1",
            "items": [
                { "text": "step a", "completed": true },
                { "text": "step b", "completed": false }
            ]
        });

        let (tool_id, tool_name, input) = codex_tool_call(&item).expect("tool call");
        let input: Value = serde_json::from_str(&input).expect("json input");
        assert_eq!(tool_id, "plan-1");
        assert_eq!(tool_name, "TodoWrite");
        assert_eq!(input["todos"][0]["text"], "step a");
        assert_eq!(input["todos"][1]["completed"], false);

        let (result_tool_id, result, is_error) = codex_tool_result(&item).expect("tool result");
        assert_eq!(result_tool_id, "plan-1");
        assert_eq!(result, "1/2 steps completed");
        assert!(!is_error);
    }

    #[test]
    fn codex_todo_list_item_snake_case_alias_is_also_recognized() {
        // Defensive alias: the exact wire casing for this item hasn't been
        // confirmed against a live app-server, so both spellings are
        // accepted (see the comment on the `codex_tool_call` match arm).
        let item = json!({
            "type": "todo_list",
            "id": "plan-2",
            "items": []
        });

        let (tool_id, tool_name, _input) = codex_tool_call(&item).expect("tool call");
        assert_eq!(tool_id, "plan-2");
        assert_eq!(tool_name, "TodoWrite");
    }

    #[test]
    fn codex_wait_agent_does_not_reparent_child_thread_from_original_spawn() {
        let event_sink = LocalChatEventSink::inert_for_tests();
        let mut handler = test_handler(&event_sink);
        let spawn = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "receiverThreadIds": ["child-thread"]
        });
        let wait = json!({
            "type": "collabAgentToolCall",
            "id": "wait-1",
            "tool": "wait_agent",
            "receiverThreadIds": ["child-thread"]
        });

        handler.remember_child_thread_parents(&spawn, "spawn-1");
        handler.remember_child_thread_parents(&wait, "wait-1");

        assert_eq!(
            handler
                .thread_state
                .lock()
                .expect("thread state lock")
                .child_thread_parents
                .get("child-thread")
                .map(String::as_str),
            Some("spawn-1")
        );
    }

    #[test]
    fn codex_child_notifications_resolve_parent_from_agent_identity_aliases() {
        let event_sink = LocalChatEventSink::inert_for_tests();
        let mut handler = test_handler(&event_sink);
        let spawn = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "result": {
                "agent_id": "agent-20513969",
                "nickname": "Leibniz"
            }
        });
        let notification = json!({
            "threadId": "different-child-thread",
            "item": {
                "type": "commandExecution",
                "id": "tool-1",
                "agentId": "agent-20513969"
            }
        });

        handler.remember_child_thread_parents(&spawn, "spawn-1");

        assert_eq!(
            handler
                .parent_tool_use_id_for_notification(&notification)
                .as_deref(),
            Some("spawn-1")
        );
    }

    #[test]
    fn codex_child_tool_call_is_not_emitted_into_parent_transcript() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let mut handler = test_handler(&event_sink);
        let spawn = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "result": {
                "agent_id": "agent-20513969",
                "nickname": "Leibniz"
            }
        });
        handler.remember_child_thread_parents(&spawn, "spawn-1");

        handler.handle(
            "item/started",
            &json!({
                "threadId": "child-thread-from-server",
                "item": {
                    "type": "commandExecution",
                    "id": "tool-1",
                    "command": "rg --files crates/core",
                    "agentId": "agent-20513969"
                }
            }),
        );

        let events = events.lock().expect("events lock");
        assert!(events.is_empty());
    }

    #[test]
    fn codex_child_notification_arriving_before_parent_registers_gets_synthetic_parent() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let mut handler = test_handler(&event_sink);

        // The child thread's own activity arrives first -- the parent
        // collabAgentToolCall spawn hasn't registered `child_thread_parents`
        // yet. Previously this notification was silently dropped forever.
        handler.handle(
            "item/started",
            &json!({
                "threadId": "child-thread-from-server",
                "item": {
                    "type": "commandExecution",
                    "id": "tool-1",
                    "command": "rg --files crates/core",
                    "agentId": "agent-race"
                }
            }),
        );

        let events = events.lock().expect("events lock");
        let synthetic_spawn = events.iter().find_map(|event| match event {
            LocalChatEvent::ToolCall(event) if event.tool_name == "Agent" => Some(event),
            _ => None,
        });
        let synthetic_spawn = synthetic_spawn.expect("synthetic spawn parent");
        assert_eq!(synthetic_spawn.tool_id, "agent:agent-race");
        assert_eq!(synthetic_spawn.parent_tool_use_id, None);

        assert!(!events.iter().any(|event| matches!(
            event,
            LocalChatEvent::ToolCall(LocalChatToolCallEvent { tool_name, .. })
                if tool_name == "Bash"
        )));
    }

    #[test]
    fn codex_child_thread_parent_mapping_survives_across_turn_handlers() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let thread_state = test_thread_state();
        let mut first_turn = TurnNotificationHandler::new(
            "backend-1".to_string(),
            event_sink.clone(),
            thread_state.clone(),
        );
        first_turn.set_thread("parent-thread".to_string(), "gpt-5".to_string());
        let spawn = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "receiverThreadIds": ["child-thread"]
        });
        first_turn.remember_child_thread_parents(&spawn, "agent:child-thread");
        drop(first_turn);

        let mut next_turn =
            TurnNotificationHandler::new("backend-1".to_string(), event_sink.clone(), thread_state);
        next_turn.set_thread("parent-thread".to_string(), "gpt-5".to_string());
        next_turn.handle(
            "item/started",
            &json!({
                "threadId": "child-thread",
                "item": {
                    "type": "commandExecution",
                    "id": "tool-1",
                    "command": "pwd"
                }
            }),
        );

        assert_eq!(
            next_turn
                .parent_tool_use_id_for_notification(&json!({ "threadId": "child-thread" }))
                .as_deref(),
            Some("agent:child-thread")
        );
        assert!(events.lock().expect("events lock").is_empty());
    }

    #[test]
    fn codex_unresolved_spawn_started_waits_for_stable_completed_id() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let mut handler = test_handler(&event_sink);
        handler.set_expected_turn_id("turn-1");

        handler.handle(
            "item/started",
            &json!({
                "threadId": "parent-thread",
                "turnId": "turn-1",
                "item": {
                    "type": "collabAgentToolCall",
                    "id": "spawn-1",
                    "tool": "spawnAgent",
                    "prompt": "Inspect the implementation"
                }
            }),
        );
        assert!(events.lock().expect("events lock").is_empty());

        handler.handle(
            "item/completed",
            &json!({
                "threadId": "parent-thread",
                "turnId": "turn-1",
                "item": {
                    "type": "collabAgentToolCall",
                    "id": "spawn-1",
                    "tool": "spawnAgent",
                    "prompt": "Inspect the implementation",
                    "receiverThreadIds": ["child-thread"],
                    "status": "completed"
                }
            }),
        );

        let events = events.lock().expect("events lock");
        let agent_calls: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                LocalChatEvent::ToolCall(event) if event.tool_name == "Agent" => Some(event),
                _ => None,
            })
            .collect();
        assert_eq!(agent_calls.len(), 1);
        assert_eq!(agent_calls[0].tool_id, "agent:child-thread");
    }

    #[test]
    fn codex_child_turn_completed_updates_agent_status_without_ending_parent() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let mut handler = test_handler(&event_sink);
        let spawn = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "receiverThreadIds": ["child-thread"]
        });
        handler.remember_child_thread_parents(&spawn, "spawn-1");

        handler.handle(
            "turn/completed",
            &json!({
                "threadId": "child-thread",
                "turn": {
                    "id": "child-turn",
                    "status": "completed",
                    "durationMs": 145489
                }
            }),
        );

        assert!(handler.active_turn.is_none());
        let events = events.lock().expect("events lock");
        assert!(!events
            .iter()
            .any(|event| matches!(event, LocalChatEvent::End(_))));
        let tool_call = events.iter().find_map(|event| match event {
            LocalChatEvent::ToolCall(event) => Some(event),
            _ => None,
        });
        let tool_call = tool_call.expect("status update tool call");
        let input: Value = serde_json::from_str(&tool_call.input).expect("json input");
        assert_eq!(tool_call.tool_id, "spawn-1");
        assert_eq!(tool_call.parent_tool_use_id, None);
        assert_eq!(
            input["agents_states"]["child-thread"]["status"],
            "completed"
        );
        let parent_result = events.iter().find_map(|event| match event {
            LocalChatEvent::ToolResult(event) if event.tool_id == "spawn-1" => Some(event),
            _ => None,
        });
        let parent_result = parent_result.expect("parent spawn completion result");
        assert_eq!(parent_result.result, "completed");
        assert!(!parent_result.is_error);
        assert_eq!(parent_result.parent_tool_use_id, None);
    }

    #[test]
    fn codex_parent_agent_completion_waits_for_all_spawned_children() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let mut handler = test_handler(&event_sink);
        let spawn = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "receiverThreadIds": ["child-one", "child-two"]
        });
        handler.remember_child_thread_parents(&spawn, "spawn-1");

        handler.handle(
            "turn/completed",
            &json!({
                "threadId": "child-one",
                "turn": {
                    "id": "child-turn-one",
                    "status": "completed"
                }
            }),
        );
        {
            let events = events.lock().expect("events lock");
            assert!(!events.iter().any(|event| matches!(
                event,
                LocalChatEvent::ToolResult(LocalChatToolResultEvent { tool_id, .. })
                    if tool_id == "spawn-1"
            )));
        }

        handler.handle(
            "turn/completed",
            &json!({
                "threadId": "child-two",
                "turn": {
                    "id": "child-turn-two",
                    "status": "completed"
                }
            }),
        );

        let events = events.lock().expect("events lock");
        let parent_results: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                LocalChatEvent::ToolResult(event) if event.tool_id == "spawn-1" => Some(event),
                _ => None,
            })
            .collect();
        assert_eq!(parent_results.len(), 1);
        assert_eq!(parent_results[0].result, "completed");
        assert!(!parent_results[0].is_error);
    }

    #[test]
    fn codex_child_thread_status_changed_updates_agent_state_from_protocol_shape() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let mut handler = test_handler(&event_sink);
        let spawn = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "receiverThreadIds": ["child-thread"]
        });
        handler.remember_child_thread_parents(&spawn, "agent:child-thread");

        handler.handle(
            "thread/status/changed",
            &json!({
                "threadId": "child-thread",
                "status": {
                    "type": "active",
                    "activeFlags": []
                }
            }),
        );

        let events = events.lock().expect("events lock");
        let tool_call = events.iter().find_map(|event| match event {
            LocalChatEvent::ToolCall(event) => Some(event),
            _ => None,
        });
        let tool_call = tool_call.expect("status update tool call");
        let input: Value = serde_json::from_str(&tool_call.input).expect("json input");
        assert_eq!(tool_call.tool_id, "agent:child-thread");
        assert_eq!(input["agents_states"]["child-thread"]["status"], "running");
    }

    #[test]
    fn codex_child_turn_completed_emits_final_agent_result_without_child_transcript() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let mut handler = test_handler(&event_sink);
        let spawn = json!({
            "type": "collabAgentToolCall",
            "id": "spawn-1",
            "tool": "spawnAgent",
            "receiverThreadIds": ["child-thread"]
        });
        handler.remember_child_thread_parents(&spawn, "agent:child-thread");

        handler.handle(
            "item/agentMessage/delta",
            &json!({
                "threadId": "child-thread",
                "turnId": "child-turn",
                "itemId": "child-msg",
                "delta": "streamed child work"
            }),
        );
        handler.handle(
            "item/completed",
            &json!({
                "threadId": "child-thread",
                "turnId": "child-turn",
                "item": {
                    "type": "agentMessage",
                    "id": "child-msg",
                    "text": "Final child report"
                }
            }),
        );
        handler.handle(
            "turn/completed",
            &json!({
                "threadId": "child-thread",
                "turn": {
                    "id": "child-turn",
                    "status": "completed",
                    "durationMs": 25
                }
            }),
        );

        let events = events.lock().expect("events lock");
        assert!(!events
            .iter()
            .any(|event| matches!(event, LocalChatEvent::Text(_))));
        let result_call = events.iter().find_map(|event| match event {
            LocalChatEvent::ToolCall(event) if event.tool_name == "Agent Result" => Some(event),
            _ => None,
        });
        let result_call = result_call.expect("agent result tool call");
        assert_eq!(result_call.tool_id, "agent:child-thread:result:child-turn");
        assert_eq!(result_call.parent_tool_use_id, None);
        let result = events.iter().find_map(|event| match event {
            LocalChatEvent::ToolResult(event)
                if event.tool_id == "agent:child-thread:result:child-turn" =>
            {
                Some(event)
            }
            _ => None,
        });
        let result = result.expect("agent result tool result");
        assert_eq!(result.result, "Final child report");
        assert!(!result.is_error);
        assert_eq!(result.parent_tool_use_id, None);
    }

    #[test]
    fn codex_agent_message_completed_emits_final_text_event() {
        let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
        let mut handler = test_handler(&event_sink);
        handler.set_expected_turn_id("turn-1");

        handler.handle(
            "item/completed",
            &json!({
                "threadId": "parent-thread",
                "turnId": "turn-1",
                "item": {
                    "type": "agentMessage",
                    "id": "msg-1",
                    "text": "Final text",
                    "phase": "commentary"
                }
            }),
        );

        let events = events.lock().expect("events lock");
        let text = events.iter().find_map(|event| match event {
            LocalChatEvent::Text(event) => Some(event),
            _ => None,
        });
        let text = text.expect("final text event");
        assert_eq!(text.text, "Final text");
        assert!(!text.is_partial);
        assert_eq!(text.parent_tool_use_id, None);
    }

    struct MockAppServer {
        ws_url: String,
        requests: Arc<std::sync::Mutex<Vec<Value>>>,
        closed: Arc<std::sync::Mutex<bool>>,
    }

    impl MockAppServer {
        async fn start(script: MockScript) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind mock app-server");
            let ws_url = format!("ws://{}", listener.local_addr().expect("mock addr"));
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let closed = Arc::new(std::sync::Mutex::new(false));
            let server_requests = requests.clone();
            let server_closed = closed.clone();

            tokio::spawn(async move {
                let (stream, _) = listener.accept().await.expect("accept websocket");
                let mut socket = tokio_tungstenite::accept_async(stream)
                    .await
                    .expect("accept websocket handshake");

                while let Some(frame) = socket.next().await {
                    let frame = frame.expect("mock websocket frame");
                    let Message::Text(text) = frame else {
                        if matches!(frame, Message::Close(_)) {
                            break;
                        }
                        continue;
                    };
                    let request: Value = serde_json::from_str(&text).expect("request json");
                    server_requests
                        .lock()
                        .expect("requests lock")
                        .push(request.clone());

                    let Some(method) = request.get("method").and_then(Value::as_str) else {
                        continue;
                    };
                    let id = request.get("id").cloned();

                    if script.rpc_error_method == Some(method) {
                        send_json(
                            &mut socket,
                            json!({
                                "id": id,
                                "error": {
                                    "code": -32000,
                                    "message": format!("{method} exploded"),
                                },
                            }),
                        )
                        .await;
                        continue;
                    }

                    match (method, id) {
                        ("initialize", Some(id)) => {
                            send_json(
                                &mut socket,
                                json!({
                                    "id": id,
                                    "result": {
                                        "userAgent": "mock",
                                        "codexHome": "/tmp/codex",
                                        "platformFamily": "unix",
                                        "platformOs": "macos",
                                    },
                                }),
                            )
                            .await;
                            if script.child_status_after_parent_completion {
                                sleep(Duration::from_millis(25)).await;
                                send_json(
                                    &mut socket,
                                    json!({
                                        "method": "thread/status/changed",
                                        "params": {
                                            "threadId": "child-thread",
                                            "status": {
                                                "type": "idle",
                                            },
                                        },
                                    }),
                                )
                                .await;
                                send_json(
                                    &mut socket,
                                    json!({
                                        "method": "turn/completed",
                                        "params": {
                                            "threadId": "child-thread",
                                            "turn": {
                                                "id": "child-turn-1",
                                                "status": "completed",
                                                "durationMs": 5,
                                                "error": null,
                                            },
                                        },
                                    }),
                                )
                                .await;
                            }
                        }
                        ("initialized", _) => {}
                        ("thread/start" | "thread/resume", Some(id)) => {
                            send_json(
                                &mut socket,
                                json!({
                                    "id": id,
                                    "result": {
                                        "thread": { "id": script.thread_id },
                                        "model": script.model,
                                        "modelProvider": "openai",
                                        "cwd": "/tmp/project",
                                    },
                                }),
                            )
                            .await;
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "thread/started",
                                    "params": {
                                        "thread": { "id": script.thread_id },
                                    },
                                }),
                            )
                            .await;
                        }
                        ("turn/start", Some(id)) => {
                            if script.stale_completion_before_turn_response {
                                send_json(
                                    &mut socket,
                                    json!({
                                        "method": "turn/completed",
                                        "params": {
                                            "threadId": script.thread_id,
                                            "turn": {
                                                "id": "stale-turn",
                                                "status": "completed",
                                                "durationMs": 1,
                                                "error": null,
                                            },
                                        },
                                    }),
                                )
                                .await;
                            }
                            if script.turn_response_delay > Duration::from_millis(0) {
                                sleep(script.turn_response_delay).await;
                            }
                            send_json(
                                &mut socket,
                                json!({
                                    "id": id,
                                    "result": {
                                        "turn": {
                                            "id": "turn-1",
                                            "status": "inProgress",
                                            "items": [],
                                            "error": null,
                                        },
                                    },
                                }),
                            )
                            .await;
                            if let Some(method) = script.server_request_method {
                                send_json(
                                    &mut socket,
                                    json!({
                                        "id": 1000,
                                        "method": method,
                                        "params": {
                                            "threadId": script.thread_id,
                                            "turnId": "turn-1",
                                            "itemId": "item-approval-1",
                                            "startedAtMs": 1,
                                        },
                                    }),
                                )
                                .await;
                            }
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "item/agentMessage/delta",
                                    "params": {
                                        "threadId": script.thread_id,
                                        "turnId": "turn-1",
                                        "itemId": "item-1",
                                        "delta": "hello ",
                                    },
                                }),
                            )
                            .await;
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "item/agentMessage/delta",
                                    "params": {
                                        "threadId": script.thread_id,
                                        "turnId": "turn-1",
                                        "itemId": "item-1",
                                        "delta": "world",
                                    },
                                }),
                            )
                            .await;
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "thread/tokenUsage/updated",
                                    "params": {
                                        "threadId": script.thread_id,
                                        "turnId": "turn-1",
                                        "tokenUsage": {
                                            "total": {
                                                "totalTokens": 42,
                                                "inputTokens": 30,
                                                "cachedInputTokens": 0,
                                                "outputTokens": 12,
                                                "reasoningOutputTokens": 0,
                                            },
                                            "last": {
                                                "totalTokens": 42,
                                                "inputTokens": 30,
                                                "cachedInputTokens": 0,
                                                "outputTokens": 12,
                                                "reasoningOutputTokens": 0,
                                            },
                                            "modelContextWindow": 200000,
                                        },
                                    },
                                }),
                            )
                            .await;
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "turn/completed",
                                    "params": {
                                        "threadId": script.thread_id,
                                        "turn": {
                                            "id": "turn-1",
                                            "status": script.turn_status,
                                            "durationMs": 17,
                                            "error": script.turn_error.map(|message| json!({ "message": message })),
                                        },
                                    },
                                }),
                            )
                            .await;
                        }
                        _ => {}
                    }
                }

                *server_closed.lock().expect("closed lock") = true;
            });

            Self {
                ws_url,
                requests,
                closed,
            }
        }

        fn launcher(&self) -> Arc<dyn CodexAppServerLauncher> {
            Arc::new(TestCodexAppServerLauncher {
                info_error: None,
                ws_url: self.ws_url.clone(),
            })
        }

        fn requests(&self) -> Vec<Value> {
            self.requests.lock().expect("requests lock").clone()
        }

        async fn wait_for_request_count(&self, count: usize) {
            tokio::time::timeout(Duration::from_secs(1), async {
                while self.requests().len() < count {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("mock server should receive expected requests");
        }

        fn closed(&self) -> bool {
            *self.closed.lock().expect("closed lock")
        }
    }

    async fn wait_for_event<F>(events: &Arc<std::sync::Mutex<Vec<LocalChatEvent>>>, predicate: F)
    where
        F: Fn(&LocalChatEvent) -> bool,
    {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                {
                    let events = events.lock().expect("events lock");
                    if events.iter().any(&predicate) {
                        break;
                    }
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("expected local chat event");
    }

    async fn send_json(
        socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        value: Value,
    ) {
        socket
            .send(Message::Text(value.to_string()))
            .await
            .expect("send mock frame");
    }

    fn create_input(
        backend_session_id: &str,
        initial_prompt: Option<&str>,
        provider_resume_id: Option<&str>,
    ) -> HarnessCreateSessionInput {
        HarnessCreateSessionInput {
            backend_session_id: backend_session_id.to_string(),
            working_dir: Some("/tmp/project".to_string()),
            initial_prompt: initial_prompt.map(str::to_string),
            provider_resume_id: provider_resume_id.map(str::to_string),
            model_id: Some(CODEX_DEFAULT_MODEL_ID.to_string()),
            reasoning_effort: Some(CODEX_DEFAULT_REASONING_EFFORT.to_string()),
            permission_mode: None,
        }
    }

    #[test]
    fn codex_harness_info_reports_default_model_metadata() {
        let harness =
            CodexLocalChatHarness::with_launcher_for_tests(Arc::new(TestCodexAppServerLauncher {
                info_error: Some("codex missing".to_string()),
                ws_url: "ws://127.0.0.1:1".to_string(),
            }));

        let info = harness.info();

        assert_eq!(info.harness, LocalChatHarnessKind::Codex);
        assert_eq!(info.label, "Codex");
        assert!(!info.available);
        assert_eq!(info.unavailable_reason, Some("codex missing".to_string()));
        assert_eq!(info.default_model_id, Some("default".to_string()));
        assert!(info.models.iter().any(|model| model.id == "gpt-5.5"));
        assert!(info.models.iter().any(|model| model.id == "gpt-5.4"));
        assert_eq!(info.default_reasoning_effort, Some("medium".to_string()));
        assert!(info
            .reasoning_efforts
            .iter()
            .any(|effort| effort.id == "xhigh"));
        assert!(info.supports_resume);
    }

    #[test]
    fn codex_error_message_reads_common_error_payload_shapes() {
        assert_eq!(
            codex_error_message(&json!({ "message": "plain failure" })),
            Some("plain failure".to_string())
        );
        assert_eq!(
            codex_error_message(&json!({ "error": { "message": "nested failure" } })),
            Some("nested failure".to_string())
        );
        assert_eq!(
            codex_error_message(&json!({
                "type": "error",
                "status": 400,
                "error": {
                    "type": "invalid_request_error",
                    "message": "The model is not supported.",
                }
            })),
            Some("The model is not supported.".to_string())
        );
        assert_eq!(
            codex_error_message(&json!({ "turn": { "error": { "message": "turn failure" } } })),
            Some("turn failure".to_string())
        );
        assert_eq!(
            codex_error_message(&json!({ "error": { "code": "bad_model" } })),
            Some(json!({ "code": "bad_model" }).to_string())
        );
    }

    #[tokio::test]
    async fn create_session_initializes_starts_thread_and_emits_initial_turn_events() {
        let server = MockAppServer::start(MockScript::default()).await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, events) = LocalChatRuntime::capturing_for_tests();

        harness
            .create_session(
                create_input("backend-1", Some("first prompt"), None),
                runtime,
            )
            .await
            .expect("create codex session");

        assert!(harness.has_session("backend-1").await);
        server.wait_for_request_count(4).await;
        wait_for_event(&events, |event| {
            matches!(
                event,
                LocalChatEvent::End(LocalChatSessionEndEvent {
                    backend_session_id,
                    ..
                }) if backend_session_id == "backend-1"
            )
        })
        .await;

        let requests = server.requests();
        assert_eq!(requests[0]["method"], "initialize");
        assert_eq!(requests[1]["method"], "initialized");
        assert_eq!(requests[2]["method"], "thread/start");
        assert_eq!(requests[2]["params"]["cwd"], "/tmp/project");
        assert!(requests[2]["params"].get("model").is_none());
        assert!(requests[2]["params"].get("effort").is_none());
        assert_eq!(requests[3]["method"], "turn/start");
        assert_eq!(requests[3]["params"]["threadId"], "codex-thread-1");
        assert_eq!(requests[3]["params"]["input"][0]["text"], "first prompt");

        let events = events.lock().expect("events lock").clone();
        assert!(
            events.contains(&LocalChatEvent::Init(LocalChatSessionInitEvent {
                backend_session_id: "backend-1".to_string(),
                harness: LocalChatHarnessKind::Codex,
                provider_resume_id: Some("codex-thread-1".to_string()),
                model: "mock-codex-model".to_string(),
                tools: Vec::new(),
            }))
        );
        assert!(events.contains(&LocalChatEvent::Text(LocalChatTextEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Codex,
            text: "hello ".to_string(),
            is_partial: true,
            parent_tool_use_id: None,
        })));
        assert!(
            events.contains(&LocalChatEvent::Usage(LocalChatSessionUsageEvent {
                backend_session_id: "backend-1".to_string(),
                harness: LocalChatHarnessKind::Codex,
                model: "mock-codex-model".to_string(),
                context_tokens: 42,
                context_window: 200000,
            }))
        );
        assert!(
            events.contains(&LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id: "backend-1".to_string(),
                harness: LocalChatHarnessKind::Codex,
                duration_ms: 17,
                cost_usd: 0.0,
                num_turns: 1,
                result: "hello world".to_string(),
                is_error: false,
                context_tokens: 42,
                context_window: 200000,
            }))
        );
        assert!(!events.iter().any(|event| matches!(
            event,
            LocalChatEvent::ToolCall(LocalChatToolCallEvent { tool_id, .. })
                if tool_id == "agent:codex-thread-1"
        )));
    }

    #[tokio::test]
    async fn create_session_registers_before_initial_turn_finishes() {
        let server = MockAppServer::start(MockScript {
            turn_response_delay: Duration::from_millis(250),
            ..MockScript::default()
        })
        .await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, events) = LocalChatRuntime::capturing_for_tests();

        tokio::time::timeout(
            Duration::from_millis(100),
            harness.create_session(
                create_input("backend-async-start", Some("slow prompt"), None),
                runtime,
            ),
        )
        .await
        .expect("create_session should not wait for the initial turn")
        .expect("create codex session");

        assert!(harness.has_session("backend-async-start").await);
        server.wait_for_request_count(4).await;
        wait_for_event(&events, |event| {
            matches!(
                event,
                LocalChatEvent::End(LocalChatSessionEndEvent {
                    backend_session_id,
                    ..
                }) if backend_session_id == "backend-async-start"
            )
        })
        .await;
    }

    #[tokio::test]
    async fn permission_mode_is_forwarded_to_thread_and_turn_requests() {
        let server = MockAppServer::start(MockScript::default()).await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, _events) = LocalChatRuntime::capturing_for_tests();
        let mut input = create_input("backend-permissions", None, None);
        input.permission_mode = Some(PermissionMode::Plan);

        harness
            .create_session(input, runtime)
            .await
            .expect("create codex session");
        harness
            .send_message("backend-permissions", "plan this")
            .await
            .expect("send codex message");

        let requests = server.requests();
        assert_eq!(requests[2]["method"], "thread/start");
        assert_eq!(requests[2]["params"]["approvalPolicy"], "never");
        assert_eq!(requests[2]["params"]["permissions"], ":read-only");
        assert_eq!(requests[3]["method"], "turn/start");
        assert_eq!(requests[3]["params"]["approvalPolicy"], "never");
        assert_eq!(requests[3]["params"]["permissions"], ":read-only");
    }

    #[tokio::test]
    async fn selected_model_and_reasoning_effort_are_forwarded_to_thread_start() {
        let server = MockAppServer::start(MockScript::default()).await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, _events) = LocalChatRuntime::capturing_for_tests();
        let mut input = create_input("backend-model-effort", None, None);
        input.model_id = Some("gpt-5.5".to_string());
        input.reasoning_effort = Some("high".to_string());

        harness
            .create_session(input, runtime)
            .await
            .expect("create codex session");

        let requests = server.requests();
        assert_eq!(requests[2]["method"], "thread/start");
        assert_eq!(requests[2]["params"]["model"], "gpt-5.5");
        assert_eq!(requests[2]["params"]["effort"], "high");
    }

    #[tokio::test]
    async fn server_approval_requests_are_denied_with_warning() {
        let server = MockAppServer::start(MockScript {
            server_request_method: Some("item/commandExecution/requestApproval"),
            ..MockScript::default()
        })
        .await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, events) = LocalChatRuntime::capturing_for_tests();

        harness
            .create_session(create_input("backend-approval", None, None), runtime)
            .await
            .expect("create codex session");
        harness
            .send_message("backend-approval", "run command")
            .await
            .expect("send codex message");

        server.wait_for_request_count(5).await;
        let requests = server.requests();
        assert!(requests.iter().any(|request| {
            request.get("id") == Some(&json!(1000))
                && request.pointer("/result/decision") == Some(&json!("decline"))
        }));
        assert!(events
            .lock()
            .expect("events lock")
            .iter()
            .any(|event| matches!(
                event,
                LocalChatEvent::Warning(LocalChatSessionWarningEvent { warning, .. })
                    if warning.contains("command execution approval")
            )));
    }

    #[tokio::test]
    async fn stale_turn_completion_before_turn_response_is_ignored() {
        let server = MockAppServer::start(MockScript {
            stale_completion_before_turn_response: true,
            ..MockScript::default()
        })
        .await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, events) = LocalChatRuntime::capturing_for_tests();

        harness
            .create_session(create_input("backend-stale", None, None), runtime)
            .await
            .expect("create codex session");
        harness
            .send_message("backend-stale", "current turn")
            .await
            .expect("send codex message");

        let events = events.lock().expect("events lock").clone();
        let end_events: Vec<_> = events
            .iter()
            .filter_map(|event| {
                if let LocalChatEvent::End(event) = event {
                    Some(event)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(end_events.len(), 1);
        assert_eq!(end_events[0].duration_ms, 17);
        assert_eq!(end_events[0].result, "hello world");
    }

    #[tokio::test]
    async fn codex_child_thread_notifications_after_parent_turn_completion_are_still_processed() {
        let server = MockAppServer::start(MockScript {
            child_status_after_parent_completion: true,
            ..MockScript::default()
        })
        .await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, events) = LocalChatRuntime::capturing_for_tests();

        harness
            .create_session(
                create_input("backend-child-after-parent", None, None),
                runtime,
            )
            .await
            .expect("create codex session");
        harness
            .send_message("backend-child-after-parent", "spawn and return")
            .await
            .expect("send codex message");

        wait_for_event(&events, |event| {
            matches!(
                event,
                LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                    tool_id,
                    tool_name,
                    input,
                    ..
                }) if tool_id == "agent:child-thread"
                    && tool_name == "Agent"
                    && serde_json::from_str::<Value>(input)
                        .ok()
                        .and_then(|value| value
                            .pointer("/agents_states/child-thread/status")
                            .and_then(Value::as_str)
                            .map(str::to_string))
                        .as_deref()
                        == Some("completed")
            )
        })
        .await;
    }

    #[tokio::test]
    async fn create_session_resumes_provider_thread_and_send_message_uses_same_thread() {
        let server = MockAppServer::start(MockScript {
            thread_id: "existing-thread",
            ..MockScript::default()
        })
        .await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, _events) = LocalChatRuntime::capturing_for_tests();

        harness
            .create_session(
                create_input("backend-resume", None, Some("existing-thread")),
                runtime,
            )
            .await
            .expect("resume codex session");
        harness
            .send_message("backend-resume", "next message")
            .await
            .expect("send resumed message");

        let requests = server.requests();
        assert_eq!(requests[2]["method"], "thread/resume");
        assert_eq!(requests[2]["params"]["threadId"], "existing-thread");
        assert_eq!(requests[2]["params"]["excludeTurns"], true);
        assert_eq!(requests[3]["method"], "turn/start");
        assert_eq!(requests[3]["params"]["threadId"], "existing-thread");
        assert_eq!(requests[3]["params"]["input"][0]["text"], "next message");
    }

    #[tokio::test]
    async fn json_rpc_errors_surface_as_start_failures() {
        let server = MockAppServer::start(MockScript {
            rpc_error_method: Some("thread/start"),
            ..MockScript::default()
        })
        .await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, events) = LocalChatRuntime::capturing_for_tests();

        let result = harness
            .create_session(create_input("backend-error", None, None), runtime)
            .await;

        assert_eq!(
            result,
            Err(LocalChatSessionError::StartFailed(
                "thread/start exploded (-32000)".to_string()
            ))
        );
        assert!(!harness.has_session("backend-error").await);
        assert!(events
            .lock()
            .expect("events lock")
            .contains(&LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id: "backend-error".to_string(),
                harness: LocalChatHarnessKind::Codex,
                error: "thread/start exploded (-32000)".to_string(),
            })));
    }

    #[tokio::test]
    async fn failed_turn_emits_error_and_returns_send_failure() {
        let server = MockAppServer::start(MockScript {
            turn_status: "failed",
            turn_error: Some("model failed"),
            ..MockScript::default()
        })
        .await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, events) = LocalChatRuntime::capturing_for_tests();

        harness
            .create_session(create_input("backend-failed-turn", None, None), runtime)
            .await
            .expect("create codex session");
        let result = harness
            .send_message("backend-failed-turn", "please fail")
            .await;

        assert_eq!(
            result,
            Err(LocalChatSessionError::SendFailed(
                "model failed".to_string()
            ))
        );
        let events = events.lock().expect("events lock").clone();
        assert!(
            events.contains(&LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id: "backend-failed-turn".to_string(),
                harness: LocalChatHarnessKind::Codex,
                error: "model failed".to_string(),
            }))
        );
        assert!(events.iter().any(|event| matches!(
            event,
            LocalChatEvent::End(LocalChatSessionEndEvent { is_error: true, .. })
        )));
    }

    #[tokio::test]
    async fn close_session_cleans_up_live_registry_and_socket() {
        let server = MockAppServer::start(MockScript::default()).await;
        let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
        let (runtime, _events) = LocalChatRuntime::capturing_for_tests();

        harness
            .create_session(create_input("backend-close", None, None), runtime)
            .await
            .expect("create codex session");
        assert!(harness.has_session("backend-close").await);

        harness
            .close_session("backend-close")
            .await
            .expect("close codex session");
        assert!(!harness.has_session("backend-close").await);

        tokio::time::timeout(Duration::from_secs(1), async {
            while !server.closed() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("mock server should observe websocket close");
    }

    #[tokio::test]
    async fn ready_probe_handles_status_line_split_across_reads() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind readiness probe listener");
        let addr = listener.local_addr().expect("read readiness probe addr");

        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept readiness probe");
            let mut request = [0_u8; 128];
            let _ = stream.read(&mut request).await;
            stream.write_all(b"HT").await.expect("write split status");
            sleep(Duration::from_millis(10)).await;
            stream
                .write_all(b"TP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await
                .expect("write remainder");
        });

        assert!(ready_probe(addr).await.expect("readiness probe"));
    }
}
