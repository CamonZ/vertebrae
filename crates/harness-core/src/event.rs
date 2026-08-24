use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::Value;

use crate::{
    ControlRequestEnvelope, ControlResolution, RunOutcome, SessionCloseOutcome, SessionUsage,
    SpeedTierStatus, TurnOutcome, TurnUsage,
};

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self::new(value)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self::new(value)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

string_id!(EventId);
string_id!(StreamId);
string_id!(SessionId);
string_id!(ThreadId);
string_id!(TurnId);
string_id!(RunId);
string_id!(ItemId);
string_id!(ToolCallId);
string_id!(ControlRequestId);
string_id!(ProviderResumeId);
string_id!(ProviderThreadRef);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventCorrelation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    /// Stable logical thread identity, independent of the delivery stream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    /// One-shot run identity. Every event produced by `run_once` carries this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<ItemId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<ToolCallId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_resume_id: Option<ProviderResumeId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSemantics {
    Delta,
    Snapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Started,
    Running,
    Completed,
    Failed,
    Declined,
    Cancelled,
}

impl ToolStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Declined | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionStarted {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_resume_id: Option<ProviderResumeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_tier_status: Option<SpeedTierStatus>,
    /// Provider-advertised tools available to the session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnStarted {
    /// Optional display summary for a turn accepted by the adapter. Exactly
    /// one `TurnStarted` is emitted for each successful `SessionHandle::send`,
    /// correlated with the accepted handle's turn id. A later provider request
    /// rejection is represented by the matching failed terminal event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_summary: Option<String>,
}

/// Authorship of exact input supplied to a turn or one-shot run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnInputProvenance {
    Human,
    Agent,
    System,
    Provider,
}

/// Lossless provider-neutral input. Unlike `TurnStarted::input_summary`, this
/// contains the complete content and is safe to use for durable replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnInput {
    /// Durable canonical thread identity. The correlation copy is routing
    /// metadata and, when present, must agree with this value.
    pub thread_id: ThreadId,
    /// Durable canonical one-shot run identity. `None` denotes an interactive
    /// turn. The correlation copy, when present, must agree with this value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    pub content: String,
    pub provenance: TurnInputProvenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadKind {
    Root,
    Subagent,
}

/// Optional descriptive metadata for an agent-backed thread.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Declares stable logical thread identity and lineage independently of the
/// stream that happens to deliver the thread's events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadDeclared {
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_thread_id: Option<ThreadId>,
    pub kind: ThreadKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caused_by_tool_call_id: Option<ToolCallId>,
    /// Opaque provider-owned loading handle. It is not a session resume id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_ref: Option<ProviderThreadRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_metadata: Option<AgentMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextEvent {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningEvent {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEvent {
    pub entries: Vec<PlanEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallEvent {
    pub tool_call_id: ToolCallId,
    pub name: String,
    pub input: Value,
    pub status: ToolStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolOutputEvent {
    pub tool_call_id: ToolCallId,
    pub output: Value,
    pub status: ToolStatus,
    pub content_semantics: UpdateSemantics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub kind: FileChangeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChangeEvent {
    /// Provider tool/item identity, when the change came from a file-editing
    /// tool. This lets consumers replace a started snapshot with its terminal
    /// snapshot instead of rendering two file-change rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    pub changes: Vec<FileChange>,
    /// File changes have the same lifecycle as tool calls. Older persisted V1
    /// events did not carry a status, so they remain terminal by default.
    #[serde(default = "default_file_change_status")]
    pub status: ToolStatus,
}

fn default_file_change_status() -> ToolStatus {
    ToolStatus::Completed
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageEvent {
    /// Additive usage for one turn. Reducers sum only this field into lifetime
    /// totals; usage repeated on terminal outcomes is informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_delta: Option<TurnUsage>,
    /// Cumulative session/context usage. Reducers replace this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_snapshot: Option<SessionUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticEvent {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Lifecycle state for a provider-neutral context compaction operation.
///
/// Compaction events are ordered on the same stream as the turn events they
/// accompany. Consumers should use the event sequence and correlation fields
/// for routing rather than treating this as a separate status channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionState {
    Active,
    Completed,
    Cleared,
}

/// Provider-neutral context compaction lifecycle metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactionEvent {
    pub state: CompactionState,
    /// Provider-independent display metadata, such as a manual or automatic
    /// trigger. Unknown future values remain round-trippable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    /// Context token count observed immediately before compaction, when the
    /// provider supplies it. This is meaningful on a completed event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<u64>,
}

/// Every event payload in the V1 neutral contract.
#[derive(Debug, Clone, PartialEq)]
pub enum HarnessEventPayloadV1 {
    SessionStarted(SessionStarted),
    ThreadDeclared(ThreadDeclared),
    TurnStarted(TurnStarted),
    TurnInput(TurnInput),
    Text(TextEvent),
    Reasoning(ReasoningEvent),
    Plan(PlanEvent),
    ToolCall(ToolCallEvent),
    ToolOutput(ToolOutputEvent),
    FileChange(FileChangeEvent),
    Usage(UsageEvent),
    Warning(DiagnosticEvent),
    Error(DiagnosticEvent),
    Compaction(CompactionEvent),
    ControlRequested(ControlRequestEnvelope),
    ControlResolved(ControlResolution),
    /// The single terminal event for an accepted interactive turn. For a
    /// handle-backed turn, its correlation contains the handle's turn id and
    /// its outcome is identical to the value returned by
    /// `TurnHandle::await_outcome`; delivery precedes readiness of that handle
    /// for every terminal status. Child turns may also use this event without
    /// having a consumer-visible handle. If a handle-backed turn's single
    /// delivery attempt fails, the handle returns the sink error instead.
    TurnFinished(TurnOutcome),
    SessionClosed(SessionCloseOutcome),
    RunFinished(RunOutcome),
    /// A future provider-neutral event type not understood by this version.
    Unknown {
        event_type: String,
        data: Value,
    },
}

impl HarnessEventPayloadV1 {
    pub fn event_type(&self) -> &str {
        match self {
            Self::SessionStarted(_) => "session_started",
            Self::ThreadDeclared(_) => "thread_declared",
            Self::TurnStarted(_) => "turn_started",
            Self::TurnInput(_) => "turn_input",
            Self::Text(_) => "text",
            Self::Reasoning(_) => "reasoning",
            Self::Plan(_) => "plan",
            Self::ToolCall(_) => "tool_call",
            Self::ToolOutput(_) => "tool_output",
            Self::FileChange(_) => "file_change",
            Self::Usage(_) => "usage",
            Self::Warning(_) => "warning",
            Self::Error(_) => "error",
            Self::Compaction(_) => "compaction",
            Self::ControlRequested(_) => "control_requested",
            Self::ControlResolved(_) => "control_resolved",
            Self::TurnFinished(_) => "turn_finished",
            Self::SessionClosed(_) => "session_closed",
            Self::RunFinished(_) => "run_finished",
            Self::Unknown { event_type, .. } => event_type,
        }
    }

    fn to_data(&self) -> Result<Value, serde_json::Error> {
        match self {
            Self::SessionStarted(value) => serde_json::to_value(value),
            Self::ThreadDeclared(value) => serde_json::to_value(value),
            Self::TurnStarted(value) => serde_json::to_value(value),
            Self::TurnInput(value) => serde_json::to_value(value),
            Self::Text(value) => serde_json::to_value(value),
            Self::Reasoning(value) => serde_json::to_value(value),
            Self::Plan(value) => serde_json::to_value(value),
            Self::ToolCall(value) => serde_json::to_value(value),
            Self::ToolOutput(value) => serde_json::to_value(value),
            Self::FileChange(value) => serde_json::to_value(value),
            Self::Usage(value) => serde_json::to_value(value),
            Self::Warning(value) => serde_json::to_value(value),
            Self::Error(value) => serde_json::to_value(value),
            Self::Compaction(value) => serde_json::to_value(value),
            Self::ControlRequested(value) => serde_json::to_value(value),
            Self::ControlResolved(value) => serde_json::to_value(value),
            Self::TurnFinished(value) => serde_json::to_value(value),
            Self::SessionClosed(value) => serde_json::to_value(value),
            Self::RunFinished(value) => serde_json::to_value(value),
            Self::Unknown { data, .. } => Ok(data.clone()),
        }
    }

    fn from_type_and_data(event_type: String, data: Value) -> Result<Self, serde_json::Error> {
        macro_rules! decode {
            ($variant:ident, $ty:ty) => {
                serde_json::from_value::<$ty>(data).map(Self::$variant)
            };
        }

        match event_type.as_str() {
            "session_started" => decode!(SessionStarted, SessionStarted),
            "thread_declared" => decode!(ThreadDeclared, ThreadDeclared),
            "turn_started" => decode!(TurnStarted, TurnStarted),
            "turn_input" => decode!(TurnInput, TurnInput),
            "text" => decode!(Text, TextEvent),
            "reasoning" => decode!(Reasoning, ReasoningEvent),
            "plan" => decode!(Plan, PlanEvent),
            "tool_call" => decode!(ToolCall, ToolCallEvent),
            "tool_output" => decode!(ToolOutput, ToolOutputEvent),
            "file_change" => decode!(FileChange, FileChangeEvent),
            "usage" => decode!(Usage, UsageEvent),
            "warning" => decode!(Warning, DiagnosticEvent),
            "error" => decode!(Error, DiagnosticEvent),
            "compaction" => decode!(Compaction, CompactionEvent),
            "control_requested" => decode!(ControlRequested, ControlRequestEnvelope),
            "control_resolved" => decode!(ControlResolved, ControlResolution),
            "turn_finished" => decode!(TurnFinished, TurnOutcome),
            "session_closed" => decode!(SessionClosed, SessionCloseOutcome),
            "run_finished" => decode!(RunFinished, RunOutcome),
            _ => Ok(Self::Unknown { event_type, data }),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HarnessEventV1 {
    pub event_id: EventId,
    pub stream_id: StreamId,
    pub sequence: u64,
    pub correlation: EventCorrelation,
    pub timestamp: DateTime<Utc>,
    pub semantics: UpdateSemantics,
    pub provider_sequence: Option<u64>,
    pub payload: HarnessEventPayloadV1,
}

#[derive(Serialize, Deserialize)]
struct WireEventV1 {
    version: u8,
    event_id: EventId,
    stream_id: StreamId,
    sequence: u64,
    #[serde(default)]
    correlation: EventCorrelation,
    timestamp: DateTime<Utc>,
    semantics: UpdateSemantics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_sequence: Option<u64>,
    #[serde(rename = "type")]
    event_type: String,
    data: Value,
}

impl Serialize for HarnessEventV1 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        WireEventV1 {
            version: 1,
            event_id: self.event_id.clone(),
            stream_id: self.stream_id.clone(),
            sequence: self.sequence,
            correlation: self.correlation.clone(),
            timestamp: self.timestamp,
            semantics: self.semantics,
            provider_sequence: self.provider_sequence,
            event_type: self.payload.event_type().to_owned(),
            data: self.payload.to_data().map_err(serde::ser::Error::custom)?,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for HarnessEventV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = WireEventV1::deserialize(deserializer)?;
        if wire.version != 1 {
            return Err(D::Error::custom(format!(
                "unsupported harness event version {}",
                wire.version
            )));
        }
        Ok(Self {
            event_id: wire.event_id,
            stream_id: wire.stream_id,
            sequence: wire.sequence,
            correlation: wire.correlation,
            timestamp: wire.timestamp,
            semantics: wire.semantics,
            provider_sequence: wire.provider_sequence,
            payload: HarnessEventPayloadV1::from_type_and_data(wire.event_type, wire.data)
                .map_err(D::Error::custom)?,
        })
    }
}

/// An event before runtime-assigned identity and ordering fields are added.
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessEventDraftV1 {
    pub stream_id: StreamId,
    pub correlation: EventCorrelation,
    pub timestamp: DateTime<Utc>,
    pub semantics: UpdateSemantics,
    pub provider_sequence: Option<u64>,
    pub payload: HarnessEventPayloadV1,
}

impl HarnessEventDraftV1 {
    pub fn new(
        stream_id: impl Into<StreamId>,
        semantics: UpdateSemantics,
        payload: HarnessEventPayloadV1,
    ) -> Self {
        Self {
            stream_id: stream_id.into(),
            correlation: EventCorrelation::default(),
            timestamp: Utc::now(),
            semantics,
            provider_sequence: None,
            payload,
        }
    }
}
