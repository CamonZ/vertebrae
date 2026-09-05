use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use vertebrae_harness_core::{
    AgentMetadata, ControlRequestId, FileChange, HarnessEventDraftV1, ItemId, ProviderResumeId,
    ProviderThreadRef, RunId, SessionId, SpeedTier, StreamId, ThreadId, ToolCallId, TurnId,
    TurnStarted,
};

use crate::ClaudeRootLocatorResolver;

mod controls;
mod drafts;
mod lineage;
mod messages;
mod outcomes;
mod records;

use drafts::{provider_thread_ref, string};

const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;
const MAX_PENDING_AGENT_RECORDS: usize = 128;
const MAX_PENDING_ROOT_RECORDS: usize = 128;

#[derive(Debug, Clone)]
pub struct ClaudeDecodeContext {
    pub session_id: Option<SessionId>,
    pub root_thread_id: ThreadId,
    pub root_stream_id: StreamId,
    pub turn_id: Option<TurnId>,
    pub run_id: Option<RunId>,
    pub provider_resume_id: Option<ProviderResumeId>,
    pub requested_speed_tier: Option<SpeedTier>,
}

impl ClaudeDecodeContext {
    pub fn interactive(session_id: SessionId, stream_id: StreamId) -> Self {
        Self {
            root_thread_id: ThreadId::new(session_id.as_str()),
            session_id: Some(session_id),
            root_stream_id: stream_id,
            turn_id: None,
            run_id: None,
            provider_resume_id: None,
            requested_speed_tier: None,
        }
    }

    pub fn one_shot(run_id: RunId, stream_id: StreamId) -> Self {
        Self {
            root_thread_id: ThreadId::new(run_id.as_str()),
            session_id: None,
            root_stream_id: stream_id,
            turn_id: None,
            run_id: Some(run_id),
            provider_resume_id: None,
            requested_speed_tier: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ClaudeDecodeError {
    #[error("malformed Claude stream-json record: {0}")]
    Malformed(String),
    #[error("failed to resolve canonical Claude root locator: {0}")]
    RootLocator(String),
}

#[derive(Debug, Clone)]
struct SpawnInfo {
    parent_thread_id: ThreadId,
    tool_call_id: ToolCallId,
    prompt: Option<String>,
    metadata: AgentMetadata,
}

#[derive(Debug, Clone)]
struct BufferedAgentRecord {
    value: Value,
    provider_sequence: u64,
    agent_id: String,
}

#[derive(Debug, Clone)]
struct BufferedRootRecord {
    value: Value,
    provider_sequence: u64,
}

/// Stateful live decoder. State is scoped to one process invocation so spawn
/// tool calls can be resolved into immediate child lineage without GUI state.
pub struct ClaudeStreamDecoder {
    context: ClaudeDecodeContext,
    declared_threads: HashSet<ThreadId>,
    spawn_tools: HashMap<ToolCallId, SpawnInfo>,
    agent_threads: HashMap<String, ThreadId>,
    provider_sequence: u64,
    root_declared: bool,
    root_init_seen: bool,
    root_locator: Option<ProviderThreadRef>,
    root_locator_resolver: Option<Arc<dyn ClaudeRootLocatorResolver>>,
    pending_root_records: VecDeque<BufferedRootRecord>,
    pending_agent_records: VecDeque<BufferedAgentRecord>,
    pending_background_turn: Option<TurnId>,
    agent_locators: HashMap<String, ProviderThreadRef>,
    agent_spawn_tools: HashMap<String, ToolCallId>,
    provider_control_inputs: HashMap<ControlRequestId, Value>,
    pending_file_changes: HashMap<ToolCallId, Vec<FileChange>>,
    compaction_active: bool,
    compaction_boundary_emitted: bool,
    event_timestamp: Option<DateTime<Utc>>,
    fast_mode_state: Option<String>,
    current_item_id: Option<ItemId>,
}

impl ClaudeStreamDecoder {
    pub fn new(context: ClaudeDecodeContext) -> Self {
        Self::with_root_locator_resolver(context, None)
    }

    pub fn with_root_locator_resolver(
        context: ClaudeDecodeContext,
        root_locator_resolver: Option<Arc<dyn ClaudeRootLocatorResolver>>,
    ) -> Self {
        Self {
            context,
            declared_threads: HashSet::new(),
            spawn_tools: HashMap::new(),
            agent_threads: HashMap::new(),
            provider_sequence: 0,
            root_declared: false,
            root_init_seen: false,
            root_locator: None,
            root_locator_resolver,
            pending_root_records: VecDeque::new(),
            pending_agent_records: VecDeque::new(),
            pending_background_turn: None,
            agent_locators: HashMap::new(),
            agent_spawn_tools: HashMap::new(),
            provider_control_inputs: HashMap::new(),
            pending_file_changes: HashMap::new(),
            compaction_active: false,
            compaction_boundary_emitted: false,
            event_timestamp: None,
            fast_mode_state: None,
            current_item_id: None,
        }
    }

    pub fn context_mut(&mut self) -> &mut ClaudeDecodeContext {
        &mut self.context
    }

    pub fn context(&self) -> &ClaudeDecodeContext {
        &self.context
    }

    /// A task-notification continuation is provider-owned work that can begin
    /// after the interactive turn has settled. A real user turn takes
    /// precedence if it starts before that continuation produces content.
    pub(crate) fn clear_pending_background_turn(&mut self) {
        self.pending_background_turn = None;
    }

    /// Seed the canonical root identity for a bounded durable tail. The init
    /// record is necessarily outside that window, but replay requests already
    /// carry its durable session identity and validated transcript locator.
    pub fn prepare_bounded_replay_tail(&mut self, locator: ProviderThreadRef) {
        self.root_init_seen = true;
        self.root_declared = true;
        self.root_locator = Some(locator);
        self.declared_threads
            .insert(self.context.root_thread_id.clone());
    }

    pub fn root_declared(&self) -> bool {
        self.root_declared
    }

    pub fn take_provider_control_input(&mut self, request_id: &ControlRequestId) -> Option<Value> {
        self.provider_control_inputs.remove(request_id)
    }

    /// Supplies a canonical locator discovered after Claude's init record.
    /// A declaration already emitted is immutable and cannot be amended.
    pub fn resolve_root_locator(
        &mut self,
        locator: ProviderThreadRef,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        if self.root_declared {
            return match self.root_locator.as_ref() {
                Some(existing) if existing == &locator => Ok(Vec::new()),
                _ => Err(ClaudeDecodeError::RootLocator(
                    "root thread was already declared with a different locator".into(),
                )),
            };
        }
        self.root_locator = Some(locator);
        if self.root_init_seen {
            let mut drafts = self.flush_root_records()?;
            drafts.extend(self.flush_resolvable_agents()?);
            Ok(drafts)
        } else {
            Ok(Vec::new())
        }
    }

    pub fn decode_line(
        &mut self,
        line: &str,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        self.decode_line_at(line, Utc::now())
    }

    /// Decode one transcript line while preserving its durable timestamp.
    /// Live callers use `decode_line`, which timestamps events at receipt.
    pub fn decode_line_at(
        &mut self,
        line: &str,
        timestamp: DateTime<Utc>,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        let value: Value = serde_json::from_str(line)
            .map_err(|error| ClaudeDecodeError::Malformed(error.to_string()))?;
        let provider_sequence = self.provider_sequence.saturating_add(1);
        self.decode_value_at_sequence(value, timestamp, provider_sequence)
    }

    /// Decode a pre-parsed durable record with a caller-supplied stable source
    /// position. Replay uses byte offsets so tail pages and full reads produce
    /// identical ordering without parsing each JSON line twice.
    pub fn decode_value_at_sequence(
        &mut self,
        value: Value,
        timestamp: DateTime<Utc>,
        provider_sequence: u64,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        self.provider_sequence = provider_sequence;
        self.event_timestamp = Some(timestamp);
        let result = self.decode_value(value, self.provider_sequence);
        self.event_timestamp = None;
        result
    }

    pub(crate) fn replay_user_input_draft(
        &self,
        content: String,
        timestamp: DateTime<Utc>,
    ) -> HarnessEventDraftV1 {
        let thread_id = self.context.root_thread_id.clone();
        HarnessEventDraftV1 {
            stream_id: self.context.root_stream_id.clone(),
            correlation: vertebrae_harness_core::EventCorrelation {
                session_id: self.context.session_id.clone(),
                thread_id: Some(thread_id.clone()),
                provider_resume_id: self.context.provider_resume_id.clone(),
                ..Default::default()
            },
            timestamp,
            semantics: vertebrae_harness_core::UpdateSemantics::Snapshot,
            provider_sequence: Some(self.provider_sequence),
            payload: vertebrae_harness_core::HarnessEventPayloadV1::TurnInput(
                vertebrae_harness_core::TurnInput {
                    thread_id,
                    run_id: self.context.run_id.clone(),
                    content,
                    provenance: vertebrae_harness_core::TurnInputProvenance::Human,
                },
            ),
        }
    }

    fn decode_value(
        &mut self,
        value: Value,
        provider_sequence: u64,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        let object = value
            .as_object()
            .ok_or_else(|| ClaudeDecodeError::Malformed("record is not an object".into()))?;
        string(object, "type")
            .ok_or_else(|| ClaudeDecodeError::Malformed("record has no string type".into()))?;

        let parent_tool_call = string(object, "parent_tool_use_id").map(ToolCallId::new);
        let agent_id = string(object, "agent_id")
            .or_else(|| string(object, "agentId"))
            .map(str::to_owned);
        if agent_id.is_none() && self.should_buffer_root(object)? {
            self.buffer_root_record(value, provider_sequence)?;
            if self.root_locator.is_some() {
                let mut drafts = self.flush_root_records()?;
                drafts.extend(self.flush_resolvable_agents()?);
                return Ok(drafts);
            }
            return Ok(Vec::new());
        }
        if let Some(agent_id) = &agent_id {
            if let Some(locator) = provider_thread_ref(object) {
                self.agent_locators.insert(agent_id.clone(), locator);
            }
            if let Some(parent_tool_call) = &parent_tool_call {
                self.agent_spawn_tools
                    .insert(agent_id.clone(), parent_tool_call.clone());
            }
            let thread_id = ThreadId::new(agent_id.clone());
            if !self.declared_threads.contains(&thread_id) {
                if !self.agent_is_resolvable(agent_id) {
                    return Ok(self.buffer_agent_record(
                        value,
                        provider_sequence,
                        agent_id.clone(),
                    ));
                }
                self.pending_agent_records.push_back(BufferedAgentRecord {
                    value,
                    provider_sequence,
                    agent_id: agent_id.clone(),
                });
                return self.flush_agent(agent_id);
            }
        }

        let mut drafts = self.begin_pending_background_turn(
            object,
            parent_tool_call.clone(),
            agent_id.is_none(),
        );
        drafts.extend(self.decode_canonical_value(value, provider_sequence)?);
        drafts.extend(self.flush_resolvable_agents()?);
        Ok(drafts)
    }

    fn begin_pending_background_turn(
        &mut self,
        object: &Map<String, Value>,
        parent_tool_call: Option<ToolCallId>,
        is_root: bool,
    ) -> Vec<HarnessEventDraftV1> {
        let record_type = string(object, "type");
        let begins_continuation = matches!(record_type, Some("assistant" | "stream_event"));
        if !is_root
            || !begins_continuation
            || self.context.turn_id.is_some()
            || self.context.run_id.is_some()
            || !self.root_declared
        {
            return Vec::new();
        }
        let Some(turn_id) = self.pending_background_turn.take() else {
            return Vec::new();
        };
        self.context.turn_id = Some(turn_id);
        let root_thread = self.context.root_thread_id.clone();
        vec![self.draft(
            self.context.root_stream_id.clone(),
            &root_thread,
            parent_tool_call,
            vertebrae_harness_core::UpdateSemantics::Snapshot,
            vertebrae_harness_core::HarnessEventPayloadV1::TurnStarted(TurnStarted {
                input_summary: None,
            }),
        )]
    }
}
