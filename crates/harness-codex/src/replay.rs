use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Map, Value, json};
use vertebrae_harness_core::{
    AgentMetadata, EventCorrelation, EventSequencer, FileChange, FileChangeEvent, FileChangeKind,
    HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1, PlanEntry, PlanEvent,
    ProviderResumeId, ProviderThreadRef, SessionId, SessionStarted, StreamId, TextEvent,
    ThreadDeclared, ThreadId, ThreadKind, ToolCallEvent, ToolCallId, ToolOutputEvent, ToolStatus,
    TranscriptReplay, TranscriptReplayAdapter, TranscriptReplayRequest, TranscriptRevision,
    TurnInput, TurnInputProvenance, UpdateSemantics,
};

/// Reader for Codex rollout JSONL files in `~/.codex/sessions` and
/// `~/.codex/archived_sessions`.
#[derive(Debug, Clone, Default)]
pub struct CodexTranscriptReplay {
    pub home_dir: Option<PathBuf>,
}

impl CodexTranscriptReplay {
    pub fn new(home_dir: Option<PathBuf>) -> Self {
        Self { home_dir }
    }

    pub fn replay(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError> {
        let Some(path) = self.discover(request)? else {
            return Ok(None);
        };
        let revision = TranscriptRevision::capture(&path)?;
        let drafts = read_rollout(&path, request)?;
        revision.verify(&path)?;
        let sequencer = EventSequencer::default();
        Ok(Some(TranscriptReplay {
            transcript_path: path,
            revision,
            projection_key: format!("codex-v1:{}", request.stream_id),
            events: sequencer.sequence_drafts(drafts),
        }))
    }

    pub fn discover(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<PathBuf>, HarnessError> {
        if !safe_filename(request.provider_resume_id.as_str()) {
            return Ok(None);
        }
        let root = self.provider_root()?;
        let mut roots = Vec::new();
        for name in ["sessions", "archived_sessions"] {
            let candidate = root.join(name);
            if candidate.is_dir() {
                roots.push(candidate);
            }
        }
        let date = request.created_at.as_deref().and_then(parse_date_prefix);
        for search_root in roots {
            if let Some(date) = date {
                let date_root = search_root.join(date.format("%Y/%m/%d").to_string());
                if let Some(path) = find_jsonl_by_id(
                    &date_root,
                    request.provider_resume_id.as_str(),
                )
                .map_err(|error| {
                    HarnessError::Operation(format!("failed to search Codex transcripts: {error}"))
                })? {
                    return Ok(Some(validated_file(&search_root, &path).ok_or_else(
                        || {
                            HarnessError::Operation(format!(
                                "Codex transcript escaped provider home: {}",
                                path.display()
                            ))
                        },
                    )?));
                }
            }
            if let Some(path) = find_jsonl_by_id(&search_root, request.provider_resume_id.as_str())
                .map_err(|error| {
                    HarnessError::Operation(format!("failed to search Codex transcripts: {error}"))
                })?
            {
                return Ok(validated_file(&search_root, &path));
            }
        }
        Ok(None)
    }

    fn provider_root(&self) -> Result<PathBuf, HarnessError> {
        let home = self
            .home_dir
            .clone()
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .ok_or_else(|| {
                HarnessError::Unavailable("could not determine the Codex home directory".into())
            })?;
        Ok(home.join(".codex"))
    }
}

impl TranscriptReplayAdapter for CodexTranscriptReplay {
    fn replay(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError> {
        self.replay(request)
    }
}

#[derive(Debug)]
struct ReplayState {
    thread_id: ThreadId,
    provider_resume_id: ProviderResumeId,
    stream_id: StreamId,
    emitted_session_start_ids: HashSet<String>,
    emitted_thread: bool,
    custom_tool_names: std::collections::HashMap<String, String>,
}

impl ReplayState {
    fn new(request: &TranscriptReplayRequest) -> Self {
        Self {
            thread_id: ThreadId::new(request.provider_resume_id.as_str()),
            provider_resume_id: request.provider_resume_id.clone(),
            stream_id: request.stream_id.clone(),
            emitted_session_start_ids: HashSet::new(),
            emitted_thread: false,
            custom_tool_names: std::collections::HashMap::new(),
        }
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

fn read_rollout(
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

    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| {
            HarnessError::Operation(format!(
                "failed to read Codex transcript {} at line {}: {error}",
                path.display(),
                line_number + 1
            ))
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let raw: Value = serde_json::from_str(&line).map_err(|error| {
            HarnessError::Operation(format!(
                "malformed Codex transcript {} at line {}: {error}",
                path.display(),
                line_number + 1
            ))
        })?;
        let timestamp = record_timestamp(&raw);
        first_timestamp.get_or_insert(timestamp);
        let provider_sequence = (line_number as u64).saturating_add(1);
        drafts.extend(parse_rollout_line(
            &raw,
            timestamp,
            provider_sequence,
            &mut state,
            path,
        ));
    }

    if !state.emitted_session_start_ids.is_empty() {
        return Ok(drafts);
    }
    let timestamp = first_timestamp.unwrap_or_else(Utc::now);
    let mut prefix = state.start_events(timestamp, 0, None, path);
    prefix.extend(drafts);
    Ok(prefix)
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
                _ => vec![state.draft(
                    timestamp,
                    provider_sequence,
                    HarnessEventPayloadV1::Text(TextEvent { text }),
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
                vec![state.draft(
                    timestamp,
                    provider_sequence,
                    HarnessEventPayloadV1::Text(TextEvent { text }),
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
    state
        .custom_tool_names
        .insert(tool_id.clone(), name.clone());
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

fn record_timestamp(value: &Value) -> DateTime<Utc> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(Utc::now)
}

fn parse_date_prefix(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.get(..10)?, "%Y-%m-%d").ok()
}

fn safe_filename(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn validated_file(root: &Path, candidate: &Path) -> Option<PathBuf> {
    if !candidate.is_file() {
        return None;
    }
    let canonical_root = fs::canonicalize(root).ok()?;
    let canonical_candidate = fs::canonicalize(candidate).ok()?;
    canonical_candidate
        .starts_with(canonical_root)
        .then_some(canonical_candidate)
}

fn find_jsonl_by_id(root: &Path, id: &str) -> std::io::Result<Option<PathBuf>> {
    if !root.is_dir() {
        return Ok(None);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_jsonl_by_id(&path, id)? {
                return Ok(Some(found));
            }
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if stem == id || stem == format!("rollout-{id}") || stem.ends_with(id) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;
    use vertebrae_harness_core::{HarnessEventPayloadV1, TranscriptReplayRequest};

    use super::*;

    #[test]
    fn discovers_date_partitioned_rollout_and_replays_core_events() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions/2026/01/01");
        fs::create_dir_all(&directory).unwrap();
        let transcript = directory.join("rollout-session-1.jsonl");
        fs::write(
            &transcript,
            concat!(
                "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"session-1\"}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hi\"}]}}\n"
            ),
        )
        .unwrap();
        let replay = CodexTranscriptReplay::new(Some(home.path().to_path_buf()))
            .replay(&TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("session-1"),
                stream_id: StreamId::new("replay/session-1"),
                project_path: None,
                created_at: Some("2026-01-01T00:00:00Z".into()),
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            replay.transcript_path,
            fs::canonicalize(transcript).unwrap()
        );
        assert!(replay.events.iter().any(|event| matches!(
            event.payload,
            HarnessEventPayloadV1::TurnInput(ref input) if input.content == "hello"
        )));
        assert!(replay.events.iter().any(|event| matches!(
            event.payload,
            HarnessEventPayloadV1::Text(ref text) if text.text == "hi"
        )));
    }

    #[test]
    fn skips_provider_injected_developer_context() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions/2026/01/01");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("rollout-session-2.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"session-2\"}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"<permissions instructions>\\nsandbox_mode is danger-full-access.\\n</permissions instructions>\"}]}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hi\"}]}}\n"
            ),
        )
        .unwrap();
        let replay = CodexTranscriptReplay::new(Some(home.path().to_path_buf()))
            .replay(&TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("session-2"),
                stream_id: StreamId::new("replay/session-2"),
                project_path: None,
                created_at: Some("2026-01-01T00:00:00Z".into()),
            })
            .unwrap()
            .unwrap();
        let texts = replay
            .events
            .iter()
            .filter_map(|event| match &event.payload {
                HarnessEventPayloadV1::Text(text) => Some(text.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(texts, vec!["hi"]);
    }
}
