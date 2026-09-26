use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::watch;
use vertebrae_harness_core::{
    CompletionStatus, EventCorrelation, EventSequencer, EventSink, HarnessCapabilities,
    HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1, HarnessRuntime, ModelCapability,
    OutcomeMetrics, QuestionCapabilities, RunHandle, RunId, RunOutcome, RunRequest,
    SequencedEventSink, SessionHandle, StartSessionRequest, StructuredInferenceRequest, ThreadId,
    TokenUsage, TurnInput, TurnInputProvenance, TurnUsage, UpdateSemantics, UsageEvent,
};

use crate::{
    DEFAULT_MODEL, SystemOneRequest, SystemOneResponse, TypeSafeClient, TypeSafeClientConfig,
    TypeSafeError,
};

/// A TypeSafe runtime exposes stateless System One judgments through the
/// provider-neutral structured inference boundary.
#[derive(Clone)]
pub struct TypeSafeRuntime {
    client: TypeSafeClient,
}

impl std::fmt::Debug for TypeSafeRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TypeSafeRuntime")
            .field("client", &self.client)
            .finish()
    }
}

impl TypeSafeRuntime {
    pub fn new(client: TypeSafeClient) -> Self {
        Self { client }
    }

    pub fn from_config(config: TypeSafeClientConfig) -> Result<Self, TypeSafeError> {
        TypeSafeClient::from_config(config).map(Self::new)
    }

    pub fn client(&self) -> &TypeSafeClient {
        &self.client
    }
}

#[derive(Debug, Clone, Default)]
enum OutcomeState {
    #[default]
    Pending,
    Ready(RunOutcome),
    Failed(OutcomeFailure),
}

#[derive(Debug, Clone)]
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

struct TypeSafeRunHandle {
    run_id: RunId,
    cancel_tx: watch::Sender<bool>,
    outcome_rx: watch::Receiver<OutcomeState>,
}

#[async_trait]
impl RunHandle for TypeSafeRunHandle {
    fn run_id(&self) -> &RunId {
        &self.run_id
    }

    async fn cancel(&self) -> Result<(), HarnessError> {
        let _ = self.cancel_tx.send(true);
        Ok(())
    }

    async fn await_outcome(&self) -> Result<RunOutcome, HarnessError> {
        await_state(self.outcome_rx.clone()).await
    }
}

#[async_trait]
impl HarnessRuntime for TypeSafeRuntime {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError> {
        Ok(HarnessCapabilities {
            provider: "typesafe".into(),
            available: true,
            unavailable_reason: None,
            persistent_sessions: false,
            one_shot_runs: true,
            structured_inference: true,
            session_resumption: false,
            default_model: Some(DEFAULT_MODEL.into()),
            models: Vec::<ModelCapability>::new(),
            default_permission_mode: None,
            permission_modes: Vec::new(),
            approval_categories: Default::default(),
            questions: QuestionCapabilities::default(),
        })
    }

    async fn start_session(
        &self,
        _request: StartSessionRequest,
        _event_sink: Arc<dyn EventSink>,
        _control_sink: Arc<dyn vertebrae_harness_core::ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError> {
        Err(HarnessError::Unsupported(
            "TypeSafe only supports one-shot judgment runs; persistent sessions are unsupported"
                .into(),
        ))
    }

    async fn run_once(
        &self,
        _request: RunRequest,
        _event_sink: Arc<dyn EventSink>,
        _control_sink: Arc<dyn vertebrae_harness_core::ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        Err(HarnessError::Unsupported(
            "TypeSafe requires the structured inference request API".into(),
        ))
    }

    async fn run_structured_inference(
        &self,
        request: StructuredInferenceRequest,
        event_sink: Arc<dyn EventSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        let questions =
            serde_json::from_value(serde_json::to_value(request.questions).map_err(|error| {
                HarnessError::InvalidRequest(format!("invalid structured questions: {error}"))
            })?)
            .map_err(|error| {
                HarnessError::InvalidRequest(format!("invalid System One questions: {error}"))
            })?;
        let judgment = SystemOneRequest::for_model(
            request.state,
            request.model.unwrap_or_else(|| DEFAULT_MODEL.into()),
            questions,
        );
        judgment
            .validate()
            .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        let prompt = serde_json::to_string(&judgment)
            .map_err(|error| HarnessError::InvalidRequest(error.to_string()))?;
        self.start_judgment(
            request.run_id,
            request.stream_id,
            prompt,
            judgment,
            event_sink,
        )
    }
}

impl TypeSafeRuntime {
    fn start_judgment(
        &self,
        run_id: RunId,
        stream_id: vertebrae_harness_core::StreamId,
        prompt: String,
        judgment: SystemOneRequest,
        event_sink: Arc<dyn EventSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError> {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (outcome_tx, outcome_rx) = watch::channel(OutcomeState::Pending);
        tokio::spawn(execute_run(
            self.client.clone(),
            RunRequest {
                run_id: run_id.clone(),
                stream_id,
                prompt,
                config: Default::default(),
            },
            judgment,
            event_sink,
            cancel_rx,
            outcome_tx,
        ));

        Ok(Arc::new(TypeSafeRunHandle {
            run_id,
            cancel_tx,
            outcome_rx,
        }))
    }
}

async fn execute_run(
    client: TypeSafeClient,
    request: RunRequest,
    judgment: SystemOneRequest,
    event_sink: Arc<dyn EventSink>,
    mut cancel_rx: watch::Receiver<bool>,
    outcome_tx: watch::Sender<OutcomeState>,
) {
    let sequenced = SequencedEventSink::new(Arc::new(EventSequencer::default()), event_sink);
    let thread_id = ThreadId::new(request.run_id.as_str());
    let correlation = EventCorrelation {
        thread_id: Some(thread_id.clone()),
        run_id: Some(request.run_id.clone()),
        ..EventCorrelation::default()
    };

    if let Err(error) = emit_event(
        &sequenced,
        request.stream_id.clone(),
        correlation.clone(),
        HarnessEventPayloadV1::TurnInput(TurnInput {
            thread_id,
            run_id: Some(request.run_id.clone()),
            content: request.prompt.clone(),
            provenance: TurnInputProvenance::Human,
        }),
    )
    .await
    {
        let _ = outcome_tx.send(OutcomeState::Failed(error.into()));
        return;
    }

    let response = if *cancel_rx.borrow() {
        None
    } else {
        let request_for_cancel = judgment.clone();
        tokio::select! {
            biased;
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    None
                } else {
                    Some(client.system_one(request_for_cancel).await)
                }
            }
            response = client.system_one(judgment.clone()) => Some(response),
        }
    };

    let outcome = match response {
        None => RunOutcome {
            status: CompletionStatus::Cancelled,
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: OutcomeMetrics::default(),
            error: None,
        },
        Some(Ok(response)) if !*cancel_rx.borrow() => match successful_outcome(response) {
            Ok((outcome, usage)) => {
                if let Err(error) = emit_event(
                    &sequenced,
                    request.stream_id.clone(),
                    correlation.clone(),
                    HarnessEventPayloadV1::Usage(UsageEvent {
                        turn_delta: Some(usage),
                        session_snapshot: None,
                    }),
                )
                .await
                {
                    let _ = outcome_tx.send(OutcomeState::Failed(error.into()));
                    return;
                }
                outcome
            }
            Err(error) => failed_outcome(error.to_string()),
        },
        Some(Ok(_)) => RunOutcome {
            status: CompletionStatus::Cancelled,
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: OutcomeMetrics::default(),
            error: None,
        },
        Some(Err(_error)) if *cancel_rx.borrow() => RunOutcome {
            status: CompletionStatus::Cancelled,
            result_text: None,
            structured_output: None,
            usage: None,
            metrics: OutcomeMetrics::default(),
            error: None,
        },
        Some(Err(error)) => failed_outcome(type_safe_error_message(&error)),
    };

    if let Err(error) = emit_event(
        &sequenced,
        request.stream_id,
        correlation,
        HarnessEventPayloadV1::RunFinished(outcome.clone()),
    )
    .await
    {
        let _ = outcome_tx.send(OutcomeState::Failed(error.into()));
    } else {
        let _ = outcome_tx.send(OutcomeState::Ready(outcome));
    }
}

fn successful_outcome(
    response: SystemOneResponse,
) -> Result<(RunOutcome, TurnUsage), HarnessError> {
    let structured_output = serde_json::to_value(response.answers).map_err(|error| {
        HarnessError::Operation(format!("failed to encode TypeSafe answers: {error}"))
    })?;
    let usage = TurnUsage {
        tokens: TokenUsage {
            input_tokens: response.usage.input_tokens,
            cached_input_tokens: 0,
            output_tokens: response.usage.output_tokens,
            reasoning_tokens: 0,
        },
        cost_microusd: 0,
    };
    Ok((
        RunOutcome {
            status: CompletionStatus::Completed,
            result_text: None,
            structured_output: Some(structured_output),
            usage: Some(usage.clone()),
            metrics: OutcomeMetrics::default(),
            error: None,
        },
        usage,
    ))
}

fn failed_outcome(error: String) -> RunOutcome {
    RunOutcome {
        status: CompletionStatus::Failed,
        result_text: None,
        structured_output: None,
        usage: None,
        metrics: OutcomeMetrics::default(),
        error: Some(error),
    }
}

fn type_safe_error_message(error: &TypeSafeError) -> String {
    let message = error.to_string();
    match error.request_id() {
        Some(request_id) => format!("{message} (request id: {request_id})"),
        None => message,
    }
}

async fn emit_event(
    sink: &SequencedEventSink,
    stream_id: vertebrae_harness_core::StreamId,
    correlation: EventCorrelation,
    payload: HarnessEventPayloadV1,
) -> Result<(), HarnessError> {
    let mut draft = HarnessEventDraftV1::new(stream_id, UpdateSemantics::Snapshot, payload);
    draft.correlation = correlation;
    sink.emit(draft).await.map(|_| ())
}

async fn await_state(
    mut receiver: watch::Receiver<OutcomeState>,
) -> Result<RunOutcome, HarnessError> {
    loop {
        let state = receiver.borrow().clone();
        match state {
            OutcomeState::Pending => receiver.changed().await.map_err(|_| {
                HarnessError::Operation("TypeSafe run ended without an outcome".into())
            })?,
            OutcomeState::Ready(outcome) => return Ok(outcome),
            OutcomeState::Failed(error) => return Err(error.into_harness_error()),
        }
    }
}
