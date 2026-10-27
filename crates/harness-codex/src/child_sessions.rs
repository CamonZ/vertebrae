//! Codex child-thread discovery stays beside rollout replay, not in the GUI.
use std::collections::BTreeMap;

use serde_json::Value;
use vertebrae_harness_core::{
    HarnessError, ProviderResumeId, ToolCallId, TranscriptChildSession, TranscriptDiscoveryIndex,
    TranscriptReplayRequest, TranscriptTailLines, record_timestamp,
};

use crate::CodexTranscriptReplay;

#[derive(Default, Clone, serde::Serialize)]
struct CodexChildren {
    children: BTreeMap<String, TranscriptChildSession>,
    activity_times: BTreeMap<String, chrono::DateTime<chrono::Utc>>,
    history_start: usize,
    order: BTreeMap<String, u64>,
    parent: Option<String>,
    agent_path: Option<String>,
    initial_message: Option<String>,
}
fn index_record(state: &mut CodexChildren, raw: &Value, ordinal: u64, own_id: &str) -> bool {
    if ordinal == 0 {
        state.parent = raw
            .pointer("/payload/parent_thread_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        state.agent_path = raw
            .pointer("/payload/agent_path")
            .or_else(|| raw.pointer("/payload/source/subagent/thread_spawn/agent_path"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        state.history_start = raw
            .pointer("/payload/subagent_history_start_ordinal")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
    }
    let record_ordinal = raw
        .get("ordinal")
        .and_then(Value::as_u64)
        .unwrap_or(ordinal);
    if record_ordinal < state.history_start as u64 {
        return false;
    }
    if raw.get("type").and_then(Value::as_str) == Some("response_item") {
        let payload = &raw["payload"];
        if payload["type"] == "agent_message"
            && state.initial_message.is_none()
            && payload.get("recipient").and_then(Value::as_str) == state.agent_path.as_deref()
        {
            state.initial_message = payload.get("id").and_then(Value::as_str).map(str::to_owned);
            return state.initial_message.is_some();
        }
    }
    if raw.get("type").and_then(Value::as_str) != Some("event_msg") {
        return false;
    }
    let Some(item) = raw.pointer("/payload/item") else {
        return false;
    };
    if item.get("type").and_then(Value::as_str) != Some("SubAgentActivity") {
        return false;
    }
    let Some(id) = item
        .get("agent_thread_id")
        .and_then(Value::as_str)
        .filter(|id| *id != own_id)
    else {
        return false;
    };
    let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
    // Interactions can target a parent or peer; only a spawn establishes a descendant.
    if kind != "started" && !state.children.contains_key(id) {
        return false;
    }
    if !matches!(
        kind,
        "started" | "completed" | "failed" | "cancelled" | "closed"
    ) {
        return false;
    }
    let child = state
        .children
        .entry(id.to_owned())
        .or_insert_with(|| TranscriptChildSession {
            provider_resume_id: ProviderResumeId::new(id),
            spawn_tool_call_id: None,
            label: item
                .get("agent_path")
                .and_then(Value::as_str)
                .and_then(|path| path.rsplit('/').next())
                .filter(|label| !label.is_empty())
                .unwrap_or("Agent")
                .to_owned(),
            is_active: None,
        });
    state.order.entry(id.to_owned()).or_insert(ordinal);
    state
        .activity_times
        .insert(id.to_owned(), record_timestamp(raw));
    if kind == "started" {
        child.spawn_tool_call_id = item.get("id").and_then(Value::as_str).map(ToolCallId::new);
        child.is_active = Some(true);
    } else if matches!(kind, "completed" | "failed" | "cancelled" | "closed") {
        child.is_active = Some(false);
    }
    true
}

fn looks_encrypted(text: &str) -> bool {
    text.starts_with("gAAAA")
        && text.len() > 80
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'='))
}
// Assignment arguments are immutable for a provider call ID. Cache only that
// lookup (including a known encrypted value), not every prompt in discovery.
fn parent_assignment(
    path: &std::path::Path,
    call_id: &str,
) -> Result<Option<String>, HarnessError> {
    use std::{
        fs::File,
        io::{BufRead, BufReader, Read},
        sync::{Mutex, OnceLock},
    };
    type Entry = (std::path::PathBuf, String, String, Option<String>);
    static CACHE: OnceLock<Mutex<std::collections::VecDeque<Entry>>> = OnceLock::new();
    let metadata =
        std::fs::metadata(path).map_err(|error| HarnessError::Operation(error.to_string()))?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = format!("{:?}", metadata.created().ok());
    let cache = CACHE.get_or_init(Mutex::default);
    {
        let entries = cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.0 == path && entry.1 == call_id && entry.2 == identity)
        {
            return Ok(entry.3.clone());
        }
    }
    let file = File::open(path).map_err(|error| HarnessError::Operation(error.to_string()))?;
    let mut reader = BufReader::new(file.take(metadata.len()));
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        if reader
            .by_ref()
            .take(8 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|error| HarnessError::Operation(error.to_string()))?
            == 0
        {
            return Ok(None);
        }
        if bytes.len() > 8 * 1024 * 1024 {
            if !bytes.ends_with(b"\n") {
                reader
                    .skip_until(b'\n')
                    .map_err(|error| HarnessError::Operation(error.to_string()))?;
            }
            log::warn!(
                "skipping oversized Codex assignment record path={}",
                path.display()
            );
            continue;
        }
        let Some(raw) = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
        else {
            continue;
        };
        let payload = &raw["payload"];
        if raw["type"] != "response_item"
            || payload["type"] != "function_call"
            || payload.get("call_id").and_then(Value::as_str) != Some(call_id)
        {
            continue;
        }
        let args = payload.get("arguments").and_then(|value| {
            value
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .or_else(|| value.as_object().map(|_| value.clone()))
        });
        let prompt = args
            .as_ref()
            .and_then(|args| args.get("message").or_else(|| args.get("prompt")))
            .and_then(Value::as_str)
            .filter(|text| !looks_encrypted(text))
            .map(str::to_owned);
        if prompt
            .as_ref()
            .is_none_or(|text| text.len() <= 2 * 1024 * 1024)
        {
            let mut entries = cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            entries.push_back((
                path.to_owned(),
                call_id.to_owned(),
                identity,
                prompt.clone(),
            ));
            while entries.len() > 32
                || entries
                    .iter()
                    .map(|entry| entry.3.as_ref().map_or(0, String::len))
                    .sum::<usize>()
                    > 2 * 1024 * 1024
            {
                entries.pop_front();
            }
        }
        return Ok(prompt);
    }
}

fn child_index() -> &'static TranscriptDiscoveryIndex<CodexChildren> {
    static INDEX: std::sync::OnceLock<TranscriptDiscoveryIndex<CodexChildren>> =
        std::sync::OnceLock::new();
    INDEX.get_or_init(Default::default)
}

impl CodexTranscriptReplay {
    pub(crate) fn restore_initial_prompt(
        &self,
        request: &TranscriptReplayRequest,
        drafts: &mut [vertebrae_harness_core::HarnessEventDraftV1],
    ) -> Result<(), HarnessError> {
        use vertebrae_harness_core::HarnessEventPayloadV1;
        if !drafts.iter().any(|draft| matches!(&draft.payload, HarnessEventPayloadV1::TurnInput(input) if input.content.contains("[The prompt body is encrypted"))) { return Ok(()); }
        let Some(path) = self.discover(request)? else {
            return Ok(());
        };
        let child = child_index().read(&path, |state, raw, ordinal| {
            index_record(state, raw, ordinal, request.provider_resume_id.as_str())
        })?;
        let (Some(parent_id), Some(message_id)) = (child.parent, child.initial_message) else {
            return Ok(());
        };
        let Some(draft) = drafts.iter_mut().find(|draft| {
            draft
                .correlation
                .item_id
                .as_ref()
                .is_some_and(|id| id.as_str() == message_id)
        }) else {
            return Ok(());
        };
        let HarnessEventPayloadV1::TurnInput(input) = &mut draft.payload else {
            return Ok(());
        };
        let marker = "[The prompt body is encrypted in this Codex transcript and is unavailable for replay.]";
        if !input.content.contains(marker) {
            return Ok(());
        }
        let parent_request = TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new(parent_id),
            created_at: None,
            ..request.clone()
        };
        let Some(parent_path) = self.discover(&parent_request)? else {
            return Ok(());
        };
        let parent = child_index().read(&parent_path, |state, raw, ordinal| {
            index_record(
                state,
                raw,
                ordinal,
                parent_request.provider_resume_id.as_str(),
            )
        })?;
        let spawn_id = parent
            .children
            .get(request.provider_resume_id.as_str())
            .and_then(|child| child.spawn_tool_call_id.as_ref());
        if let Some(id) = spawn_id
            && let Some(prompt) = parent_assignment(&parent_path, id.as_str())?
        {
            input.content = input.content.replace(marker, &prompt);
        }
        Ok(())
    }

    pub fn child_sessions(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Vec<TranscriptChildSession>, HarnessError> {
        let Some(path) = self.discover(request)? else {
            return Ok(Vec::new());
        };
        let state = child_index().read(&path, |state, raw, ordinal| {
            index_record(state, raw, ordinal, request.provider_resume_id.as_str())
        })?;
        let mut children = state.children;
        let activity_times = state.activity_times;
        for child in children.values_mut() {
            let child_request = TranscriptReplayRequest {
                provider_resume_id: child.provider_resume_id.clone(),
                created_at: None,
                ..request.clone()
            };
            match self.discover(&child_request) {
                Ok(Some(child_path)) => {
                    // A bounded read is sufficient for the latest work status.
                    // Compare cross-file lifecycle timestamps so copied parent history
                    // cannot override a spawn, and a later resumed turn can run again.
                    {
                        let mut status_time = activity_times
                            .get(child.provider_resume_id.as_str())
                            .copied()
                            .unwrap_or(chrono::DateTime::UNIX_EPOCH);
                        match TranscriptTailLines::read_cached(&child_path, 128 * 1024, "Codex") {
                            Ok(tail) => {
                                for (_, line) in &tail.lines {
                                    let Ok(raw) = serde_json::from_str::<Value>(line) else {
                                        continue;
                                    };
                                    let timestamp = record_timestamp(&raw);
                                    if timestamp < status_time {
                                        continue;
                                    }
                                    match raw.pointer("/payload/type").and_then(Value::as_str) {
                                        Some("task_started") => {
                                            child.is_active = Some(true);
                                            status_time = timestamp;
                                        }
                                        Some("task_complete" | "turn_aborted") => {
                                            child.is_active = Some(false);
                                            status_time = timestamp;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            Err(error) => {
                                log::warn!("could not read Codex child activity: {error}")
                            }
                        }
                    }
                }
                Ok(None) => {
                    log::debug!(
                        "Codex child transcript {} is missing",
                        child.provider_resume_id
                    )
                }
                Err(error) => log::warn!("could not discover Codex child transcript: {error}"),
            }
        }
        let mut children: Vec<_> = children.into_values().collect();
        children.sort_by_key(|child| {
            state
                .order
                .get(child.provider_resume_id.as_str())
                .copied()
                .unwrap_or_default()
        });
        Ok(children)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;
    use vertebrae_harness_core::{HarnessEventPayloadV1, StreamId, TranscriptReplayPageRequest};
    const CHILD: &str = "01a17f07-7376-7ff3-92af-4aa71378c140";
    fn request(id: &str) -> TranscriptReplayRequest {
        TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new(id),
            stream_id: StreamId::new(format!("selected/{id}")),
            project_path: None,
            created_at: None,
        }
    }

    #[test]
    fn restores_a_plaintext_parent_assignment_but_never_uses_ciphertext_as_a_prompt() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions");
        fs::create_dir_all(&directory).unwrap();
        let parent = [
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"collaboration.spawn_agent","call_id":"spawn","arguments":"{\"message\":\"Actual assigned prompt\"}"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"SubAgentActivity","id":"spawn","kind":"started","agent_thread_id":"selected","agent_path":"/root/worker"}}}),
        ];
        let child = [
            serde_json::json!({"type":"session_meta","payload":{"id":"selected","parent_thread_id":"parent","agent_path":"/root/worker"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"agent_message","id":"assignment","recipient":"/root/worker","author":"/root","content":[{"type":"input_text","text":"Message Type: NEW_TASK\nPayload:\n"},{"type":"encrypted_content","encrypted_content":"gAAAA_private"}]}}),
        ];
        for (name, records) in [("parent", parent), ("selected", child)] {
            fs::write(
                directory.join(format!("{name}.jsonl")),
                records
                    .iter()
                    .map(|record| format!("{record}\n"))
                    .collect::<String>(),
            )
            .unwrap();
        }
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_owned()));
        let replay = adapter.replay(&request("selected")).unwrap().unwrap();
        assert!(replay.events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::TurnInput(input) if input.content.contains("Actual assigned prompt") && !input.content.contains("encrypted"))));
        let page = adapter
            .replay_page(
                &request("selected"),
                &TranscriptReplayPageRequest {
                    cursor: None,
                    limit: Some(20),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(page.events, replay.events);
        assert!(looks_encrypted(&format!("gAAAA{}", "x".repeat(100))));
        assert!(!looks_encrypted("Read the parser and report findings."));
    }

    #[test]
    fn discovers_real_child_and_replays_only_its_own_history_with_paging() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("rollout-parent.jsonl"),
            include_str!("../tests/fixtures/child-sessions/parent.jsonl"),
        )
        .unwrap();
        fs::write(
            directory.join(format!("rollout-{CHILD}.jsonl")),
            include_str!("../tests/fixtures/child-sessions/child.jsonl"),
        )
        .unwrap();
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_owned()));
        let children = adapter.child_sessions(&request("parent")).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].provider_resume_id.as_str(), CHILD);
        assert_eq!(children[0].is_active, Some(false));
        let replay = adapter.replay(&request(CHILD)).unwrap().unwrap();
        assert!(replay.events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::ToolCall(call) if call.tool_call_id.as_str() == "exec-da5af6af-b2f4-4d0a-a158-eb7efab7d140")));
        assert!(!replay.events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::Text(text) if text.text.contains("parent-only"))));
        let mut cursor = None;
        let mut paged = Vec::new();
        loop {
            let page = adapter
                .replay_page(
                    &request(CHILD),
                    &TranscriptReplayPageRequest {
                        cursor,
                        limit: Some(2),
                    },
                )
                .unwrap()
                .unwrap();
            paged.splice(0..0, page.events);
            if !page.has_more {
                break;
            }
            cursor = page.next_cursor;
        }
        assert_eq!(paged, replay.events);
        // Truncated final writes drop only that record.
        let path = directory.join(format!("rollout-{CHILD}.jsonl"));
        let mut body = fs::read_to_string(&path).unwrap();
        body.push_str("{\"type\":");
        fs::write(path, body).unwrap();
        assert_eq!(
            adapter.replay(&request(CHILD)).unwrap().unwrap().events,
            replay.events
        );
    }

    #[test]
    fn selected_child_respects_provider_ordinals_when_records_have_gaps() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions");
        fs::create_dir_all(&directory).unwrap();
        let records = [
            serde_json::json!({"type":"session_meta", "ordinal":0, "payload":{"id":"selected", "subagent_history_start_ordinal":20}}),
            serde_json::json!({"type":"response_item", "ordinal":15, "payload":{"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"copied parent"}]}}),
            serde_json::json!({"type":"event_msg", "ordinal":19, "payload":{"type":"item_completed", "item":{"type":"SubAgentActivity", "kind":"started", "agent_thread_id":"copied-sibling"}}}),
            serde_json::json!({"type":"response_item", "ordinal":25, "payload":{"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"own reply"}]}}),
            serde_json::json!({"type":"event_msg", "ordinal":30, "payload":{"type":"item_completed", "item":{"type":"SubAgentActivity", "kind":"started", "agent_thread_id":"grandchild", "id":"spawn"}}}),
        ];
        fs::write(
            directory.join("selected.jsonl"),
            records
                .iter()
                .map(|record| format!("{record}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_owned()));
        let replay = adapter.replay(&request("selected")).unwrap().unwrap();
        let text = replay
            .events
            .iter()
            .filter_map(|event| match &event.payload {
                HarnessEventPayloadV1::Text(text) => Some(text.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(text, ["own reply"]);
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(directory.join("selected.jsonl"))
            .unwrap();
        file.write_all(b"\xff\n").unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"event_msg","ordinal":40,"payload":{"type":"item_completed","item":{"type":"SubAgentActivity","kind":"interacted","agent_thread_id":"parent-or-peer","agent_path":"/root"}}})).unwrap();
        let children = adapter.child_sessions(&request("selected")).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].provider_resume_id.as_str(), "grandchild");
    }

    #[test]
    fn tracks_work_resumption_and_completion_without_requiring_a_loaded_parent_page() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions");
        fs::create_dir_all(&directory).unwrap();
        let parent = include_str!("../tests/fixtures/child-sessions/parent.jsonl")
            .lines()
            .next()
            .unwrap();
        fs::write(directory.join("parent.jsonl"), parent).unwrap();
        let child_path = directory.join(format!("{CHILD}.jsonl"));
        fs::write(
            &child_path,
            "{\"timestamp\":\"2026-12-01T00:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        )
        .unwrap();
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_owned()));
        assert_eq!(
            adapter.child_sessions(&request("parent")).unwrap()[0].is_active,
            Some(true)
        );
        fs::write(
            &child_path,
            "{\"timestamp\":\"2026-12-01T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_aborted\"}}\n",
        )
        .unwrap();
        assert_eq!(
            adapter.child_sessions(&request("parent")).unwrap()[0].is_active,
            Some(false)
        );
        // Child sessions can spawn their own children; the adapter returns
        // immediate descendants so the panel can preserve that hierarchy.
        fs::write(&child_path, "{\"timestamp\":\"2026-12-01T00:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"SubAgentActivity\",\"kind\":\"started\",\"agent_thread_id\":\"nested\",\"id\":\"nested-spawn\",\"agent_path\":\"/root/child/nested\"}}}\n").unwrap();
        let nested = adapter.child_sessions(&request(CHILD)).unwrap();
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].provider_resume_id.as_str(), "nested");
        assert_eq!(adapter.child_sessions(&request("parent")).unwrap().len(), 1);
        fs::remove_file(child_path).unwrap();
        assert_eq!(adapter.child_sessions(&request("parent")).unwrap().len(), 1);
        assert!(adapter.replay(&request(CHILD)).unwrap().is_none());
        assert!(adapter.replay(&request("parent")).unwrap().is_some());
    }
}
