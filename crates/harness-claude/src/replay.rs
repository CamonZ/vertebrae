use std::{
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, Utc};
use serde_json::Value;
use vertebrae_harness_core::{
    EventSequencer, HarnessError, HarnessEventDraftV1, ProviderThreadRef, SessionId,
    TranscriptReplay, TranscriptReplayAdapter, TranscriptReplayRequest,
};

use crate::{ClaudeDecodeContext, ClaudeStreamDecoder};

/// Reader for Claude Code's durable project JSONL transcripts.
///
/// `home_dir` is injectable so callers and tests can use a specific Claude
/// home. When omitted, the adapter follows the current process' `HOME`.
#[derive(Debug, Clone, Default)]
pub struct ClaudeTranscriptReplay {
    pub home_dir: Option<PathBuf>,
}

impl ClaudeTranscriptReplay {
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
        let drafts = self.read_drafts(&path, request)?;
        let sequencer = EventSequencer::default();
        Ok(Some(TranscriptReplay {
            transcript_path: path,
            events: sequencer.sequence_drafts(drafts),
        }))
    }

    pub fn discover(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<PathBuf>, HarnessError> {
        let root = self.provider_root()?;
        let projects = root.join("projects");
        if !projects.is_dir() || !safe_filename(request.provider_resume_id.as_str()) {
            return Ok(None);
        }

        if let Some(project_path) = request.project_path.as_deref() {
            let candidate = projects
                .join(claude_project_dir_name(project_path))
                .join(format!("{}.jsonl", request.provider_resume_id));
            if let Some(path) = validated_file(&projects, &candidate) {
                return Ok(Some(path));
            }
        }

        let found = find_jsonl_by_stem(&projects, request.provider_resume_id.as_str()).map_err(
            |error| {
                HarnessError::Operation(format!("failed to search Claude transcripts: {error}"))
            },
        )?;
        Ok(found.and_then(|path| validated_file(&projects, &path)))
    }

    fn provider_root(&self) -> Result<PathBuf, HarnessError> {
        let home = self
            .home_dir
            .clone()
            .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
            .ok_or_else(|| {
                HarnessError::Unavailable("could not determine the Claude home directory".into())
            })?;
        Ok(home.join(".claude"))
    }

    fn read_drafts(
        &self,
        path: &Path,
        request: &TranscriptReplayRequest,
    ) -> Result<Vec<HarnessEventDraftV1>, HarnessError> {
        let file = File::open(path).map_err(|error| {
            HarnessError::Operation(format!(
                "failed to open Claude transcript {}: {error}",
                path.display()
            ))
        })?;
        let mut decoder = ClaudeStreamDecoder::new(ClaudeDecodeContext::interactive(
            SessionId::new(request.provider_resume_id.as_str()),
            request.stream_id.clone(),
        ));
        decoder.context_mut().provider_resume_id = Some(request.provider_resume_id.clone());
        decoder
            .resolve_root_locator(ProviderThreadRef::new(path.to_string_lossy()))
            .map_err(|error| HarnessError::Operation(error.to_string()))?;

        let mut drafts = Vec::new();
        for (line_number, line) in BufReader::new(file).lines().enumerate() {
            let line = line.map_err(|error| {
                HarnessError::Operation(format!(
                    "failed to read Claude transcript {} at line {}: {error}",
                    path.display(),
                    line_number + 1
                ))
            })?;
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&line).map_err(|error| {
                HarnessError::Operation(format!(
                    "malformed Claude transcript {} at line {}: {error}",
                    path.display(),
                    line_number + 1
                ))
            })?;
            let timestamp = record_timestamp(&value);
            let mut line_drafts = decoder
                .decode_line_at(&line, timestamp)
                .map_err(|error| HarnessError::Operation(error.to_string()))?;
            if value.get("type").and_then(Value::as_str) == Some("user")
                && value.get("isMeta").and_then(Value::as_bool) != Some(true)
                && let Some(text) = user_text(&value)
            {
                // Claude's live runtime emits the human input before the
                // provider's echoed `user` record. Preserve that order in
                // replay while letting the shared decoder handle tools,
                // tool results, and child-thread lineage.
                line_drafts.insert(0, decoder.replay_user_input_draft(text, timestamp));
            }
            drafts.extend(line_drafts);
        }
        drafts.extend(decoder.unresolved_diagnostics());
        Ok(drafts)
    }
}

impl TranscriptReplayAdapter for ClaudeTranscriptReplay {
    fn replay(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError> {
        self.replay(request)
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

fn user_text(value: &Value) -> Option<String> {
    let content = value.pointer("/message/content")?;
    if let Some(text) = content.as_str() {
        return (!text.trim().is_empty()).then(|| text.to_owned());
    }
    let text = content
        .as_array()?
        .iter()
        .filter_map(|item| {
            let item = item.as_object()?;
            (item.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| item.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

fn claude_project_dir_name(project_path: &Path) -> String {
    project_path
        .to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
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

fn find_jsonl_by_stem(root: &Path, stem: &str) -> std::io::Result<Option<PathBuf>> {
    if !root.is_dir() {
        return Ok(None);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_jsonl_by_stem(&path, stem)? {
                return Ok(Some(found));
            }
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            && path.file_stem().and_then(|value| value.to_str()) == Some(stem)
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;
    use vertebrae_harness_core::{
        HarnessEventPayloadV1, HarnessProjection, ProviderResumeId, StreamId, ToolCallId,
        ToolStatus, TranscriptReplayRequest, UpdateSemantics,
    };

    use super::*;

    #[test]
    fn discovers_project_transcript_and_replays_human_and_assistant_events() {
        let home = tempdir().unwrap();
        let project = PathBuf::from("/workspace/demo");
        let directory = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir_name(&project));
        fs::create_dir_all(&directory).unwrap();
        let transcript = directory.join("session-1.jsonl");
        fs::write(
            &transcript,
            concat!(
                "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"session-1\",\"model\":\"sonnet\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
                "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]},\"timestamp\":\"2026-01-01T00:00:01Z\"}\n",
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]},\"timestamp\":\"2026-01-01T00:00:02Z\"}\n"
            ),
        )
        .unwrap();

        let replay = ClaudeTranscriptReplay::new(Some(home.path().to_path_buf()))
            .replay(&TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("session-1"),
                stream_id: StreamId::new("replay/session-1"),
                project_path: Some(project),
                created_at: None,
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
    fn replays_tool_progress_as_ordered_running_deltas_before_terminal_result() {
        let home = tempdir().unwrap();
        let project = PathBuf::from("/workspace/progress");
        let directory = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir_name(&project));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("session-progress.jsonl"),
            concat!(
                "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"session-progress\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Bash\",\"input\":{\"command\":\"sleep 2\"}}]},\"timestamp\":\"2026-01-01T00:00:01Z\"}\n",
                "{\"type\":\"tool_progress\",\"tool_use_id\":\"tool-1\",\"tool_name\":\"Bash\",\"elapsed_time_seconds\":1.25,\"task_id\":\"task-1\",\"timestamp\":\"2026-01-01T00:00:02Z\"}\n",
                "{\"type\":\"tool_progress\",\"tool_use_id\":\"tool-1\",\"tool_name\":\"Bash\",\"elapsed_time_seconds\":2.5,\"task_id\":\"task-1\",\"timestamp\":\"2026-01-01T00:00:03Z\"}\n",
                "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool-1\",\"content\":\"done\"}]},\"timestamp\":\"2026-01-01T00:00:04Z\"}\n"
            ),
        )
        .unwrap();

        let replay = ClaudeTranscriptReplay::new(Some(home.path().to_path_buf()))
            .replay(&TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("session-progress"),
                stream_id: StreamId::new("replay/progress"),
                project_path: Some(project),
                created_at: None,
            })
            .unwrap()
            .unwrap();

        let progress = replay
            .events
            .iter()
            .filter_map(|event| match &event.payload {
                HarnessEventPayloadV1::ToolOutput(output)
                    if output.status == ToolStatus::Running =>
                {
                    Some((event, output))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(progress.len(), 2);
        assert!(progress[0].0.sequence < progress[1].0.sequence);
        assert_eq!(progress[0].1.output["elapsed_seconds"], 1.25);
        assert_eq!(progress[1].1.output["elapsed_seconds"], 2.5);
        let terminal = replay
            .events
            .iter()
            .find_map(|event| match &event.payload {
                HarnessEventPayloadV1::ToolOutput(output)
                    if output.status == ToolStatus::Completed =>
                {
                    Some((event, output))
                }
                _ => None,
            })
            .unwrap();
        assert!(progress[1].0.sequence < terminal.0.sequence);
        assert_eq!(terminal.1.content_semantics, UpdateSemantics::Snapshot);
        assert_eq!(terminal.1.output, "done");
        assert!(replay.events.iter().all(|event| !matches!(
            &event.payload,
            HarnessEventPayloadV1::Warning(warning)
                if warning.code.as_deref() == Some("claude_unknown_record")
        )));

        let mut projection = HarnessProjection::new(16);
        for event in replay.events.clone() {
            projection.ingest(event).unwrap();
        }
        let tool = &projection
            .stream(&StreamId::new("replay/progress"))
            .unwrap()
            .tools[&ToolCallId::new("tool-1")];
        assert_eq!(tool.output_deltas.len(), 2);
        assert_eq!(
            tool.output_snapshot.as_ref().unwrap().status,
            ToolStatus::Completed
        );
    }
}
