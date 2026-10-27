//! Claude's subagent paths and metadata never cross the adapter boundary.
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    sync::{Mutex, OnceLock},
};

use serde_json::Value;
use vertebrae_harness_core::{
    HarnessError, ProviderResumeId, ToolCallId, TranscriptChildSession, TranscriptDiscoveryIndex,
    TranscriptReplayRequest, TranscriptRevision, TranscriptTailLines, validated_file,
};

use crate::ClaudeTranscriptReplay;

#[derive(Default, Clone, serde::Serialize)]
struct ClaudeChildren {
    spawns: BTreeMap<String, (String, u64)>,
    completed: HashSet<String>,
    linked_agents: BTreeMap<String, String>,
}
fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.split_once(&format!("<{name}>"))?
        .1
        .split_once(&format!("</{name}>"))
        .map(|(value, _)| value)
}
fn index_record(state: &mut ClaudeChildren, raw: &Value, ordinal: u64) -> bool {
    let mut changed = false;
    let content = raw.pointer("/message/content");
    let text = content
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            content
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        });
    if text.contains("<task-notification>")
        && tag(&text, "status").is_some_and(|status| {
            matches!(
                status,
                "completed" | "failed" | "stopped" | "cancelled" | "killed"
            )
        })
        && let Some(id) = tag(&text, "tool-use-id")
    {
        changed |= state.completed.insert(id.to_owned());
    }
    for block in content.and_then(Value::as_array).into_iter().flatten() {
        if block.get("type").and_then(Value::as_str) == Some("tool_use")
            && matches!(
                block.get("name").and_then(Value::as_str),
                Some("Agent" | "Task")
            )
            && let Some(id) = block.get("id").and_then(Value::as_str)
        {
            changed |= !state.spawns.contains_key(id);
            state.spawns.entry(id.to_owned()).or_insert_with(|| {
                (
                    block
                        .pointer("/input/description")
                        .and_then(Value::as_str)
                        .unwrap_or("Agent")
                        .to_owned(),
                    ordinal,
                )
            });
        }
        if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
            let result = raw.get("toolUseResult");
            if state.spawns.contains_key(id)
                && result
                    .and_then(|result| result.get("isAsync"))
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                changed |= state.completed.insert(id.to_owned());
            }
            if let Some(agent) = result
                .and_then(|result| result.get("agentId"))
                .and_then(Value::as_str)
            {
                changed = true;
                state.linked_agents.insert(agent.to_owned(), id.to_owned());
            }
        }
    }
    changed
}
fn read_metadata(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "child metadata exceeds 64 KiB",
        ));
    }
    Ok(bytes)
}

// Expected transient metadata failures are logged once per file revision/cause.
fn metadata_diagnostic(path: &std::path::Path, cause: &str) {
    type Seen = BTreeMap<(std::path::PathBuf, String), Option<TranscriptRevision>>;
    static SEEN: OnceLock<Mutex<Seen>> = OnceLock::new();
    let revision = TranscriptRevision::capture(path).ok();
    let mut seen = SEEN
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = (path.to_owned(), cause.to_owned());
    if seen.get(&key) == Some(&revision) {
        return;
    }
    if seen.len() >= 128 {
        seen.clear();
    }
    log::warn!(
        "Claude child discovery path={} cause={cause}",
        path.display()
    );
    seen.insert(key, revision);
}
fn child_has_finished(path: &std::path::Path) -> bool {
    match TranscriptTailLines::read_cached(path, 16 * 1024, "Claude") {
        Ok(tail) => tail
            .lines
            .iter()
            .rev()
            .filter_map(|(_, line)| serde_json::from_str::<Value>(line).ok())
            .find(|raw| {
                matches!(
                    raw.get("type").and_then(Value::as_str),
                    Some("assistant" | "user")
                )
            })
            .is_some_and(|raw| {
                raw.pointer("/message/stop_reason").and_then(Value::as_str) == Some("end_turn")
            }),
        Err(error) => {
            metadata_diagnostic(path, &format!("could not read child lifecycle: {error}"));
            false
        }
    }
}

impl ClaudeTranscriptReplay {
    pub fn child_sessions(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Vec<TranscriptChildSession>, HarnessError> {
        let Some(path) = self.discover(request)? else {
            return Ok(Vec::new());
        };
        static INDEX: std::sync::OnceLock<TranscriptDiscoveryIndex<ClaudeChildren>> =
            std::sync::OnceLock::new();
        let state = INDEX
            .get_or_init(TranscriptDiscoveryIndex::default)
            .read(&path, index_record)?;
        let spawns = state.spawns;
        let completed = state.completed;
        let linked_agents = state.linked_agents;
        let Some(parent_dir) = path.parent() else {
            return Ok(Vec::new());
        };
        let directory =
            if parent_dir.file_name().and_then(|name| name.to_str()) == Some("subagents") {
                parent_dir.to_path_buf()
            } else {
                path.with_extension("").join("subagents")
            };
        if !directory.is_dir() {
            return Ok(Vec::new());
        }
        let authority = self.provider_root()?.join("projects");
        let entries = fs::read_dir(&directory).map_err(|error| {
            HarnessError::Operation(format!("failed to list Claude child sessions: {error}"))
        })?;
        let mut children = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    log::warn!("could not list Claude child transcript: {error}");
                    continue;
                }
            };
            let candidate = entry.path();
            if candidate.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = candidate.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let Some(agent) = stem.strip_prefix("agent-") else {
                continue;
            };
            if stem == request.provider_resume_id.as_str() {
                continue;
            }
            if validated_file(&authority, &candidate).is_none() {
                metadata_diagnostic(
                    &candidate,
                    "child transcript is unavailable or outside provider directory",
                );
                continue;
            }
            let metadata_path = candidate.with_extension("meta.json");
            let metadata = match validated_file(&authority, &metadata_path) {
                Some(path) => match read_metadata(&path) {
                    Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                        Ok(value) => Some(value),
                        Err(error) => {
                            metadata_diagnostic(
                                &metadata_path,
                                &format!("malformed metadata: {error}"),
                            );
                            None
                        }
                    },
                    Err(error) => {
                        metadata_diagnostic(
                            &metadata_path,
                            &format!("unreadable metadata: {error}"),
                        );
                        None
                    }
                },
                None => {
                    metadata_diagnostic(
                        &metadata_path,
                        "missing metadata or path outside provider directory",
                    );
                    None
                }
            };
            let tool_id = metadata
                .as_ref()
                .and_then(|meta| meta.get("toolUseId"))
                .and_then(Value::as_str)
                .or_else(|| linked_agents.get(agent).map(String::as_str));
            let Some(tool_id) = tool_id else {
                metadata_diagnostic(
                    &metadata_path,
                    "no spawning call could be linked to this child",
                );
                continue;
            };
            // A directory can also contain descendants owned by other agents.
            if !spawns.contains_key(tool_id) {
                continue;
            }
            let finished = metadata
                .as_ref()
                .and_then(|meta| meta.get("finished"))
                .and_then(Value::as_bool);
            children.push(TranscriptChildSession {
                provider_resume_id: ProviderResumeId::new(stem),
                spawn_tool_call_id: Some(ToolCallId::new(tool_id)),
                label: spawns[tool_id].0.clone(),
                is_active: if finished == Some(true)
                    || completed.contains(tool_id)
                    || child_has_finished(&candidate)
                {
                    Some(false)
                } else {
                    // Missing `finished` occurs on historical completed agents.
                    // Only an explicit provider value establishes activity.
                    finished.map(|finished| !finished)
                },
            });
        }
        children.sort_by_key(|child| {
            child
                .spawn_tool_call_id
                .as_ref()
                .and_then(|id| spawns.get(id.as_str()))
                .map(|(_, ordinal)| *ordinal)
        });
        Ok(children)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use vertebrae_harness_core::{HarnessEventPayloadV1, StreamId, TranscriptReplayPageRequest};
    const CHILD: &str = "agent-aaeb35c276750cf44";
    fn request(id: &str) -> TranscriptReplayRequest {
        TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new(id),
            stream_id: StreamId::new(format!("selected/{id}")),
            project_path: None,
            created_at: None,
        }
    }
    #[test]
    fn discovers_real_child_and_replays_text_and_tools_as_a_standalone_conversation() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".claude/projects/fixture");
        let agents = directory.join("parent/subagents");
        fs::create_dir_all(&agents).unwrap();
        fs::write(
            directory.join("parent.jsonl"),
            include_str!("../tests/fixtures/child-sessions/parent.jsonl"),
        )
        .unwrap();
        fs::write(
            agents.join(format!("{CHILD}.jsonl")),
            include_str!("../tests/fixtures/child-sessions/child.jsonl"),
        )
        .unwrap();
        fs::write(
            agents.join(format!("{CHILD}.meta.json")),
            include_str!("../tests/fixtures/child-sessions/child.meta.json"),
        )
        .unwrap();
        let adapter = ClaudeTranscriptReplay::new(Some(home.path().to_owned()));
        let children = adapter.child_sessions(&request("parent")).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].provider_resume_id.as_str(), CHILD);
        assert_eq!(children[0].is_active, Some(false));
        let replay = adapter.replay(&request(CHILD)).unwrap().unwrap();
        assert!(replay.events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::Text(text) if text.text == "child reply")));
        assert!(replay.events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::ToolCall(call) if call.tool_call_id.as_str() == "toolu_01QSjPiMXuxW7iHTpqQtjxKM")));
        assert!(
            replay
                .events
                .iter()
                .all(|event| event.correlation.parent_tool_call_id.is_none())
        );
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
        let mut body = fs::read_to_string(agents.join(format!("{CHILD}.jsonl"))).unwrap();
        body.push_str("{\"type\":");
        fs::write(agents.join(format!("{CHILD}.jsonl")), body).unwrap();
        assert_eq!(
            adapter.replay(&request(CHILD)).unwrap().unwrap().events,
            replay.events
        );
        // The same directory can contain nested agents; the metadata spawn ID
        // selects their immediate parent rather than flattening into the root.
        fs::write(agents.join("agent-nested.jsonl"), "").unwrap();
        fs::write(
            agents.join("agent-nested.meta.json"),
            "{\"toolUseId\":\"nested-spawn\",\"finished\":false}",
        )
        .unwrap();
        assert_eq!(adapter.child_sessions(&request("parent")).unwrap().len(), 1);
        fs::write(agents.join(format!("{CHILD}.jsonl")), "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Agent\",\"id\":\"nested-spawn\"}]}}\n").unwrap();
        let nested = adapter.child_sessions(&request(CHILD)).unwrap();
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].provider_resume_id.as_str(), "agent-nested");
        assert_eq!(nested[0].is_active, Some(true));
        fs::write(agents.join("agent-nested.jsonl"), "{\"type\":\"user\",\"agentId\":\"nested\",\"message\":{\"content\":\"nested assignment\"}}\n{\"type\":\"assistant\",\"agentId\":\"nested\",\"message\":{\"id\":\"nested-answer\",\"content\":[{\"type\":\"text\",\"text\":\"nested response\"}],\"stop_reason\":\"end_turn\"}}\n").unwrap();
        let nested_replay = adapter.replay(&request("agent-nested")).unwrap().unwrap();
        assert!(nested_replay.events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::TurnInput(input) if input.content == "nested assignment")));
        assert!(nested_replay.events.iter().any(|event| matches!(&event.payload, HarnessEventPayloadV1::Text(text) if text.text == "nested response")));
        assert_eq!(
            adapter.child_sessions(&request(CHILD)).unwrap()[0].is_active,
            Some(false)
        );
        fs::write(
            agents.join("agent-nested.meta.json"),
            "{\"toolUseId\":\"nested-spawn\",\"finished\":true}",
        )
        .unwrap();
        assert_eq!(
            adapter.child_sessions(&request(CHILD)).unwrap()[0].is_active,
            Some(false)
        );
    }
    #[test]
    fn invalid_utf8_and_stale_metadata_do_not_hide_children_or_leave_activity_running() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".claude/projects/fixture");
        let agents = directory.join("parent/subagents");
        fs::create_dir_all(&agents).unwrap();
        let parent = directory.join("parent.jsonl");
        let mut body = include_str!("../tests/fixtures/child-sessions/parent.jsonl")
            .as_bytes()
            .to_vec();
        body.extend_from_slice(b"\xff\n");
        fs::write(&parent, body).unwrap();
        fs::write(agents.join(format!("{CHILD}.jsonl")), "").unwrap();
        let meta = agents.join(format!("{CHILD}.meta.json"));
        fs::write(&meta, "{\"toolUseId\":\"toolu_019bLng9wNyc1LBNCPUbL2nh\"}").unwrap();
        let adapter = ClaudeTranscriptReplay::new(Some(home.path().to_owned()));
        assert_eq!(
            adapter.child_sessions(&request("parent")).unwrap()[0].is_active,
            None
        );
        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&parent).unwrap();
        file.write_all(b"{\"type\":\"user\",\"message\":{\"content\":\"<task-notification><tool-use-id>toolu_019bLng9wNyc1LBNCPUbL2nh</tool-use-id><status>completed</status></task-notification>\"}}\n").unwrap();
        assert_eq!(
            adapter.child_sessions(&request("parent")).unwrap()[0].is_active,
            Some(false)
        );
        fs::write(&meta, "{malformed").unwrap();
        file.write_all(b"{\"type\":\"user\",\"toolUseResult\":{\"agentId\":\"aaeb35c276750cf44\",\"isAsync\":true},\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_019bLng9wNyc1LBNCPUbL2nh\"}]}}\n").unwrap();
        assert_eq!(
            adapter.child_sessions(&request("parent")).unwrap().len(),
            1,
            "parent linkage recovers from malformed metadata with a diagnostic"
        );
    }
}
