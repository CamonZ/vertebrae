use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use chrono::NaiveDate;
use vertebrae_harness_core::{
    HarnessError, TranscriptReplay, TranscriptReplayAdapter, TranscriptReplayCache,
    TranscriptReplayPage, TranscriptReplayPageRequest, TranscriptReplayRequest, TranscriptRevision,
    load_transcript_page, sequence_replay_drafts, tail_read_budget,
};

use crate::rollout::{read_rollout, read_rollout_tail};

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
        let projection_key = codex_projection_key(request);
        let tail_path = path.clone();
        let budget = tail_read_budget(page.limit.unwrap_or_default());
        let normalized_path = path.clone();
        let normalized_revision = revision.clone();
        load_transcript_page(
            page,
            codex_replay_cache(),
            path,
            revision,
            &projection_key,
            move || read_rollout_tail(&tail_path, request, budget),
            || self.normalize(normalized_path, normalized_revision, request),
        )
    }

    fn normalize(
        &self,
        path: PathBuf,
        revision: TranscriptRevision,
        request: &TranscriptReplayRequest,
    ) -> Result<TranscriptReplay, HarnessError> {
        let drafts = read_rollout(&path, request)?;
        revision.verify(&path)?;
        let projection_key = codex_projection_key(request);
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

    fn replay_page(
        &self,
        request: &TranscriptReplayRequest,
        page: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        self.replay_page(request, page)
    }
}

const NORMALIZED_REPLAY_CACHE_CAPACITY: usize = 8;

fn codex_replay_cache() -> &'static TranscriptReplayCache {
    static CACHE: OnceLock<TranscriptReplayCache> = OnceLock::new();
    CACHE.get_or_init(|| TranscriptReplayCache::new(NORMALIZED_REPLAY_CACHE_CAPACITY))
}

fn codex_projection_key(request: &TranscriptReplayRequest) -> String {
    format!(
        "codex-v2:resume={:?}:stream={:?}:project={:?}:created={:?}",
        request.provider_resume_id.as_str(),
        request.stream_id.as_str(),
        request.project_path,
        request.created_at
    )
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

    use chrono::{DateTime, Utc};
    use tempfile::tempdir;
    use vertebrae_harness_core::{
        HarnessEventPayloadV1, HarnessEventV1, ProviderResumeId, StreamId, TranscriptReplayRequest,
    };

    use super::*;

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
        let directory = home.path().join(".codex/sessions/2026/01/01");
        fs::create_dir_all(&directory).unwrap();
        let transcript = directory.join("rollout-long-codex.jsonl");
        let mut body = String::new();
        for index in 0..20_000 {
            body.push_str(&format!(
                "{{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"message-{index}\"}}]}}}}\n"
            ));
        }
        fs::write(&transcript, body).unwrap();
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_path_buf()));
        let page = adapter
            .replay_page(
                &TranscriptReplayRequest {
                    provider_resume_id: ProviderResumeId::new("long-codex"),
                    stream_id: StreamId::new("replay/long-codex"),
                    project_path: None,
                    created_at: Some("2026-01-01T00:00:00Z".into()),
                },
                &TranscriptReplayPageRequest {
                    cursor: None,
                    limit: Some(10),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(page.events.len(), 10);
        assert!(page.has_more);
        let tail = read_rollout_tail(
            &transcript,
            &TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("long-codex"),
                stream_id: StreamId::new("replay/long-codex"),
                project_path: None,
                created_at: Some("2026-01-01T00:00:00Z".into()),
            },
            tail_read_budget(10),
        )
        .unwrap();
        assert!(tail.bytes_read <= tail_read_budget(10));
        assert!(
            tail.bytes_read < fs::metadata(&transcript).unwrap().len() as usize / 10,
            "cold tail read {} bytes of a {} byte transcript",
            tail.bytes_read,
            fs::metadata(&transcript).unwrap().len()
        );
        assert!(tail.drafts.len() < 1_000);
        assert!(matches!(
            &page.events.last().unwrap().payload,
            HarnessEventPayloadV1::Text(text) if text.text == "message-19999"
        ));
        let older = adapter
            .replay_page(
                &TranscriptReplayRequest {
                    provider_resume_id: ProviderResumeId::new("long-codex"),
                    stream_id: StreamId::new("replay/long-codex"),
                    project_path: None,
                    created_at: Some("2026-01-01T00:00:00Z".into()),
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
                provider_resume_id: ProviderResumeId::new("long-codex"),
                stream_id: StreamId::new("replay/long-codex"),
                project_path: None,
                created_at: Some("2026-01-01T00:00:00Z".into()),
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
        let variants = [
            TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("resume-b"),
                ..base.clone()
            },
            TranscriptReplayRequest {
                stream_id: StreamId::new("stream-b"),
                ..base.clone()
            },
            TranscriptReplayRequest {
                project_path: Some(PathBuf::from("/project/b")),
                ..base.clone()
            },
            TranscriptReplayRequest {
                created_at: Some("2026-01-02".into()),
                ..base.clone()
            },
        ];
        for variant in variants {
            assert_ne!(codex_projection_key(&base), codex_projection_key(&variant));
        }
    }

    #[test]
    fn oversized_newest_record_defers_without_unbounded_cold_normalization() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions/2026/01/01");
        fs::create_dir_all(&directory).unwrap();
        let transcript = directory.join("rollout-oversized-tail.jsonl");
        let huge = "x".repeat(tail_read_budget(usize::MAX) + 128 * 1024);
        fs::write(
            &transcript,
            format!(
                "{{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"oversized-tail\"}}}}\n{{\"timestamp\":\"2026-01-01T00:00:01Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"{huge}\"}}]}}}}\n"
            ),
        )
        .unwrap();
        let page = CodexTranscriptReplay::new(Some(home.path().to_path_buf()))
            .replay_page(
                &TranscriptReplayRequest {
                    provider_resume_id: ProviderResumeId::new("oversized-tail"),
                    stream_id: StreamId::new("replay/oversized-tail"),
                    project_path: None,
                    created_at: Some("2026-01-01T00:00:00Z".into()),
                },
                &TranscriptReplayPageRequest {
                    cursor: None,
                    limit: Some(10),
                },
            )
            .unwrap()
            .unwrap();
        assert!(page.events.is_empty());
        assert!(page.has_more);
        assert!(page.next_cursor.is_some());
        let tail = read_rollout_tail(
            &transcript,
            &TranscriptReplayRequest {
                provider_resume_id: ProviderResumeId::new("oversized-tail"),
                stream_id: StreamId::new("replay/oversized-tail"),
                project_path: None,
                created_at: Some("2026-01-01T00:00:00Z".into()),
            },
            tail_read_budget(10),
        )
        .unwrap();
        assert_eq!(tail.bytes_read, tail_read_budget(10));
        assert!(tail.drafts.is_empty());
    }

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
                "{\"timestamp\":\"invalid\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hi\"}]}}\n"
            ),
        )
        .unwrap();
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_path_buf()));
        let request = TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new("session-1"),
            stream_id: StreamId::new("replay/session-1"),
            project_path: None,
            created_at: Some("2026-01-01T00:00:00Z".into()),
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
    fn empty_transcript_pages_match_full_replay_with_a_stable_timestamp() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions/2026/01/01");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("rollout-empty-session.jsonl"), "").unwrap();
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_path_buf()));
        let request = TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new("empty-session"),
            stream_id: StreamId::new("replay/empty-session"),
            project_path: None,
            created_at: Some("2026-01-01T00:00:00Z".into()),
        };

        let replay = adapter.replay(&request).unwrap().unwrap();
        let mut cursor = None;
        let mut paged = Vec::new();
        loop {
            let page = adapter
                .replay_page(
                    &request,
                    &TranscriptReplayPageRequest {
                        cursor,
                        limit: Some(1),
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

        assert_eq!(replay.events.len(), 2);
        assert!(
            replay
                .events
                .iter()
                .all(|event| event.timestamp == DateTime::UNIX_EPOCH)
        );
        assert_stable_events_equal(&paged, &replay.events);
    }

    #[test]
    fn id_less_file_change_has_stable_identity_across_full_and_paged_replay() {
        let home = tempdir().unwrap();
        let directory = home.path().join(".codex/sessions/2026/01/01");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("rollout-file-change.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-01-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"file-change\"}}\n",
                "{\"timestamp\":\"2026-01-01T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"patch_apply_end\",\"changes\":{\"src/lib.rs\":{\"type\":\"update\",\"diff\":\"+changed\"}}}}\n"
            ),
        )
        .unwrap();
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_path_buf()));
        let request = TranscriptReplayRequest {
            provider_resume_id: ProviderResumeId::new("file-change"),
            stream_id: StreamId::new("replay/file-change"),
            project_path: None,
            created_at: Some("2026-01-01T00:00:00Z".into()),
        };

        let first_full = adapter.replay(&request).unwrap().unwrap();
        let second_full = adapter.replay(&request).unwrap().unwrap();
        let page = adapter
            .replay_page(
                &request,
                &TranscriptReplayPageRequest {
                    cursor: None,
                    limit: Some(10),
                },
            )
            .unwrap()
            .unwrap();
        let full_change = first_full
            .events
            .iter()
            .find(|event| matches!(event.payload, HarnessEventPayloadV1::FileChange(_)))
            .unwrap();
        let second_change = second_full
            .events
            .iter()
            .find(|event| matches!(event.payload, HarnessEventPayloadV1::FileChange(_)))
            .unwrap();
        let paged_change = page
            .events
            .iter()
            .find(|event| matches!(event.payload, HarnessEventPayloadV1::FileChange(_)))
            .unwrap();

        assert_eq!(full_change.event_id, second_change.event_id);
        assert_eq!(full_change.event_id, paged_change.event_id);
        assert_eq!(full_change.sequence, paged_change.sequence);
        assert_eq!(full_change.payload, paged_change.payload);
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
