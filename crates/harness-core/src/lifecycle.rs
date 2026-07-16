use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ControlRequestEnvelope, ControlResolution, HarnessCapabilities, HarnessEventV1,
    ProviderResumeId, RunId, SessionId, StreamId, TurnId,
};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RequestConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnOutcome {
    pub status: CompletionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
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
    async fn emit(&self, event: HarnessEventV1) -> Result<(), HarnessError>;
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
    /// Interrupts the turn while another task may be awaiting its outcome.
    async fn interrupt(&self) -> Result<(), HarnessError>;
    async fn await_outcome(&self) -> Result<TurnOutcome, HarnessError>;
}

#[async_trait]
pub trait SessionHandle: Send + Sync {
    fn session_id(&self) -> &SessionId;
    fn provider_resume_id(&self) -> Option<&ProviderResumeId>;
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
