use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::{
    CompletionStatus, ControlDecision, ControlRequestEnvelope, ControlRequestId, ControlResolution,
    DiagnosticEvent, EventId, FileChange, HarnessEventPayloadV1, HarnessEventV1, PlanEntry,
    ProviderResumeId, ResolutionSource, RunOutcome, SessionCloseOutcome, SessionCloseStatus,
    SessionStarted, SessionUsage, StreamId, ToolCallEvent, ToolCallId, ToolOutputEvent, TurnId,
    TurnOutcome, TurnStarted, TurnUsage, UpdateSemantics,
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
    pub text: String,
    pub reasoning: String,
    pub usage: TurnUsage,
    pub outcome: Option<TurnOutcome>,
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
    pub session: Option<SessionStarted>,
    pub provider_resume_id: Option<ProviderResumeId>,
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
    pub run_outcome: Option<RunOutcome>,
    pub session_close_outcome: Option<SessionCloseOutcome>,
    pub unknown_events: Vec<UnknownEventRecord>,
}

impl Default for StreamProjection {
    fn default() -> Self {
        Self {
            next_sequence: 1,
            session: None,
            provider_resume_id: None,
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
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectionUpdate {
    pub applied_event_ids: Vec<EventId>,
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

/// Pure, multi-stream ordered reducer for live delivery and replay.
#[derive(Debug, Clone)]
pub struct HarnessProjection {
    streams: BTreeMap<StreamId, StreamProjection>,
    seen_event_ids: HashSet<EventId>,
    buffered: BTreeMap<StreamId, BTreeMap<u64, HarnessEventV1>>,
    buffer_capacity: usize,
}

impl HarnessProjection {
    pub fn new(buffer_capacity: usize) -> Self {
        Self {
            streams: BTreeMap::new(),
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

    pub fn buffered_len(&self, stream_id: &StreamId) -> usize {
        self.buffered.get(stream_id).map_or(0, BTreeMap::len)
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

    fn apply(&mut self, event: HarnessEventV1, update: &mut ProjectionUpdate) {
        let event_id = event.event_id.clone();
        let stream_id = event.stream_id.clone();
        let semantics = event.semantics;
        let turn_id = event.correlation.turn_id.clone();
        let stream = self.streams.entry(stream_id).or_default();

        match event.payload {
            HarnessEventPayloadV1::SessionStarted(started) => {
                stream.provider_resume_id = started.provider_resume_id.clone();
                stream.session = Some(started);
            }
            HarnessEventPayloadV1::TurnStarted(started) => {
                if let Some(turn_id) = turn_id {
                    stream.turns.entry(turn_id).or_default().started = Some(started);
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
