use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, ToSocketAddrs};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{sleep, Instant};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tungstenite::Message;

use crate::helpers::find_codex_binary;
use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatEventSink, LocalChatHarness,
    LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatModelOption, LocalChatRuntime,
    LocalChatSessionEndEvent, LocalChatSessionError, LocalChatSessionErrorEvent,
    LocalChatSessionInitEvent, LocalChatSessionUsageEvent, LocalChatTextEvent,
};

const CODEX_DEFAULT_MODEL_ID: &str = "default";
const CODEX_DEFAULT_MODEL_LABEL: &str = "Codex default";
const APP_SERVER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const APP_SERVER_READY_POLL: Duration = Duration::from_millis(50);

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
        {
            let sessions = self.sessions.read().await;
            if sessions.contains_key(&backend_session_id) {
                return Err(LocalChatSessionError::SessionExists(backend_session_id));
            }
        }

        let mut launched = self.launcher.launch().await.map_err(|err| {
            LocalChatSessionError::SpawnFailed(format!("Failed to start Codex app-server: {err}"))
        })?;
        let mut connection = match CodexRpcConnection::connect(&launched.ws_url).await {
            Ok(connection) => connection,
            Err(error) => {
                stop_process(&mut launched.process).await;
                return Err(LocalChatSessionError::StartFailed(error));
            }
        };
        if let Err(error) = connection.initialize().await {
            stop_process(&mut launched.process).await;
            return Err(LocalChatSessionError::StartFailed(error));
        }

        let model_override = requested_model_override(input.model_id.as_deref());
        let thread = match connection
            .start_or_resume_thread(ThreadRequest {
                provider_resume_id: input.provider_resume_id.as_deref(),
                working_dir: input.working_dir.as_deref(),
                model: model_override,
            })
            .await
        {
            Ok(thread) => thread,
            Err(error) => {
                stop_process(&mut launched.process).await;
                return Err(LocalChatSessionError::StartFailed(error));
            }
        };

        let event_sink = runtime.event_sink();
        emit_init(
            &event_sink,
            &backend_session_id,
            Some(thread.thread_id.clone()),
            thread.model.clone(),
        );

        let session = Arc::new(CodexLocalChatSession {
            backend_session_id: backend_session_id.clone(),
            thread_id: thread.thread_id,
            model: thread.model,
            event_sink,
            connection: Mutex::new(connection),
            process: Mutex::new(launched.process),
            stats: Mutex::new(SessionStats::default()),
        });

        if let Some(initial_prompt) = input.initial_prompt.as_deref() {
            if let Err(error) = session
                .run_turn(initial_prompt, TurnFailureSurface::Start)
                .await
            {
                session.shutdown().await;
                return Err(error);
            }
        }

        let mut sessions = self.sessions.write().await;
        if sessions.contains_key(&backend_session_id) {
            drop(sessions);
            session.shutdown().await;
            return Err(LocalChatSessionError::SessionExists(backend_session_id));
        }
        sessions.insert(backend_session_id, session);
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
    model: String,
    event_sink: LocalChatEventSink,
    connection: Mutex<CodexRpcConnection>,
    process: Mutex<Option<Child>>,
    stats: Mutex<SessionStats>,
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
        let mut connection = self.connection.lock().await;
        let outcome = connection
            .start_turn(TurnRequest {
                backend_session_id: &self.backend_session_id,
                thread_id: &self.thread_id,
                content,
                model: &self.model,
                num_turns,
                event_sink: &self.event_sink,
            })
            .await
            .map_err(|err| failure_surface.error(err))?;

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
        if let Ok(mut connection) = self.connection.try_lock() {
            let _ = connection.close().await;
        }

        let mut process = self.process.lock().await;
        stop_process(&mut process).await;
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

struct ThreadRequest<'a> {
    provider_resume_id: Option<&'a str>,
    working_dir: Option<&'a str>,
    model: Option<&'a str>,
}

struct ThreadStart {
    thread_id: String,
    model: String,
}

struct TurnRequest<'a> {
    backend_session_id: &'a str,
    thread_id: &'a str,
    content: &'a str,
    model: &'a str,
    num_turns: u32,
    event_sink: &'a LocalChatEventSink,
}

struct TurnOutcome {
    context_tokens: u32,
    context_window: u32,
    error: Option<String>,
}

struct CodexRpcConnection {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl CodexRpcConnection {
    async fn connect(ws_url: &str) -> Result<Self, String> {
        let (stream, _) = connect_async(ws_url)
            .await
            .map_err(|err| format!("Failed to connect to Codex app-server websocket: {err}"))?;
        Ok(Self { stream, next_id: 1 })
    }

    async fn initialize(&mut self) -> Result<(), String> {
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
            None,
        )
        .await?;
        self.notify("initialized", json!({})).await
    }

    async fn start_or_resume_thread(
        &mut self,
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

        let response = self.request(method, params, None).await?;
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

        Ok(ThreadStart { thread_id, model })
    }

    async fn start_turn(&mut self, request: TurnRequest<'_>) -> Result<TurnOutcome, String> {
        let params = json!({
            "threadId": request.thread_id,
            "input": [
                {
                    "type": "text",
                    "text": request.content,
                }
            ],
        });
        let mut handler = TurnNotificationHandler::new(
            request.backend_session_id,
            request.thread_id,
            request.model,
            request.num_turns,
            request.event_sink,
        );
        let response = self
            .request("turn/start", params, Some(&mut handler))
            .await?;
        let turn_id = response
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .map(str::to_string);

        while !handler.is_completed() {
            let message = self.read_message().await?;
            self.handle_message(message, None, Some(&mut handler))
                .await?;
            if let Some(expected_turn_id) = &turn_id {
                handler.retain_completion_for_turn(expected_turn_id);
            }
        }

        Ok(handler.into_outcome())
    }

    async fn request(
        &mut self,
        method: &'static str,
        params: Value,
        mut notification_handler: Option<&mut TurnNotificationHandler<'_>>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send_json(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;

        loop {
            let message = self.read_message().await?;
            let handler = notification_handler.as_deref_mut();
            if let Some(response) = self.handle_message(message, Some(id), handler).await? {
                return Ok(response);
            }
        }
    }

    async fn notify(&mut self, method: &'static str, params: Value) -> Result<(), String> {
        self.send_json(&json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn close(&mut self) -> Result<(), String> {
        self.stream
            .close(None)
            .await
            .map_err(|err| format!("Failed to close Codex app-server websocket: {err}"))
    }

    async fn send_json(&mut self, value: &Value) -> Result<(), String> {
        self.stream
            .send(Message::Text(value.to_string()))
            .await
            .map_err(|err| format!("Failed to send Codex app-server request: {err}"))
    }

    async fn read_message(&mut self) -> Result<RpcMessage, String> {
        while let Some(frame) = self.stream.next().await {
            let frame =
                frame.map_err(|err| format!("Failed to read Codex app-server response: {err}"))?;
            match frame {
                Message::Text(text) => {
                    return serde_json::from_str(&text)
                        .map_err(|err| format!("Invalid Codex app-server JSON frame: {err}"));
                }
                Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => {}
                Message::Close(_) => return Err("Codex app-server websocket closed".to_string()),
                Message::Frame(_) => {}
            }
        }
        Err("Codex app-server websocket ended".to_string())
    }

    async fn handle_message(
        &mut self,
        message: RpcMessage,
        response_id: Option<u64>,
        notification_handler: Option<&mut TurnNotificationHandler<'_>>,
    ) -> Result<Option<Value>, String> {
        if let (Some(expected_id), Some(message_id)) = (response_id, message.id.as_ref()) {
            if message_id.as_u64() == Some(expected_id) {
                if let Some(error) = message.error {
                    return Err(format!("{} ({})", error.message, error.code));
                }
                return Ok(Some(message.result.unwrap_or(Value::Null)));
            }
        }

        if let (Some(id), Some(method)) = (message.id.as_ref(), message.method.as_deref()) {
            self.respond_to_server_request(id.clone(), method).await?;
            return Ok(None);
        }

        if let (Some(method), Some(params), Some(handler)) = (
            message.method.as_deref(),
            message.params.as_ref(),
            notification_handler,
        ) {
            handler.handle(method, params);
        }

        Ok(None)
    }

    async fn respond_to_server_request(&mut self, id: Value, method: &str) -> Result<(), String> {
        self.send_json(&json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("Vertebrae local chat does not handle Codex server request '{method}' yet"),
            },
        }))
        .await
    }
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

struct TurnNotificationHandler<'a> {
    backend_session_id: &'a str,
    thread_id: &'a str,
    model: &'a str,
    num_turns: u32,
    event_sink: &'a LocalChatEventSink,
    text: String,
    context_tokens: u32,
    context_window: u32,
    completed: Option<TurnCompletion>,
}

impl<'a> TurnNotificationHandler<'a> {
    fn new(
        backend_session_id: &'a str,
        thread_id: &'a str,
        model: &'a str,
        num_turns: u32,
        event_sink: &'a LocalChatEventSink,
    ) -> Self {
        Self {
            backend_session_id,
            thread_id,
            model,
            num_turns,
            event_sink,
            text: String::new(),
            context_tokens: 0,
            context_window: 0,
            completed: None,
        }
    }

    fn handle(&mut self, method: &str, params: &Value) {
        if params.get("threadId").and_then(Value::as_str) != Some(self.thread_id) {
            return;
        }

        match method {
            "item/agentMessage/delta" => self.handle_agent_delta(params),
            "thread/tokenUsage/updated" => self.handle_usage(params),
            "turn/completed" => self.handle_turn_completed(params),
            "error" => self.handle_error(params),
            _ => {}
        }
    }

    fn handle_agent_delta(&mut self, params: &Value) {
        let Some(delta) = params.get("delta").and_then(Value::as_str) else {
            return;
        };
        self.text.push_str(delta);
        self.event_sink
            .emit(LocalChatEvent::Text(LocalChatTextEvent {
                backend_session_id: self.backend_session_id.to_string(),
                harness: LocalChatHarnessKind::Codex,
                text: delta.to_string(),
                is_partial: true,
            }));
    }

    fn handle_usage(&mut self, params: &Value) {
        self.context_tokens = value_to_u32(params.pointer("/tokenUsage/total/totalTokens"))
            .unwrap_or(self.context_tokens);
        self.context_window = value_to_u32(params.pointer("/tokenUsage/modelContextWindow"))
            .unwrap_or(self.context_window);
        self.event_sink
            .emit(LocalChatEvent::Usage(LocalChatSessionUsageEvent {
                backend_session_id: self.backend_session_id.to_string(),
                harness: LocalChatHarnessKind::Codex,
                model: self.model.to_string(),
                context_tokens: self.context_tokens,
                context_window: self.context_window,
            }));
    }

    fn handle_turn_completed(&mut self, params: &Value) {
        let status = params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let turn_id = params
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let duration_ms = value_to_u32(params.pointer("/turn/durationMs")).unwrap_or(0);
        let error = if status == "completed" {
            None
        } else {
            Some(
                params
                    .pointer("/turn/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or(status)
                    .to_string(),
            )
        };

        if let Some(error) = &error {
            self.emit_error(error.clone());
        }

        self.event_sink
            .emit(LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id: self.backend_session_id.to_string(),
                harness: LocalChatHarnessKind::Codex,
                duration_ms,
                cost_usd: 0.0,
                num_turns: self.num_turns,
                result: self.text.clone(),
                is_error: error.is_some(),
                context_tokens: self.context_tokens,
                context_window: self.context_window,
            }));

        self.completed = Some(TurnCompletion { turn_id, error });
    }

    fn handle_error(&mut self, params: &Value) {
        let error = params
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Codex app-server error")
            .to_string();
        self.emit_error(error.clone());
        self.completed = Some(TurnCompletion {
            turn_id: None,
            error: Some(error),
        });
    }

    fn emit_error(&self, error: String) {
        self.event_sink
            .emit(LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id: self.backend_session_id.to_string(),
                harness: LocalChatHarnessKind::Codex,
                error,
            }));
    }

    fn retain_completion_for_turn(&mut self, expected_turn_id: &str) {
        if self
            .completed
            .as_ref()
            .and_then(|completion| completion.turn_id.as_deref())
            .is_some_and(|turn_id| turn_id != expected_turn_id)
        {
            self.completed = None;
        }
    }

    fn is_completed(&self) -> bool {
        self.completed.is_some()
    }

    fn into_outcome(self) -> TurnOutcome {
        TurnOutcome {
            context_tokens: self.context_tokens,
            context_window: self.context_window,
            error: self.completed.and_then(|completion| completion.error),
        }
    }
}

struct TurnCompletion {
    turn_id: Option<String>,
    error: Option<String>,
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

fn requested_model_override(model_id: Option<&str>) -> Option<&str> {
    match model_id {
        Some(CODEX_DEFAULT_MODEL_ID) | None => None,
        Some(model_id) => Some(model_id),
    }
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
            models: vec![LocalChatModelOption {
                id: CODEX_DEFAULT_MODEL_ID.to_string(),
                label: CODEX_DEFAULT_MODEL_LABEL.to_string(),
            }],
            supports_resume: true,
        }
    }

    async fn launch(&self) -> Result<LaunchedCodexAppServer, String> {
        let binary = find_codex_binary()?;
        let (ws_url, ready_addr) = reserve_local_ws_url()?;
        let mut process = spawn_codex_app_server(&binary, &ws_url)?;
        if let Err(err) = wait_for_ready(ready_addr).await {
            let _ = process.kill().await;
            let _ = process.wait().await;
            return Err(err);
        }
        Ok(LaunchedCodexAppServer {
            ws_url,
            process: Some(process),
        })
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
    let mut response = [0_u8; 64];
    let bytes = stream
        .read(&mut response)
        .await
        .map_err(|err| format!("Failed to read Codex app-server readiness probe: {err}"))?;
    Ok(
        std::str::from_utf8(&response[..bytes]).is_ok_and(|response| {
            response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_chat::{LocalChatEvent, LocalChatRuntime};
    use tokio::net::TcpListener;

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
                models: vec![LocalChatModelOption {
                    id: CODEX_DEFAULT_MODEL_ID.to_string(),
                    label: CODEX_DEFAULT_MODEL_LABEL.to_string(),
                }],
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
        turn_status: &'static str,
        turn_error: Option<&'static str>,
    }

    impl Default for MockScript {
        fn default() -> Self {
            Self {
                thread_id: "codex-thread-1",
                model: "mock-codex-model",
                rpc_error_method: None,
                turn_status: "completed",
                turn_error: None,
            }
        }
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

        fn closed(&self) -> bool {
            *self.closed.lock().expect("closed lock")
        }
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
        assert_eq!(
            info.models,
            vec![LocalChatModelOption {
                id: "default".to_string(),
                label: "Codex default".to_string(),
            }]
        );
        assert!(info.supports_resume);
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
        let requests = server.requests();
        assert_eq!(requests[0]["method"], "initialize");
        assert_eq!(requests[1]["method"], "initialized");
        assert_eq!(requests[2]["method"], "thread/start");
        assert_eq!(requests[2]["params"]["cwd"], "/tmp/project");
        assert!(requests[2]["params"].get("model").is_none());
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
        let (runtime, _events) = LocalChatRuntime::capturing_for_tests();

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
}
