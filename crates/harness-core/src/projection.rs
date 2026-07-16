use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde_json::Value;

use crate::{
    CompletionStatus, ControlDecision, ControlRequestEnvelope, ControlRequestId, ControlResolution,
    DiagnosticEvent, EventId, FileChange, HarnessEventPayloadV1, HarnessEventV1, PlanEntry,
    ProviderResumeId, ResolutionSource, RunId, RunOutcome, SessionCloseOutcome, SessionCloseStatus,
    SessionId, SessionStarted, SessionUsage, StreamId, ThreadDeclared, ThreadId, ThreadKind,
    ToolCallEvent, ToolCallId, ToolOutputEvent, TurnId, TurnInput, TurnOutcome, TurnStarted,
    TurnUsage, UpdateSemantics,
};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolProjection {
    pub call: Option<ToolCallEvent>,
    pub output_deltas: Vec<Value>,
    pub output_snapshot: Option<ToolOutputEvent>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnProjection {
    pub started: Option<TurnStarted>,
    pub inputs: Vec<TurnInput>,
    pub text: String,
    pub reasoning: String,
    pub usage: TurnUsage,
    pub outcome: Option<TurnOutcome>,
}

/// Logical thread metadata projected independently of event delivery streams.
/// Event bodies remain in `StreamProjection`; consumers select the listed
/// streams rather than nesting a child transcript into its parent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ThreadProjection {
    pub declaration: Option<ThreadDeclared>,
    pub session_id: Option<SessionId>,
    pub stream_ids: BTreeSet<StreamId>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UnknownEventRecord {
    pub event_id: EventId,
    pub event_type: String,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreamProjection {
    pub next_sequence: u64,
    /// Stable interactive session bound to this delivery stream.
    pub session_id: Option<SessionId>,
    /// Stable logical thread bound to this delivery stream.
    pub thread_id: Option<ThreadId>,
    /// Stable one-shot run bound to this delivery stream.
    pub run_id: Option<RunId>,
    pub session: Option<SessionStarted>,
    pub provider_resume_id: Option<ProviderResumeId>,
    pub turn_inputs: Vec<TurnInput>,
    pub text: String,
    pub reasoning: String,
    pub plan: Vec<PlanEntry>,
    pub turns: BTreeMap<TurnId, TurnProjection>,
    pub tools: BTreeMap<ToolCallId, ToolProjection>,
    pub file_changes: Vec<FileChange>,
    pub turn_usage_total: TurnUsage,
    pub session_usage: Option<SessionUsage>,
    pub warnings: Vec<DiagnosticEvent>,
    pub errors: Vec<DiagnosticEvent>,
    pub pending_controls: BTreeMap<ControlRequestId, ControlRequestEnvelope>,
    pub resolved_controls: BTreeMap<ControlRequestId, ControlResolution>,
    pub turn_outcomes: BTreeMap<TurnId, TurnOutcome>,
    /// Canonical one-shot outcomes keyed by their durable run identity.
    pub run_outcomes: BTreeMap<RunId, RunOutcome>,
    /// Compatibility/latest view for callers written before run correlation.
    /// New consumers should read `run_outcomes`.
    pub run_outcome: Option<RunOutcome>,
    pub session_close_outcome: Option<SessionCloseOutcome>,
    pub unknown_events: Vec<UnknownEventRecord>,
}

impl Default for StreamProjection {
    fn default() -> Self {
        Self {
            next_sequence: 1,
            session_id: None,
            thread_id: None,
            run_id: None,
            session: None,
            provider_resume_id: None,
            turn_inputs: Vec::new(),
            text: String::new(),
            reasoning: String::new(),
            plan: Vec::new(),
            turns: BTreeMap::new(),
            tools: BTreeMap::new(),
            file_changes: Vec::new(),
            turn_usage_total: TurnUsage::default(),
            session_usage: None,
            warnings: Vec::new(),
            errors: Vec::new(),
            pending_controls: BTreeMap::new(),
            resolved_controls: BTreeMap::new(),
            turn_outcomes: BTreeMap::new(),
            run_outcomes: BTreeMap::new(),
            run_outcome: None,
            session_close_outcome: None,
            unknown_events: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionDiagnostic {
    GapDetected {
        stream_id: StreamId,
        expected: u64,
        received: u64,
    },
    DuplicateEventIgnored {
        event_id: EventId,
    },
    StaleSequenceIgnored {
        stream_id: StreamId,
        expected: u64,
        received: u64,
    },
    SequenceConflictIgnored {
        stream_id: StreamId,
        sequence: u64,
    },
    StreamSessionConflict {
        event_id: EventId,
        stream_id: StreamId,
        expected: SessionId,
        received: SessionId,
    },
    StreamThreadConflict {
        event_id: EventId,
        stream_id: StreamId,
        expected: ThreadId,
        received: ThreadId,
    },
    StreamRunConflict {
        event_id: EventId,
        stream_id: StreamId,
        expected: RunId,
        received: Option<RunId>,
    },
    TurnInputThreadCorrelationConflict {
        event_id: EventId,
        payload_thread_id: ThreadId,
        correlation_thread_id: ThreadId,
    },
    TurnInputRunCorrelationConflict {
        event_id: EventId,
        payload_run_id: Option<RunId>,
        correlation_run_id: RunId,
    },
    ThreadDeclaredCorrelationConflict {
        event_id: EventId,
        payload_thread_id: ThreadId,
        correlation_thread_id: ThreadId,
    },
    InvalidThreadDeclaration {
        event_id: EventId,
        thread_id: ThreadId,
        violation: ThreadDeclarationViolation,
    },
    ThreadDeclarationConflict {
        event_id: EventId,
        thread_id: ThreadId,
    },
    ThreadSessionConflict {
        event_id: EventId,
        thread_id: ThreadId,
        expected: SessionId,
        received: SessionId,
    },
    ThreadLineageSessionConflict {
        event_id: EventId,
        parent_thread_id: ThreadId,
        child_thread_id: ThreadId,
        parent_session_id: SessionId,
        child_session_id: SessionId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadDeclarationViolation {
    RootHasParent,
    RootHasCausingToolCall,
    SubagentMissingParent,
    SelfParent,
    LineageCycle,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectionUpdate {
    pub applied_event_ids: Vec<EventId>,
    /// Sequenced events consumed but excluded from canonical state after an
    /// identity or declaration diagnostic.
    pub ignored_event_ids: Vec<EventId>,
    pub diagnostics: Vec<ProjectionDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProjectionError {
    #[error("projection gap buffer for stream {stream_id} exceeded capacity {capacity}")]
    ProjectionOverflow {
        stream_id: StreamId,
        capacity: usize,
    },
}

#[derive(Debug, Clone)]
struct EventIdentity {
    session_id: Option<SessionId>,
    thread_id: Option<ThreadId>,
    run_id: Option<RunId>,
}

/// Pure, multi-stream ordered reducer for live delivery and replay.
#[derive(Debug, Clone)]
pub struct HarnessProjection {
    streams: BTreeMap<StreamId, StreamProjection>,
    threads: BTreeMap<ThreadId, ThreadProjection>,
    seen_event_ids: HashSet<EventId>,
    buffered: BTreeMap<StreamId, BTreeMap<u64, HarnessEventV1>>,
    buffer_capacity: usize,
}

impl HarnessProjection {
    pub fn new(buffer_capacity: usize) -> Self {
        Self {
            streams: BTreeMap::new(),
            threads: BTreeMap::new(),
            seen_event_ids: HashSet::new(),
            buffered: BTreeMap::new(),
            buffer_capacity,
        }
    }

    pub fn stream(&self, stream_id: &StreamId) -> Option<&StreamProjection> {
        self.streams.get(stream_id)
    }

    pub fn streams(&self) -> &BTreeMap<StreamId, StreamProjection> {
        &self.streams
    }

    pub fn thread(&self, thread_id: &ThreadId) -> Option<&ThreadProjection> {
        self.threads.get(thread_id)
    }

    pub fn threads(&self) -> &BTreeMap<ThreadId, ThreadProjection> {
        &self.threads
    }

    pub fn buffered_len(&self, stream_id: &StreamId) -> usize {
        self.buffered.get(stream_id).map_or(0, BTreeMap::len)
    }

    fn declaration_closes_cycle(&self, declaration: &ThreadDeclared) -> bool {
        let Some(parent_thread_id) = &declaration.parent_thread_id else {
            return false;
        };
        let mut cursor = Some(parent_thread_id.clone());
        let mut visited = HashSet::new();
        while let Some(thread_id) = cursor {
            if thread_id == declaration.thread_id {
                return true;
            }
            if !visited.insert(thread_id.clone()) {
                return true;
            }
            cursor = self
                .threads
                .get(&thread_id)
                .and_then(|thread| thread.declaration.as_ref())
                .and_then(|parent| parent.parent_thread_id.clone());
        }
        false
    }

    pub fn ingest(&mut self, event: HarnessEventV1) -> Result<ProjectionUpdate, ProjectionError> {
        let mut update = ProjectionUpdate::default();

        if self.seen_event_ids.contains(&event.event_id) {
            update
                .diagnostics
                .push(ProjectionDiagnostic::DuplicateEventIgnored {
                    event_id: event.event_id,
                });
            return Ok(update);
        }

        let expected = self
            .streams
            .get(&event.stream_id)
            .map_or(1, |stream| stream.next_sequence);

        if event.sequence < expected {
            self.seen_event_ids.insert(event.event_id.clone());
            update
                .diagnostics
                .push(ProjectionDiagnostic::StaleSequenceIgnored {
                    stream_id: event.stream_id,
                    expected,
                    received: event.sequence,
                });
            return Ok(update);
        }

        if event.sequence > expected {
            let buffer = self.buffered.entry(event.stream_id.clone()).or_default();
            if buffer.contains_key(&event.sequence) {
                self.seen_event_ids.insert(event.event_id);
                update
                    .diagnostics
                    .push(ProjectionDiagnostic::SequenceConflictIgnored {
                        stream_id: event.stream_id,
                        sequence: event.sequence,
                    });
                return Ok(update);
            }
            if buffer.len() >= self.buffer_capacity {
                return Err(ProjectionError::ProjectionOverflow {
                    stream_id: event.stream_id,
                    capacity: self.buffer_capacity,
                });
            }
            self.seen_event_ids.insert(event.event_id.clone());
            let stream_id = event.stream_id.clone();
            let received = event.sequence;
            buffer.insert(event.sequence, event);
            update.diagnostics.push(ProjectionDiagnostic::GapDetected {
                stream_id,
                expected,
                received,
            });
            return Ok(update);
        }

        let stream_id = event.stream_id.clone();
        self.seen_event_ids.insert(event.event_id.clone());
        self.apply(event, &mut update);

        loop {
            let expected = self
                .streams
                .get(&stream_id)
                .map_or(1, |stream| stream.next_sequence);
            let next = self
                .buffered
                .get_mut(&stream_id)
                .and_then(|buffer| buffer.remove(&expected));
            let Some(next) = next else {
                break;
            };
            self.apply(next, &mut update);
        }

        Ok(update)
    }

    fn validate_event_identity(
        &self,
        event: &HarnessEventV1,
        update: &mut ProjectionUpdate,
    ) -> Option<EventIdentity> {
        let mut valid = true;
        let mut identity = EventIdentity {
            session_id: event.correlation.session_id.clone(),
            thread_id: event.correlation.thread_id.clone(),
            run_id: event.correlation.run_id.clone(),
        };

        match &event.payload {
            HarnessEventPayloadV1::TurnInput(input) => {
                if let Some(correlation_thread_id) = &event.correlation.thread_id
                    && correlation_thread_id != &input.thread_id
                {
                    valid = false;
                    update.diagnostics.push(
                        ProjectionDiagnostic::TurnInputThreadCorrelationConflict {
                            event_id: event.event_id.clone(),
                            payload_thread_id: input.thread_id.clone(),
                            correlation_thread_id: correlation_thread_id.clone(),
                        },
                    );
                }
                if let Some(correlation_run_id) = &event.correlation.run_id
                    && input.run_id.as_ref() != Some(correlation_run_id)
                {
                    valid = false;
                    update.diagnostics.push(
                        ProjectionDiagnostic::TurnInputRunCorrelationConflict {
                            event_id: event.event_id.clone(),
                            payload_run_id: input.run_id.clone(),
                            correlation_run_id: correlation_run_id.clone(),
                        },
                    );
                }
                identity.thread_id = Some(input.thread_id.clone());
                identity.run_id = input.run_id.clone();
            }
            HarnessEventPayloadV1::ThreadDeclared(declaration) => {
                if let Some(correlation_thread_id) = &event.correlation.thread_id
                    && correlation_thread_id != &declaration.thread_id
                {
                    valid = false;
                    update.diagnostics.push(
                        ProjectionDiagnostic::ThreadDeclaredCorrelationConflict {
                            event_id: event.event_id.clone(),
                            payload_thread_id: declaration.thread_id.clone(),
                            correlation_thread_id: correlation_thread_id.clone(),
                        },
                    );
                }
                identity.thread_id = Some(declaration.thread_id.clone());

                match declaration.kind {
                    ThreadKind::Root => {
                        if declaration.parent_thread_id.is_some() {
                            valid = false;
                            update.diagnostics.push(
                                ProjectionDiagnostic::InvalidThreadDeclaration {
                                    event_id: event.event_id.clone(),
                                    thread_id: declaration.thread_id.clone(),
                                    violation: ThreadDeclarationViolation::RootHasParent,
                                },
                            );
                        }
                        if declaration.caused_by_tool_call_id.is_some() {
                            valid = false;
                            update.diagnostics.push(
                                ProjectionDiagnostic::InvalidThreadDeclaration {
                                    event_id: event.event_id.clone(),
                                    thread_id: declaration.thread_id.clone(),
                                    violation: ThreadDeclarationViolation::RootHasCausingToolCall,
                                },
                            );
                        }
                    }
                    ThreadKind::Subagent if declaration.parent_thread_id.is_none() => {
                        valid = false;
                        update
                            .diagnostics
                            .push(ProjectionDiagnostic::InvalidThreadDeclaration {
                                event_id: event.event_id.clone(),
                                thread_id: declaration.thread_id.clone(),
                                violation: ThreadDeclarationViolation::SubagentMissingParent,
                            });
                    }
                    ThreadKind::Subagent => {}
                }
                if declaration.parent_thread_id.as_ref() == Some(&declaration.thread_id) {
                    valid = false;
                    update
                        .diagnostics
                        .push(ProjectionDiagnostic::InvalidThreadDeclaration {
                            event_id: event.event_id.clone(),
                            thread_id: declaration.thread_id.clone(),
                            violation: ThreadDeclarationViolation::SelfParent,
                        });
                } else if self.declaration_closes_cycle(declaration) {
                    valid = false;
                    update
                        .diagnostics
                        .push(ProjectionDiagnostic::InvalidThreadDeclaration {
                            event_id: event.event_id.clone(),
                            thread_id: declaration.thread_id.clone(),
                            violation: ThreadDeclarationViolation::LineageCycle,
                        });
                }
            }
            _ => {}
        }

        if let Some(stream) = self.streams.get(&event.stream_id) {
            if let (Some(expected), Some(received)) = (&stream.session_id, &identity.session_id)
                && expected != received
            {
                valid = false;
                update
                    .diagnostics
                    .push(ProjectionDiagnostic::StreamSessionConflict {
                        event_id: event.event_id.clone(),
                        stream_id: event.stream_id.clone(),
                        expected: expected.clone(),
                        received: received.clone(),
                    });
            }
            if let (Some(expected), Some(received)) = (&stream.thread_id, &identity.thread_id)
                && expected != received
            {
                valid = false;
                update
                    .diagnostics
                    .push(ProjectionDiagnostic::StreamThreadConflict {
                        event_id: event.event_id.clone(),
                        stream_id: event.stream_id.clone(),
                        expected: expected.clone(),
                        received: received.clone(),
                    });
            }
            if let Some(expected) = &stream.run_id {
                let received = match &event.payload {
                    HarnessEventPayloadV1::TurnInput(input) => Some(input.run_id.clone()),
                    _ => identity.run_id.as_ref().map(|run_id| Some(run_id.clone())),
                };
                if let Some(received) = received
                    && received.as_ref() != Some(expected)
                {
                    valid = false;
                    update
                        .diagnostics
                        .push(ProjectionDiagnostic::StreamRunConflict {
                            event_id: event.event_id.clone(),
                            stream_id: event.stream_id.clone(),
                            expected: expected.clone(),
                            received,
                        });
                }
            }

            // Once a stream is bound, omitted routing metadata inherits that
            // binding. Explicit disagreement is still rejected above.
            if identity.session_id.is_none() {
                identity.session_id = stream.session_id.clone();
            }
            if identity.thread_id.is_none() {
                identity.thread_id = stream.thread_id.clone();
            }
            if identity.run_id.is_none() {
                identity.run_id = stream.run_id.clone();
            }
        }

        if let HarnessEventPayloadV1::ThreadDeclared(declaration) = &event.payload
            && let Some(declaration_session_id) = &identity.session_id
        {
            if let Some(parent_thread_id) = &declaration.parent_thread_id
                && let Some(parent) = self.threads.get(parent_thread_id)
                && let Some(parent_session_id) = &parent.session_id
                && parent_session_id != declaration_session_id
            {
                valid = false;
                update
                    .diagnostics
                    .push(ProjectionDiagnostic::ThreadLineageSessionConflict {
                        event_id: event.event_id.clone(),
                        parent_thread_id: parent_thread_id.clone(),
                        child_thread_id: declaration.thread_id.clone(),
                        parent_session_id: parent_session_id.clone(),
                        child_session_id: declaration_session_id.clone(),
                    });
            }

            for (child_thread_id, child) in &self.threads {
                let Some(child_declaration) = &child.declaration else {
                    continue;
                };
                if child_declaration.parent_thread_id.as_ref() != Some(&declaration.thread_id) {
                    continue;
                }
                let Some(child_session_id) = &child.session_id else {
                    continue;
                };
                if child_session_id != declaration_session_id {
                    valid = false;
                    update
                        .diagnostics
                        .push(ProjectionDiagnostic::ThreadLineageSessionConflict {
                            event_id: event.event_id.clone(),
                            parent_thread_id: declaration.thread_id.clone(),
                            child_thread_id: child_thread_id.clone(),
                            parent_session_id: declaration_session_id.clone(),
                            child_session_id: child_session_id.clone(),
                        });
                }
            }
        }

        if let Some(thread_id) = &identity.thread_id
            && let Some(thread) = self.threads.get(thread_id)
        {
            if let (Some(expected), Some(received)) = (&thread.session_id, &identity.session_id)
                && expected != received
            {
                valid = false;
                update
                    .diagnostics
                    .push(ProjectionDiagnostic::ThreadSessionConflict {
                        event_id: event.event_id.clone(),
                        thread_id: thread_id.clone(),
                        expected: expected.clone(),
                        received: received.clone(),
                    });
            }
            if let HarnessEventPayloadV1::ThreadDeclared(declaration) = &event.payload
                && let Some(existing) = &thread.declaration
                && existing != declaration
            {
                valid = false;
                update
                    .diagnostics
                    .push(ProjectionDiagnostic::ThreadDeclarationConflict {
                        event_id: event.event_id.clone(),
                        thread_id: thread_id.clone(),
                    });
            }
        }

        valid.then_some(identity)
    }

    fn bind_event_identity(&mut self, event: &HarnessEventV1, identity: &EventIdentity) {
        let stream = self.streams.entry(event.stream_id.clone()).or_default();
        if stream.session_id.is_none() {
            stream.session_id = identity.session_id.clone();
        }
        if stream.thread_id.is_none() {
            stream.thread_id = identity.thread_id.clone();
        }
        if stream.run_id.is_none() {
            stream.run_id = identity.run_id.clone();
        }

        if let Some(thread_id) = &identity.thread_id {
            let thread = self.threads.entry(thread_id.clone()).or_default();
            if thread.session_id.is_none() {
                thread.session_id = identity.session_id.clone();
            }
            thread.stream_ids.insert(event.stream_id.clone());
            if let HarnessEventPayloadV1::ThreadDeclared(declaration) = &event.payload
                && thread.declaration.is_none()
            {
                thread.declaration = Some(declaration.clone());
            }
        }
    }

    fn ignore_event(&mut self, event: HarnessEventV1, update: &mut ProjectionUpdate) {
        let stream = self.streams.entry(event.stream_id).or_default();
        stream.next_sequence = event.sequence.saturating_add(1);
        update.ignored_event_ids.push(event.event_id);
    }

    fn apply(&mut self, event: HarnessEventV1, update: &mut ProjectionUpdate) {
        let event_id = event.event_id.clone();
        let stream_id = event.stream_id.clone();
        let semantics = event.semantics;
        let turn_id = event.correlation.turn_id.clone();
        let Some(identity) = self.validate_event_identity(&event, update) else {
            self.ignore_event(event, update);
            return;
        };
        let run_id = identity.run_id.clone();
        self.bind_event_identity(&event, &identity);

        let stream = self.streams.entry(stream_id).or_default();

        match event.payload {
            HarnessEventPayloadV1::SessionStarted(started) => {
                stream.provider_resume_id = started.provider_resume_id.clone();
                stream.session = Some(started);
            }
            HarnessEventPayloadV1::ThreadDeclared(_) => {}
            HarnessEventPayloadV1::TurnStarted(started) => {
                if let Some(turn_id) = turn_id {
                    stream.turns.entry(turn_id).or_default().started = Some(started);
                }
            }
            HarnessEventPayloadV1::TurnInput(input) => {
                let inputs = if let Some(turn_id) = turn_id {
                    &mut stream.turns.entry(turn_id).or_default().inputs
                } else {
                    &mut stream.turn_inputs
                };
                match semantics {
                    UpdateSemantics::Delta => inputs.push(input),
                    UpdateSemantics::Snapshot => *inputs = vec![input],
                }
            }
            HarnessEventPayloadV1::Text(text) => {
                let target = text_target(stream, turn_id.as_ref(), false);
                apply_text(target, text.text, semantics);
            }
            HarnessEventPayloadV1::Reasoning(reasoning) => {
                let target = text_target(stream, turn_id.as_ref(), true);
                apply_text(target, reasoning.text, semantics);
            }
            HarnessEventPayloadV1::Plan(plan) => match semantics {
                UpdateSemantics::Delta => stream.plan.extend(plan.entries),
                UpdateSemantics::Snapshot => stream.plan = plan.entries,
            },
            HarnessEventPayloadV1::ToolCall(call) => {
                let tool = stream.tools.entry(call.tool_call_id.clone()).or_default();
                match (&mut tool.call, semantics) {
                    (Some(current), UpdateSemantics::Delta) => {
                        merge_value(&mut current.input, call.input);
                        current.name = call.name;
                        current.status = call.status;
                    }
                    _ => tool.call = Some(call),
                }
            }
            HarnessEventPayloadV1::ToolOutput(output) => {
                let tool = stream.tools.entry(output.tool_call_id.clone()).or_default();
                match output.content_semantics {
                    UpdateSemantics::Delta => tool.output_deltas.push(output.output.clone()),
                    UpdateSemantics::Snapshot => tool.output_snapshot = Some(output.clone()),
                }
                if output.status.is_terminal()
                    && output.content_semantics == UpdateSemantics::Snapshot
                {
                    tool.output_snapshot = Some(output);
                }
            }
            HarnessEventPayloadV1::FileChange(changes) => match semantics {
                UpdateSemantics::Delta => stream.file_changes.extend(changes.changes),
                UpdateSemantics::Snapshot => stream.file_changes = changes.changes,
            },
            HarnessEventPayloadV1::Usage(usage) => {
                if let Some(delta) = usage.turn_delta {
                    stream.turn_usage_total.add_assign(&delta);
                    if let Some(turn_id) = turn_id {
                        stream
                            .turns
                            .entry(turn_id)
                            .or_default()
                            .usage
                            .add_assign(&delta);
                    }
                }
                if let Some(snapshot) = usage.session_snapshot {
                    stream.session_usage = Some(snapshot);
                }
            }
            HarnessEventPayloadV1::Warning(warning) => stream.warnings.push(warning),
            HarnessEventPayloadV1::Error(error) => stream.errors.push(error),
            HarnessEventPayloadV1::ControlRequested(request) => {
                stream
                    .pending_controls
                    .insert(request.request_id.clone(), request);
            }
            HarnessEventPayloadV1::ControlResolved(resolution) => {
                stream.pending_controls.remove(&resolution.request_id);
                stream
                    .resolved_controls
                    .insert(resolution.request_id.clone(), resolution);
            }
            HarnessEventPayloadV1::TurnFinished(outcome) => {
                if let Some(turn_id) = turn_id {
                    match outcome.status {
                        CompletionStatus::Interrupted => settle_pending_controls(
                            stream,
                            Some(&turn_id),
                            ResolutionSource::Interrupted,
                            "turn interrupted before the control request resolved",
                        ),
                        CompletionStatus::Cancelled => settle_pending_controls(
                            stream,
                            Some(&turn_id),
                            ResolutionSource::Cancelled,
                            "turn cancelled before the control request resolved",
                        ),
                        CompletionStatus::Completed | CompletionStatus::Failed => {}
                    }
                    stream.turns.entry(turn_id.clone()).or_default().outcome =
                        Some(outcome.clone());
                    stream.turn_outcomes.insert(turn_id, outcome);
                }
            }
            HarnessEventPayloadV1::SessionClosed(outcome) => {
                let (source, message) = match outcome.status {
                    SessionCloseStatus::Closed => (
                        ResolutionSource::Cancelled,
                        "session closed before the control request resolved",
                    ),
                    SessionCloseStatus::ProcessLost | SessionCloseStatus::Failed => (
                        ResolutionSource::Fallback,
                        "session ended unexpectedly before the control request resolved",
                    ),
                };
                settle_pending_controls(stream, None, source, message);
                stream.session_close_outcome = Some(outcome);
            }
            HarnessEventPayloadV1::RunFinished(outcome) => {
                let (source, message) = match outcome.status {
                    CompletionStatus::Completed => (
                        ResolutionSource::Cancelled,
                        "run completed before the control request resolved",
                    ),
                    CompletionStatus::Failed => (
                        ResolutionSource::Fallback,
                        "run failed before the control request resolved",
                    ),
                    CompletionStatus::Interrupted => (
                        ResolutionSource::Interrupted,
                        "run interrupted before the control request resolved",
                    ),
                    CompletionStatus::Cancelled => (
                        ResolutionSource::Cancelled,
                        "run cancelled before the control request resolved",
                    ),
                };
                settle_pending_controls(stream, None, source, message);
                if let Some(run_id) = run_id {
                    stream.run_outcomes.insert(run_id, outcome.clone());
                }
                stream.run_outcome = Some(outcome);
            }
            HarnessEventPayloadV1::Unknown { event_type, data } => {
                stream.unknown_events.push(UnknownEventRecord {
                    event_id: event_id.clone(),
                    event_type,
                    data,
                });
            }
        }

        stream.next_sequence = event.sequence.saturating_add(1);
        update.applied_event_ids.push(event_id);
    }
}

fn settle_pending_controls(
    stream: &mut StreamProjection,
    turn_id: Option<&TurnId>,
    source: ResolutionSource,
    message: &str,
) {
    let request_ids: Vec<_> = stream
        .pending_controls
        .iter()
        .filter(|(_, request)| {
            turn_id.is_none_or(|turn_id| request.turn_id.as_ref() == Some(turn_id))
        })
        .map(|(request_id, _)| request_id.clone())
        .collect();
    for request_id in request_ids {
        let request = stream
            .pending_controls
            .remove(&request_id)
            .expect("request id came from pending controls");
        let decision = if source == ResolutionSource::Fallback {
            request.automatic_resolution
        } else {
            Some(ControlDecision::Cancel)
        };
        stream.resolved_controls.insert(
            request_id.clone(),
            ControlResolution {
                request_id,
                source,
                decision,
                message: Some(message.to_owned()),
            },
        );
    }
}

fn text_target<'a>(
    stream: &'a mut StreamProjection,
    turn_id: Option<&TurnId>,
    reasoning: bool,
) -> &'a mut String {
    if let Some(turn_id) = turn_id {
        let turn = stream.turns.entry(turn_id.clone()).or_default();
        if reasoning {
            &mut turn.reasoning
        } else {
            &mut turn.text
        }
    } else if reasoning {
        &mut stream.reasoning
    } else {
        &mut stream.text
    }
}

fn apply_text(target: &mut String, value: String, semantics: UpdateSemantics) {
    match semantics {
        UpdateSemantics::Delta => target.push_str(&value),
        UpdateSemantics::Snapshot => *target = value,
    }
}

fn merge_value(target: &mut Value, incoming: Value) {
    match (target, incoming) {
        (Value::String(target), Value::String(incoming)) => target.push_str(&incoming),
        (Value::Array(target), Value::Array(incoming)) => target.extend(incoming),
        (Value::Object(target), Value::Object(incoming)) => {
            for (key, value) in incoming {
                match target.get_mut(&key) {
                    Some(current) => merge_value(current, value),
                    None => {
                        target.insert(key, value);
                    }
                }
            }
        }
        (target, incoming) => *target = incoming,
    }
}
