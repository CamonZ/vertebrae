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
    sync::{Mutex as AsyncMutex, broadcast, oneshot, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use vertebrae_harness_core::{
    AgentMetadata, ApprovalCategory, ApprovalRequest, CompletionStatus, ControlRequest,
    ControlRequestEnvelope, ControlResolution, ControlSink, DiagnosticEvent, EventCorrelation,
    EventSequencer, EventSink, FileChange, FileChangeEvent, FileChangeKind, GrantScope,
    HarnessCapabilities, HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1, HarnessRuntime,
    OutcomeMetrics, ProviderResumeId, ProviderThreadRef, QuestionCapabilities, RunHandle, RunId,
    RunOutcome, RunRequest, SendTurnRequest, SequencedEventSink, SessionCloseOutcome,
    SessionCloseStatus, SessionHandle, SessionId, SessionStarted, SessionUsage,
    StartSessionRequest, StreamId, TextEvent, ThreadDeclared, ThreadId, ThreadKind, TokenUsage,
    ToolCallEvent, ToolCallId, ToolOutputEvent, ToolStatus, TurnHandle, TurnId, TurnInput,
    TurnInputProvenance, TurnOutcome, TurnStarted, TurnUsage, UpdateSemantics, UsageEvent,
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

fn log_raw_traffic(direction: &str, payload: &str) {
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
}

struct CodexConnection {
    writer: Arc<AsyncMutex<futures::stream::SplitSink<WsStream, Message>>>,
    pending: Arc<AsyncMutex<HashMap<String, PendingResponse>>>,
    next_id: AsyncMutex<u64>,
    notifications: broadcast::Sender<NotificationMessage>,
    closed: watch::Sender<Option<String>>,
    reader: AsyncMutex<Option<JoinHandle<()>>>,
}

impl CodexConnection {
    async fn connect(
        url: &str,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<Self>, HarnessError> {
        let (stream, _) = connect_async(url).await.map_err(|error| {
            HarnessError::Unavailable(format!("failed to connect to Codex App Server: {error}"))
        })?;
        let (writer, mut reader) = stream.split();
        let (notifications, _) = broadcast::channel(512);
        let (closed, _) = watch::channel(None);
        let connection = Arc::new(Self {
            writer: Arc::new(AsyncMutex::new(writer)),
            pending: Arc::new(AsyncMutex::new(HashMap::new())),
            next_id: AsyncMutex::new(1),
            notifications,
            closed,
            reader: AsyncMutex::new(None),
        });
        let pending = Arc::clone(&connection.pending);
        let writer = Arc::clone(&connection.writer);
        let notification_tx = connection.notifications.clone();
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
                            let _ = pending.tx.send(result);
                        }
                        continue;
                    }
                    if let Some(method) = message.method {
                        let writer = Arc::clone(&writer);
                        let control_sink = Arc::clone(&control_sink);
                        tokio::spawn(async move {
                            respond_to_control_request(
                                &writer,
                                &control_sink,
                                id,
                                &method,
                                message.params.unwrap_or(Value::Null),
                            )
                            .await;
                        });
                        continue;
                    }
                }
                if let Some(method) = message.method {
                    let _ = notification_tx.send(NotificationMessage {
                        method,
                        params: message.params.unwrap_or(Value::Null),
                    });
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

    async fn request(&self, method: &str, params: Value) -> Result<Value, HarnessError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        let key = id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(key.clone(), PendingResponse { tx });
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

    async fn notify(&self, method: &str, params: Value) -> Result<(), HarnessError> {
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

    async fn close(&self) {
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
}

async fn respond_to_control_request(
    writer: &Arc<AsyncMutex<futures::stream::SplitSink<WsStream, Message>>>,
    control_sink: &Arc<dyn ControlSink>,
    id: Value,
    method: &str,
    params: Value,
) {
    let response = match control_request(method, &params) {
        None => {
            json!({"id": id, "error": {"code": -32601, "message": format!("unsupported Codex server request '{method}'")}})
        }
        Some(request) => match control_sink.request(request).await {
            Ok(resolution) => json!({"id": id, "result": encode_control_resolution(&resolution)}),
            Err(error) => {
                json!({"id": id, "error": {"code": -32000, "message": error.to_string()}})
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
        expected_turn: Option<&str>,
        root_turn: &mut TurnAccumulator,
    ) -> Result<Option<TurnOutcome>, HarnessError> {
        let params = notification.params().clone();
        let thread_id = optional_string(&params, &["/threadId", "/thread/id"]);
        let is_child = thread_id
            .as_deref()
            .is_some_and(|id| id != self.root_thread_id.as_str());
        let (stream, correlation) = if is_child {
            let Some((_, stream, correlation)) = self.declare_child(&params).await? else {
                return Ok(None);
            };
            (stream, correlation)
        } else {
            if let Some(expected) = expected_turn {
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
                self.root_correlation(
                    optional_string(&params, &["/turnId", "/turn/id"]).map(TurnId::new),
                    None,
                ),
            )
        };
        match notification {
            CodexNotification::AgentMessageDelta(params) => {
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
                if let Some(file_change) = file_change_event(item) {
                    self.emit(
                        stream,
                        correlation,
                        HarnessEventPayloadV1::FileChange(file_change),
                        UpdateSemantics::Snapshot,
                    )
                    .await?;
                } else if let Some((tool_id, name, input, is_spawn)) = tool_call(item) {
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
                if let Some(file_change) = file_change_event(item) {
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
                    "[Codex] turn/completed received thread_id={thread_id:?} turn_id={actual_turn:?} expected_turn={expected_turn:?} status={status}"
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
        if *cancel_rx.borrow() {
            return Ok(TurnOutcome {
                status: CompletionStatus::Cancelled,
                result_text: None,
                structured_output: None,
                usage: None,
                metrics: OutcomeMetrics::default(),
                error: Some("Codex turn cancelled".into()),
            });
        }
        let mut notifications = self.connection.notifications.subscribe();
        let mut connection_closed = self.connection.closed.subscribe();
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
        self.emit(
            self.root_stream_id.clone(),
            correlation.clone(),
            HarnessEventPayloadV1::TurnInput(TurnInput {
                thread_id: self.root_thread_id.clone(),
                run_id: run_id.clone(),
                content: content.clone(),
                provenance,
            }),
            UpdateSemantics::Snapshot,
        )
        .await?;
        let mut params = json!({"threadId": self.root_thread_id.as_str(), "input": [{"type":"text", "text": content}]});
        if let Some(schema) = output_schema {
            params["outputSchema"] = schema;
        }
        let structured_output_requested = params.get("outputSchema").is_some();
        self.config.permission.apply_to_params(&mut params);
        let response = self.connection.request("turn/start", params).await?;
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
        let mut accumulator = TurnAccumulator::default();
        if let Some(error) = connection_closed.borrow().clone() {
            return Err(HarnessError::Operation(error));
        }
        let result = loop {
            tokio::select! {
                changed = cancel_rx.changed() => { if changed.is_ok() && *cancel_rx.borrow() { let _ = tokio::time::timeout(self.config.terminal_exit_timeout, self.connection.request("turn/interrupt", json!({"threadId": self.root_thread_id.as_str(), "turnId": provider_turn}))).await; break TurnOutcome { status: CompletionStatus::Cancelled, result_text: None, structured_output: None, usage: accumulator.usage, metrics: OutcomeMetrics::default(), error: Some("Codex run cancelled".into()) }; } }
                closed = connection_closed.changed() => {
                    if closed.is_ok()
                        && let Some(error) = connection_closed.borrow().clone()
                    {
                        return Err(HarnessError::Operation(error));
                    }
                }
                notification = notifications.recv() => match notification {
                    Ok(notification) => if let Some(outcome) = self.process_notification(decode_notification(notification.method, notification.params).map_err(HarnessError::Operation)?, Some(&provider_turn), &mut accumulator).await? {
                        if run_id.is_none() {
                            self.emit(
                                self.root_stream_id.clone(),
                                self.root_correlation(Some(turn_id.clone()), None),
                                HarnessEventPayloadV1::TurnFinished(outcome.clone()),
                                UpdateSemantics::Snapshot,
                            ).await?;
                        }
                        break outcome;
                    },
                    Err(broadcast::error::RecvError::Lagged(count)) => return Err(HarnessError::Operation(format!("Codex notification buffer lost {count} messages"))),
                    Err(broadcast::error::RecvError::Closed) => return Err(HarnessError::Operation("Codex notification stream closed".into())),
                }
            }
        };
        let mut result = result;
        log::info!(
            "[Codex] turn finished provider_turn_id={provider_turn} status={:?} result_text_len={}",
            result.status,
            result.result_text.as_deref().map_or(0, str::len)
        );
        if structured_output_requested
            && result.status == CompletionStatus::Completed
            && result.structured_output.is_none()
        {
            match result.result_text.as_deref() {
                Some(text) => match serde_json::from_str(text) {
                    Ok(value) => result.structured_output = Some(value),
                    Err(error) => {
                        result.status = CompletionStatus::Failed;
                        result.error = Some(format!(
                            "Codex structured output was not valid JSON: {error}"
                        ));
                    }
                },
                None => {
                    result.status = CompletionStatus::Failed;
                    result.error = Some("Codex structured output was empty".into());
                }
            }
        }
        Ok(result)
    }

    async fn close(
        &self,
        status: SessionCloseStatus,
        error: Option<String>,
    ) -> Result<SessionCloseOutcome, HarnessError> {
        if *self.closed_rx.borrow() {
            return Ok(SessionCloseOutcome {
                status: SessionCloseStatus::Closed,
                error: None,
            });
        }
        let _ = self.closed.send(true);
        self.connection.close().await;
        let mut process = self.process.lock().await;
        cleanup_process(&mut process, self.config.cleanup_timeout).await;
        let outcome = SessionCloseOutcome { status, error };
        let _ = self
            .emit(
                self.root_stream_id.clone(),
                self.root_correlation(None, None),
                HarnessEventPayloadV1::SessionClosed(outcome.clone()),
                UpdateSemantics::Snapshot,
            )
            .await;
        Ok(outcome)
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
    Failed(String),
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
        let (tx, rx) = watch::channel(OutcomeState::Pending);
        let (cancel, cancel_rx) = watch::channel(false);
        let state = Arc::clone(&self.state);
        let turn_id = request.turn_id.clone();
        let turn_id_for_task = turn_id.clone();
        let task_state = Arc::clone(&state);
        tokio::spawn(async move {
            let _gate = task_state.root_turn_gate.lock().await;
            let result = task_state
                .execute_turn(
                    turn_id_for_task,
                    request.content,
                    request.output_schema,
                    None,
                    TurnInputProvenance::Human,
                    cancel_rx,
                )
                .await;
            let _ = tx.send(match result {
                Ok(value) => OutcomeState::Ready(value),
                Err(error) => OutcomeState::Failed(error.to_string()),
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
            OutcomeState::Failed(error) => return Err(HarnessError::Operation(error)),
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
        tokio::spawn(async move {
            let _gate = task_state.root_turn_gate.lock().await;
            let outcome = task_state
                .execute_turn(
                    TurnId::new(format!("{}:turn", task_run_id)),
                    request.prompt,
                    task_state.default_output_schema.clone(),
                    Some(task_run_id.clone()),
                    TurnInputProvenance::Human,
                    cancel_rx,
                )
                .await;
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
            let _ = tx.send(OutcomeState::Ready(run));
            let _ = task_state.close(SessionCloseStatus::Closed, None).await;
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
    let launcher: Arc<dyn CodexAppServerLauncher> = config
        .launcher
        .clone()
        .unwrap_or_else(|| Arc::new(ProcessCodexAppServerLauncher::new(Arc::new(launch_config))));
    let mut launched = launcher.launch().await?;
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
    if let Some(provider) = &config.model_provider {
        params["modelProvider"] = json!(provider);
    }
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
    let structured_output = [
        "/turn/structuredOutput",
        "/structuredOutput",
        "/turn/result",
        "/result",
    ]
    .iter()
    .find_map(|pointer| params.pointer(pointer))
    .and_then(|value| match value {
        Value::String(value) => serde_json::from_str(value).ok(),
        Value::Object(_) | Value::Array(_) => Some(value.clone()),
        _ => None,
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
        FileChangeKind, SessionState, ToolStatus, file_change_event, parse_usage, tool_call,
        tool_output,
    };
    use vertebrae_harness_core::{SessionId, ThreadId, ToolCallId, TurnId};

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
