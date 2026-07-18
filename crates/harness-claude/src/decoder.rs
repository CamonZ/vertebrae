use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
};

use chrono::Utc;
use serde_json::{Map, Value};
use vertebrae_harness_core::{
    AgentMetadata, ApprovalCategory, ApprovalRequest, CompletionStatus, ControlDecision,
    ControlPresentation, ControlRequest, ControlRequestEnvelope, ControlRequestId,
    ControlResolution, DiagnosticEvent, EventCorrelation, HarnessEventDraftV1,
    HarnessEventPayloadV1, OutcomeMetrics, PlanEntry, PlanEvent, ProviderResumeId,
    ProviderThreadRef, QuestionOption, ResolutionSource, RunId, RunOutcome, SessionId,
    SessionStarted, SessionUsage, StreamId, TextEvent, ThreadDeclared, ThreadId, ThreadKind,
    TokenUsage, ToolCallEvent, ToolCallId, ToolOutputEvent, ToolStatus, TurnId, TurnInput,
    TurnInputProvenance, TurnOutcome, TurnUsage, UpdateSemantics, UsageEvent, UserQuestion,
};

use crate::ClaudeRootLocatorResolver;

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
    agent_locators: HashMap<String, ProviderThreadRef>,
    agent_spawn_tools: HashMap<String, ToolCallId>,
    provider_control_inputs: HashMap<ControlRequestId, Value>,
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
            agent_locators: HashMap::new(),
            agent_spawn_tools: HashMap::new(),
            provider_control_inputs: HashMap::new(),
        }
    }

    pub fn context_mut(&mut self) -> &mut ClaudeDecodeContext {
        &mut self.context
    }

    pub fn context(&self) -> &ClaudeDecodeContext {
        &self.context
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
        let value: Value = serde_json::from_str(line)
            .map_err(|error| ClaudeDecodeError::Malformed(error.to_string()))?;
        self.provider_sequence = self.provider_sequence.saturating_add(1);
        self.decode_value(value, self.provider_sequence)
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

        let mut drafts = self.decode_canonical_value(value, provider_sequence)?;
        drafts.extend(self.flush_resolvable_agents()?);
        Ok(drafts)
    }

    fn decode_canonical_value(
        &mut self,
        value: Value,
        provider_sequence: u64,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        self.provider_sequence = provider_sequence;
        let object = value.as_object().expect("validated Claude record object");
        let record_type = string(object, "type").expect("validated Claude record type");
        let parent_tool_call = string(object, "parent_tool_use_id").map(ToolCallId::new);
        let agent_id = string(object, "agent_id")
            .or_else(|| string(object, "agentId"))
            .map(str::to_owned);
        let (thread_id, stream_id, declaration) =
            self.resolve_thread(object, agent_id.as_deref(), parent_tool_call.as_ref());
        let mut drafts = Vec::new();
        if let Some(declaration) = declaration {
            let spawn = declaration
                .caused_by_tool_call_id
                .clone()
                .and_then(|id| self.spawn_tools.get(&id).cloned());
            drafts.push(self.draft(
                stream_id.clone(),
                &thread_id,
                parent_tool_call.clone(),
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::ThreadDeclared(declaration),
            ));
            if let Some(prompt) = spawn.and_then(|spawn| spawn.prompt) {
                drafts.push(self.draft(
                    stream_id.clone(),
                    &thread_id,
                    parent_tool_call.clone(),
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::TurnInput(TurnInput {
                        thread_id: thread_id.clone(),
                        run_id: self.context.run_id.clone(),
                        content: prompt,
                        provenance: TurnInputProvenance::Agent,
                    }),
                ));
            }
        }

        match record_type {
            "system" if string(object, "subtype") == Some("init") => {
                let conversation_id = string(object, "session_id")
                    .or_else(|| string(object, "uuid"))
                    .unwrap_or(self.context.root_thread_id.as_str())
                    .to_owned();
                let session_id = SessionId::new(conversation_id.clone());
                self.context.session_id = Some(session_id.clone());
                self.context.root_thread_id = ThreadId::new(conversation_id.clone());
                self.context.provider_resume_id = Some(ProviderResumeId::new(conversation_id));
                self.root_declared = true;
                let root = self.context.root_thread_id.clone();
                let root_stream = self.context.root_stream_id.clone();
                drafts.push(self.draft(
                    root_stream.clone(),
                    &root,
                    None,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::SessionStarted(SessionStarted {
                        provider: "anthropic".into(),
                        model: string(object, "model").map(str::to_owned),
                        provider_resume_id: self.context.provider_resume_id.clone(),
                        tools: claude_init_tools(object),
                    }),
                ));
                if self.declared_threads.insert(root.clone()) {
                    drafts.push(self.draft(
                        root_stream,
                        &root,
                        None,
                        UpdateSemantics::Snapshot,
                        HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
                            thread_id: root.clone(),
                            parent_thread_id: None,
                            kind: ThreadKind::Root,
                            caused_by_tool_call_id: None,
                            provider_thread_ref: self.root_locator.clone(),
                            agent_metadata: None,
                        }),
                    ));
                }
            }
            "stream_event" => {
                let event = object
                    .get("event")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        ClaudeDecodeError::Malformed(
                            "stream_event has no nested event object".into(),
                        )
                    })?;
                self.decode_stream_event(
                    event,
                    &thread_id,
                    &stream_id,
                    parent_tool_call,
                    &mut drafts,
                )?;
            }
            "content_block_delta" => {
                self.decode_delta(
                    object.get("delta").and_then(Value::as_object),
                    &thread_id,
                    &stream_id,
                    parent_tool_call,
                    &mut drafts,
                )?;
            }
            "assistant" => self.decode_message(
                object,
                true,
                &thread_id,
                &stream_id,
                parent_tool_call,
                &mut drafts,
            )?,
            "user" => self.decode_message(
                object,
                false,
                &thread_id,
                &stream_id,
                parent_tool_call,
                &mut drafts,
            )?,
            "result" => self.decode_result(
                object,
                &thread_id,
                &stream_id,
                parent_tool_call,
                &mut drafts,
            ),
            "control_request" => {
                let control = decode_control_request(object, &self.context)?;
                if let Some(input) = object
                    .get("request")
                    .and_then(Value::as_object)
                    .and_then(|request| request.get("input"))
                    .cloned()
                {
                    self.provider_control_inputs
                        .insert(control.request_id.clone(), input);
                }
                drafts.push(self.draft(
                    stream_id,
                    &thread_id,
                    parent_tool_call,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::ControlRequested(control),
                ));
            }
            "control_cancel_request" => {
                let request_id = string(object, "request_id").ok_or_else(|| {
                    ClaudeDecodeError::Malformed("control_cancel_request has no request_id".into())
                })?;
                let request_id = ControlRequestId::new(request_id);
                self.provider_control_inputs.remove(&request_id);
                drafts.push(self.draft(
                    stream_id,
                    &thread_id,
                    parent_tool_call,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::ControlResolved(ControlResolution {
                        request_id,
                        source: ResolutionSource::Provider,
                        decision: Some(ControlDecision::Cancel),
                        message: Some("Claude cancelled the control request".into()),
                    }),
                ));
            }
            "system" if string(object, "subtype") == Some("task_progress") => {
                if let Some(description) = string(object, "description") {
                    drafts.push(self.draft(
                        stream_id,
                        &thread_id,
                        parent_tool_call,
                        UpdateSemantics::Snapshot,
                        HarnessEventPayloadV1::Plan(PlanEvent {
                            entries: vec![PlanEntry {
                                id: string(object, "task_id").unwrap_or("task").into(),
                                text: description.into(),
                                status: string(object, "status").map(str::to_owned),
                            }],
                        }),
                    ));
                }
            }
            // Claude emits several system telemetry/status records during a
            // normal turn. They are provider protocol, not user-facing
            // diagnostics; only the explicitly modeled init/task progress
            // records above produce normalized events.
            "system" => {}
            "rate_limit_event" => {
                if let Some(message) = rate_limit_failure_message(object) {
                    drafts.push(self.draft(
                        stream_id,
                        &thread_id,
                        parent_tool_call,
                        UpdateSemantics::Snapshot,
                        HarnessEventPayloadV1::Error(DiagnosticEvent {
                            message,
                            code: Some("claude_rate_limited".into()),
                        }),
                    ));
                }
            }
            "content_block_start" | "content_block_stop" | "message_start" | "message_stop" => {}
            unknown => drafts.push(self.draft(
                stream_id,
                &thread_id,
                parent_tool_call,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!("ignored unknown Claude stream-json record type: {unknown}"),
                    code: Some("claude_unknown_record".into()),
                }),
            )),
        }
        Ok(drafts)
    }

    fn should_buffer_root(
        &mut self,
        object: &Map<String, Value>,
    ) -> Result<bool, ClaudeDecodeError> {
        if self.root_declared {
            return Ok(false);
        }
        let is_init =
            string(object, "type") == Some("system") && string(object, "subtype") == Some("init");
        if is_init {
            let conversation_id = string(object, "session_id")
                .or_else(|| string(object, "uuid"))
                .ok_or_else(|| {
                    ClaudeDecodeError::Malformed(
                        "Claude init has no canonical session_id or uuid".into(),
                    )
                })?
                .to_owned();
            let session_id = SessionId::new(conversation_id.clone());
            self.context.session_id = Some(session_id.clone());
            self.context.root_thread_id = ThreadId::new(conversation_id.clone());
            self.context.provider_resume_id = Some(ProviderResumeId::new(conversation_id));
            self.root_init_seen = true;
            self.root_locator = provider_thread_ref(object).or_else(|| self.root_locator.clone());
            if self.root_locator.is_none()
                && let Some(resolver) = &self.root_locator_resolver
            {
                self.root_locator = resolver
                    .resolve(&session_id)
                    .map_err(ClaudeDecodeError::RootLocator)?;
            }
            return Ok(true);
        }
        if self.root_init_seen {
            if let Some(locator) = provider_thread_ref(object) {
                self.root_locator = Some(locator);
            }
            return Ok(true);
        }
        Ok(false)
    }

    fn buffer_root_record(
        &mut self,
        value: Value,
        provider_sequence: u64,
    ) -> Result<(), ClaudeDecodeError> {
        if self.pending_root_records.len() >= MAX_PENDING_ROOT_RECORDS {
            return Err(ClaudeDecodeError::RootLocator(format!(
                "unresolved-root buffer exceeded {MAX_PENDING_ROOT_RECORDS} records"
            )));
        }
        self.pending_root_records.push_back(BufferedRootRecord {
            value,
            provider_sequence,
        });
        Ok(())
    }

    fn flush_root_records(&mut self) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        if self.root_locator.is_none() || !self.root_init_seen {
            return Ok(Vec::new());
        }
        let mut records = self.pending_root_records.drain(..).collect::<Vec<_>>();
        records.sort_by_key(|record| record.provider_sequence);
        let mut drafts = Vec::new();
        for record in records {
            drafts.extend(self.decode_canonical_value(record.value, record.provider_sequence)?);
        }
        Ok(drafts)
    }

    fn agent_is_resolvable(&self, agent_id: &str) -> bool {
        let Some(spawn_id) = self.agent_spawn_tools.get(agent_id) else {
            return false;
        };
        self.agent_locators.contains_key(agent_id) && self.spawn_tools.contains_key(spawn_id)
    }

    fn buffer_agent_record(
        &mut self,
        value: Value,
        provider_sequence: u64,
        agent_id: String,
    ) -> Vec<HarnessEventDraftV1> {
        let mut drafts = Vec::new();
        if self.pending_agent_records.len() >= MAX_PENDING_AGENT_RECORDS {
            self.pending_agent_records.pop_front();
            let root = self.context.root_thread_id.clone();
            drafts.push(self.draft(
                self.context.root_stream_id.clone(),
                &root,
                None,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!(
                        "Claude unresolved-agent buffer exceeded {MAX_PENDING_AGENT_RECORDS} records; oldest record was discarded"
                    ),
                    code: Some("claude_agent_buffer_overflow".into()),
                }),
            ));
        }
        self.pending_agent_records.push_back(BufferedAgentRecord {
            value,
            provider_sequence,
            agent_id,
        });
        drafts
    }

    fn flush_resolvable_agents(&mut self) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        let agents = self
            .pending_agent_records
            .iter()
            .map(|record| record.agent_id.clone())
            .filter(|agent_id| self.agent_is_resolvable(agent_id))
            .collect::<HashSet<_>>();
        let mut drafts = Vec::new();
        for agent_id in agents {
            drafts.extend(self.flush_agent(&agent_id)?);
        }
        Ok(drafts)
    }

    fn flush_agent(
        &mut self,
        agent_id: &str,
    ) -> Result<Vec<HarnessEventDraftV1>, ClaudeDecodeError> {
        if !self.agent_is_resolvable(agent_id) {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        self.pending_agent_records.retain(|record| {
            if record.agent_id == agent_id {
                records.push(record.clone());
                false
            } else {
                true
            }
        });
        records.sort_by_key(|record| record.provider_sequence);
        let mut drafts = Vec::new();
        for record in records {
            drafts.extend(self.decode_canonical_value(record.value, record.provider_sequence)?);
        }
        Ok(drafts)
    }

    pub fn unresolved_agent_diagnostics(&mut self) -> Vec<HarnessEventDraftV1> {
        if self.pending_agent_records.is_empty() {
            return Vec::new();
        }
        let count = self.pending_agent_records.len();
        self.pending_agent_records.clear();
        let root = self.context.root_thread_id.clone();
        vec![self.draft(
            self.context.root_stream_id.clone(),
            &root,
            None,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Warning(DiagnosticEvent {
                message: format!("discarded {count} unresolved Claude agent record(s) without canonical spawn lineage and provider locator"),
                code: Some("claude_unresolved_agent".into()),
            }),
        )]
    }

    pub fn unresolved_diagnostics(&mut self) -> Vec<HarnessEventDraftV1> {
        let mut drafts = Vec::new();
        if !self.pending_root_records.is_empty() {
            let count = self.pending_root_records.len();
            self.pending_root_records.clear();
            let root = self.context.root_thread_id.clone();
            drafts.push(self.draft(
                self.context.root_stream_id.clone(),
                &root,
                None,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!(
                        "discarded {count} Claude root record(s) without a canonical provider locator"
                    ),
                    code: Some("claude_unresolved_root_locator".into()),
                }),
            ));
        }
        drafts.extend(self.unresolved_agent_diagnostics());
        drafts
    }

    fn resolve_thread(
        &mut self,
        object: &Map<String, Value>,
        agent_id: Option<&str>,
        parent_tool_call: Option<&ToolCallId>,
    ) -> (ThreadId, StreamId, Option<ThreadDeclared>) {
        let Some(agent_id) = agent_id else {
            return (
                self.context.root_thread_id.clone(),
                self.context.root_stream_id.clone(),
                None,
            );
        };
        let thread_id = self
            .agent_threads
            .entry(agent_id.to_owned())
            .or_insert_with(|| ThreadId::new(agent_id))
            .clone();
        let stream_id = StreamId::new(format!(
            "{}/agent/{agent_id}",
            self.context.root_stream_id.as_str()
        ));
        if !self.declared_threads.insert(thread_id.clone()) {
            return (thread_id, stream_id, None);
        }
        let spawn_id = self
            .agent_spawn_tools
            .get(agent_id)
            .or(parent_tool_call)
            .expect("resolvable agent has spawn id");
        let spawn = self
            .spawn_tools
            .get(spawn_id)
            .expect("resolvable agent has spawn record");
        let parent_thread_id = spawn.parent_thread_id.clone();
        let metadata = if spawn.metadata != AgentMetadata::default() {
            Some(spawn.metadata.clone())
        } else {
            Some(agent_metadata(object)).filter(|metadata| metadata != &AgentMetadata::default())
        };
        (
            thread_id.clone(),
            stream_id,
            Some(ThreadDeclared {
                thread_id,
                parent_thread_id: Some(parent_thread_id),
                kind: ThreadKind::Subagent,
                caused_by_tool_call_id: Some(spawn.tool_call_id.clone()),
                provider_thread_ref: self.agent_locators.get(agent_id).cloned(),
                agent_metadata: metadata,
            }),
        )
    }

    fn decode_stream_event(
        &self,
        event: &Map<String, Value>,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        match string(event, "type") {
            Some("content_block_delta") => self.decode_delta(
                event.get("delta").and_then(Value::as_object),
                thread_id,
                stream_id,
                parent,
                drafts,
            )?,
            Some("message_delta") => {
                if let Some(usage) = event.get("usage") {
                    let usage = usage.as_object().ok_or_else(|| {
                        ClaudeDecodeError::Malformed("message_delta usage is not an object".into())
                    })?;
                    drafts.push(self.usage_draft(stream_id.clone(), thread_id, parent, usage));
                }
            }
            Some(
                "message_start"
                | "message_stop"
                | "content_block_start"
                | "content_block_stop"
                | "ping",
            ) => {}
            Some("error") => {
                let message = event
                    .get("error")
                    .and_then(Value::as_object)
                    .and_then(|error| string(error, "message"))
                    .ok_or_else(|| {
                        ClaudeDecodeError::Malformed(
                            "nested error event has no error message".into(),
                        )
                    })?;
                drafts.push(self.draft(
                    stream_id.clone(),
                    thread_id,
                    parent,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::Error(DiagnosticEvent {
                        message: message.into(),
                        code: Some("claude_stream_error".into()),
                    }),
                ));
            }
            Some(unknown) => drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                parent,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Warning(DiagnosticEvent {
                    message: format!("ignored unknown Claude nested stream event type: {unknown}"),
                    code: Some("claude_unknown_stream_event".into()),
                }),
            )),
            None => {
                return Err(ClaudeDecodeError::Malformed(
                    "nested stream event has no string type".into(),
                ));
            }
        }
        Ok(())
    }

    fn decode_delta(
        &self,
        delta: Option<&Map<String, Value>>,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        let delta = delta.ok_or_else(|| {
            ClaudeDecodeError::Malformed("content_block_delta has no delta object".into())
        })?;
        let payload = match string(delta, "type") {
            Some("thinking_delta") => {
                let text = string(delta, "thinking").ok_or_else(|| {
                    ClaudeDecodeError::Malformed("thinking_delta has no thinking text".into())
                })?;
                HarnessEventPayloadV1::Reasoning(vertebrae_harness_core::ReasoningEvent {
                    text: text.into(),
                })
            }
            Some("text_delta") => {
                let text = string(delta, "text")
                    .ok_or_else(|| ClaudeDecodeError::Malformed("text_delta has no text".into()))?;
                HarnessEventPayloadV1::Text(TextEvent { text: text.into() })
            }
            Some("signature_delta") => return Ok(()),
            Some(unknown) => {
                drafts.push(self.draft(
                    stream_id.clone(),
                    thread_id,
                    parent,
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::Warning(DiagnosticEvent {
                        message: format!("ignored unknown Claude content delta type: {unknown}"),
                        code: Some("claude_unknown_content_delta".into()),
                    }),
                ));
                return Ok(());
            }
            None => {
                return Err(ClaudeDecodeError::Malformed(
                    "content delta has no string type".into(),
                ));
            }
        };
        drafts.push(self.draft(
            stream_id.clone(),
            thread_id,
            parent,
            UpdateSemantics::Delta,
            payload,
        ));
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn decode_message(
        &mut self,
        record: &Map<String, Value>,
        assistant: bool,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        let message = record
            .get("message")
            .ok_or_else(|| ClaudeDecodeError::Malformed("message record has no message".into()))?
            .as_object()
            .ok_or_else(|| {
                ClaudeDecodeError::Malformed("message record message is not an object".into())
            })?;
        if assistant && let Some(usage) = message.get("usage") {
            let usage = usage.as_object().ok_or_else(|| {
                ClaudeDecodeError::Malformed("assistant message usage is not an object".into())
            })?;
            drafts.push(self.usage_draft(stream_id.clone(), thread_id, parent.clone(), usage));
        }
        let content = message
            .get("content")
            .ok_or_else(|| ClaudeDecodeError::Malformed("message has no content".into()))?
            .as_array()
            .ok_or_else(|| {
                ClaudeDecodeError::Malformed("message content is not an array".into())
            })?;
        for (index, item) in content.iter().enumerate() {
            let item = item.as_object().ok_or_else(|| {
                ClaudeDecodeError::Malformed(format!(
                    "message content block {} is not an object",
                    index + 1
                ))
            })?;
            let block_type = required_nonempty_string(item, "type", "message content block")?;
            match block_type {
                "text" => {
                    let text = required_string(item, "text", "text content block")?;
                    if assistant {
                        drafts.push(self.draft(
                            stream_id.clone(),
                            thread_id,
                            parent.clone(),
                            UpdateSemantics::Snapshot,
                            HarnessEventPayloadV1::Text(TextEvent { text: text.into() }),
                        ));
                    }
                }
                "thinking" => {
                    let text = required_string(item, "thinking", "thinking content block")?;
                    if assistant {
                        drafts.push(self.draft(
                            stream_id.clone(),
                            thread_id,
                            parent.clone(),
                            UpdateSemantics::Snapshot,
                            HarnessEventPayloadV1::Reasoning(
                                vertebrae_harness_core::ReasoningEvent { text: text.into() },
                            ),
                        ));
                    }
                }
                "tool_use" | "server_tool_use" => {
                    let id = required_nonempty_string(item, "id", "tool_use content block")?;
                    let name = required_nonempty_string(item, "name", "tool_use content block")?;
                    let input = item.get("input").cloned().ok_or_else(|| {
                        ClaudeDecodeError::Malformed("tool_use content block has no input".into())
                    })?;
                    if assistant {
                        self.decode_tool_use(
                            id,
                            name,
                            input,
                            thread_id,
                            stream_id,
                            parent.clone(),
                            drafts,
                        )?;
                    }
                }
                "tool_result"
                | "web_search_tool_result"
                | "web_fetch_tool_result"
                | "code_execution_tool_result"
                | "bash_code_execution_tool_result"
                | "text_editor_code_execution_tool_result"
                | "tool_search_tool_result" => {
                    let id =
                        required_nonempty_string(item, "tool_use_id", "tool_result content block")?;
                    let output = item.get("content").cloned().ok_or_else(|| {
                        ClaudeDecodeError::Malformed(
                            "tool_result content block has no content".into(),
                        )
                    })?;
                    let failed = optional_bool(item, "is_error", "tool_result content block")?
                        .unwrap_or(false);
                    if !assistant {
                        drafts.push(self.draft(
                            stream_id.clone(),
                            thread_id,
                            parent.clone(),
                            UpdateSemantics::Snapshot,
                            HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                                tool_call_id: ToolCallId::new(id),
                                output,
                                status: if failed {
                                    ToolStatus::Failed
                                } else {
                                    ToolStatus::Completed
                                },
                                content_semantics: UpdateSemantics::Snapshot,
                            }),
                        ));
                    }
                }
                // Opaque or non-text user content is valid but has no neutral
                // live event in this adapter. Validate its stable outer shape
                // and ignore it deliberately rather than treating it as new.
                "redacted_thinking" => {
                    required_string(item, "data", "redacted_thinking content block")?;
                }
                "image" | "document" => {
                    item.get("source")
                        .and_then(Value::as_object)
                        .ok_or_else(|| {
                            ClaudeDecodeError::Malformed(format!(
                                "{block_type} content block has no source object"
                            ))
                        })?;
                }
                unknown => drafts.push(self.draft(
                    stream_id.clone(),
                    thread_id,
                    parent.clone(),
                    UpdateSemantics::Snapshot,
                    HarnessEventPayloadV1::Warning(DiagnosticEvent {
                        message: format!(
                            "ignored unknown Claude message content block type: {unknown}"
                        ),
                        code: Some("claude_unknown_content_block".into()),
                    }),
                )),
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn decode_tool_use(
        &mut self,
        id: &str,
        name: &str,
        input: Value,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) -> Result<(), ClaudeDecodeError> {
        let tool_call_id = ToolCallId::new(id);
        if is_spawn_tool(name) {
            self.spawn_tools.insert(
                tool_call_id.clone(),
                SpawnInfo {
                    parent_thread_id: thread_id.clone(),
                    tool_call_id: tool_call_id.clone(),
                    prompt: input
                        .get("prompt")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    metadata: AgentMetadata {
                        name: input
                            .get("name")
                            .or_else(|| input.get("subagent_type"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        role: input
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        model: input
                            .get("model")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                },
            );
        }
        drafts.push(self.draft(
            stream_id.clone(),
            thread_id,
            parent.clone(),
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::ToolCall(ToolCallEvent {
                tool_call_id: tool_call_id.clone(),
                name: name.into(),
                input: input.clone(),
                status: ToolStatus::Started,
            }),
        ));
        if name == "TodoWrite"
            && let Some(todos) = input.get("todos")
        {
            let todos = todos.as_array().ok_or_else(|| {
                ClaudeDecodeError::Malformed("TodoWrite todos is not an array".into())
            })?;
            let mut entries = Vec::with_capacity(todos.len());
            for (index, todo) in todos.iter().enumerate() {
                let todo = todo.as_object().ok_or_else(|| {
                    ClaudeDecodeError::Malformed(format!(
                        "TodoWrite item {} is not an object",
                        index + 1
                    ))
                })?;
                let text = todo
                    .get("content")
                    .or_else(|| todo.get("text"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ClaudeDecodeError::Malformed(format!(
                            "TodoWrite item {} has no text",
                            index + 1
                        ))
                    })?;
                entries.push(PlanEntry {
                    id: todo
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| index.to_string()),
                    text: text.into(),
                    status: todo
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
            drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                parent,
                UpdateSemantics::Snapshot,
                HarnessEventPayloadV1::Plan(PlanEvent { entries }),
            ));
        }
        Ok(())
    }

    fn decode_result(
        &self,
        object: &Map<String, Value>,
        thread_id: &ThreadId,
        stream_id: &StreamId,
        parent: Option<ToolCallId>,
        drafts: &mut Vec<HarnessEventDraftV1>,
    ) {
        let total_cost_usd = object
            .get("total_cost_usd")
            .or_else(|| object.get("cost_usd"))
            .and_then(Value::as_f64);
        let mut usage = object
            .get("usage")
            .and_then(Value::as_object)
            .map(turn_usage);
        if let Some(usage) = &mut usage {
            usage.cost_microusd = total_cost_usd
                .map(|cost| (cost * 1_000_000.0).round() as u64)
                .unwrap_or(usage.cost_microusd);
        }
        if let Some(usage) = &usage {
            drafts.push(self.draft(
                stream_id.clone(),
                thread_id,
                parent.clone(),
                UpdateSemantics::Delta,
                HarnessEventPayloadV1::Usage(UsageEvent {
                    turn_delta: Some(usage.clone()),
                    session_snapshot: None,
                }),
            ));
        }
        let failed = object
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || matches!(string(object, "subtype"), Some("error"));
        let status = if failed {
            CompletionStatus::Failed
        } else {
            CompletionStatus::Completed
        };
        let result_text = string(object, "result").map(str::to_owned);
        let structured_output = object.get("structured_output").cloned();
        let metrics = OutcomeMetrics {
            duration_ms: object.get("duration_ms").and_then(Value::as_u64),
            turn_count: object.get("num_turns").and_then(Value::as_u64),
            // Claude's result record carries cumulative model usage. As in the
            // legacy GUI parser, only its maximum context window is meaningful;
            // terminal context tokens are explicitly zero.
            context_tokens: Some(0),
            context_window: Some(result_context_window(object)),
            total_cost_usd,
        };
        let error = failed.then(|| {
            result_text
                .clone()
                .unwrap_or_else(|| "Claude run failed".into())
        });
        let payload = if self.context.run_id.is_some() {
            HarnessEventPayloadV1::RunFinished(RunOutcome {
                status,
                result_text,
                structured_output,
                usage,
                metrics,
                error,
            })
        } else {
            HarnessEventPayloadV1::TurnFinished(TurnOutcome {
                status,
                result_text,
                structured_output,
                usage,
                metrics,
                error,
            })
        };
        drafts.push(self.draft(
            stream_id.clone(),
            thread_id,
            parent,
            UpdateSemantics::Snapshot,
            payload,
        ));
    }

    fn usage_draft(
        &self,
        stream_id: StreamId,
        thread_id: &ThreadId,
        parent: Option<ToolCallId>,
        usage: &Map<String, Value>,
    ) -> HarnessEventDraftV1 {
        let turn = turn_usage(usage);
        let context_tokens = turn
            .tokens
            .input_tokens
            .saturating_add(turn.tokens.cached_input_tokens);
        self.draft(
            stream_id,
            thread_id,
            parent,
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Usage(UsageEvent {
                turn_delta: None,
                session_snapshot: Some(SessionUsage {
                    tokens: turn.tokens,
                    cost_microusd: turn.cost_microusd,
                    context_tokens: Some(context_tokens),
                    context_window: Some(DEFAULT_CONTEXT_WINDOW),
                }),
            }),
        )
    }

    fn draft(
        &self,
        stream_id: StreamId,
        thread_id: &ThreadId,
        parent_tool_call_id: Option<ToolCallId>,
        semantics: UpdateSemantics,
        payload: HarnessEventPayloadV1,
    ) -> HarnessEventDraftV1 {
        HarnessEventDraftV1 {
            stream_id,
            correlation: EventCorrelation {
                session_id: if self.root_declared {
                    self.context.session_id.clone()
                } else {
                    None
                },
                thread_id: self.root_declared.then(|| thread_id.clone()),
                turn_id: self.context.turn_id.clone(),
                run_id: self.context.run_id.clone(),
                parent_tool_call_id,
                provider_resume_id: if self.root_declared {
                    self.context.provider_resume_id.clone()
                } else {
                    None
                },
                ..EventCorrelation::default()
            },
            timestamp: Utc::now(),
            semantics,
            provider_sequence: Some(self.provider_sequence),
            payload,
        }
    }
}

fn result_context_window(object: &Map<String, Value>) -> u64 {
    object
        .get("modelUsage")
        .or_else(|| object.get("model_usage"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|usage| usage.values())
        .filter_map(|usage| {
            usage
                .get("contextWindow")
                .or_else(|| usage.get("context_window"))
                .and_then(Value::as_u64)
        })
        .max()
        .unwrap_or(DEFAULT_CONTEXT_WINDOW)
}

fn claude_init_tools(object: &Map<String, Value>) -> Vec<String> {
    object
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            tool.as_str()
                .or_else(|| tool.get("name").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .collect()
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn rate_limit_failure_message(object: &Map<String, Value>) -> Option<String> {
    let info = object.get("rate_limit_info").and_then(Value::as_object);
    let status = info
        .and_then(|info| string(info, "status"))
        .or_else(|| string(object, "status"));
    let message = string(object, "message")
        .or_else(|| string(object, "reason"))
        .or_else(|| {
            object
                .get("error")
                .and_then(Value::as_object)
                .and_then(|error| string(error, "message"))
        })
        .or_else(|| info.and_then(|info| string(info, "message")));
    let message_is_rate_limit = message.is_some_and(|message| {
        let message = message.to_ascii_lowercase();
        message.contains("rate limit")
            || message.contains("rate_limit")
            || message.contains("too many requests")
    });
    let status_is_failure = status.is_some_and(|status| {
        !matches!(
            status.to_ascii_lowercase().as_str(),
            "allowed" | "ok" | "available" | "active"
        )
    });
    if !message_is_rate_limit && !status_is_failure {
        return None;
    }
    Some(
        message
            .map(str::to_owned)
            .or_else(|| status.map(|status| format!("Claude rate limit status: {status}")))
            .unwrap_or_else(|| "Claude rate limit reached".into()),
    )
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<&'a str, ClaudeDecodeError> {
    object
        .get(key)
        .ok_or_else(|| ClaudeDecodeError::Malformed(format!("{context} has no {key}")))?
        .as_str()
        .ok_or_else(|| ClaudeDecodeError::Malformed(format!("{context} {key} is not a string")))
}

fn required_nonempty_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<&'a str, ClaudeDecodeError> {
    let value = required_string(object, key, context)?;
    if value.trim().is_empty() {
        Err(ClaudeDecodeError::Malformed(format!(
            "{context} {key} is empty"
        )))
    } else {
        Ok(value)
    }
}

fn optional_bool(
    object: &Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<Option<bool>, ClaudeDecodeError> {
    object
        .get(key)
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                ClaudeDecodeError::Malformed(format!("{context} {key} is not a boolean"))
            })
        })
        .transpose()
}

fn provider_thread_ref(object: &Map<String, Value>) -> Option<ProviderThreadRef> {
    ["provider_thread_ref", "transcript_path", "transcriptPath"]
        .iter()
        .find_map(|key| string(object, key))
        .map(ProviderThreadRef::new)
}

fn agent_metadata(object: &Map<String, Value>) -> AgentMetadata {
    AgentMetadata {
        name: string(object, "agent_name").map(str::to_owned),
        role: string(object, "agent_role").map(str::to_owned),
        model: string(object, "model").map(str::to_owned),
    }
}

fn is_spawn_tool(name: &str) -> bool {
    matches!(name, "Task" | "Agent" | "TaskCreate")
}

fn u64_field(object: &Map<String, Value>, key: &str) -> u64 {
    object.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn turn_usage(object: &Map<String, Value>) -> TurnUsage {
    let input = u64_field(object, "input_tokens");
    let cache_read = u64_field(object, "cache_read_input_tokens");
    let cache_create = u64_field(object, "cache_creation_input_tokens");
    TurnUsage {
        tokens: TokenUsage {
            input_tokens: input,
            cached_input_tokens: cache_read.saturating_add(cache_create),
            output_tokens: u64_field(object, "output_tokens"),
            reasoning_tokens: u64_field(object, "thinking_tokens"),
        },
        cost_microusd: object
            .get("cost_usd")
            .and_then(Value::as_f64)
            .map(|cost| (cost * 1_000_000.0).round() as u64)
            .unwrap_or(0),
    }
}

fn decode_control_request(
    object: &Map<String, Value>,
    context: &ClaudeDecodeContext,
) -> Result<ControlRequestEnvelope, ClaudeDecodeError> {
    let request_id = string(object, "request_id")
        .ok_or_else(|| ClaudeDecodeError::Malformed("control_request has no request_id".into()))?;
    let request = object
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ClaudeDecodeError::Malformed("control_request has no request object".into())
        })?;
    let subtype = string(request, "subtype").unwrap_or("unknown");
    let tool_name = string(request, "tool_name").unwrap_or("Claude tool");
    let raw_input = request.get("input").cloned();
    let tool_call_id = string(request, "tool_use_id").map(ToolCallId::new);
    let control_request = if subtype == "can_use_tool" && tool_name == "AskUserQuestion" {
        ControlRequest::UserQuestion {
            questions: decode_user_questions(request)?,
        }
    } else {
        let category = match tool_name {
            "Bash" | "Shell" => ApprovalCategory::CommandExecution,
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => ApprovalCategory::FileChange,
            "WebFetch" | "WebSearch" => ApprovalCategory::NetworkAccess,
            _ => ApprovalCategory::AdditionalPermission,
        };
        ControlRequest::Approval(ApprovalRequest {
            category,
            title: if subtype == "can_use_tool" {
                format!("Allow Claude to use {tool_name}?")
            } else {
                format!("Claude control request: {subtype}")
            },
            details: Some(Value::Object(request.clone())),
            modification_supported: subtype == "can_use_tool",
        })
    };
    Ok(ControlRequestEnvelope {
        request_id: ControlRequestId::new(request_id),
        session_id: context.session_id.clone(),
        turn_id: context.turn_id.clone(),
        request: control_request,
        presentation: Some(ControlPresentation {
            tool_name: Some(tool_name.to_owned()),
            tool_call_id,
            input: raw_input,
            message: Some(format!("{tool_name} needs approval")),
        }),
        timeout_ms: object.get("timeout_ms").and_then(Value::as_u64),
        automatic_resolution: None,
    })
}

fn decode_user_questions(
    request: &Map<String, Value>,
) -> Result<Vec<UserQuestion>, ClaudeDecodeError> {
    let questions = request
        .get("input")
        .and_then(Value::as_object)
        .and_then(|input| input.get("questions"))
        .and_then(Value::as_array)
        .filter(|questions| !questions.is_empty())
        .ok_or_else(|| {
            ClaudeDecodeError::Malformed(
                "AskUserQuestion control input has no non-empty questions array".into(),
            )
        })?;
    questions
        .iter()
        .enumerate()
        .map(|(question_index, question)| {
            let question = question.as_object().ok_or_else(|| {
                ClaudeDecodeError::Malformed(format!(
                    "AskUserQuestion question {} is not an object",
                    question_index + 1
                ))
            })?;
            let prompt = string(question, "question")
                .filter(|prompt| !prompt.trim().is_empty())
                .ok_or_else(|| {
                    ClaudeDecodeError::Malformed(format!(
                        "AskUserQuestion question {} has no text",
                        question_index + 1
                    ))
                })?
                .to_owned();
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ClaudeDecodeError::Malformed(format!(
                        "AskUserQuestion question {} has no options array",
                        question_index + 1
                    ))
                })?
                .iter()
                .enumerate()
                .map(|(option_index, option)| {
                    let option = option.as_object().ok_or_else(|| {
                        ClaudeDecodeError::Malformed(format!(
                            "AskUserQuestion question {} option {} is not an object",
                            question_index + 1,
                            option_index + 1
                        ))
                    })?;
                    let label = string(option, "label")
                        .filter(|label| !label.trim().is_empty())
                        .ok_or_else(|| {
                            ClaudeDecodeError::Malformed(format!(
                                "AskUserQuestion question {} option {} has no label",
                                question_index + 1,
                                option_index + 1
                            ))
                        })?
                        .to_owned();
                    Ok(QuestionOption {
                        id: label.clone(),
                        label,
                        description: string(option, "description").map(str::to_owned),
                    })
                })
                .collect::<Result<Vec<_>, ClaudeDecodeError>>()?;
            let multiple = match question.get("multiSelect") {
                Some(value) => value.as_bool().ok_or_else(|| {
                    ClaudeDecodeError::Malformed(format!(
                        "AskUserQuestion question {} has non-boolean multiSelect",
                        question_index + 1
                    ))
                })?,
                None => false,
            };
            Ok(UserQuestion {
                id: prompt.clone(),
                prompt,
                header: string(question, "header").map(str::to_owned),
                options,
                multiple,
                free_form: true,
            })
        })
        .collect()
}
