use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tungstenite::Message;

use crate::local_chat::LocalChatEventSink;

use super::models::CODEX_DEFAULT_MODEL_LABEL;
use super::notifications::{TurnNotificationHandler, TurnOutcome};
use super::permissions::CodexPermissionSettings;
use super::thread_state::CodexThreadState;

pub(super) struct ThreadRequest<'a> {
    pub(super) provider_resume_id: Option<&'a str>,
    pub(super) working_dir: Option<&'a str>,
    pub(super) model: Option<&'a str>,
    pub(super) reasoning_effort: Option<&'a str>,
    pub(super) permission_settings: CodexPermissionSettings,
}

pub(super) struct ThreadStart {
    pub(super) thread_id: String,
    pub(super) model: String,
}

pub(super) struct TurnRequest<'a> {
    pub(super) thread_id: &'a str,
    pub(super) content: &'a str,
    pub(super) num_turns: u32,
    pub(super) permission_settings: CodexPermissionSettings,
}

type CodexWsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type CodexWsWriter = SplitSink<CodexWsStream, Message>;
type CodexWsReader = SplitStream<CodexWsStream>;
type PendingResponses = Arc<Mutex<HashMap<u64, PendingRpcResponse>>>;

struct PendingRpcResponse {
    method: &'static str,
    tx: oneshot::Sender<Result<Value, String>>,
}

pub(super) struct CodexRpcConnection {
    writer: Arc<Mutex<CodexWsWriter>>,
    next_id: Mutex<u64>,
    pending_responses: PendingResponses,
    notification_handler: Arc<StdMutex<TurnNotificationHandler>>,
    reader_task: JoinHandle<()>,
}

impl CodexRpcConnection {
    pub(super) async fn connect(
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

    pub(super) async fn initialize(&self) -> Result<(), String> {
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

    pub(super) async fn start_or_resume_thread(
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

    pub(super) async fn start_turn(&self, request: TurnRequest<'_>) -> Result<TurnOutcome, String> {
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

    pub(super) async fn close(&self) -> Result<(), String> {
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
