use std::{collections::HashSet, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
    time::{Instant, sleep_until},
};
use vertebrae_harness_core::{
    CompletionStatus, ControlSink, DiagnosticEvent, EventCorrelation, EventSequencer, EventSink,
    HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1 as Event, ItemId, ProviderResumeId,
    SendTurnRequest, SequencedEventSink, SessionCloseOutcome, SessionCloseStatus, SessionHandle,
    SessionId, SessionStarted, StartSessionRequest, StreamId, ThreadId, TurnHandle, TurnId,
    TurnInput, TurnInputProvenance, TurnOutcome, TurnStarted, UpdateSemantics,
};

use crate::{
    AgentSession, SessionConfig,
    protocol::{Process, operation, response},
    updates::{cancel_permission, permission, permission_response, update},
};

struct Session {
    id: SessionId,
    provider_resume_id: Option<ProviderResumeId>,
    turns: mpsc::Sender<Turn>,
    available: Arc<Semaphore>,
    steering: Option<mpsc::Sender<Steer>>,
    closing: watch::Sender<bool>,
    closed: watch::Receiver<Option<Result<SessionCloseOutcome, String>>>,
}

struct Steer {
    expected_turn: TurnId,
    content: String,
    result: oneshot::Sender<Result<(), HarnessError>>,
}

struct Turn {
    request: SendTurnRequest,
    interrupt: watch::Receiver<bool>,
    result: watch::Sender<Option<Result<TurnOutcome, String>>>,
    permit: OwnedSemaphorePermit,
}

struct TurnTicket {
    id: TurnId,
    interrupt: watch::Sender<bool>,
    result: watch::Receiver<Option<Result<TurnOutcome, String>>>,
}

async fn settle<T: Clone>(
    mut result: watch::Receiver<Option<Result<T, String>>>,
) -> Result<T, HarnessError> {
    loop {
        if let Some(result) = result.borrow_and_update().clone() {
            return result.map_err(operation);
        }
        result
            .changed()
            .await
            .map_err(|_| operation("ACP session stopped unexpectedly"))?;
    }
}

async fn wait_for_signal(receiver: &mut watch::Receiver<bool>) {
    if receiver.wait_for(|value| *value).await.is_err() {
        std::future::pending::<()>().await;
    }
}

#[async_trait]
impl TurnHandle for TurnTicket {
    fn turn_id(&self) -> &TurnId {
        &self.id
    }
    async fn interrupt(&self) -> Result<(), HarnessError> {
        self.interrupt.send_replace(true);
        Ok(())
    }
    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError> {
        settle(self.result.clone()).await
    }
}

#[async_trait]
impl SessionHandle for Session {
    fn session_id(&self) -> &SessionId {
        &self.id
    }

    fn provider_resume_id(&self) -> Option<&ProviderResumeId> {
        self.provider_resume_id.as_ref()
    }

    async fn send(&self, request: SendTurnRequest) -> Result<Arc<dyn TurnHandle>, HarnessError> {
        if request.output_schema.is_some() {
            return Err(HarnessError::Unsupported(
                "ACP does not support structured output".into(),
            ));
        }
        if request.content.trim().is_empty() {
            return Err(HarnessError::InvalidRequest("ACP prompt is empty".into()));
        }
        if self.turns.is_closed() {
            return Err(HarnessError::SessionNotFound(self.id.to_string()));
        }
        let permit = self
            .available
            .clone()
            .try_acquire_owned()
            .map_err(|_| operation("ACP session already has an active turn or is closed"))?;
        if *self.closing.borrow() {
            return Err(operation("ACP session is closing"));
        }
        let id = request.turn_id.clone();
        let (interrupt, receiver) = watch::channel(false);
        let (sender, result) = watch::channel(None);
        self.turns
            .try_send(Turn {
                request,
                interrupt: receiver,
                result: sender,
                permit,
            })
            .map_err(|_| HarnessError::SessionNotFound(self.id.to_string()))?;
        Ok(Arc::new(TurnTicket {
            id,
            interrupt,
            result,
        }))
    }

    async fn steer(
        &self,
        expected_turn_id: &TurnId,
        content: String,
    ) -> Result<TurnId, HarnessError> {
        let sender = self
            .steering
            .as_ref()
            .ok_or_else(|| HarnessError::Unsupported("ACP live steering".into()))?;
        if content.trim().is_empty() || content.trim_start().starts_with('/') {
            return Err(HarnessError::InvalidRequest(
                "Steering requires a non-command message".into(),
            ));
        }
        let (result, received) = oneshot::channel();
        sender
            .send(Steer {
                expected_turn: expected_turn_id.clone(),
                content,
                result,
            })
            .await
            .map_err(|_| operation("ACP session is closed"))?;
        received
            .await
            .map_err(|_| operation("ACP session stopped before steering"))??;
        Ok(expected_turn_id.clone())
    }

    fn termination(
        &self,
    ) -> Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>> {
        let closed = self.closed.clone();
        Some(Box::pin(async move {
            let _ = settle(closed).await;
        }))
    }

    async fn close(&self) -> Result<SessionCloseOutcome, HarnessError> {
        self.closing.send_replace(true);
        settle(self.closed.clone()).await
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.closing.send_replace(true);
    }
}

struct Actor {
    process: Process,
    agent_session: String,
    config: SessionConfig,
    next_id: u64,
    steers: mpsc::Receiver<Steer>,
    stream: StreamId,
    correlation: EventCorrelation,
    events: SequencedEventSink,
    controls: Arc<dyn ControlSink>,
}

pub(crate) async fn start(
    process: Process,
    request: StartSessionRequest,
    session: AgentSession,
    events: Arc<dyn EventSink>,
    controls: Arc<dyn ControlSink>,
) -> Result<Arc<dyn SessionHandle>, HarnessError> {
    let (turns, receiver) = mpsc::channel(1);
    let (steering, steers) = mpsc::channel(1);
    let (closing, close_receiver) = watch::channel(false);
    let (closed_sender, closed) = watch::channel(None);
    let provider_resume_id = session
        .supports_resume
        .then(|| ProviderResumeId::new(session.id.clone()));
    let mut actor = Actor {
        process,
        agent_session: session.id,
        config: session.config,
        next_id: 2,
        steers,
        stream: request.stream_id,
        correlation: EventCorrelation {
            session_id: Some(request.session_id.clone()),
            thread_id: Some(ThreadId::new(request.session_id.as_str())),
            ..Default::default()
        },
        events: SequencedEventSink::new(Arc::new(EventSequencer::default()), events),
        controls,
    };
    let started = actor
        .emit(
            Event::SessionStarted(SessionStarted {
                provider: "acp".into(),
                model: actor.config.current("model").map(str::to_owned),
                provider_resume_id: provider_resume_id.clone(),
                speed_tier_status: None,
                tools: Vec::new(),
            }),
            UpdateSemantics::Snapshot,
            &actor.correlation,
        )
        .await;
    if let Err(error) = started {
        actor.process.reap().await;
        return Err(error);
    }
    tokio::spawn(actor.run(receiver, close_receiver, closed_sender));
    Ok(Arc::new(Session {
        id: request.session_id,
        provider_resume_id,
        turns,
        steering: session.supports_steering.then_some(steering),
        available: Arc::new(Semaphore::new(1)),
        closing,
        closed,
    }))
}

impl Actor {
    async fn next_steer(receiver: &mut mpsc::Receiver<Steer>) -> Steer {
        match receiver.recv().await {
            Some(steer) => steer,
            None => std::future::pending().await,
        }
    }

    async fn emit(
        &self,
        payload: Event,
        semantics: UpdateSemantics,
        correlation: &EventCorrelation,
    ) -> Result<(), HarnessError> {
        let mut draft = HarnessEventDraftV1::new(self.stream.clone(), semantics, payload);
        draft.correlation = correlation.clone();
        self.events.emit(draft).await?;
        Ok(())
    }

    async fn run(
        mut self,
        mut turns: mpsc::Receiver<Turn>,
        mut closing: watch::Receiver<bool>,
        closed: watch::Sender<Option<Result<SessionCloseOutcome, String>>>,
    ) {
        let mut failure = None;
        loop {
            tokio::select! {
                biased;
                turn = turns.recv() => {
                    let Some(turn) = turn else { break };
                    if let Err(error) = self.run_turn(turn, &mut closing).await {
                        failure = Some(error);
                        break;
                    }
                }
                steer = Self::next_steer(&mut self.steers) => {
                    let _ = steer.result.send(Err(operation("ACP turn is no longer active")));
                }
                _ = wait_for_signal(&mut closing) => break,
                message = self.process.read() => {
                    let result = match message {
                        Ok(message) if message["method"] == "session/update" => {
                            self.update_config(&message["params"]);
                            Ok(())
                        }
                        Ok(message) if message.get("method").is_some() && message.get("id").is_some() => {
                            self.process.reject(&message["id"]).await
                        }
                        Ok(_) => Ok(()),
                        Err(error) => Err(error),
                    };
                    if let Err(error) = result {
                        let _ = self.emit(
                            Event::Error(DiagnosticEvent { message: error.to_string(), code: None }),
                            UpdateSemantics::Snapshot,
                            &self.correlation,
                        ).await;
                        failure = Some(error);
                        break;
                    }
                }
            }
        }
        turns.close();
        if let Some(turn) = turns.recv().await {
            let mut stopping = watch::channel(true).1;
            let _ = self.run_turn(turn, &mut stopping).await;
        }
        self.process.reap().await;
        let outcome = SessionCloseOutcome {
            status: if failure.is_some() {
                SessionCloseStatus::ProcessLost
            } else {
                SessionCloseStatus::Closed
            },
            error: failure.map(|error| error.to_string()),
        };
        let result = self
            .emit(
                Event::SessionClosed(outcome.clone()),
                UpdateSemantics::Snapshot,
                &self.correlation,
            )
            .await
            .map(|()| outcome)
            .map_err(|error| error.to_string());
        closed.send_replace(Some(result));
    }

    async fn run_turn(
        &mut self,
        mut turn: Turn,
        closing: &mut watch::Receiver<bool>,
    ) -> Result<(), HarnessError> {
        let correlation = EventCorrelation {
            turn_id: Some(turn.request.turn_id.clone()),
            ..self.correlation.clone()
        };
        if let Err(error) = self
            .emit(
                Event::TurnStarted(TurnStarted {
                    input_summary: None,
                }),
                UpdateSemantics::Snapshot,
                &correlation,
            )
            .await
        {
            turn.result.send_replace(Some(Err(error.to_string())));
            return Err(error);
        }

        let (status, failure, fatal) = if *closing.borrow() || *turn.interrupt.borrow() {
            (CompletionStatus::Interrupted, None, false)
        } else {
            let original_config = self.config.clone();
            let settings = tokio::select! {
                biased;
                _ = wait_for_signal(closing) => None,
                _ = wait_for_signal(&mut turn.interrupt) => None,
                result = tokio::time::timeout(
                    Duration::from_secs(10),
                    self.config.apply(
                        &mut self.process,
                        &mut self.next_id,
                        &self.agent_session,
                        &turn.request.settings,
                    ),
                ) => Some(result.unwrap_or_else(|_| Err(operation("ACP agent did not confirm its settings in time")))),
            };
            match settings {
                None => (
                    CompletionStatus::Interrupted,
                    Some(operation(
                        "ACP session closed because a settings change was interrupted",
                    )),
                    true,
                ),
                Some(Ok(())) => match self.prompt(&mut turn, closing, &correlation).await {
                    Ok(status) => (status, None, false),
                    Err(error) => (CompletionStatus::Failed, Some(error), true),
                },
                Some(Err(error)) => {
                    let fatal = !matches!(error, HarnessError::InvalidRequest(_))
                        || self.config != original_config;
                    (CompletionStatus::Failed, Some(error), fatal)
                }
            }
        };
        if let Some(error) = &failure {
            let diagnostic = DiagnosticEvent {
                message: error.to_string(),
                code: None,
            };
            let _ = self
                .emit(
                    if fatal {
                        Event::Error(diagnostic)
                    } else {
                        Event::Warning(diagnostic)
                    },
                    UpdateSemantics::Snapshot,
                    &correlation,
                )
                .await;
        }
        let outcome = TurnOutcome {
            status,
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: Default::default(),
            error: failure.as_ref().map(ToString::to_string),
        };
        drop(turn.permit);
        let delivered = self
            .emit(
                Event::TurnFinished(outcome.clone()),
                UpdateSemantics::Snapshot,
                &correlation,
            )
            .await;
        turn.result.send_replace(Some(
            delivered
                .as_ref()
                .map(|()| outcome)
                .map_err(ToString::to_string),
        ));
        delivered?;
        if fatal {
            failure.map_or(Ok(()), Err)
        } else {
            Ok(())
        }
    }

    fn update_config(&mut self, params: &Value) {
        if params["sessionId"] == self.agent_session
            && params["update"]["sessionUpdate"] == "config_option_update"
        {
            self.config.replace(&params["update"]);
        }
    }

    async fn write_prompt(&mut self, content: &str) -> Result<u64, HarnessError> {
        self.next_id += 1;
        self.process.write(json!({
            "jsonrpc":"2.0", "id": self.next_id, "method":"session/prompt",
            "params":{"sessionId": self.agent_session, "prompt":[{"type":"text", "text":content}]}
        })).await?;
        Ok(self.next_id)
    }

    async fn prompt(
        &mut self,
        turn: &mut Turn,
        closing: &mut watch::Receiver<bool>,
        correlation: &EventCorrelation,
    ) -> Result<CompletionStatus, HarnessError> {
        let mut latest = self.write_prompt(&turn.request.content).await?;
        let mut pending = HashSet::from([latest]);
        let mut status = CompletionStatus::Completed;
        let mut approval = None;
        let mut text_item = None;
        let mut deadline = None;
        loop {
            tokio::select! {
                biased;
                _ = wait_for_signal(&mut turn.interrupt), if deadline.is_none() => {
                    self.cancel(&mut approval).await?;
                    deadline = Some(Instant::now() + Duration::from_secs(5));
                }
                _ = wait_for_signal(closing), if deadline.is_none() => {
                    self.cancel(&mut approval).await?;
                    deadline = Some(Instant::now() + Duration::from_secs(5));
                }
                _ = async { sleep_until(deadline.expect("deadline set")).await }, if deadline.is_some() => {
                    return Err(operation("ACP agent did not acknowledge cancellation"));
                }
                answered = async {
                    let (_, _, receiver): &mut PendingApproval = approval.as_mut().expect("approval set");
                    receiver.await.ok().and_then(Result::ok)
                }, if approval.is_some() => {
                    let (rpc_id, request, _) = approval.take().expect("approval set");
                    self.process.write(permission_response(&rpc_id, &request, answered)).await?;
                }
                steer = Self::next_steer(&mut self.steers) => {
                    if deadline.is_some() || steer.expected_turn != turn.request.turn_id {
                        let _ = steer.result.send(Err(operation("ACP turn is no longer active")));
                    } else if approval.is_some() {
                        let _ = steer.result.send(Err(operation("Answer the agent before steering")));
                    } else {
                        latest = self.write_prompt(&steer.content).await?;
                        pending.insert(latest);
                        let mut item = correlation.clone();
                        item.item_id = Some(ItemId::new(format!("steer:{}", uuid::Uuid::new_v4())));
                        self.emit(Event::TurnInput(TurnInput {
                            thread_id: item.thread_id.clone().expect("interactive thread"),
                            run_id: None,
                            content: steer.content,
                            provenance: TurnInputProvenance::Human,
                        }), UpdateSemantics::Snapshot, &item).await?;
                        let _ = steer.result.send(Ok(()));
                    }
                }
                message = self.process.read() => {
                    let message = message?;
                    if message.get("method").is_none()
                        && let Some(id) = message["id"].as_u64()
                        && pending.remove(&id)
                    {
                        let stop = response(message, "session/prompt")?;
                        let completion = match stop["stopReason"].as_str() {
                            Some("cancelled") => CompletionStatus::Interrupted,
                            Some("end_turn" | "max_tokens" | "max_turn_requests" | "refusal") => CompletionStatus::Completed,
                            _ => return Err(operation("ACP prompt returned an invalid stop reason")),
                        };
                        if id == latest {
                            status = completion;
                        }
                        if pending.is_empty() {
                            return Ok(status);
                        }
                        continue;
                    }
                    let params = &message["params"];
                    match (message["method"].as_str(), message.get("id")) {
                        (Some("session/update"), None) if params["sessionId"] == self.agent_session => {
                            self.update_config(params);
                            if let Some((event, semantics)) = update(&params["update"]) {
                                let mut item = correlation.clone();
                                match &event {
                                    Event::Text(_) => {
                                        item.item_id = Some(text_item.get_or_insert_with(|| {
                                            ItemId::new(uuid::Uuid::new_v4().to_string())
                                        }).clone());
                                    }
                                    Event::ToolCall(call) => {
                                        text_item = None;
                                        item.tool_call_id = Some(call.tool_call_id.clone());
                                    }
                                    Event::ToolOutput(output) => {
                                        text_item = None;
                                        item.tool_call_id = Some(output.tool_call_id.clone());
                                    }
                                    _ => {}
                                }
                                self.emit(event, semantics, &item).await?;
                            }
                        }
                        (Some("session/request_permission"), Some(rpc_id)) => {
                            if deadline.is_none() && approval.is_none() && params["sessionId"] == self.agent_session
                                && let Some(request) = permission(params, correlation) {
                                text_item = None;
                                let controls = self.controls.clone();
                                let control = request.clone();
                                let (sender, receiver) = oneshot::channel();
                                tokio::spawn(async move {
                                    let mut sender = sender;
                                    tokio::select! {
                                        _ = sender.closed() => {}
                                        resolution = controls.request(control) => { let _ = sender.send(resolution); }
                                    }
                                });
                                approval = Some((rpc_id.clone(), request, receiver));
                            } else {
                                self.process.write(cancel_permission(rpc_id)).await?;
                            }
                        }
                        (Some(_), Some(id)) => self.process.reject(id).await?,
                        _ => {}
                    }
                }
            }
        }
    }

    async fn cancel(&mut self, approval: &mut Option<PendingApproval>) -> Result<(), HarnessError> {
        self.process.write(json!({
            "jsonrpc":"2.0", "method":"session/cancel", "params":{"sessionId":self.agent_session}
        })).await?;
        if let Some((rpc_id, _, _)) = approval.take() {
            self.process.write(cancel_permission(&rpc_id)).await?;
        }
        Ok(())
    }
}

type PendingApproval = (
    Value,
    vertebrae_harness_core::ControlRequestEnvelope,
    oneshot::Receiver<Result<vertebrae_harness_core::ControlResolution, HarnessError>>,
);
