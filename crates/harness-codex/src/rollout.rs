//! Codex rollout JSONL record parsing and stateful normalization.
//!
//! One module owns the provider wire format: `ReplayState` tracks per-replay
//! identity/dedup state, and the `parse_*` family projects each rollout record
//! type into harness event drafts. Discovery and paging live in `replay.rs`.

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use vertebrae_harness_core::{
    AgentMetadata, CompletionStatus, EventCorrelation, FileChange, FileChangeEvent, FileChangeKind,
    HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1, ItemId, PlanEntry, PlanEvent,
    ProviderResumeId, ProviderThreadRef, SessionId, SessionStarted, StreamId, TailReadOutcome,
    TextEvent, ThreadDeclared, ThreadId, ThreadKind, ToolCallEvent, ToolCallId, ToolOutputEvent,
    ToolStatus, TranscriptReplayRequest, TranscriptTailLines, TurnInput, TurnInputProvenance,
    UpdateSemantics, record_timestamp,
};

#[derive(Debug)]
pub(crate) struct ReplayState {
    thread_id: ThreadId,
    provider_resume_id: ProviderResumeId,
    stream_id: StreamId,
    emitted_session_start_ids: HashSet<String>,
    emitted_thread: bool,
    suppressed_tool_ids: HashSet<String>,
    // Completed provider items are authoritative over legacy records with the
    // same ID, regardless of record order. Last snapshot wins deterministically.
    completed_item_sequences: HashMap<String, u64>,
}

impl ReplayState {
    pub(crate) fn new(request: &TranscriptReplayRequest) -> Self {
        Self {
            thread_id: ThreadId::new(request.provider_resume_id.as_str()),
            provider_resume_id: request.provider_resume_id.clone(),
            stream_id: request.stream_id.clone(),
            emitted_session_start_ids: HashSet::new(),
            emitted_thread: false,
            suppressed_tool_ids: HashSet::new(),
            completed_item_sequences: HashMap::new(),
        }
    }

    fn finish(&self, drafts: &mut Vec<HarnessEventDraftV1>) {
        drafts.retain(|draft| {
            let id = match &draft.payload {
                HarnessEventPayloadV1::ToolCall(call) => Some(&call.tool_call_id),
                HarnessEventPayloadV1::ToolOutput(output) => Some(&output.tool_call_id),
                HarnessEventPayloadV1::FileChange(change) => change.tool_call_id.as_ref(),
                _ => None,
            };
            id.and_then(|id| self.completed_item_sequences.get(id.as_str()))
                .is_none_or(|sequence| draft.provider_sequence == Some(*sequence))
        });
    }

    fn correlation(&self) -> EventCorrelation {
        EventCorrelation {
            session_id: Some(SessionId::new(self.provider_resume_id.as_str())),
            thread_id: Some(self.thread_id.clone()),
            provider_resume_id: Some(self.provider_resume_id.clone()),
            ..Default::default()
        }
    }

    fn draft(
        &self,
        timestamp: DateTime<Utc>,
        provider_sequence: u64,
        payload: HarnessEventPayloadV1,
    ) -> HarnessEventDraftV1 {
        HarnessEventDraftV1 {
            stream_id: self.stream_id.clone(),
            correlation: self.correlation(),
            timestamp,
            semantics: UpdateSemantics::Snapshot,
            provider_sequence: Some(provider_sequence),
            payload,
        }
    }

    fn item_draft(
        &self,
        timestamp: DateTime<Utc>,
        provider_sequence: u64,
        item_id: Option<ItemId>,
        payload: HarnessEventPayloadV1,
    ) -> HarnessEventDraftV1 {
        let mut draft = self.draft(timestamp, provider_sequence, payload);
        draft.correlation.item_id = item_id;
        draft
    }

    fn start_events(
        &mut self,
        timestamp: DateTime<Utc>,
        provider_sequence: u64,
        session_id: Option<String>,
        path: &Path,
    ) -> Vec<HarnessEventDraftV1> {
        let session_id = session_id.unwrap_or_else(|| self.provider_resume_id.to_string());
        if !self.emitted_session_start_ids.insert(session_id) {
            return Vec::new();
        }
        let mut events = vec![self.draft(
            timestamp,
            provider_sequence,
            HarnessEventPayloadV1::SessionStarted(SessionStarted {
                provider: "openai".into(),
                model: Some("codex".into()),
                provider_resume_id: Some(self.provider_resume_id.clone()),
                speed_tier_status: None,
                tools: Vec::new(),
            }),
        )];
        if !self.emitted_thread {
            self.emitted_thread = true;
            events.push(self.draft(
                timestamp,
                provider_sequence,
                HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
                    thread_id: self.thread_id.clone(),
                    parent_thread_id: None,
                    kind: ThreadKind::Root,
                    caused_by_tool_call_id: None,
                    provider_thread_ref: Some(ProviderThreadRef::new(path.to_string_lossy())),
                    agent_metadata: Some(AgentMetadata {
                        name: Some("codex".into()),
                        role: None,
                        model: Some("codex".into()),
                    }),
                }),
            ));
        }
        events
    }
}

pub(crate) fn read_rollout(
    path: &Path,
    request: &TranscriptReplayRequest,
) -> Result<Vec<HarnessEventDraftV1>, HarnessError> {
    let file = File::open(path).map_err(|error| {
        HarnessError::Operation(format!(
            "failed to open Codex transcript {}: {error}",
            path.display()
        ))
    })?;
    let mut state = ReplayState::new(request);
    let mut drafts = Vec::new();
    let mut first_timestamp = None;

    let mut reader = BufReader::new(file);
    let mut offset = 0_u64;
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let read = reader.read_until(b'\n', &mut bytes).map_err(|error| {
            HarnessError::Operation(format!(
                "failed to read Codex transcript {} at byte {offset}: {error}",
                path.display()
            ))
        })?;
        if read == 0 {
            break;
        }
        let provider_sequence = offset.saturating_add(1);
        offset = offset.saturating_add(read as u64);
        let line = std::str::from_utf8(&bytes).map_err(|error| {
            HarnessError::Operation(format!(
                "malformed UTF-8 in Codex transcript {} at byte {}: {error}",
                path.display(),
                provider_sequence - 1
            ))
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let raw: Value = serde_json::from_str(line).map_err(|error| {
            HarnessError::Operation(format!(
                "malformed Codex transcript {} at byte {}: {error}",
                path.display(),
                provider_sequence - 1
            ))
        })?;
        let timestamp = record_timestamp(&raw);
        first_timestamp.get_or_insert(timestamp);
        drafts.extend(parse_rollout_line(
            &raw,
            timestamp,
            provider_sequence,
            &mut state,
            path,
        ));
    }

    state.finish(&mut drafts);
    if !state.emitted_session_start_ids.is_empty() {
        return Ok(drafts);
    }
    let timestamp = first_timestamp.unwrap_or(DateTime::UNIX_EPOCH);
    let mut prefix = state.start_events(timestamp, 0, None, path);
    prefix.extend(drafts);
    Ok(prefix)
}

pub(crate) fn read_rollout_tail(
    path: &Path,
    request: &TranscriptReplayRequest,
    budget: usize,
) -> Result<TailReadOutcome, HarnessError> {
    let tail = TranscriptTailLines::read(path, budget, "Codex")?;
    let mut state = ReplayState::new(request);
    let mut drafts = Vec::new();
    for (provider_sequence, line) in &tail.lines {
        if line.trim().is_empty() {
            continue;
        }
        let raw: Value = serde_json::from_str(line).map_err(|error| {
            HarnessError::Operation(format!(
                "malformed Codex transcript {} at byte {}: {error}",
                path.display(),
                provider_sequence - 1
            ))
        })?;
        // Legacy calls/outputs can refer to IDs or suppression state outside
        // this window. Defer those tails to full normalization rather than
        // inventing a duplicate or orphan output at the page boundary.
        if tail.older_records_exist && is_legacy_tool_record(&raw, &state) {
            return Ok(TailReadOutcome {
                drafts: Vec::new(),
                older_records_exist: true,
                bytes_read: tail.bytes_read,
            });
        }
        let timestamp = record_timestamp(&raw);
        drafts.extend(parse_rollout_line(
            &raw,
            timestamp,
            *provider_sequence,
            &mut state,
            path,
        ));
    }
    state.finish(&mut drafts);
    if !tail.older_records_exist && state.emitted_session_start_ids.is_empty() {
        let timestamp = drafts
            .first()
            .map(|draft| draft.timestamp)
            .unwrap_or(DateTime::UNIX_EPOCH);
        let mut prefix = state.start_events(timestamp, 0, None, path);
        prefix.extend(drafts);
        drafts = prefix;
    }
    Ok(TailReadOutcome {
        drafts,
        older_records_exist: tail.older_records_exist,
        bytes_read: tail.bytes_read,
    })
}

fn parse_rollout_line(
    raw: &Value,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
    path: &Path,
) -> Vec<HarnessEventDraftV1> {
    let Some(kind) = raw.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    match kind {
        "session_meta" => {
            let payload = raw.get("payload").and_then(Value::as_object);
            let id = payload.and_then(|payload| string(payload, "id"));
            state.start_events(timestamp, provider_sequence, id, path)
        }
        "response_item" => parse_response_item(
            raw.get("payload").and_then(Value::as_object),
            timestamp,
            provider_sequence,
            state,
        ),
        "event_msg" => parse_event_msg(
            raw.get("payload").and_then(Value::as_object),
            timestamp,
            provider_sequence,
            state,
        ),
        "thread.started" => state.start_events(
            timestamp,
            provider_sequence,
            raw.get("thread_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            path,
        ),
        "item.completed" | "item.started" | "item.updated" => {
            parse_exec_item(raw, timestamp, provider_sequence, state)
        }
        "turn.failed" | "error" => {
            let message = raw
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| raw.pointer("/error/message").and_then(Value::as_str))
                .unwrap_or("Codex turn failed");
            vec![state.draft(
                timestamp,
                provider_sequence,
                HarnessEventPayloadV1::Error(vertebrae_harness_core::DiagnosticEvent {
                    message: message.to_owned(),
                    code: Some("codex_replay_error".into()),
                }),
            )]
        }
        _ => Vec::new(),
    }
}

fn parse_response_item(
    payload: Option<&Map<String, Value>>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let Some(payload) = payload else {
        return Vec::new();
    };
    let Some(kind) = string(payload, "type") else {
        return Vec::new();
    };
    match kind.as_str() {
        "message" => {
            let text = content_text(payload.get("content"));
            if text.is_empty() {
                return Vec::new();
            }
            match string(payload, "role").as_deref() {
                Some("user") => vec![state.draft(
                    timestamp,
                    provider_sequence,
                    HarnessEventPayloadV1::TurnInput(TurnInput {
                        thread_id: state.thread_id.clone(),
                        run_id: None,
                        content: text,
                        provenance: TurnInputProvenance::Human,
                    }),
                )],
                // Codex seeds every rollout with `developer` messages carrying
                // the sandbox permissions, app, plugin, and skill instructions.
                // They are provider-injected context, not model output, and
                // replaying them renders the system prompt as a first turn.
                Some("developer" | "system") => Vec::new(),
                _ => vec![state.item_draft(
                    timestamp,
                    provider_sequence,
                    string(payload, "id").map(ItemId::new),
                    HarnessEventPayloadV1::Text(TextEvent {
                        text,
                        completion_status: Some(CompletionStatus::Completed),
                    }),
                )],
            }
        }
        "reasoning" => content_text(payload.get("summary").or_else(|| payload.get("text")))
            .is_empty()
            .then(Vec::new)
            .unwrap_or_else(|| {
                vec![state.draft(
                    timestamp,
                    provider_sequence,
                    HarnessEventPayloadV1::Reasoning(vertebrae_harness_core::ReasoningEvent {
                        text: content_text(payload.get("summary").or_else(|| payload.get("text"))),
                    }),
                )]
            }),
        "function_call" => tool_call_draft(payload, timestamp, provider_sequence, state),
        "function_call_output" => tool_output_draft(payload, timestamp, provider_sequence, state),
        "custom_tool_call" => custom_tool_call_draft(payload, timestamp, provider_sequence, state),
        "custom_tool_call_output" => Vec::new(),
        _ => Vec::new(),
    }
}

fn parse_event_msg(
    payload: Option<&Map<String, Value>>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let Some(payload) = payload else {
        return Vec::new();
    };
    match string(payload, "type").as_deref() {
        Some("item_completed") => {
            completed_item_drafts(payload, timestamp, provider_sequence, state)
        }
        Some("turn_aborted") => vec![state.draft(
            timestamp,
            provider_sequence,
            HarnessEventPayloadV1::Error(vertebrae_harness_core::DiagnosticEvent {
                message: format!(
                    "Codex turn aborted: {}",
                    string(payload, "reason").unwrap_or_else(|| "unknown reason".into())
                ),
                code: Some("codex_turn_aborted".into()),
            }),
        )],
        Some("patch_apply_end") => {
            patch_apply_end_draft(payload, timestamp, provider_sequence, state)
        }
        Some("custom_tool_call") => {
            custom_tool_call_draft(payload, timestamp, provider_sequence, state)
        }
        _ => Vec::new(),
    }
}

/// Recognize only legacy tool records that need context beyond a bounded tail.
fn is_legacy_tool_record(raw: &Value, state: &ReplayState) -> bool {
    let payload = &raw["payload"];
    match raw.get("type").and_then(Value::as_str) {
        Some("response_item") => match payload.get("type").and_then(Value::as_str) {
            Some("function_call") => !matches!(
                payload.get("name").and_then(Value::as_str),
                Some("exec" | "wait" | "sleep" | "js")
            ),
            Some("function_call_output") => !payload
                .get("call_id")
                .and_then(Value::as_str)
                .is_some_and(|id| state.suppressed_tool_ids.contains(id)),
            Some("custom_tool_call") => {
                payload.get("name").and_then(Value::as_str) == Some("apply_patch")
            }
            _ => false,
        },
        Some("event_msg") => {
            payload.get("type").and_then(Value::as_str) == Some("patch_apply_end")
                || (payload.get("type").and_then(Value::as_str) == Some("custom_tool_call")
                    && payload.get("name").and_then(Value::as_str) == Some("apply_patch"))
        }
        Some("item.completed" | "item.started" | "item.updated") => matches!(
            raw.pointer("/item/type").and_then(Value::as_str),
            Some("command_execution" | "file_change" | "fileChange")
        ),
        _ => false,
    }
}

/// The rollout uses core item shapes; App Server uses client-facing shapes.
/// Translate here, then share the live projection to keep event semantics equal.
fn completed_item_drafts(
    payload: &Map<String, Value>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    use crate::runtime::projection::{file_change_event, tool_call, tool_output};

    let Some(mut item) = payload.get("item").cloned() else {
        return Vec::new();
    };
    let Some(id) = item.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return Vec::new();
    };
    match item.get("type").and_then(Value::as_str) {
        Some("CommandExecution") => {
            item["type"] = json!("commandExecution");
            if let Some(command) = item.get("command").and_then(Value::as_array) {
                let Some(arguments) = command
                    .iter()
                    .map(Value::as_str)
                    .collect::<Option<Vec<_>>>()
                else {
                    return Vec::new();
                };
                let command = shlex::try_join(arguments)
                    .unwrap_or_else(|_| "<command included NUL byte>".into());
                item["command"] = json!(command);
            }
            if let Some(cwd) = item.get("cwd").and_then(Value::as_str)
                && let Ok(url) = url::Url::parse(cwd)
                && let Ok(path) = url.to_file_path()
            {
                item["cwd"] = json!(path.to_string_lossy());
            }
        }
        Some("FileChange") => {
            item["type"] = json!("fileChange");
            if let Some(changes) = item.get("changes").and_then(Value::as_object) {
                let changes = changes
                    .iter()
                    .map(|(path, change)| {
                        let mut diff = change
                            .get("unified_diff")
                            .or_else(|| change.get("content"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        if let Some(moved) = change.get("move_path").and_then(Value::as_str) {
                            diff.push_str(&format!("\n\nMoved to: {moved}"));
                        }
                        json!({"path": path, "kind": change.get("type"), "diff": diff})
                    })
                    .collect::<Vec<_>>();
                item["changes"] = json!(changes);
            }
        }
        Some("McpToolCall") => item["type"] = json!("mcpToolCall"),
        _ => return Vec::new(),
    }
    let mut events = Vec::new();
    if let Some(change) = file_change_event(&item) {
        events.push(HarnessEventPayloadV1::FileChange(change));
    } else if let Some((tool_id, name, input, _)) = tool_call(&item) {
        events.push(HarnessEventPayloadV1::ToolCall(ToolCallEvent {
            tool_call_id: ToolCallId::new(tool_id),
            name,
            input,
            status: ToolStatus::Started,
        }));
        if let Some((tool_id, output, failed)) = tool_output(&item) {
            events.push(HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                tool_call_id: ToolCallId::new(tool_id),
                output,
                status: if failed {
                    ToolStatus::Failed
                } else {
                    ToolStatus::Completed
                },
                content_semantics: UpdateSemantics::Snapshot,
            }));
        }
    }
    if events.is_empty() {
        return Vec::new();
    }
    state
        .completed_item_sequences
        .insert(id.clone(), provider_sequence);
    events
        .into_iter()
        .map(|payload| {
            let mut draft = state.item_draft(
                timestamp,
                provider_sequence,
                Some(ItemId::new(&id)),
                payload,
            );
            draft.correlation.tool_call_id = Some(ToolCallId::new(&id));
            draft
        })
        .collect()
}

fn parse_exec_item(
    raw: &Value,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let Some(item) = raw.get("item").and_then(Value::as_object) else {
        return Vec::new();
    };
    match string(item, "type").as_deref() {
        Some("agent_message") => string(item, "text")
            .filter(|text| !text.is_empty())
            .map(|text| {
                vec![state.item_draft(
                    timestamp,
                    provider_sequence,
                    string(item, "id").map(ItemId::new),
                    HarnessEventPayloadV1::Text(TextEvent {
                        text,
                        completion_status: Some(CompletionStatus::Completed),
                    }),
                )]
            })
            .unwrap_or_default(),
        Some("reasoning") => string(item, "text")
            .filter(|text| !text.is_empty())
            .map(|text| {
                vec![state.draft(
                    timestamp,
                    provider_sequence,
                    HarnessEventPayloadV1::Reasoning(vertebrae_harness_core::ReasoningEvent {
                        text,
                    }),
                )]
            })
            .unwrap_or_default(),
        Some("command_execution") => {
            let tool_id =
                string(item, "id").unwrap_or_else(|| format!("codex-line-{provider_sequence}"));
            let command = string(item, "command").unwrap_or_default();
            vec![
                state.draft(
                    timestamp,
                    provider_sequence,
                    HarnessEventPayloadV1::ToolCall(ToolCallEvent {
                        tool_call_id: ToolCallId::new(tool_id.clone()),
                        name: "Bash".into(),
                        input: json!({"command": command}),
                        status: ToolStatus::Started,
                    }),
                ),
                state.draft(
                    timestamp,
                    provider_sequence,
                    HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                        tool_call_id: ToolCallId::new(tool_id),
                        output: Value::String(
                            string(item, "aggregated_output").unwrap_or_default(),
                        ),
                        status: if item
                            .get("exit_code")
                            .and_then(Value::as_i64)
                            .is_some_and(|code| code != 0)
                        {
                            ToolStatus::Failed
                        } else {
                            ToolStatus::Completed
                        },
                        content_semantics: UpdateSemantics::Snapshot,
                    }),
                ),
            ]
        }
        Some("file_change") | Some("fileChange") => {
            file_change_item(item, timestamp, provider_sequence, state)
        }
        Some("todo_list") => todo_list_draft(item, timestamp, provider_sequence, state),
        _ => Vec::new(),
    }
}

fn tool_call_draft(
    payload: &Map<String, Value>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let Some(tool_id) = string(payload, "call_id").or_else(|| string(payload, "id")) else {
        return Vec::new();
    };
    let name = string(payload, "name").unwrap_or_else(|| "tool".into());
    if matches!(name.as_str(), "exec" | "wait" | "sleep" | "js") {
        state.suppressed_tool_ids.insert(tool_id);
        return Vec::new();
    }
    let input = parse_json_value(payload.get("arguments")).unwrap_or_else(|| json!({}));
    let input = if name == "exec_command" {
        let mut input = input;
        if let Some(command) = input.get("cmd").cloned()
            && let Some(object) = input.as_object_mut()
        {
            object.insert("command".into(), command);
        }
        input
    } else {
        input
    };
    vec![state.draft(
        timestamp,
        provider_sequence,
        HarnessEventPayloadV1::ToolCall(ToolCallEvent {
            tool_call_id: ToolCallId::new(tool_id),
            name: if name == "exec_command" {
                "Bash".into()
            } else {
                name
            },
            input,
            status: ToolStatus::Started,
        }),
    )]
}

fn tool_output_draft(
    payload: &Map<String, Value>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let Some(tool_id) = string(payload, "call_id").or_else(|| string(payload, "id")) else {
        return Vec::new();
    };
    if state.suppressed_tool_ids.contains(&tool_id) {
        return Vec::new();
    }
    let output = payload.get("output").cloned().unwrap_or(Value::Null);
    let failed = payload
        .get("exit_code")
        .and_then(Value::as_i64)
        .is_some_and(|code| code != 0);
    vec![state.draft(
        timestamp,
        provider_sequence,
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
    )]
}

fn custom_tool_call_draft(
    payload: &Map<String, Value>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let Some(tool_id) = string(payload, "call_id").or_else(|| string(payload, "id")) else {
        return Vec::new();
    };
    let name = string(payload, "name").unwrap_or_default();
    state.suppressed_tool_ids.insert(tool_id.clone());
    if name != "apply_patch" {
        return Vec::new();
    }
    let changes = apply_patch_changes(payload.get("input").or_else(|| payload.get("arguments")));
    file_change_draft(
        changes,
        Some(ToolCallId::new(tool_id)),
        ToolStatus::Started,
        timestamp,
        provider_sequence,
        state,
    )
}

fn patch_apply_end_draft(
    payload: &Map<String, Value>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let changes = payload
        .get("changes")
        .and_then(Value::as_object)
        .map(|changes| {
            changes
                .iter()
                .filter_map(|(path, change)| {
                    let change = change.as_object()?;
                    Some(FileChange {
                        path: path.clone(),
                        kind: file_change_kind(string(change, "type").as_deref()),
                        previous_path: None,
                        patch: string(change, "unified_diff").or_else(|| string(change, "content")),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    file_change_draft(
        changes,
        string(payload, "call_id").map(ToolCallId::new),
        if payload.get("success").and_then(Value::as_bool) == Some(false) {
            ToolStatus::Failed
        } else {
            ToolStatus::Completed
        },
        timestamp,
        provider_sequence,
        state,
    )
}

fn file_change_item(
    item: &Map<String, Value>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let changes = item
        .get("changes")
        .and_then(Value::as_array)
        .map(|changes| {
            changes
                .iter()
                .filter_map(|change| {
                    let change = change.as_object()?;
                    Some(FileChange {
                        path: string(change, "path").unwrap_or_default(),
                        kind: file_change_kind(string(change, "kind").as_deref()),
                        previous_path: None,
                        patch: string(change, "diff"),
                    })
                })
                .filter(|change| !change.path.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    file_change_draft(
        changes,
        string(item, "id").map(ToolCallId::new),
        status(string(item, "status").as_deref()),
        timestamp,
        provider_sequence,
        state,
    )
}

fn todo_list_draft(
    item: &Map<String, Value>,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &mut ReplayState,
) -> Vec<HarnessEventDraftV1> {
    let Some(id) = string(item, "id") else {
        return Vec::new();
    };
    let entries = item
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            Some(PlanEntry {
                id: string(entry, "id").unwrap_or_else(|| id.clone()),
                text: string(entry, "text").unwrap_or_default(),
                status: Some(
                    if entry.get("completed").and_then(Value::as_bool) == Some(true) {
                        "completed".into()
                    } else {
                        "pending".into()
                    },
                ),
            })
        })
        .filter(|entry| !entry.text.is_empty())
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Vec::new();
    }
    vec![state.draft(
        timestamp,
        provider_sequence,
        HarnessEventPayloadV1::Plan(PlanEvent { entries }),
    )]
}

fn file_change_draft(
    changes: Vec<FileChange>,
    tool_call_id: Option<ToolCallId>,
    status: ToolStatus,
    timestamp: DateTime<Utc>,
    provider_sequence: u64,
    state: &ReplayState,
) -> Vec<HarnessEventDraftV1> {
    if changes.is_empty() {
        return Vec::new();
    }
    vec![state.draft(
        timestamp,
        provider_sequence,
        HarnessEventPayloadV1::FileChange(FileChangeEvent {
            tool_call_id,
            changes,
            status,
        }),
    )]
}

fn apply_patch_changes(input: Option<&Value>) -> Vec<FileChange> {
    let text = match input {
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
        None => return Vec::new(),
    };
    let mut changes = Vec::new();
    let mut current: Option<FileChange> = None;
    let mut patch = Vec::new();
    let finish = |current: &mut Option<FileChange>,
                  patch: &mut Vec<String>,
                  changes: &mut Vec<FileChange>| {
        if let Some(mut change) = current.take() {
            let diff = patch
                .iter()
                .filter(|line| !line.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            if !diff.is_empty() {
                change.patch = Some(diff);
            }
            changes.push(change);
            patch.clear();
        }
    };
    for line in text.lines() {
        let parsed = [
            ("*** Add File: ", FileChangeKind::Added),
            ("*** Update File: ", FileChangeKind::Modified),
            ("*** Delete File: ", FileChangeKind::Deleted),
        ]
        .iter()
        .find_map(|(prefix, kind)| line.strip_prefix(prefix).map(|path| (path, *kind)));
        if let Some((path, kind)) = parsed {
            finish(&mut current, &mut patch, &mut changes);
            current = Some(FileChange {
                path: path.to_owned(),
                kind,
                previous_path: None,
                patch: None,
            });
        } else if current.is_some()
            && (line.starts_with('+') || line.starts_with('-') || line.starts_with("@@"))
        {
            patch.push(line.to_owned());
        }
    }
    finish(&mut current, &mut patch, &mut changes);
    changes
}

fn content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let item = item.as_object()?;
                string(item, "text")
                    .or_else(|| string(item, "input_text"))
                    .or_else(|| string(item, "output_text"))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(value) => string(value.as_object().unwrap_or(&Map::new()), "text").unwrap_or_default(),
        None => String::new(),
    }
}

fn parse_json_value(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::String(text)) => serde_json::from_str(text)
            .ok()
            .or_else(|| Some(json!({"arguments": text}))),
        Some(value) => Some(value.clone()),
        None => None,
    }
}

fn string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn file_change_kind(kind: Option<&str>) -> FileChangeKind {
    match kind.unwrap_or_default().to_ascii_lowercase().as_str() {
        "add" | "added" => FileChangeKind::Added,
        "delete" | "deleted" | "remove" => FileChangeKind::Deleted,
        "rename" | "renamed" => FileChangeKind::Renamed,
        _ => FileChangeKind::Modified,
    }
}

fn status(value: Option<&str>) -> ToolStatus {
    match value.unwrap_or_default().to_ascii_lowercase().as_str() {
        "failed" | "error" => ToolStatus::Failed,
        "declined" => ToolStatus::Declined,
        "cancelled" | "canceled" => ToolStatus::Cancelled,
        "started" => ToolStatus::Started,
        "running" => ToolStatus::Running,
        _ => ToolStatus::Completed,
    }
}

#[cfg(test)]
mod tests;
