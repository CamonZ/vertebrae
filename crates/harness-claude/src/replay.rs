use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use chrono::{DateTime, Utc};
use serde_json::Value;
use vertebrae_harness_core::{
    HarnessError, HarnessEventDraftV1, ProviderThreadRef, SessionId, TranscriptReplay,
    TranscriptReplayAdapter, TranscriptReplayCache, TranscriptReplayPage,
    TranscriptReplayPageRequest, TranscriptReplayRequest, TranscriptRevision,
    sequence_replay_drafts,
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
        let revision = TranscriptRevision::capture(&path)?;
        Ok(Some(self.normalize(path, revision, request)?))
    }

    pub fn replay_page(
        &self,
        request: &TranscriptReplayRequest,
        page: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        let Some(path) = self.discover(request)? else {
            return Ok(None);
        };
        let revision = TranscriptRevision::capture(&path)?;
        let projection_key = claude_projection_key(request);
        if page.cursor.is_none() {
            let tail = self.read_tail_drafts(
                &path,
                request,
                tail_read_budget(page.limit.unwrap_or_default()),
            )?;
            revision.verify(&path)?;
            let (drafts, older_records_exist, deferred) = match tail {
                Some((drafts, older_records_exist)) => (drafts, older_records_exist, false),
                None => (Vec::new(), true, true),
            };
            let replay = TranscriptReplay {
                transcript_path: path,
                revision,
                projection_key: projection_key.clone(),
                events: sequence_replay_drafts(&projection_key, drafts),
            };
            return if deferred || (replay.events.is_empty() && older_records_exist) {
                replay.deferred_tail_page().map(Some)
            } else {
                replay.page_tail(page, older_records_exist).map(Some)
            };
        }
        if let Some(cached) = claude_replay_cache().page(&path, &revision, &projection_key, page)? {
            return Ok(Some(cached));
        }
        let normalized_path = path.clone();
        let normalized_revision = revision.clone();
        let replay = claude_replay_cache().get_or_try_insert_with(
            &path,
            &revision,
            &projection_key,
            || self.normalize(normalized_path, normalized_revision, request),
        )?;
        claude_replay_cache().retain_window_for_page(&replay, page.cursor.as_deref())?;
        replay.page(page).map(Some)
    }

    fn normalize(
        &self,
        path: PathBuf,
        revision: TranscriptRevision,
        request: &TranscriptReplayRequest,
    ) -> Result<TranscriptReplay, HarnessError> {
        let drafts = self.read_drafts(&path, request)?;
        revision.verify(&path)?;
        let projection_key = claude_projection_key(request);
        Ok(TranscriptReplay {
            transcript_path: path,
            revision,
            projection_key: projection_key.clone(),
            events: sequence_replay_drafts(&projection_key, drafts),
        })
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

        let mut reader = BufReader::new(file);
        let mut drafts = Vec::new();
        let mut offset = 0_u64;
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            let read = reader.read_until(b'\n', &mut bytes).map_err(|error| {
                HarnessError::Operation(format!(
                    "failed to read Claude transcript {} at byte {offset}: {error}",
                    path.display()
                ))
            })?;
            if read == 0 {
                break;
            }
            let source = offset.saturating_add(1);
            offset = offset.saturating_add(read as u64);
            let line = std::str::from_utf8(&bytes).map_err(|error| {
                HarnessError::Operation(format!(
                    "malformed UTF-8 in Claude transcript {} at byte {}: {error}",
                    path.display(),
                    source - 1
                ))
            })?;
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(line).map_err(|error| {
                HarnessError::Operation(format!(
                    "malformed Claude transcript {} at byte {}: {error}",
                    path.display(),
                    source - 1
                ))
            })?;
            let timestamp = record_timestamp(&value);
            let replay_user_text = (value.get("type").and_then(Value::as_str) == Some("user")
                && value.get("isMeta").and_then(Value::as_bool) != Some(true)
                && value.get("isCompactSummary").and_then(Value::as_bool) != Some(true))
            .then(|| user_text(&value))
            .flatten();
            let mut line_drafts = decoder
                .decode_value_at_sequence(value, timestamp, source)
                .map_err(|error| HarnessError::Operation(error.to_string()))?;
            if let Some(text) = replay_user_text {
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

    fn read_tail_drafts(
        &self,
        path: &Path,
        request: &TranscriptReplayRequest,
        budget: usize,
    ) -> Result<Option<(Vec<HarnessEventDraftV1>, bool)>, HarnessError> {
        let (lines, older_records_exist) = read_tail_lines(path, budget)?;
        let mut decoder = ClaudeStreamDecoder::new(ClaudeDecodeContext::interactive(
            SessionId::new(request.provider_resume_id.as_str()),
            request.stream_id.clone(),
        ));
        decoder.context_mut().provider_resume_id = Some(request.provider_resume_id.clone());
        let locator = ProviderThreadRef::new(path.to_string_lossy());
        decoder
            .resolve_root_locator(locator.clone())
            .map_err(|error| HarnessError::Operation(error.to_string()))?;
        if older_records_exist {
            decoder.prepare_bounded_replay_tail(locator);
        }
        let mut drafts = Vec::new();
        for (source, line) in lines {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&line).map_err(|error| {
                HarnessError::Operation(format!(
                    "malformed Claude transcript {} at byte {}: {error}",
                    path.display(),
                    source - 1
                ))
            })?;
            if older_records_exist && !claude_tail_record_is_context_free(&value) {
                return Ok(None);
            }
            let timestamp = record_timestamp(&value);
            let replay_user_text = (value.get("type").and_then(Value::as_str) == Some("user")
                && value.get("isMeta").and_then(Value::as_bool) != Some(true)
                && value.get("isCompactSummary").and_then(Value::as_bool) != Some(true))
            .then(|| user_text(&value))
            .flatten();
            let mut line_drafts = decoder
                .decode_value_at_sequence(value, timestamp, source)
                .map_err(|error| HarnessError::Operation(error.to_string()))?;
            if let Some(text) = replay_user_text {
                line_drafts.insert(0, decoder.replay_user_input_draft(text, timestamp));
            }
            drafts.extend(line_drafts);
        }
        drafts.extend(decoder.unresolved_diagnostics());
        Ok(Some((drafts, older_records_exist)))
    }
}

impl TranscriptReplayAdapter for ClaudeTranscriptReplay {
    fn replay(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError> {
        self.replay(request)
    }

    fn replay_page(
        &self,
        request: &TranscriptReplayRequest,
        page: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        self.replay_page(request, page)
    }
}

const NORMALIZED_REPLAY_CACHE_CAPACITY: usize = 8;

fn claude_replay_cache() -> &'static TranscriptReplayCache {
    static CACHE: OnceLock<TranscriptReplayCache> = OnceLock::new();
    CACHE.get_or_init(|| TranscriptReplayCache::new(NORMALIZED_REPLAY_CACHE_CAPACITY))
}

fn claude_projection_key(request: &TranscriptReplayRequest) -> String {
    format!(
        "claude-v2:resume={:?}:stream={:?}:project={:?}:created={:?}",
        request.provider_resume_id.as_str(),
        request.stream_id.as_str(),
        request.project_path,
        request.created_at
    )
}

const MIN_TAIL_READ_BYTES: usize = 64 * 1024;
const MAX_TAIL_READ_BYTES: usize = 1024 * 1024;

fn tail_read_budget(limit: usize) -> usize {
    limit
        .max(1)
        .saturating_mul(2 * 1024)
        .clamp(MIN_TAIL_READ_BYTES, MAX_TAIL_READ_BYTES)
}

fn read_captured_tail(reader: impl Read, captured_len: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(captured_len);
    reader.take(captured_len as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn read_tail_lines(path: &Path, budget: usize) -> Result<(Vec<(u64, String)>, bool), HarnessError> {
    let mut file = File::open(path).map_err(|error| {
        HarnessError::Operation(format!(
            "failed to open Claude transcript {}: {error}",
            path.display()
        ))
    })?;
    let len = file
        .metadata()
        .map_err(|error| HarnessError::Operation(error.to_string()))?
        .len();
    let start = len.saturating_sub(budget as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| HarnessError::Operation(error.to_string()))?;
    let bytes = read_captured_tail(file, (len - start) as usize)
        .map_err(|error| HarnessError::Operation(error.to_string()))?;
    let discard = if start > 0 {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1)
    } else {
        0
    };
    let first_offset = start.saturating_add(discard as u64);
    let text = std::str::from_utf8(&bytes[discard..]).map_err(|error| {
        HarnessError::Operation(format!(
            "malformed UTF-8 in Claude transcript {} tail: {error}",
            path.display()
        ))
    })?;
    let mut offset = first_offset;
    let lines: Vec<_> = text
        .split_inclusive('\n')
        .map(|line| {
            let source = offset.saturating_add(1);
            offset = offset.saturating_add(line.len() as u64);
            (source, line.to_owned())
        })
        .collect();
    #[cfg(test)]
    LAST_TAIL_WORK.with(|work| work.set((bytes.len(), lines.len())));
    Ok((lines, first_offset > 0))
}

#[cfg(test)]
thread_local! {
    static LAST_TAIL_WORK: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}

fn record_timestamp(value: &Value) -> DateTime<Utc> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or(DateTime::UNIX_EPOCH)
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

fn claude_tail_record_is_context_free(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.contains_key("agent_id")
        || object.contains_key("agentId")
        || object.contains_key("parent_tool_use_id")
    {
        return false;
    }
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return false;
    };
    if !matches!(kind, "assistant" | "user") {
        return false;
    }
    let Some(content) = value.pointer("/message/content") else {
        return false;
    };
    if content.is_string() {
        return kind == "user";
    }
    content.as_array().is_some_and(|blocks| {
        blocks.iter().all(|block| {
            block
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|block_type| matches!(block_type, "text" | "thinking"))
        })
    })
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
        CompactionState, HarnessEventPayloadV1, HarnessEventV1, HarnessProjection,
        ProviderResumeId, StreamId, ToolCallId, ToolStatus, TranscriptReplayRequest,
        UpdateSemantics,
    };

    use super::*;

    #[test]
    fn captured_tail_reader_does_not_follow_appended_bytes() {
        let bytes = read_captured_tail(std::io::Cursor::new(b"snapshot-appended"), 8).unwrap();
        assert_eq!(bytes, b"snapshot");
    }

    fn assert_stable_events_equal(actual: &[HarnessEventV1], expected: &[HarnessEventV1]) {
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            assert_eq!(actual.event_id, expected.event_id);
            assert_eq!(actual.stream_id, expected.stream_id);
            assert_eq!(actual.sequence, expected.sequence);
            assert_eq!(actual.correlation, expected.correlation);
            assert_eq!(actual.timestamp, expected.timestamp);
            assert_eq!(actual.semantics, expected.semantics);
            assert_eq!(actual.provider_sequence, expected.provider_sequence);
            assert_eq!(actual.payload, expected.payload);
        }
    }

    #[test]
    fn cold_newest_page_reads_and_decodes_only_a_bounded_tail() {
        let home = tempdir().unwrap();
        let project = PathBuf::from("/workspace/long-claude");
        let directory = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir_name(&project));
        fs::create_dir_all(&directory).unwrap();
        let transcript = directory.join("long-claude.jsonl");
        let mut body = String::from(
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"long-claude\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
        );
        for index in 0..20_000 {
            body.push_str(&format!(
                "{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"message-{index}\"}}]}},\"timestamp\":\"2026-01-01T00:00:00Z\"}}\n"
            ));
        }
        fs::write(&transcript, body).unwrap();
        let adapter = ClaudeTranscriptReplay::new(Some(home.path().to_path_buf()));
        let page = adapter
            .replay_page(
                &TranscriptReplayRequest {
                    provider_resume_id: ProviderResumeId::new("long-claude"),
                    stream_id: StreamId::new("replay/long-claude"),
                    project_path: Some(project),
                    created_at: None,
                },
                &TranscriptReplayPageRequest {
                    cursor: None,
                    limit: Some(10),
                },
            )
            .unwrap()
            .unwrap();
        let (bytes_read, lines_decoded) = LAST_TAIL_WORK.with(std::cell::Cell::get);

        assert_eq!(page.events.len(), 10);
        assert!(page.has_more);
        assert!(bytes_read <= tail_read_budget(10));
        assert!(bytes_read < fs::metadata(transcript).unwrap().len() as usize / 10);
        assert!(lines_decoded < 1_000);
        assert!(matches!(
            &page.events.last().unwrap().payload,
            HarnessEventPayloadV1::Text(text) if text.text == "message-19999"
        ));
        let older = adapter
            .replay_page(
                &TranscriptReplayRequest {
                    provider_resume_id: ProviderResumeId::new("long-claude"),
                    stream_id: StreamId::new("replay/long-claude"),
                    project_path: Some(PathBuf::from("/workspace/long-claude")),
                    created_at: None,
                },
                &TranscriptReplayPageRequest {
                    cursor: page.next_cursor.clone(),
                    limit: Some(10),
                },
            )
            .unwrap()
            .unwrap();
        let full = adapter
            .replay(&TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("long-claude"),
                stream_id: StreamId::new("replay/long-claude"),
                project_path: Some(PathBuf::from("/workspace/long-claude")),
                created_at: None,
            })
            .unwrap()
            .unwrap();
        let reconstructed = older
            .events
            .iter()
            .chain(&page.events)
            .cloned()
            .collect::<Vec<_>>();
        assert_stable_events_equal(
            &reconstructed,
            &full.events[full.events.len() - reconstructed.len()..],
        );
    }

    #[test]
    fn projection_identity_includes_every_replay_request_input() {
        let base = TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new("resume-a"),
            stream_id: StreamId::new("stream-a"),
            project_path: Some(PathBuf::from("/project/a")),
            created_at: Some("2026-01-01".into()),
        };
        let mut variants = Vec::new();
        variants.push(TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new("resume-b"),
            ..base.clone()
        });
        variants.push(TranscriptReplayRequest {
            stream_id: StreamId::new("stream-b"),
            ..base.clone()
        });
        variants.push(TranscriptReplayRequest {
            project_path: Some(PathBuf::from("/project/b")),
            ..base.clone()
        });
        variants.push(TranscriptReplayRequest {
            created_at: Some("2026-01-02".into()),
            ..base.clone()
        });
        for variant in variants {
            assert_ne!(
                claude_projection_key(&base),
                claude_projection_key(&variant)
            );
        }
    }

    #[test]
    fn bounded_tail_defers_when_subagent_lineage_is_outside_the_window() {
        let home = tempdir().unwrap();
        let project = PathBuf::from("/workspace/lineage-tail");
        let directory = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir_name(&project));
        fs::create_dir_all(&directory).unwrap();
        let transcript = directory.join("lineage-tail.jsonl");
        let mut body = String::from(concat!(
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"lineage-tail\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"spawn\",\"name\":\"Task\",\"input\":{\"prompt\":\"research\"}}]},\"timestamp\":\"2026-01-01T00:00:01Z\"}\n"
        ));
        for index in 0..10_000 {
            body.push_str(&format!(
                "{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"padding-{index}\"}}]}},\"timestamp\":\"2026-01-01T00:00:02Z\"}}\n"
            ));
        }
        body.push_str("{\"type\":\"assistant\",\"agent_id\":\"child\",\"parent_tool_use_id\":\"spawn\",\"transcript_path\":\"subagents/child.jsonl\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"child newest\"}]},\"timestamp\":\"2026-01-01T00:00:03Z\"}\n");
        fs::write(&transcript, body).unwrap();
        let adapter = ClaudeTranscriptReplay::new(Some(home.path().to_path_buf()));
        let request = TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new("lineage-tail"),
            stream_id: StreamId::new("replay/lineage-tail"),
            project_path: Some(project),
            created_at: None,
        };

        let head = adapter
            .replay_page(
                &request,
                &TranscriptReplayPageRequest {
                    cursor: None,
                    limit: Some(10),
                },
            )
            .unwrap()
            .unwrap();
        let (bytes_read, _) = LAST_TAIL_WORK.with(std::cell::Cell::get);
        assert!(head.events.is_empty());
        assert!(head.has_more);
        assert!(bytes_read <= tail_read_budget(10));

        let newest = adapter
            .replay_page(
                &request,
                &TranscriptReplayPageRequest {
                    cursor: head.next_cursor,
                    limit: Some(10),
                },
            )
            .unwrap()
            .unwrap();
        assert!(newest.events.iter().any(|event| {
            matches!(&event.payload, HarnessEventPayloadV1::Text(text) if text.text == "child newest")
                && event.correlation.thread_id.as_ref().is_some_and(|id| id.as_str() == "child")
        }));
        assert!(newest.events.iter().all(|event| !matches!(
            &event.payload,
            HarnessEventPayloadV1::Warning(warning)
                if warning.code.as_deref() == Some("claude_unresolved_agent")
        )));
    }

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
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]},\"timestamp\":\"invalid\"}\n"
            ),
        )
        .unwrap();

        let adapter = ClaudeTranscriptReplay::new(Some(home.path().to_path_buf()));
        let request = TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new("session-1"),
            stream_id: StreamId::new("replay/session-1"),
            project_path: Some(project),
            created_at: None,
        };
        let replay = adapter.replay(&request).unwrap().unwrap();

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
        assert!(replay.events.iter().any(|event| {
            matches!(event.payload, HarnessEventPayloadV1::Text(ref text) if text.text == "hi")
                && event.timestamp == DateTime::UNIX_EPOCH
        }));

        let mut cursor = None;
        let mut paged = Vec::new();
        loop {
            let page = adapter
                .replay_page(
                    &request,
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
        assert_stable_events_equal(&paged, &replay.events);
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
            projection.ingest_replay(event).unwrap();
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

    #[test]
    fn replays_compaction_lifecycle_through_the_shared_decoder() {
        let home = tempdir().unwrap();
        let project = PathBuf::from("/workspace/compaction");
        let directory = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir_name(&project));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("session-compaction.jsonl"),
            concat!(
                "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"session-compaction\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
                "{\"type\":\"system\",\"subtype\":\"status\",\"status\":\"compacting\",\"timestamp\":\"2026-01-01T00:00:01Z\"}\n",
                "{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"compact_metadata\":{\"trigger\":\"auto\",\"pre_tokens\":4096},\"timestamp\":\"2026-01-01T00:00:02Z\"}\n",
                "{\"type\":\"user\",\"isCompactSummary\":true,\"message\":{\"content\":\"continued\"},\"timestamp\":\"2026-01-01T00:00:03Z\"}\n"
            ),
        )
        .unwrap();

        let replay = ClaudeTranscriptReplay::new(Some(home.path().to_path_buf()))
            .replay(&TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("session-compaction"),
                stream_id: StreamId::new("replay/compaction"),
                project_path: Some(project),
                created_at: None,
            })
            .unwrap()
            .unwrap();
        let compactions = replay
            .events
            .iter()
            .filter_map(|event| match &event.payload {
                HarnessEventPayloadV1::Compaction(value) => Some((event, value)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(compactions.len(), 2);
        assert_eq!(compactions[0].1.state, CompactionState::Active);
        assert_eq!(compactions[1].1.state, CompactionState::Completed);
        assert_eq!(compactions[1].1.trigger.as_deref(), Some("auto"));
        assert_eq!(compactions[1].1.pre_tokens, Some(4096));
        assert!(compactions[0].0.sequence < compactions[1].0.sequence);
        assert!(
            replay
                .events
                .iter()
                .all(|event| { !matches!(event.payload, HarnessEventPayloadV1::TurnInput(_)) })
        );
    }
}
