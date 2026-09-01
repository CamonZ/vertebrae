use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    process::Child,
    sync::{Mutex as AsyncMutex, mpsc, oneshot, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use vertebrae_harness_core::{
    AgentMetadata, ApprovalCategory, ApprovalRequest, CompletionStatus, ControlRequest,
    ControlRequestEnvelope, ControlResolution, ControlSink, DiagnosticEvent, EventCorrelation,
    EventSequencer, EventSink, FileChange, FileChangeEvent, FileChangeKind, GrantScope,
    HarnessCapabilities, HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1, HarnessRuntime,
    ItemId, OutcomeMetrics, OutputVerbosity, ProviderResumeId, ProviderThreadRef,
    QuestionCapabilities, RunHandle, RunId, RunOutcome, RunRequest, SendTurnRequest,
    SequencedEventSink, SessionCloseOutcome, SessionCloseStatus, SessionHandle, SessionId,
    SessionStarted, SessionUsage, SpeedTier, StartSessionRequest, StreamId, TextEvent,
    ThreadDeclared, ThreadId, ThreadKind, TokenUsage, ToolCallEvent, ToolCallId, ToolOutputEvent,
    ToolStatus, TurnHandle, TurnId, TurnInput, TurnInputProvenance, TurnOutcome, TurnStarted,
    TurnUsage, UpdateSemantics, UsageEvent,
};

use crate::{
    CodexNotification, CodexProviderConfig, decode_notification,
    launcher::{CodexAppServerLauncher, ProcessCodexAppServerLauncher, cleanup_process},
    number, optional_string, required_string,
};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

const RAW_TRAFFIC_ENV: &str = "VERTEBRAE_CODEX_RAW_TRAFFIC";

fn raw_traffic_logging_enabled() -> bool {
    matches!(
        std::env::var(RAW_TRAFFIC_ENV).as_deref(),
        Ok("1" | "true" | "TRUE" | "yes" | "YES")
    )
}

fn trace(
    session_id: Option<&str>,
    kind: &str,
    direction: &str,
    turn_id: Option<&str>,
    state: &str,
    detail: Option<&str>,
    payload: Option<&str>,
) {
    let record = json!({
        "timestamp_ms": Utc::now().timestamp_millis(),
        "source": "codex",
        "kind": kind,
        "direction": direction,
        "session_id": session_id,
        "turn_id": turn_id,
        "state": state,
        "detail": detail,
        "payload": payload,
    });
    log::info!("[LOCAL_CHAT_TRACE] {record}");
}

fn log_raw_traffic(direction: &str, payload: &str) {
    let (kind, trace_direction) = match direction {
        "send" => ("wire.send", "harness_to_provider"),
        "recv" => ("wire.recv", "provider_to_harness"),
        _ => ("wire", "internal"),
    };
    trace(
        None,
        kind,
        trace_direction,
        None,
        "transport",
        None,
        Some(payload),
    );
    if raw_traffic_logging_enabled() {
        log::info!("[Codex][raw][{direction}] {payload}");
    }
}

#[derive(Clone)]
struct NotificationMessage {
    method: String,
    params: Value,
}

struct PendingResponse {
    tx: oneshot::Sender<Result<Value, HarnessError>>,
    normalized_root_turn_id: Option<TurnId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlDisposition {
    Forward,
    RejectStale,
}

struct ActiveRootTurn {
    normalized_turn_id: TurnId,
    provider_turn_id: Option<String>,
}

#[derive(Default)]
struct RootTurnIdentityState {
    root_thread_id: Option<ThreadId>,
    active: Option<ActiveRootTurn>,
    recent_provider_turn_id: Option<String>,
}

#[derive(Default)]
struct RootTurnIdentity {
    state: Mutex<RootTurnIdentityState>,
}

impl RootTurnIdentity {
    fn set_root_thread(&self, thread_id: ThreadId) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .root_thread_id = Some(thread_id);
    }

    fn begin_turn(&self, turn_id: TurnId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(provider_turn_id) = state
            .active
            .take()
            .and_then(|active| active.provider_turn_id)
        {
            state.recent_provider_turn_id = Some(provider_turn_id);
        }
        state.active = Some(ActiveRootTurn {
            normalized_turn_id: turn_id,
            provider_turn_id: None,
        });
    }

    fn bind_provider_turn(&self, provider_turn_id: &str, turn_id: TurnId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.active.as_mut()
            && active.normalized_turn_id == turn_id
        {
            active.provider_turn_id = Some(provider_turn_id.to_string());
        }
    }

    fn finish_turn(&self, turn_id: &TurnId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .active
            .as_ref()
            .is_some_and(|active| &active.normalized_turn_id == turn_id)
        {
            let active = state.active.take().expect("active turn was checked");
            if active.provider_turn_id.is_some() {
                state.recent_provider_turn_id = active.provider_turn_id;
            }
        }
    }

    fn clear(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.root_thread_id = None;
        state.active = None;
        state.recent_provider_turn_id = None;
    }

    fn prepare_control_request(&self, request: &mut ControlRequestEnvelope) -> ControlDisposition {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(thread_id) = request.thread_id.as_ref() else {
            return ControlDisposition::Forward;
        };
        let Some(root_thread_id) = state.root_thread_id.as_ref() else {
            return ControlDisposition::Forward;
        };
        let is_root = thread_id == root_thread_id;
        request.is_root = Some(is_root);
        if !is_root {
            return ControlDisposition::Forward;
        }

        let Some(active) = state.active.as_ref() else {
            return ControlDisposition::RejectStale;
        };
        let Some(requested_turn_id) = request.turn_id.as_ref() else {
            request.turn_id = Some(active.normalized_turn_id.clone());
            return ControlDisposition::Forward;
        };
        if requested_turn_id == &active.normalized_turn_id
            || active.provider_turn_id.as_deref() == Some(requested_turn_id.as_str())
        {
            request.turn_id = Some(active.normalized_turn_id.clone());
            return ControlDisposition::Forward;
        }
        if state.recent_provider_turn_id.as_deref() == Some(requested_turn_id.as_str()) {
            return ControlDisposition::RejectStale;
        }
        if active.provider_turn_id.is_none() {
            request.turn_id = Some(active.normalized_turn_id.clone());
            return ControlDisposition::Forward;
        }
        ControlDisposition::RejectStale
    }
}

pub(crate) struct CodexConnection {
    writer: Arc<AsyncMutex<futures::stream::SplitSink<WsStream, Message>>>,
    pending: Arc<AsyncMutex<HashMap<String, PendingResponse>>>,
    next_id: AsyncMutex<u64>,
    notifications: AsyncMutex<mpsc::Receiver<NotificationMessage>>,
    closed: watch::Sender<Option<String>>,
    reader: AsyncMutex<Option<JoinHandle<()>>>,
    root_turn_identity: Arc<RootTurnIdentity>,
}

impl CodexConnection {
    pub(crate) async fn connect(
        url: &str,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<Self>, HarnessError> {
        let (stream, _) = connect_async(url).await.map_err(|error| {
            HarnessError::Unavailable(format!("failed to connect to Codex App Server: {error}"))
        })?;
        let (writer, mut reader) = stream.split();
        let (notification_tx, notification_rx) = mpsc::channel(512);
        let (closed, _) = watch::channel(None);
        let root_turn_identity = Arc::new(RootTurnIdentity::default());
        let connection = Arc::new(Self {
            writer: Arc::new(AsyncMutex::new(writer)),
            pending: Arc::new(AsyncMutex::new(HashMap::new())),
            next_id: AsyncMutex::new(1),
            notifications: AsyncMutex::new(notification_rx),
            closed,
            reader: AsyncMutex::new(None),
            root_turn_identity: Arc::clone(&root_turn_identity),
        });
        let pending = Arc::clone(&connection.pending);
        let writer = Arc::clone(&connection.writer);
        let connection_closed = connection.closed.clone();
        let reader_task = tokio::spawn(async move {
            let failure = loop {
                let Some(frame) = reader.next().await else {
                    break "Codex App Server websocket ended".to_string();
                };
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(error) => break format!("Codex App Server websocket read failed: {error}"),
                };
                let Some(text) = (match frame {
                    Message::Text(text) => Some(text.to_string()),
                    Message::Close(_) => None,
                    _ => continue,
                }) else {
                    break "Codex App Server websocket closed".into();
                };
                log_raw_traffic("recv", &text);
                let message: crate::CodexRpcMessage = match serde_json::from_str(&text) {
                    Ok(message) => message,
                    Err(error) => break format!("malformed Codex App Server JSON: {error}"),
                };
                if let Some(id) = message.id.clone() {
                    if message.method.is_none() {
                        let key = id.to_string();
                        if let Some(pending) = pending.lock().await.remove(&key) {
                            let result = match message.error {
                                Some(error) => Err(HarnessError::Operation(format!(
                                    "{} ({})",
                                    error.message, error.code
                                ))),
                                None => Ok(message.result.unwrap_or(Value::Null)),
                            };
                            if let (Some(normalized_turn_id), Ok(response)) =
                                (pending.normalized_root_turn_id, &result)
                                && let Ok(provider_turn_id) = required_string(
                                    response.get("turn").unwrap_or(response),
                                    &["/id", "/turn/id"],
                                    "turn/start response turn id",
                                )
                            {
                                root_turn_identity
                                    .bind_provider_turn(&provider_turn_id, normalized_turn_id);
                            }
                            let _ = pending.tx.send(result);
                        }
                        continue;
                    }
                    if let Some(method) = message.method {
                        let writer = Arc::clone(&writer);
                        let control_sink = Arc::clone(&control_sink);
                        let params = message.params.unwrap_or(Value::Null);
                        let prepared = control_request(&method, &params).map(|mut request| {
                            let disposition =
                                root_turn_identity.prepare_control_request(&mut request);
                            (request, disposition)
                        });
                        tokio::spawn(async move {
                            respond_to_control_request(
                                &writer,
                                &control_sink,
                                id,
                                &method,
                                prepared,
                            )
                            .await;
                        });
                        continue;
                    }
                }
                if let Some(method) = message.method
                    && notification_tx
                        .send(NotificationMessage {
                            method,
                            params: message.params.unwrap_or(Value::Null),
                        })
                        .await
                        .is_err()
                {
                    break "Codex notification queue closed".to_string();
                }
            };
            let pending = std::mem::take(&mut *pending.lock().await);
            let _ = connection_closed.send(Some(failure.clone()));
            for (_, pending) in pending {
                let _ = pending
                    .tx
                    .send(Err(HarnessError::Operation(failure.clone())));
            }
        });
        *connection.reader.lock().await = Some(reader_task);
        Ok(connection)
    }

    pub(crate) async fn request(&self, method: &str, params: Value) -> Result<Value, HarnessError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        let key = id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(
            key.clone(),
            PendingResponse {
                tx,
                normalized_root_turn_id: None,
            },
        );
        let message = json!({"id": id, "method": method, "params": params});
        if let Err(error) = self.send(message).await {
            self.pending.lock().await.remove(&key);
            return Err(error);
        }
        rx.await.map_err(|_| {
            HarnessError::Operation(format!(
                "Codex App Server response channel closed for {method}"
            ))
        })?
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
        normalized_root_turn_id: TurnId,
    ) -> Result<Value, HarnessError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        let key = id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(
            key.clone(),
            PendingResponse {
                tx,
                normalized_root_turn_id: Some(normalized_root_turn_id),
            },
        );
        if let Err(error) = self
            .send(json!({"id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().await.remove(&key);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(result) => result.map_err(|_| {
                HarnessError::Operation(format!(
                    "Codex App Server response channel closed for {method}"
                ))
            })?,
            Err(_) => {
                self.pending.lock().await.remove(&key);
                Err(HarnessError::Operation(format!(
                    "Codex {method} request timed out"
                )))
            }
        }
    }

    /// Sends a JSON-RPC request without retaining response state. Used for
    /// best-effort interruption, where provider terminal notification is the
    /// authoritative acknowledgement.
    async fn request_no_wait(&self, method: &str, params: Value) -> Result<(), HarnessError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        self.send(json!({"id": id, "method": method, "params": params}))
            .await
    }

    pub(crate) async fn notify(&self, method: &str, params: Value) -> Result<(), HarnessError> {
        self.send(json!({"method": method, "params": params})).await
    }

    async fn send(&self, value: Value) -> Result<(), HarnessError> {
        let text = value.to_string();
        log_raw_traffic("send", &text);
        self.writer
            .lock()
            .await
            .send(Message::Text(text))
            .await
            .map_err(|error| {
                HarnessError::Operation(format!("failed to send Codex App Server message: {error}"))
            })
    }

    pub(crate) async fn close(&self) {
        self.root_turn_identity.clear();
        if let Some(reader) = self.reader.lock().await.take() {
            reader.abort();
        }
        let _ = self.writer.lock().await.close().await;
        let _ = self.closed.send(Some("Codex App Server closed".into()));
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, pending) in pending {
            let _ = pending.tx.send(Err(HarnessError::Operation(
                "Codex App Server closed".into(),
            )));
        }
    }

    fn set_root_thread(&self, thread_id: ThreadId) {
        self.root_turn_identity.set_root_thread(thread_id);
    }

    fn begin_root_turn(&self, turn_id: TurnId) {
        self.root_turn_identity.begin_turn(turn_id);
    }

    fn finish_root_turn(&self, turn_id: &TurnId) {
        self.root_turn_identity.finish_turn(turn_id);
    }
}

async fn respond_to_control_request(
    writer: &Arc<AsyncMutex<futures::stream::SplitSink<WsStream, Message>>>,
    control_sink: &Arc<dyn ControlSink>,
    id: Value,
    method: &str,
    prepared: Option<(ControlRequestEnvelope, ControlDisposition)>,
) {
    let response = match prepared {
        None => {
            json!({"id": id, "error": {"code": -32601, "message": format!("unsupported Codex server request '{method}'")}})
        }
        Some((request, disposition)) => match disposition {
            ControlDisposition::Forward => match control_sink.request(request).await {
                Ok(resolution) => {
                    json!({"id": id, "result": encode_control_resolution(&resolution)})
                }
                Err(error) => {
                    json!({"id": id, "error": {"code": -32000, "message": error.to_string()}})
                }
            },
            ControlDisposition::RejectStale => {
                json!({"id": id, "result": {"decision": "decline"}})
            }
        },
    };
    log_raw_traffic("send", &response.to_string());
    let _ = writer
        .lock()
        .await
        .send(Message::Text(response.to_string()))
        .await;
}

fn control_request(method: &str, params: &Value) -> Option<ControlRequestEnvelope> {
    let request = match method {
        "item/commandExecution/requestApproval" => ControlRequest::Approval(ApprovalRequest {
            category: ApprovalCategory::CommandExecution,
            title: "Codex command execution".into(),
            details: Some(params.clone()),
            modification_supported: false,
        }),
        "item/fileChange/requestApproval" => ControlRequest::Approval(ApprovalRequest {
            category: ApprovalCategory::FileChange,
            title: "Codex file change".into(),
            details: Some(params.clone()),
            modification_supported: false,
        }),
        "item/permissions/requestApproval" => {
            ControlRequest::PermissionGrant(vertebrae_harness_core::PermissionGrantRequest {
                permissions: params
                    .get("permissions")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                scope_supported: vec![GrantScope::Turn, GrantScope::Session],
            })
        }
        "item/question/request" | "item/userQuestion/request" => ControlRequest::UserQuestion {
            questions: Vec::new(),
        },
        _ => return None,
    };
    Some(ControlRequestEnvelope {
        request_id: params
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or(method)
            .into(),
        session_id: params
            .get("threadId")
            .and_then(Value::as_str)
            .map(|value| SessionId::new(value.to_string())),
        turn_id: params
            .get("turnId")
            .and_then(Value::as_str)
            .map(|value| TurnId::new(value.to_string())),
        thread_id: params
            .get("threadId")
            .and_then(Value::as_str)
            .map(|value| ThreadId::new(value.to_string())),
        is_root: None,
        request,
        presentation: None,
        timeout_ms: None,
        automatic_resolution: None,
    })
}

fn encode_control_resolution(resolution: &ControlResolution) -> Value {
    match resolution.decision.as_ref() {
        Some(vertebrae_harness_core::ControlDecision::AllowOnce) => json!({"decision":"accept"}),
        Some(vertebrae_harness_core::ControlDecision::AllowForSession) => {
            json!({"decision":"acceptForSession"})
        }
        Some(vertebrae_harness_core::ControlDecision::Deny) => json!({"decision":"decline"}),
        Some(vertebrae_harness_core::ControlDecision::Cancel) => json!({"decision":"cancel"}),
        Some(vertebrae_harness_core::ControlDecision::Modified(value)) => {
            json!({"decision":"accept", "updatedInput": value})
        }
        Some(vertebrae_harness_core::ControlDecision::PermissionsGranted {
            permissions,
            scope,
        }) => {
            json!({"permissions": permissions.iter().cloned().map(|permission| (permission, Value::Bool(true))).collect::<serde_json::Map<_, _>>(), "scope": match scope { GrantScope::Turn => "turn", GrantScope::Session => "session" }})
        }
        Some(vertebrae_harness_core::ControlDecision::QuestionsAnswered(answers)) => {
            json!({"decision":"accept", "answers": answers})
        }
        None => json!({"decision":"decline"}),
    }
}

#[derive(Clone)]
struct ChildInfo {
    parent_thread_id: Option<ThreadId>,
    caused_by: Option<ToolCallId>,
    prompt: Option<String>,
    metadata: Option<AgentMetadata>,
}

struct SessionState {
    connection: Arc<CodexConnection>,
    process: AsyncMutex<Option<Child>>,
    config: Arc<CodexProviderConfig>,
    sink: Arc<SequencedEventSink>,
    root_stream_id: StreamId,
    root_session_id: SessionId,
    root_thread_id: ThreadId,
    default_output_schema: Option<Value>,
    root_turn_gate: AsyncMutex<()>,
    cleanup: AsyncMutex<Option<watch::Receiver<Option<SessionCloseOutcome>>>>,
    children: Mutex<HashMap<String, ChildInfo>>,
    declared_threads: Mutex<HashSet<String>>,
    closed: watch::Sender<bool>,
    closed_rx: watch::Receiver<bool>,
}

impl SessionState {
    async fn emit(
        &self,
        stream_id: StreamId,
        correlation: EventCorrelation,
        payload: HarnessEventPayloadV1,
        semantics: UpdateSemantics,
    ) -> Result<(), HarnessError> {
        self.sink
            .emit(HarnessEventDraftV1 {
                stream_id,
                correlation,
                timestamp: Utc::now(),
                semantics,
                provider_sequence: None,
                payload,
            })
            .await
            .map(|_| ())
    }

    fn root_correlation(&self, turn_id: Option<TurnId>, run_id: Option<RunId>) -> EventCorrelation {
        EventCorrelation {
            session_id: Some(self.root_session_id.clone()),
            thread_id: Some(self.root_thread_id.clone()),
            turn_id,
            run_id,
            ..EventCorrelation::default()
        }
    }

    fn child_correlation(
        session_id: &SessionId,
        thread_id: ThreadId,
        turn_id: Option<TurnId>,
        parent_tool_call_id: Option<ToolCallId>,
    ) -> EventCorrelation {
        EventCorrelation {
            session_id: Some(session_id.clone()),
            thread_id: Some(thread_id),
            turn_id,
            parent_tool_call_id,
            ..EventCorrelation::default()
        }
    }

    async fn declare_child(
        &self,
        params: &Value,
    ) -> Result<Option<(ThreadId, StreamId, EventCorrelation)>, HarnessError> {
        let Some(thread_id) = optional_string(params, &["/threadId", "/thread/id"]) else {
            return Ok(None);
        };
        if thread_id == self.root_thread_id.as_str() {
            return Ok(None);
        }
        let info = self
            .children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&thread_id)
            .cloned();
        let parent = optional_string(params, &["/parentThreadId", "/thread/parentThreadId"])
            .map(ThreadId::new)
            .or_else(|| info.as_ref().and_then(|info| info.parent_thread_id.clone()));
        let caused_by = info.as_ref().and_then(|info| info.caused_by.clone());
        let metadata = info.as_ref().and_then(|info| info.metadata.clone());
        let is_new = self
            .declared_threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(thread_id.clone());
        let thread = ThreadId::new(thread_id.clone());
        let stream = StreamId::new(format!("{}:thread:{}", self.root_stream_id, thread_id));
        let correlation = Self::child_correlation(
            &self.root_session_id,
            thread.clone(),
            optional_string(params, &["/turnId", "/turn/id"]).map(TurnId::new),
            caused_by.clone(),
        );
        if is_new {
            self.emit(
                stream.clone(),
                correlation.clone(),
                HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
                    thread_id: thread.clone(),
                    parent_thread_id: parent,
                    kind: ThreadKind::Subagent,
                    caused_by_tool_call_id: caused_by,
                    provider_thread_ref: Some(ProviderThreadRef::new(thread_id.clone())),
                    agent_metadata: metadata,
                }),
                UpdateSemantics::Snapshot,
            )
            .await?;
            if let Some(prompt) = info.and_then(|info| info.prompt) {
                self.emit(
                    stream.clone(),
                    correlation.clone(),
                    HarnessEventPayloadV1::TurnInput(TurnInput {
                        thread_id: thread.clone(),
                        run_id: None,
                        content: prompt,
                        provenance: TurnInputProvenance::Agent,
                    }),
                    UpdateSemantics::Snapshot,
                )
                .await?;
            }
        }
        Ok(Some((thread, stream, correlation)))
    }

    async fn remember_spawn(&self, item: &Value, tool_id: &str, parent_thread_id: ThreadId) {
        let Some(ids) = item
            .get("receiverThreadIds")
            .or_else(|| item.get("receiver_thread_ids"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let prompt = optional_string(
            item,
            &["/prompt", "/input/prompt", "/input/text", "/description"],
        );
        let metadata = Some(AgentMetadata {
            name: optional_string(item, &["/newAgentNickname", "/nickname", "/agent/nickname"]),
            role: optional_string(item, &["/newAgentRole", "/role", "/agent/role"]),
            model: optional_string(item, &["/model", "/agent/model"]),
        });
        let parent = Some(parent_thread_id);
        let mut children = self
            .children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for id in ids.iter().filter_map(Value::as_str) {
            children.entry(id.to_string()).or_insert(ChildInfo {
                parent_thread_id: parent.clone(),
                caused_by: Some(ToolCallId::new(tool_id)),
                prompt: prompt.clone(),
                metadata: metadata.clone(),
            });
        }
    }

    async fn process_notification(
        &self,
        notification: CodexNotification,
        expected_provider_turn: Option<&str>,
        normalized_root_turn: Option<&TurnId>,
        root_turn: &mut TurnAccumulator,
    ) -> Result<Option<TurnOutcome>, HarnessError> {
        let params = notification.params().clone();
        let thread_id = optional_string(&params, &["/threadId", "/thread/id"]);
        let is_child = thread_id
            .as_deref()
            .is_some_and(|id| id != self.root_thread_id.as_str());
        let (stream, mut correlation) = if is_child {
            let Some((_, stream, correlation)) = self.declare_child(&params).await? else {
                return Ok(None);
            };
            (stream, correlation)
        } else {
            if let Some(expected) = expected_provider_turn {
                let actual = optional_string(&params, &["/turnId", "/turn/id"]);
                if actual.as_deref().is_some_and(|actual| actual != expected) {
                    log::warn!(
                        "[Codex] dropping {} for mismatched turn_id actual={actual:?} expected={expected}",
                        notification.method()
                    );
                    return Ok(None);
                }
            }
            (
                self.root_stream_id.clone(),
                self.root_correlation(normalized_root_turn.cloned(), None),
            )
        };
        match notification {
            CodexNotification::AgentMessageDelta(params) => {
                correlation.item_id =
                    optional_string(&params, &["/itemId", "/item_id", "/item/id"]).map(ItemId::new);
                let text = required_string(&params, &["/delta"], "agent message delta")
                    .map_err(HarnessError::Operation)?;
                if !is_child {
                    root_turn.text.push_str(&text);
                }
                self.emit(
                    stream,
                    correlation,
                    HarnessEventPayloadV1::Text(TextEvent { text }),
                    UpdateSemantics::Delta,
                )
                .await?;
            }
            CodexNotification::ItemStarted(params) => {
                let Some(item) = params.get("item") else {
                    return Err(HarnessError::Operation(
                        "Codex item/started is missing item".into(),
                    ));
                };
                let item_id =
                    optional_string(item, &["/id", "/itemId", "/item_id"]).map(ItemId::new);
                correlation.item_id = item_id;
                if let Some(file_change) = file_change_event(item) {
                    correlation.tool_call_id = file_change.tool_call_id.clone();
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::FileChange(file_change),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                } else if let Some((tool_id, name, input, is_spawn)) = tool_call(item) {
                    correlation.tool_call_id = Some(ToolCallId::new(tool_id.clone()));
                    if is_spawn {
                        let parent_thread = thread_id
                            .as_deref()
                            .map(ThreadId::new)
                            .unwrap_or_else(|| self.root_thread_id.clone());
                        self.remember_spawn(item, &tool_id, parent_thread).await;
                    }
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::ToolCall(ToolCallEvent {
                            tool_call_id: ToolCallId::new(tool_id),
                            name,
                            input,
                            status: ToolStatus::Started,
                        }),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                }
            }
            CodexNotification::ItemCompleted(params) => {
                let Some(item) = params.get("item") else {
                    return Err(HarnessError::Operation(
                        "Codex item/completed is missing item".into(),
                    ));
                };
                let item_id =
                    optional_string(item, &["/id", "/itemId", "/item_id"]).map(ItemId::new);
                correlation.item_id = item_id;
                if let Some(file_change) = file_change_event(item) {
                    correlation.tool_call_id = file_change.tool_call_id.clone();
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::FileChange(file_change),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                } else {
                    match item.get("type").and_then(Value::as_str) {
                        Some("agentMessage") => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                if !is_child {
                                    root_turn.text = text.to_string();
                                }
                                self.emit(
                                    stream,
                                    correlation,
                                    HarnessEventPayloadV1::Text(TextEvent { text: text.into() }),
                                    UpdateSemantics::Snapshot,
                                )
                                .await?;
                            }
                        }
                        _ => {
                            if let Some((tool_id, output, failed)) = tool_output(item) {
                                correlation.tool_call_id = Some(ToolCallId::new(tool_id.clone()));
                                self.emit(
                                    stream,
                                    correlation,
                                    HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                                        tool_call_id: ToolCallId::new(tool_id),
                                        output,
                                        status: if failed {
                                            ToolStatus::Failed
                                        } else {
                                            ToolStatus::Completed
                                        },
                                        content_semantics: UpdateSemantics::Snapshot,
                                    }),
                                    UpdateSemantics::Snapshot,
                                )
                                .await?;
                            }
                        }
                    }
                }
            }
            CodexNotification::TokenUsageUpdated(params) => {
                let usage = parse_usage(&params);
                let turn_delta = if !is_child {
                    let turn_delta = usage.0.as_ref().map(|current| {
                        let delta = usage_delta(root_turn.last_usage.as_ref(), current);
                        root_turn.last_usage = Some(current.clone());
                        root_turn.usage = Some(current.clone());
                        delta
                    });
                    root_turn.context_tokens = usage
                        .1
                        .as_ref()
                        .and_then(|snapshot| snapshot.context_tokens);
                    root_turn.context_window = usage
                        .1
                        .as_ref()
                        .and_then(|snapshot| snapshot.context_window);
                    turn_delta
                } else {
                    usage.0.clone()
                };
                self.emit(
                    stream,
                    correlation,
                    HarnessEventPayloadV1::Usage(UsageEvent {
                        turn_delta,
                        session_snapshot: usage.1,
                    }),
                    UpdateSemantics::Snapshot,
                )
                .await?;
            }
            CodexNotification::TurnCompleted(params) => {
                let status = optional_string(&params, &["/turn/status", "/status"])
                    .unwrap_or_else(|| "completed".into());
                let actual_turn = optional_string(&params, &["/turnId", "/turn/id"]);
                log::info!(
                    "[Codex] turn/completed received thread_id={thread_id:?} turn_id={actual_turn:?} expected_turn={expected_provider_turn:?} status={status}"
                );
                let outcome = outcome_from_completion(&params, status, root_turn);
                if is_child {
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::TurnFinished(outcome),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                } else {
                    return Ok(Some(outcome));
                }
            }
            CodexNotification::Error(params) => {
                let message = optional_string(
                    &params,
                    &["/message", "/error/message", "/turn/error/message"],
                )
                .unwrap_or_else(|| params.to_string());
                self.emit(
                    stream,
                    correlation,
                    HarnessEventPayloadV1::Error(DiagnosticEvent {
                        message,
                        code: Some("codex_error".into()),
                    }),
                    UpdateSemantics::Snapshot,
                )
                .await?;
            }
            CodexNotification::ThreadStarted(_) | CodexNotification::ThreadStatusChanged(_) => {
                let _ = self.declare_child(&params).await?;
            }
            CodexNotification::Unknown { .. } => {
                // App Server notifications are an extensible provider
                // protocol. Routine lifecycle and capability notifications
                // are not chat content, and surfacing them as warnings makes
                // the local chat transcript provider-version dependent. Keep
                // the unknown value observable at the protocol boundary, but
                // let the provider-neutral stream ignore notifications it does
                // not project into V1 events.
            }
        }
        Ok(None)
    }

    async fn execute_turn(
        &self,
        turn_id: TurnId,
        content: String,
        output_schema: Option<Value>,
        run_id: Option<RunId>,
        provenance: TurnInputProvenance,
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<TurnOutcome, HarnessError> {
        let content_len = content.len();
        trace(
            Some(self.root_session_id.as_str()),
            "turn.requested",
            "internal",
            Some(turn_id.as_str()),
            "starting",
            Some(&format!("content_len={content_len}")),
            Some(&content),
        );
        // There is one lossless receiver for the connection. Holding the
        // receiver for the duration of a root turn also makes the single
        // root-turn gate explicit: every notification is consumed exactly
        // once, while the websocket reader applies backpressure to the
        // provider instead of dropping messages from a broadcast ring.
        let mut notifications = self.connection.notifications.lock().await;
        let mut connection_closed = self.connection.closed.subscribe();
        let mut session_closed = self.closed_rx.clone();
        let correlation = self.root_correlation(Some(turn_id.clone()), run_id.clone());
        self.emit(
            self.root_stream_id.clone(),
            correlation.clone(),
            HarnessEventPayloadV1::TurnStarted(TurnStarted {
                input_summary: summary(&content),
            }),
            UpdateSemantics::Snapshot,
        )
        .await?;
        let validation_schema = output_schema.clone();
        let result = async {
            self.emit(
                self.root_stream_id.clone(),
                correlation,
                HarnessEventPayloadV1::TurnInput(TurnInput {
                    thread_id: self.root_thread_id.clone(),
                    run_id: run_id.clone(),
                    content: content.clone(),
                    provenance,
                }),
                UpdateSemantics::Snapshot,
            )
            .await?;
            if *cancel_rx.borrow() {
                return Ok(cancelled_outcome(CompletionStatus::Cancelled, None));
            }

            let mut params = json!({"threadId": self.root_thread_id.as_str(), "input": [{"type":"text", "text": content}]});
            if let Some(schema) = output_schema {
                params["outputSchema"] = schema;
            }
            self.config.permission.apply_to_params(&mut params);
            self.connection.begin_root_turn(turn_id.clone());
            let response = match self
                .connection
                .request_with_timeout(
                    "turn/start",
                    params,
                    self.config.request_timeout,
                    turn_id.clone(),
                )
                .await
            {
                Ok(response) => response,
                Err(_error) if *session_closed.borrow() => {
                    return Ok(cancelled_outcome(
                        if run_id.is_none() {
                            CompletionStatus::Interrupted
                        } else {
                            CompletionStatus::Cancelled
                        },
                        None,
                    ));
                }
                Err(error) => return Err(error),
            };
            let provider_turn = required_string(
                response.get("turn").unwrap_or(&response),
                &["/id", "/turn/id"],
                "turn/start response turn id",
            )
            .map_err(HarnessError::Operation)?;
            log::info!(
                "[Codex] turn/start accepted requested_turn_id={} provider_turn_id={provider_turn}",
                turn_id
            );
            trace(
                Some(self.root_session_id.as_str()),
                "turn.accepted",
                "provider_to_harness",
                Some(turn_id.as_str()),
                "awaiting_provider",
                Some(&format!("provider_turn_id={provider_turn}")),
                None,
            );
            let mut accumulator = TurnAccumulator::default();
            if let Some(error) = connection_closed.borrow().clone() {
                return Err(HarnessError::Operation(error));
            }
            let outcome = loop {
                if *session_closed.borrow() {
                    break cancelled_outcome(
                        if run_id.is_none() {
                            CompletionStatus::Interrupted
                        } else {
                            CompletionStatus::Cancelled
                        },
                        accumulator.usage,
                    );
                }
                tokio::select! {
                    changed = session_closed.changed() => {
                        if changed.is_ok() && *session_closed.borrow() {
                            break cancelled_outcome(
                                if run_id.is_none() {
                                    CompletionStatus::Interrupted
                                } else {
                                    CompletionStatus::Cancelled
                                },
                                accumulator.usage,
                            );
                        }
                    }
                    changed = cancel_rx.changed() => {
                        if changed.is_ok() && *cancel_rx.borrow() {
                            let provider_terminal = tokio::time::timeout(
                                self.config.terminal_exit_timeout,
                                async {
                                    tokio::select! {
                                        outcome = self.wait_for_provider_terminal(
                                            &provider_turn,
                                            &turn_id,
                                            &mut notifications,
                                            &mut connection_closed,
                                            &mut accumulator,
                                        ) => outcome,
                                        _ = self.connection.request_no_wait(
                                            "turn/interrupt",
                                            json!({"threadId": self.root_thread_id.as_str(), "turnId": provider_turn}),
                                        ) => self.wait_for_provider_terminal(
                                            &provider_turn,
                                            &turn_id,
                                            &mut notifications,
                                            &mut connection_closed,
                                            &mut accumulator,
                                        ).await,
                                    }
                                },
                            )
                            .await;
                            break match provider_terminal {
                                Ok(result) => result?,
                                Err(_) => cancelled_outcome(
                                    if run_id.is_none() {
                                        CompletionStatus::Interrupted
                                    } else {
                                        CompletionStatus::Cancelled
                                    },
                                    accumulator.usage,
                                ),
                            };
                        }
                    }
                    outcome = self.next_provider_notification(
                        &provider_turn,
                        &turn_id,
                        &mut notifications,
                        &mut connection_closed,
                        &mut accumulator,
                    ) => {
                        if let Some(outcome) = outcome? {
                            break outcome;
                        }
                    }
                }
            };
            Ok::<_, HarnessError>(outcome)
        }
        .await;
        self.connection.finish_root_turn(&turn_id);
        let result = match result {
            Ok(outcome) => outcome,
            // Session shutdown closes the connection after publishing the
            // closed signal. Both notifications can therefore become ready
            // in the same select, and the connection error may win even
            // though shutdown is the cause of the interruption.
            Err(_error) if *self.closed_rx.borrow() => cancelled_outcome(
                if run_id.is_none() {
                    CompletionStatus::Interrupted
                } else {
                    CompletionStatus::Cancelled
                },
                None,
            ),
            Err(error) => failed_outcome(error),
        };
        let result = validate_structured_output(result, validation_schema.as_ref());
        if run_id.is_none() {
            self.emit(
                self.root_stream_id.clone(),
                self.root_correlation(Some(turn_id.clone()), None),
                HarnessEventPayloadV1::TurnFinished(result.clone()),
                UpdateSemantics::Snapshot,
            )
            .await?;
        }
        log::info!(
            "[Codex] turn finished turn_id={} status={:?} result_text_len={}",
            turn_id,
            result.status,
            result.result_text.as_deref().map_or(0, str::len)
        );
        trace(
            Some(self.root_session_id.as_str()),
            "turn.finished",
            "provider_to_harness",
            Some(turn_id.as_str()),
            "idle",
            Some(&format!(
                "status={:?}; error={:?}",
                result.status, result.error
            )),
            result.result_text.as_deref(),
        );
        Ok(result)
    }

    async fn next_provider_notification(
        &self,
        provider_turn: &str,
        normalized_turn: &TurnId,
        notifications: &mut mpsc::Receiver<NotificationMessage>,
        connection_closed: &mut watch::Receiver<Option<String>>,
        accumulator: &mut TurnAccumulator,
    ) -> Result<Option<TurnOutcome>, HarnessError> {
        tokio::select! {
            // Prefer a terminal notification already buffered ahead of a
            // connection close observed in the same poll.
            biased;
            notification = notifications.recv() => match notification {
                Some(notification) => {
                    let notification = decode_notification(notification.method, notification.params)
                        .map_err(HarnessError::Operation)?;
                    self.process_notification(
                        notification,
                        Some(provider_turn),
                        Some(normalized_turn),
                        accumulator,
                    ).await
                }
                None => Err(HarnessError::Operation(
                    "Codex notification stream closed".into(),
                )),
            },
            closed = connection_closed.changed() => {
                if closed.is_ok()
                    && let Some(error) = connection_closed.borrow().clone()
                {
                    return Err(HarnessError::Operation(error));
                }
                Err(HarnessError::Operation("Codex connection closed without a reason".into()))
            }
        }
    }

    async fn wait_for_provider_terminal(
        &self,
        provider_turn: &str,
        normalized_turn: &TurnId,
        notifications: &mut mpsc::Receiver<NotificationMessage>,
        connection_closed: &mut watch::Receiver<Option<String>>,
        accumulator: &mut TurnAccumulator,
    ) -> Result<TurnOutcome, HarnessError> {
        loop {
            if let Some(outcome) = self
                .next_provider_notification(
                    provider_turn,
                    normalized_turn,
                    notifications,
                    connection_closed,
                    accumulator,
                )
                .await?
            {
                return Ok(outcome);
            }
        }
    }

    async fn close(
        self: &Arc<Self>,
        status: SessionCloseStatus,
        error: Option<String>,
    ) -> Result<SessionCloseOutcome, HarnessError> {
        let mut slot = self.cleanup.lock().await;
        if let Some(rx) = slot.as_ref() {
            let rx = rx.clone();
            drop(slot);
            return wait_cleanup(rx).await;
        }
        let (tx, rx) = watch::channel(None);
        *slot = Some(rx.clone());
        drop(slot);
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = this.close_inner(status, error).await;
            let _ = tx.send(Some(outcome));
        });
        wait_cleanup(rx).await
    }

    async fn close_inner(
        &self,
        status: SessionCloseStatus,
        error: Option<String>,
    ) -> SessionCloseOutcome {
        let _ = self.closed.send(true);
        self.connection.close().await;
        let mut process = self.process.lock().await;
        cleanup_process(&mut process, self.config.cleanup_timeout).await;
        let outcome = SessionCloseOutcome { status, error };
        trace(
            Some(self.root_session_id.as_str()),
            "process.closed",
            "internal",
            None,
            "closed",
            Some(&format!(
                "status={:?}; error={:?}",
                outcome.status, outcome.error
            )),
            None,
        );
        let _ = self
            .emit(
                self.root_stream_id.clone(),
                self.root_correlation(None, None),
                HarnessEventPayloadV1::SessionClosed(outcome.clone()),
                UpdateSemantics::Snapshot,
            )
            .await;
        outcome
    }
}

async fn wait_cleanup(
    mut rx: watch::Receiver<Option<SessionCloseOutcome>>,
) -> Result<SessionCloseOutcome, HarnessError> {
    loop {
        if let Some(outcome) = rx.borrow().clone() {
            return Ok(outcome);
        }
        rx.changed().await.map_err(|_| {
            HarnessError::Operation("Codex App Server cleanup ended without an outcome".into())
        })?;
    }
}

#[derive(Default)]
struct TurnAccumulator {
    text: String,
    usage: Option<TurnUsage>,
    last_usage: Option<TurnUsage>,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
}

fn failed_outcome(error: HarnessError) -> TurnOutcome {
    TurnOutcome {
        status: CompletionStatus::Failed,
        result_text: None,
        structured_output: None,
        usage: None,
        metrics: OutcomeMetrics::default(),
        error: Some(error.to_string()),
    }
}

fn validate_structured_output(mut outcome: TurnOutcome, schema: Option<&Value>) -> TurnOutcome {
    let Some(schema) = schema else {
        return outcome;
    };
    if outcome.status != CompletionStatus::Completed {
        return outcome;
    }

    if outcome.structured_output.is_none() {
        let Some(text) = outcome.result_text.as_deref() else {
            outcome.status = CompletionStatus::Failed;
            outcome.error = Some("Codex structured output was empty".into());
            return outcome;
        };
        match serde_json::from_str(text) {
            Ok(value) => outcome.structured_output = Some(value),
            Err(error) => {
                outcome.status = CompletionStatus::Failed;
                outcome.error = Some(format!(
                    "Codex structured output was not valid JSON: {error}"
                ));
                return outcome;
            }
        }
    }

    let validator = match jsonschema::validator_for(schema) {
        Ok(validator) => validator,
        Err(error) => {
            outcome.status = CompletionStatus::Failed;
            outcome.error = Some(format!(
                "Codex output schema could not be compiled: {error}"
            ));
            return outcome;
        }
    };
    let output = outcome
        .structured_output
        .as_ref()
        .expect("structured output is populated above");
    if let Err(error) = validator.validate(output) {
        outcome.status = CompletionStatus::Failed;
        outcome.error = Some(format!(
            "Codex structured output did not match the requested schema: {error}"
        ));
    }
    outcome
}

fn cancelled_outcome(status: CompletionStatus, usage: Option<TurnUsage>) -> TurnOutcome {
    let message = if status == CompletionStatus::Interrupted {
        "Codex turn interrupted"
    } else {
        "Codex turn cancelled"
    };
    TurnOutcome {
        status,
        result_text: None,
        structured_output: None,
        usage,
        metrics: OutcomeMetrics::default(),
        error: Some(message.into()),
    }
}

struct CodexSessionHandle {
    state: Arc<SessionState>,
    session_id: SessionId,
    provider_resume_id: ProviderResumeId,
}
struct CodexTurnHandle {
    turn_id: TurnId,
    cancel: watch::Sender<bool>,
    outcome: watch::Receiver<OutcomeState<TurnOutcome>>,
}
struct CodexRunHandle {
    run_id: RunId,
    cancel: watch::Sender<bool>,
    outcome: watch::Receiver<OutcomeState<RunOutcome>>,
}

#[derive(Clone, Default)]
enum OutcomeState<T> {
    #[default]
    Pending,
    Ready(T),
    Failed(OutcomeFailure),
}

#[derive(Clone)]
enum OutcomeFailure {
    EventSink(String),
    Other(String),
}

impl From<HarnessError> for OutcomeFailure {
    fn from(error: HarnessError) -> Self {
        match error {
            HarnessError::EventSink(message) => Self::EventSink(message),
            error => Self::Other(error.to_string()),
        }
    }
}

impl OutcomeFailure {
    fn into_harness_error(self) -> HarnessError {
        match self {
            Self::EventSink(message) => HarnessError::EventSink(message),
            Self::Other(message) => HarnessError::Operation(message),
        }
    }
}

#[async_trait]
impl SessionHandle for CodexSessionHandle {
    fn session_id(&self) -> &SessionId {
        &self.session_id
    }
    fn provider_resume_id(&self) -> Option<&ProviderResumeId> {
        Some(&self.provider_resume_id)
    }
    async fn send(&self, request: SendTurnRequest) -> Result<Arc<dyn TurnHandle>, HarnessError> {
        if *self.state.closed_rx.borrow() {
            return Err(HarnessError::Operation(
                "cannot send a turn on a closed Codex session".into(),
            ));
        }
        let (tx, rx) = watch::channel(OutcomeState::Pending);
        let (cancel, cancel_rx) = watch::channel(false);
        let state = Arc::clone(&self.state);
        let turn_id = request.turn_id.clone();
        let turn_id_for_task = turn_id.clone();
        let task_state = Arc::clone(&state);
        tokio::spawn(async move {
            let _gate = task_state.root_turn_gate.lock().await;
            let result = if *task_state.closed_rx.borrow() {
                Ok(cancelled_outcome(CompletionStatus::Interrupted, None))
            } else {
                task_state
                    .execute_turn(
                        turn_id_for_task,
                        request.content,
                        request.output_schema,
                        None,
                        TurnInputProvenance::Human,
                        cancel_rx,
                    )
                    .await
            };
            let _ = tx.send(match result {
                Ok(value) => OutcomeState::Ready(value),
                Err(error) => OutcomeState::Failed(error.into()),
            });
        });
        Ok(Arc::new(CodexTurnHandle {
            turn_id,
            cancel,
            outcome: rx,
        }))
    }
    async fn close(&self) -> Result<SessionCloseOutcome, HarnessError> {
        self.state.close(SessionCloseStatus::Closed, None).await
    }
}

#[async_trait]
impl TurnHandle for CodexTurnHandle {
    fn turn_id(&self) -> &TurnId {
        &self.turn_id
    }
    async fn interrupt(&self) -> Result<(), HarnessError> {
        let _ = self.cancel.send(true);
        Ok(())
    }
    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError> {
        await_state(self.outcome.clone(), "Codex turn ended without an outcome").await
    }
}

#[async_trait]
impl RunHandle for CodexRunHandle {
    fn run_id(&self) -> &RunId {
        &self.run_id
    }
    async fn cancel(&self) -> Result<(), HarnessError> {
        let _ = self.cancel.send(true);
        Ok(())
    }
    async fn await_outcome(&self) -> Result<RunOutcome, HarnessError> {
        await_state(self.outcome.clone(), "Codex run ended without an outcome").await
    }
}

async fn await_state<T: Clone>(
    mut receiver: watch::Receiver<OutcomeState<T>>,
    message: &str,
) -> Result<T, HarnessError> {
    loop {
        let state = receiver.borrow().clone();
        match state {
            OutcomeState::Pending => receiver
                .changed()
                .await
                .map_err(|_| HarnessError::Operation(message.into()))?,
            OutcomeState::Ready(value) => return Ok(value),
            OutcomeState::Failed(error) => return Err(error.into_harness_error()),
        }
    }
}

#[derive(Clone)]
pub struct CodexRuntime {
    config: Arc<CodexProviderConfig>,
}

impl CodexRuntime {
    pub fn new(config: CodexProviderConfig) -> Self {
        Self {
            config: Arc::new(config),
        }
    }
    pub fn config(&self) -> &CodexProviderConfig {
        &self.config
    }
}

#[async_trait]
impl HarnessRuntime for CodexRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        match self.config.discover_capabilities().await {
            Ok(capabilities) => Ok(capabilities),
            Err(error) => Ok(HarnessCapabilities {
                provider: "openai".into(),
                available: false,
                unavailable_reason: Some(error.to_string()),
                persistent_sessions: true,
                one_shot_runs: true,
                session_resumption: true,
                default_model: None,
                models: Vec::new(),
                default_permission_mode: None,
                permission_modes: Vec::new(),
                approval_categories: [
                    ApprovalCategory::CommandExecution,
                    ApprovalCategory::FileChange,
                    ApprovalCategory::AdditionalPermission,
                ]
                .into_iter()
                .collect(),
                questions: QuestionCapabilities {
                    multiple_selection: true,
                    free_form_answers: true,
                    automatic_resolution: true,
                },
            }),
        }
    }

    async fn start_session(
        &self,
        request: StartSessionRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        let state = setup_session(
            Arc::clone(&self.config),
            request.stream_id,
            request.config,
            request.resume_id,
            event_sink,
            control_sink,
        )
        .await?;
        let handle = CodexSessionHandle {
            session_id: state.root_session_id.clone(),
            provider_resume_id: ProviderResumeId::new(state.root_thread_id.as_str()),
            state,
        };
        Ok(Arc::new(handle))
    }

    async fn run_once(
        &self,
        request: RunRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        let state = setup_session(
            Arc::clone(&self.config),
            request.stream_id,
            request.config,
            None,
            event_sink,
            control_sink,
        )
        .await?;
        let (tx, rx) = watch::channel(OutcomeState::Pending);
        let (cancel, cancel_rx) = watch::channel(false);
        let run_id = request.run_id.clone();
        let task_run_id = run_id.clone();
        let task_state = Arc::clone(&state);
        let turn_key = format!("{}:turn", task_run_id);
        tokio::spawn(async move {
            let _gate = task_state.root_turn_gate.lock().await;
            let outcome = if *task_state.closed_rx.borrow() {
                Ok(cancelled_outcome(CompletionStatus::Cancelled, None))
            } else {
                task_state
                    .execute_turn(
                        TurnId::new(turn_key.clone()),
                        request.prompt,
                        task_state.default_output_schema.clone(),
                        Some(task_run_id.clone()),
                        TurnInputProvenance::Human,
                        cancel_rx,
                    )
                    .await
            };
            let run = match outcome {
                Ok(outcome) => RunOutcome {
                    status: outcome.status,
                    result_text: outcome.result_text,
                    structured_output: outcome.structured_output,
                    usage: outcome.usage,
                    metrics: outcome.metrics,
                    error: outcome.error,
                },
                Err(error) => RunOutcome {
                    status: CompletionStatus::Failed,
                    result_text: None,
                    structured_output: None,
                    usage: None,
                    metrics: OutcomeMetrics::default(),
                    error: Some(error.to_string()),
                },
            };
            let _ = task_state
                .emit(
                    task_state.root_stream_id.clone(),
                    task_state.root_correlation(None, Some(task_run_id.clone())),
                    HarnessEventPayloadV1::RunFinished(run.clone()),
                    UpdateSemantics::Snapshot,
                )
                .await;
            let _ = task_state.close(SessionCloseStatus::Closed, None).await;
            let _ = tx.send(OutcomeState::Ready(run));
        });
        Ok(Arc::new(CodexRunHandle {
            run_id,
            cancel,
            outcome: rx,
        }))
    }
}

async fn setup_session(
    config: Arc<CodexProviderConfig>,
    stream_id: StreamId,
    request_config: vertebrae_harness_core::RequestConfig,
    resume_id: Option<ProviderResumeId>,
    event_sink: Arc<dyn EventSink>,
    control_sink: Arc<dyn ControlSink>,
) -> Result<Arc<SessionState>, HarnessError> {
    config.validate_request(&request_config)?;
    let default_output_schema = request_config.output_schema.clone();
    let mut launch_config = (*config).clone();
    launch_config
        .environment
        .extend(request_config.environment.clone());
    if let Some(path) = request_config.environment.get("PATH") {
        launch_config.search_path = Some(path.clone().into());
    }
    add_model_verbosity_override(&mut launch_config.extra_args, request_config.verbosity);
    let launcher: Arc<dyn CodexAppServerLauncher> = config
        .launcher
        .clone()
        .unwrap_or_else(|| Arc::new(ProcessCodexAppServerLauncher::new(Arc::new(launch_config))));
    let mut launched = launcher.launch().await?;
    trace(
        None,
        "process.started",
        "internal",
        None,
        "running",
        Some(&format!(
            "pid={:?}; stream_id={}",
            launched.process.as_ref().and_then(|process| process.id()),
            stream_id
        )),
        None,
    );
    let connection =
        match CodexConnection::connect(&launched.ws_url, Arc::clone(&control_sink)).await {
            Ok(connection) => connection,
            Err(error) => {
                cleanup_process(&mut launched.process, config.cleanup_timeout).await;
                return Err(error);
            }
        };
    let initialize = connection.request("initialize", json!({"clientInfo":{"name":config.client_name,"title":config.client_title,"version":config.client_version},"capabilities":{"experimentalApi":true}})).await;
    if let Err(error) = initialize {
        connection.close().await;
        cleanup_process(&mut launched.process, config.cleanup_timeout).await;
        return Err(error);
    }
    if let Err(error) = connection.notify("initialized", json!({})).await {
        connection.close().await;
        cleanup_process(&mut launched.process, config.cleanup_timeout).await;
        return Err(error);
    }
    let sink = Arc::new(SequencedEventSink::new(
        Arc::new(EventSequencer::default()),
        event_sink,
    ));
    for root in &config.installed_skills_roots {
        if root.is_absolute() && root.is_dir() {
            if let Err(error) = connection
                .request("skills/extraRoots/set", json!({"extraRoots":[root]}))
                .await
            {
                emit_direct(
                    &sink,
                    stream_id.clone(),
                    EventCorrelation::default(),
                    HarnessEventPayloadV1::Warning(DiagnosticEvent {
                        message: format!(
                            "Codex installed skill root registration failed for {}: {error}",
                            root.display()
                        ),
                        code: Some("codex_skill_root_registration".into()),
                    }),
                )
                .await?;
            }
        } else {
            if let Err(error) = emit_direct(
                &sink,
                stream_id.clone(),
                EventCorrelation::default(),
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!(
                        "Codex installed skill root was not registered: {}",
                        root.display()
                    ),
                    code: Some("codex_invalid_skill_root".into()),
                }),
            )
            .await
            {
                connection.close().await;
                cleanup_process(&mut launched.process, config.cleanup_timeout).await;
                return Err(error);
            }
        }
    }
    let mut params = if let Some(resume) = &resume_id {
        json!({"threadId":resume.as_str(),"excludeTurns":true})
    } else {
        json!({"serviceName":"vertebrae"})
    };
    if let Some(cwd) = &request_config.working_directory {
        params["cwd"] = json!(cwd);
    }
    if let Some(model) = &request_config.model {
        params["model"] = json!(model);
    }
    if let Some(effort) = &request_config.reasoning_effort {
        params["effort"] = json!(effort);
    }
    add_service_tier(&mut params, &request_config);
    if let Some(personality) = &request_config.personality {
        params["personality"] = json!(personality);
    }
    if let Some(provider) = &config.model_provider {
        params["modelProvider"] = json!(provider);
    }
    add_developer_instructions(&mut params, &request_config);
    config.permission.apply_to_params(&mut params);
    let method = if resume_id.is_some() {
        "thread/resume"
    } else {
        "thread/start"
    };
    let response = match connection.request(method, params).await {
        Ok(response) => response,
        Err(error) => {
            connection.close().await;
            cleanup_process(&mut launched.process, config.cleanup_timeout).await;
            return Err(error);
        }
    };
    let thread = match required_string(
        response.get("thread").unwrap_or(&response),
        &["/id", "/thread/id"],
        "thread id",
    ) {
        Ok(thread) => thread,
        Err(error) => {
            connection.close().await;
            cleanup_process(&mut launched.process, config.cleanup_timeout).await;
            return Err(HarnessError::Operation(error));
        }
    };
    let model = optional_string(&response, &["/model"])
        .or(request_config.model)
        .unwrap_or_else(|| "Codex default".into());
    let root_session_id = SessionId::new(thread.clone());
    let root_thread_id = ThreadId::new(thread.clone());
    connection.set_root_thread(root_thread_id.clone());
    let provider_ref = ProviderThreadRef::new(thread.clone());
    let (closed, closed_rx) = watch::channel(false);
    let state = Arc::new(SessionState {
        connection,
        process: AsyncMutex::new(launched.process),
        config,
        sink,
        root_stream_id: stream_id.clone(),
        root_session_id: root_session_id.clone(),
        root_thread_id: root_thread_id.clone(),
        default_output_schema,
        root_turn_gate: AsyncMutex::new(()),
        cleanup: AsyncMutex::new(None),
        children: Mutex::new(HashMap::new()),
        declared_threads: Mutex::new([thread.clone()].into_iter().collect()),
        closed,
        closed_rx,
    });
    if let Err(error) = emit_direct(
        &state.sink,
        stream_id.clone(),
        state.root_correlation(None, None),
        HarnessEventPayloadV1::SessionStarted(SessionStarted {
            provider: "openai".into(),
            model: Some(model),
            provider_resume_id: Some(ProviderResumeId::new(thread.clone())),
            speed_tier_status: None,
            tools: Vec::new(),
        }),
    )
    .await
    {
        let _ = state
            .close(SessionCloseStatus::Failed, Some(error.to_string()))
            .await;
        return Err(error);
    }
    if let Err(error) = emit_direct(
        &state.sink,
        stream_id.clone(),
        state.root_correlation(None, None),
        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
            thread_id: root_thread_id,
            parent_thread_id: None,
            kind: ThreadKind::Root,
            caused_by_tool_call_id: None,
            provider_thread_ref: Some(provider_ref),
            agent_metadata: None,
        }),
    )
    .await
    {
        let _ = state
            .close(SessionCloseStatus::Failed, Some(error.to_string()))
            .await;
        return Err(error);
    }
    Ok(state)
}

fn add_developer_instructions(
    params: &mut Value,
    request_config: &vertebrae_harness_core::RequestConfig,
) {
    if let Some(instructions) = request_config
        .developer_instructions
        .as_deref()
        .map(str::trim)
        .filter(|instructions| !instructions.is_empty())
    {
        params["developerInstructions"] = json!(instructions);
    }
}

fn add_service_tier(params: &mut Value, request_config: &vertebrae_harness_core::RequestConfig) {
    let Some(speed_tier) = request_config.speed_tier else {
        return;
    };
    params["serviceTier"] = json!(match speed_tier {
        SpeedTier::Default => "default",
        SpeedTier::Fast => "priority",
    });
}

fn add_model_verbosity_override(extra_args: &mut Vec<String>, verbosity: Option<OutputVerbosity>) {
    let Some(verbosity) = verbosity else {
        return;
    };
    extra_args.extend([
        "-c".into(),
        format!("model_verbosity={}", verbosity.as_str()),
    ]);
}

async fn emit_direct(
    sink: &Arc<SequencedEventSink>,
    stream: StreamId,
    correlation: EventCorrelation,
    payload: HarnessEventPayloadV1,
) -> Result<(), HarnessError> {
    sink.emit(HarnessEventDraftV1 {
        stream_id: stream,
        correlation,
        timestamp: Utc::now(),
        semantics: UpdateSemantics::Snapshot,
        provider_sequence: None,
        payload,
    })
    .await
    .map(|_| ())
}

fn tool_call(item: &Value) -> Option<(String, String, Value, bool)> {
    let kind = item.get("type").and_then(Value::as_str)?;
    if kind == "fileChange" {
        return None;
    }
    let is_tool = kind.contains("tool") || kind == "commandExecution";
    if !is_tool {
        return None;
    }
    let id = optional_string(item, &["/id", "/toolCallId", "/tool_call_id"])?;
    if kind == "commandExecution" {
        let command = optional_string(item, &["/command"])?;
        let mut input = json!({"command": command});
        if let Some(cwd) = optional_string(item, &["/cwd"]) {
            input["cwd"] = json!(cwd);
        }
        return Some((id, "Bash".into(), input, false));
    }
    let name = optional_string(item, &["/tool", "/name", "/type"]).unwrap_or_else(|| kind.into());
    let input = item
        .get("input")
        .cloned()
        .or_else(|| item.get("arguments").cloned())
        .unwrap_or_else(|| json!({"item":item}));
    Some((id, name, input, kind == "collabAgentToolCall"))
}

fn file_change_event(item: &Value) -> Option<FileChangeEvent> {
    if item.get("type").and_then(Value::as_str) != Some("fileChange") {
        return None;
    }
    let tool_call_id = optional_string(item, &["/id", "/itemId", "/toolCallId"])?;
    let changes = item
        .get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|change| {
            let path = optional_string(change, &["/path"])?;
            let kind = match optional_string(change, &["/kind", "/type"])?.as_str() {
                "add" | "added" => FileChangeKind::Added,
                "delete" | "deleted" => FileChangeKind::Deleted,
                "rename" | "renamed" => FileChangeKind::Renamed,
                "update" | "updated" | "modify" | "modified" => FileChangeKind::Modified,
                _ => return None,
            };
            Some(FileChange {
                path,
                kind,
                previous_path: optional_string(change, &["/previousPath", "/previous_path"]),
                patch: optional_string(change, &["/diff", "/patch", "/unifiedDiff"]),
            })
        })
        .collect::<Vec<_>>();
    if changes.is_empty() {
        return None;
    }
    let status = match optional_string(item, &["/status"]).as_deref() {
        Some("inProgress") | Some("started") | Some("running") => ToolStatus::Started,
        Some("failed") | Some("error") => ToolStatus::Failed,
        Some("declined") => ToolStatus::Declined,
        Some("cancelled") | Some("canceled") => ToolStatus::Cancelled,
        _ => ToolStatus::Completed,
    };
    Some(FileChangeEvent {
        tool_call_id: Some(ToolCallId::new(tool_call_id)),
        changes,
        status,
    })
}

fn tool_output(item: &Value) -> Option<(String, Value, bool)> {
    let id = optional_string(item, &["/id", "/toolCallId", "/tool_call_id"])?;
    let output = item
        .get("output")
        .cloned()
        .or_else(|| item.get("result").cloned())
        .or_else(|| item.get("aggregatedOutput").cloned())
        .or_else(|| item.get("aggregated_output").cloned())
        .or_else(|| item.get("text").cloned())?;
    let failed = item
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "failed" | "error"))
        || item
            .get("exitCode")
            .or_else(|| item.get("exit_code"))
            .and_then(Value::as_i64)
            .is_some_and(|exit_code| exit_code != 0);
    Some((id, output, failed))
}

fn parse_usage(params: &Value) -> (Option<TurnUsage>, Option<SessionUsage>) {
    let total = |field: &str| number(params, &[&format!("/tokenUsage/total/{field}")]);
    let last = |field: &str| number(params, &[&format!("/tokenUsage/last/{field}")]);
    let fallback =
        |field: &str| total(field).or_else(|| number(params, &[&format!("/tokenUsage/{field}")]));
    let turn_tokens = TokenUsage {
        input_tokens: last("inputTokens")
            .or_else(|| fallback("inputTokens"))
            .unwrap_or(0),
        cached_input_tokens: last("cachedInputTokens")
            .or_else(|| fallback("cachedInputTokens"))
            .unwrap_or(0),
        output_tokens: last("outputTokens")
            .or_else(|| fallback("outputTokens"))
            .unwrap_or(0),
        reasoning_tokens: last("reasoningOutputTokens")
            .or_else(|| last("reasoningTokens"))
            .or_else(|| fallback("reasoningOutputTokens"))
            .or_else(|| fallback("reasoningTokens"))
            .unwrap_or(0),
    };
    let thread_tokens = TokenUsage {
        input_tokens: fallback("inputTokens").unwrap_or(0),
        cached_input_tokens: fallback("cachedInputTokens").unwrap_or(0),
        output_tokens: fallback("outputTokens").unwrap_or(0),
        reasoning_tokens: fallback("reasoningOutputTokens")
            .or_else(|| fallback("reasoningTokens"))
            .unwrap_or(0),
    };
    let turn =
        (turn_tokens.input_tokens > 0 || turn_tokens.output_tokens > 0).then_some(TurnUsage {
            tokens: turn_tokens,
            cost_microusd: 0,
        });
    let snapshot =
        (thread_tokens.input_tokens > 0 || thread_tokens.output_tokens > 0).then(|| SessionUsage {
            tokens: thread_tokens,
            cost_microusd: 0,
            context_tokens: last("totalTokens").or_else(|| fallback("totalTokens")),
            context_window: number(params, &["/tokenUsage/modelContextWindow"]),
        });
    (turn, snapshot)
}

fn usage_delta(previous: Option<&TurnUsage>, current: &TurnUsage) -> TurnUsage {
    let previous = previous.cloned().unwrap_or_default();
    TurnUsage {
        tokens: TokenUsage {
            input_tokens: current
                .tokens
                .input_tokens
                .saturating_sub(previous.tokens.input_tokens),
            cached_input_tokens: current
                .tokens
                .cached_input_tokens
                .saturating_sub(previous.tokens.cached_input_tokens),
            output_tokens: current
                .tokens
                .output_tokens
                .saturating_sub(previous.tokens.output_tokens),
            reasoning_tokens: current
                .tokens
                .reasoning_tokens
                .saturating_sub(previous.tokens.reasoning_tokens),
        },
        cost_microusd: current.cost_microusd.saturating_sub(previous.cost_microusd),
    }
}

fn outcome_from_completion(
    params: &Value,
    status: String,
    accumulator: &TurnAccumulator,
) -> TurnOutcome {
    let status = match status.as_str() {
        "completed" => CompletionStatus::Completed,
        "cancelled" | "canceled" => CompletionStatus::Cancelled,
        "interrupted" => CompletionStatus::Interrupted,
        _ => CompletionStatus::Failed,
    };
    let error = (status != CompletionStatus::Completed).then(|| {
        optional_string(
            params,
            &["/error/message", "/turn/error/message", "/message"],
        )
        .unwrap_or_else(|| "Codex turn failed".into())
    });
    let structured_output = ["/turn/structuredOutput", "/structuredOutput"]
        .iter()
        .find_map(|pointer| params.pointer(pointer))
        .cloned()
        .or_else(|| {
            ["/turn/result", "/result"]
                .iter()
                .find_map(|pointer| params.pointer(pointer))
                .and_then(|value| match value {
                    Value::String(value) => serde_json::from_str(value).ok(),
                    value => Some(value.clone()),
                })
        });
    TurnOutcome {
        status,
        result_text: (!accumulator.text.is_empty())
            .then(|| accumulator.text.clone())
            .or_else(|| optional_string(params, &["/turn/result", "/result"])),
        structured_output,
        usage: accumulator.usage.clone(),
        metrics: OutcomeMetrics {
            duration_ms: number(params, &["/turn/durationMs"]),
            turn_count: None,
            context_tokens: accumulator.context_tokens,
            context_window: accumulator.context_window,
            total_cost_usd: None,
        },
        error,
    }
}

fn summary(content: &str) -> Option<String> {
    let mut chars = content.chars();
    let value: String = chars.by_ref().take(160).collect();
    if value.is_empty() {
        None
    } else if chars.next().is_some() {
        Some(format!("{value}…"))
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ControlDisposition, FileChangeKind, RootTurnIdentity, SessionState, ToolStatus,
        add_developer_instructions, add_model_verbosity_override, add_service_tier,
        control_request, file_change_event, parse_usage, tool_call, tool_output,
    };
    use vertebrae_harness_core::{
        OutputVerbosity, SessionId, SpeedTier, ThreadId, ToolCallId, TurnId,
    };

    #[test]
    fn maps_additive_instructions_to_codex_developer_layer() {
        let mut params = json!({"serviceName": "vertebrae"});
        add_developer_instructions(
            &mut params,
            &vertebrae_harness_core::RequestConfig {
                verbosity: None,
                developer_instructions: Some("reference contract".into()),
                ..Default::default()
            },
        );
        assert_eq!(params["developerInstructions"], "reference contract");
    }

    #[test]
    fn maps_speed_tiers_to_codex_service_tiers() {
        for (speed_tier, service_tier) in [
            (SpeedTier::Default, "default"),
            (SpeedTier::Fast, "priority"),
        ] {
            let mut params = json!({});
            add_service_tier(
                &mut params,
                &vertebrae_harness_core::RequestConfig {
                    verbosity: None,
                    speed_tier: Some(speed_tier),
                    ..Default::default()
                },
            );
            assert_eq!(params["serviceTier"], service_tier);
        }
    }

    #[test]
    fn omits_codex_service_tier_when_unset() {
        let mut params = json!({"serviceName": "vertebrae"});
        add_service_tier(
            &mut params,
            &vertebrae_harness_core::RequestConfig::default(),
        );
        assert_eq!(params, json!({"serviceName": "vertebrae"}));
    }

    #[test]
    fn maps_verbosity_to_a_process_local_codex_config_override() {
        let mut args = vec!["--experimental-api".into()];
        add_model_verbosity_override(&mut args, Some(OutputVerbosity::Medium));
        assert_eq!(
            args,
            vec!["--experimental-api", "-c", "model_verbosity=medium"]
        );
    }

    #[test]
    fn omits_process_local_verbosity_override_when_unset() {
        let mut args = Vec::new();
        add_model_verbosity_override(&mut args, None);
        assert!(args.is_empty());
    }

    #[test]
    fn child_correlation_preserves_parent_tool_call() {
        let correlation = SessionState::child_correlation(
            &SessionId::new("root-session"),
            ThreadId::new("child-thread"),
            Some(TurnId::new("child-turn")),
            Some(ToolCallId::new("spawn-tool")),
        );

        assert_eq!(
            correlation.parent_tool_call_id,
            Some(ToolCallId::new("spawn-tool"))
        );
    }

    fn approval(thread_id: &str, turn_id: &str) -> vertebrae_harness_core::ControlRequestEnvelope {
        control_request(
            "item/commandExecution/requestApproval",
            &json!({
                "requestId": format!("approval-{thread_id}-{turn_id}"),
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )
        .expect("supported control request")
    }

    #[test]
    fn classifies_and_normalizes_early_root_controls_without_touching_children() {
        let identity = RootTurnIdentity::default();
        identity.set_root_thread(ThreadId::new("root-thread"));
        identity.begin_turn(TurnId::new("requested-root"));

        let mut early_root = approval("root-thread", "provider-root");
        assert_eq!(
            identity.prepare_control_request(&mut early_root),
            ControlDisposition::Forward
        );
        assert_eq!(early_root.turn_id, Some(TurnId::new("requested-root")));
        assert_eq!(early_root.thread_id, Some(ThreadId::new("root-thread")));
        assert_eq!(early_root.is_root, Some(true));

        let mut child = approval("child-thread", "child-turn");
        assert_eq!(
            identity.prepare_control_request(&mut child),
            ControlDisposition::Forward
        );
        assert_eq!(child.turn_id, Some(TurnId::new("child-turn")));
        assert_eq!(child.thread_id, Some(ThreadId::new("child-thread")));
        assert_eq!(child.is_root, Some(false));
    }

    #[test]
    fn root_turn_identity_is_bounded_and_rejects_the_replaced_provider_turn() {
        let identity = RootTurnIdentity::default();
        identity.set_root_thread(ThreadId::new("root-thread"));

        for index in 0..100 {
            let normalized = TurnId::new(format!("requested-{index}"));
            identity.begin_turn(normalized.clone());
            identity.bind_provider_turn(&format!("provider-{index}"), normalized.clone());
            identity.finish_turn(&normalized);
        }
        {
            let state = identity.state.lock().unwrap();
            assert!(state.active.is_none());
            assert_eq!(
                state.recent_provider_turn_id.as_deref(),
                Some("provider-99")
            );
        }

        identity.begin_turn(TurnId::new("requested-next"));
        let mut old = approval("root-thread", "provider-99");
        assert_eq!(
            identity.prepare_control_request(&mut old),
            ControlDisposition::RejectStale
        );
        assert_eq!(old.turn_id, Some(TurnId::new("provider-99")));

        identity.bind_provider_turn("provider-next", TurnId::new("requested-next"));
        let mut current = approval("root-thread", "provider-next");
        assert_eq!(
            identity.prepare_control_request(&mut current),
            ControlDisposition::Forward
        );
        assert_eq!(current.turn_id, Some(TurnId::new("requested-next")));

        identity.clear();
        let state = identity.state.lock().unwrap();
        assert!(state.active.is_none());
        assert!(state.recent_provider_turn_id.is_none());
    }

    #[test]
    fn maps_command_execution_start_and_completion_to_one_tool_lifecycle() {
        let started = json!({
            "type": "commandExecution",
            "id": "exec-1",
            "command": "/bin/zsh -lc \"pwd\"",
            "cwd": "/repo",
            "status": "inProgress",
        });
        let completed = json!({
            "type": "commandExecution",
            "id": "exec-1",
            "command": "/bin/zsh -lc \"pwd\"",
            "status": "completed",
            "exitCode": 0,
            "aggregatedOutput": "/repo",
        });

        assert_eq!(
            tool_call(&started),
            Some((
                "exec-1".into(),
                "Bash".into(),
                json!({"command":"/bin/zsh -lc \"pwd\"", "cwd":"/repo"}),
                false,
            ))
        );
        assert_eq!(
            tool_output(&completed),
            Some(("exec-1".into(), "/repo".into(), false))
        );
    }

    #[test]
    fn maps_nonzero_command_exit_code_to_failed_tool_output() {
        let completed = json!({
            "type": "commandExecution",
            "id": "exec-2",
            "status": "completed",
            "exitCode": 1,
            "aggregatedOutput": "boom",
        });

        assert_eq!(
            tool_output(&completed),
            Some(("exec-2".into(), "boom".into(), true))
        );
    }

    #[test]
    fn maps_file_change_items_to_structured_lifecycle_events() {
        let started = json!({
            "type": "fileChange",
            "id": "file-1",
            "status": "inProgress",
            "changes": [{"path": "src/new.rs", "kind": "add", "diff": "+fn main() {}"}]
        });
        let completed = json!({
            "type": "fileChange",
            "id": "file-1",
            "status": "completed",
            "changes": [{"path": "src/new.rs", "kind": "add", "diff": "+fn main() {}"}]
        });

        let started = file_change_event(&started).expect("started file change");
        assert_eq!(started.tool_call_id.as_ref().unwrap().as_str(), "file-1");
        assert_eq!(started.status, ToolStatus::Started);
        assert_eq!(started.changes[0].kind, FileChangeKind::Added);

        let completed = file_change_event(&completed).expect("completed file change");
        assert_eq!(completed.status, ToolStatus::Completed);
        assert_eq!(completed.changes[0].path, "src/new.rs");
    }

    #[test]
    fn keeps_thread_totals_separate_from_last_turn_context_usage() {
        let params = json!({
            "tokenUsage": {
                "total": {
                    "totalTokens": 979558,
                    "inputTokens": 969766,
                    "cachedInputTokens": 841984,
                    "outputTokens": 9792,
                    "reasoningOutputTokens": 3276,
                },
                "last": {
                    "totalTokens": 98480,
                    "inputTokens": 96621,
                    "cachedInputTokens": 94976,
                    "outputTokens": 1859,
                    "reasoningOutputTokens": 516,
                },
                "modelContextWindow": 258400,
            }
        });

        let (turn, snapshot) = parse_usage(&params);
        let turn = turn.expect("last usage should populate the turn delta");
        let snapshot = snapshot.expect("total usage should populate the thread snapshot");
        assert_eq!(turn.tokens.input_tokens, 96621);
        assert_eq!(turn.tokens.output_tokens, 1859);
        assert_eq!(snapshot.tokens.input_tokens, 969766);
        assert_eq!(snapshot.tokens.output_tokens, 9792);
        assert_eq!(snapshot.context_tokens, Some(98480));
        assert_eq!(snapshot.context_window, Some(258400));
    }
}
