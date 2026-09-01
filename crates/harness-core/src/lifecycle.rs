use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ControlRequestEnvelope, ControlResolution, HarnessCapabilities, HarnessEventV1,
    OutputVerbosity, ProviderResumeId, RunId, SessionId, SpeedTier, StreamId, TurnId,
};

/// Portable, per-request behavior shared by provider adapters.
///
/// Provider-specific process paths, launch arguments, endpoints, credentials,
/// protocol clients, and permission plumbing belong in adapter constructor
/// configuration. They must not be tunneled through this type or its
/// `environment` field.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RequestConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Optional provider-neutral serving speed override. When unset, the
    /// provider's existing default behavior is preserved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_tier: Option<SpeedTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbosity: Option<OutputVerbosity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    /// Additive instructions for the provider's developer/system layer.
    /// Adapters preserve their built-in instructions and merge this value
    /// through their native provider mechanism.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartSessionRequest {
    pub session_id: SessionId,
    pub stream_id: StreamId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<ProviderResumeId>,
    #[serde(default)]
    pub config: RequestConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SendTurnRequest {
    pub turn_id: TurnId,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunRequest {
    pub run_id: RunId,
    pub stream_id: StreamId,
    pub prompt: String,
    #[serde(default)]
    pub config: RequestConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionStatus {
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
}

impl TokenUsage {
    pub(crate) fn add_assign(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(other.cached_input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnUsage {
    pub tokens: TokenUsage,
    pub cost_microusd: u64,
}

impl TurnUsage {
    pub(crate) fn add_assign(&mut self, other: &Self) {
        self.tokens.add_assign(&other.tokens);
        self.cost_microusd = self.cost_microusd.saturating_add(other.cost_microusd);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionUsage {
    pub tokens: TokenUsage,
    pub cost_microusd: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// Provider-neutral terminal measurements that are not token usage.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OutcomeMetrics {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Provider-reported total cost, including results with no usage object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnOutcome {
    pub status: CompletionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_output: Option<Value>,
    /// Informational terminal usage. Aggregate only `UsageEvent` payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    #[serde(default)]
    pub metrics: OutcomeMetrics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunOutcome {
    pub status: CompletionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_output: Option<Value>,
    /// Informational terminal usage. Aggregate only `UsageEvent` payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    #[serde(default)]
    pub metrics: OutcomeMetrics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionCloseStatus {
    Closed,
    ProcessLost,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCloseOutcome {
    pub status: SessionCloseStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("harness is unavailable: {0}")]
    Unavailable(String),
    #[error("unsupported harness operation: {0}")]
    Unsupported(String),
    #[error("invalid harness request: {0}")]
    InvalidRequest(String),
    #[error("harness operation failed: {0}")]
    Operation(String),
    #[error("event sink failed: {0}")]
    EventSink(String),
    #[error("control request failed: {0}")]
    Control(String),
}

#[async_trait]
pub trait EventSink: Send + Sync {
    /// Accepts an event for ordered delivery.
    ///
    /// `Ok` means the sink accepted the event; `Err` means it did not. Sinks
    /// must not accept an event and then report failure, because adapters use
    /// this result to preserve exactly-once lifecycle delivery.
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError>;

    /// Waits until all events accepted by the sink before this call have
    /// reached their durable/live delivery boundary.
    ///
    /// Most live sinks do not have an additional asynchronous boundary, so
    /// the default is intentionally a no-op. Durable sinks may override this
    /// to drain an output queue. Keeping this operation on the neutral sink
    /// contract lets adapters acknowledge terminal lifecycle events without
    /// teaching them about persistence or provider-specific queues.
    async fn flush(&self) -> Result<(), HarnessError> {
        Ok(())
    }
}

#[async_trait]
pub trait ControlSink: Send + Sync {
    async fn request(
        &self,
        request: ControlRequestEnvelope,
    ) -> Result<ControlResolution, HarnessError>;
}

#[async_trait]
pub trait TurnHandle: Send + Sync {
    fn turn_id(&self) -> &TurnId;
    /// Requests interruption while another task may be awaiting the outcome.
    ///
    /// This applies equally to a turn waiting in an adapter queue and one that
    /// is already in flight. A successful request does not itself settle the
    /// handle: the adapter must still emit the turn's single `TurnFinished`
    /// event and make the same terminal outcome available through
    /// [`TurnHandle::await_outcome`]. Repeated calls must be safe and must not
    /// produce additional terminal events.
    async fn interrupt(&self) -> Result<(), HarnessError>;
    /// Waits for the terminal outcome of an accepted interactive turn.
    ///
    /// Before this future becomes ready, the adapter must have delivered
    /// exactly one `TurnFinished` event to the session's event sink. The event
    /// must be correlated with [`TurnHandle::turn_id`] and contain the same
    /// [`CompletionStatus`] and outcome data returned here. This guarantee
    /// applies to completed, failed, interrupted, and cancelled turns.
    ///
    /// If the single terminal delivery attempt fails, this method returns that
    /// sink failure instead of making an outcome available.
    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError>;
}

#[async_trait]
pub trait SessionHandle: Send + Sync {
    fn session_id(&self) -> &SessionId;
    fn provider_resume_id(&self) -> Option<&ProviderResumeId>;
    /// Submits an interactive turn to the provider adapter.
    ///
    /// Returning `Ok` is the provider-neutral acceptance boundary and
    /// transfers responsibility for the complete lifecycle to the adapter. An
    /// accepted turn emits exactly one correlated `TurnStarted` followed by
    /// exactly one correlated `TurnFinished`. `TurnStarted` represents this
    /// adapter acceptance; a later provider request rejection is a `Failed`
    /// terminal outcome, not a rejected `send`. Returning `Err` rejects the
    /// turn and therefore creates no lifecycle events or handle for that
    /// request.
    ///
    /// Because adapters may dispatch asynchronously after returning the
    /// handle, failure to deliver `TurnStarted` is surfaced by
    /// `TurnHandle::await_outcome` as an event-sink error. Provider work and the
    /// matching terminal event must not begin after that start-delivery
    /// failure.
    async fn send(&self, request: SendTurnRequest) -> Result<Arc<dyn TurnHandle>, HarnessError>;
    async fn close(&self) -> Result<SessionCloseOutcome, HarnessError>;
}

#[async_trait]
pub trait RunHandle: Send + Sync {
    fn run_id(&self) -> &RunId;
    /// Cancels the run while another task may be awaiting its outcome.
    async fn cancel(&self) -> Result<(), HarnessError>;
    async fn await_outcome(&self) -> Result<RunOutcome, HarnessError>;
}

#[async_trait]
pub trait HarnessRuntime: Send + Sync {
    async fn capabilities(&self) -> Result<HarnessCapabilities, HarnessError>;

    async fn start_session(
        &self,
        request: StartSessionRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn SessionHandle>, HarnessError>;

    async fn run_once(
        &self,
        request: RunRequest,
        event_sink: Arc<dyn EventSink>,
        control_sink: Arc<dyn ControlSink>,
    ) -> Result<Arc<dyn RunHandle>, HarnessError>;
}

/// Best-effort interrupt, then session close, then turn settlement.
pub const DEFAULT_TURN_INTERRUPT_TIMEOUT: Duration = Duration::from_secs(2);
pub const DEFAULT_SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_TURN_OUTCOME_TIMEOUT: Duration = Duration::from_secs(2);

/// Outcome of [`interrupt_close_and_await`]. Callers log; this helper does not.
#[derive(Debug)]
pub struct SessionShutdown {
    pub interrupt_timed_out: bool,
    pub interrupt_error: Option<String>,
    pub close: Option<Result<SessionCloseOutcome, HarnessError>>,
    pub close_timed_out: bool,
    pub outcome_timed_out: bool,
}

/// Interrupt an optional in-flight turn, close the session, then await the turn.
///
/// Timeouts are bounded and independent. A timed-out interrupt still proceeds
/// to close; a timed-out close still awaits the turn so the caller can drop
/// ownership. Process reaping belongs in `SessionHandle::close`.
pub async fn interrupt_close_and_await(
    turn: Option<Arc<dyn TurnHandle>>,
    session: Option<Arc<dyn SessionHandle>>,
) -> SessionShutdown {
    interrupt_close_and_await_with_timeouts(
        turn,
        session,
        DEFAULT_TURN_INTERRUPT_TIMEOUT,
        DEFAULT_SESSION_CLOSE_TIMEOUT,
        DEFAULT_TURN_OUTCOME_TIMEOUT,
    )
    .await
}

pub async fn interrupt_close_and_await_with_timeouts(
    turn: Option<Arc<dyn TurnHandle>>,
    session: Option<Arc<dyn SessionHandle>>,
    interrupt_timeout: Duration,
    close_timeout: Duration,
    outcome_timeout: Duration,
) -> SessionShutdown {
    let mut shutdown = SessionShutdown {
        interrupt_timed_out: false,
        interrupt_error: None,
        close: None,
        close_timed_out: false,
        outcome_timed_out: false,
    };
    if let Some(turn) = turn.as_ref() {
        match tokio::time::timeout(interrupt_timeout, turn.interrupt()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => shutdown.interrupt_error = Some(error.to_string()),
            Err(_) => shutdown.interrupt_timed_out = true,
        }
    }
    if let Some(session) = session {
        match tokio::time::timeout(close_timeout, session.close()).await {
            Ok(result) => shutdown.close = Some(result),
            Err(_) => shutdown.close_timed_out = true,
        }
    }
    if let Some(turn) = turn
        && tokio::time::timeout(outcome_timeout, turn.await_outcome())
            .await
            .is_err()
    {
        shutdown.outcome_timed_out = true;
    }
    shutdown
}
