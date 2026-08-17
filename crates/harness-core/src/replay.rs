use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::{HarnessError, HarnessEventV1, ProviderResumeId, StreamId};

/// Provider-neutral inputs needed to locate one durable provider transcript.
///
/// The adapter owns the meaning of `project_path` and `created_at`; they are
/// deliberately opaque to the shared contract so provider-specific directory
/// layouts do not leak into surfaces or the reducer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptReplayRequest {
    pub provider_resume_id: ProviderResumeId,
    pub stream_id: StreamId,
    pub project_path: Option<PathBuf>,
    pub created_at: Option<String>,
}

/// A discovered transcript projected into the durable V1 event contract.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptReplay {
    pub transcript_path: PathBuf,
    /// Revision captured before decoding and verified after decoding.
    pub revision: TranscriptRevision,
    /// Adapter-owned normalizer/version namespace plus the replay stream.
    pub projection_key: String,
    pub events: Vec<HarnessEventV1>,
}

/// Provider-neutral file revision used to prevent mixing transcript pages.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TranscriptRevision {
    byte_len: u64,
    modified_nanos: u128,
}

impl TranscriptRevision {
    /// Capture the metadata revision immediately before provider decoding.
    pub fn capture(path: &Path) -> Result<Self, HarnessError> {
        let metadata = fs::metadata(path).map_err(|error| {
            HarnessError::Operation(format!(
                "failed to inspect replay transcript {}: {error}",
                path.display()
            ))
        })?;
        let modified_nanos = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        Ok(Self {
            byte_len: metadata.len(),
            modified_nanos,
        })
    }

    /// Ensure decoding finished against the same provider transcript revision.
    pub fn verify(&self, path: &Path) -> Result<(), HarnessError> {
        if &Self::capture(path)? == self {
            return Ok(());
        }
        Err(HarnessError::Operation(
            "provider transcript changed while replay was being decoded; retry the replay".into(),
        ))
    }
}

/// Default number of normalized events returned for one replay page.
pub const DEFAULT_TRANSCRIPT_REPLAY_PAGE_SIZE: usize = 200;

/// Upper bound applied to surface-provided replay page sizes.
pub const MAX_TRANSCRIPT_REPLAY_PAGE_SIZE: usize = 1_000;

/// Provider-neutral page request for a durable transcript replay.
///
/// `cursor` is opaque outside the harness boundary. Omitting it requests the
/// newest page. A returned cursor requests the page immediately preceding the
/// current one. Events within every page remain in chronological order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranscriptReplayPageRequest {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

/// One chronological page from a normalized durable transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptReplayPage {
    /// Opaque identity for the provider transcript revision used by this page.
    pub cache_key: String,
    pub events: Vec<HarnessEventV1>,
    /// Cursor for the next older page, when one exists.
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

impl TranscriptReplay {
    /// Page an already-normalized replay from newest to oldest without changing
    /// the chronological ordering inside each returned page.
    pub fn page(
        &self,
        request: &TranscriptReplayPageRequest,
    ) -> Result<TranscriptReplayPage, HarnessError> {
        self.revision.verify(&self.transcript_path)?;
        let cache_key = transcript_cache_key(self);
        let end = match request.cursor.as_deref() {
            Some(cursor) => decode_cursor(cursor, &cache_key)?,
            None => self.events.len(),
        };
        if end > self.events.len() {
            return Err(HarnessError::InvalidRequest(
                "transcript replay cursor is outside the available event range".into(),
            ));
        }
        let limit = request
            .limit
            .unwrap_or(DEFAULT_TRANSCRIPT_REPLAY_PAGE_SIZE)
            .clamp(1, MAX_TRANSCRIPT_REPLAY_PAGE_SIZE);
        let start = end.saturating_sub(limit);
        let has_more = start > 0;
        Ok(TranscriptReplayPage {
            cache_key: cache_key.clone(),
            events: self.events[start..end].to_vec(),
            next_cursor: has_more.then(|| encode_cursor(&cache_key, start)),
            has_more,
        })
    }
}

/// Provider adapters implement discovery, parsing, and normalization for
/// their own durable transcript formats. Callers never need to inspect a
/// provider JSONL line or know where that provider stores it.
pub trait TranscriptReplayAdapter: Send + Sync {
    fn replay(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError>;

    /// Load one normalized replay page. Adapters may override this to use a
    /// provider-owned index or cache; the default preserves compatibility by
    /// paging the full normalized replay.
    fn replay_page(
        &self,
        request: &TranscriptReplayRequest,
        page: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        self.replay(request)?
            .map(|replay| replay.page(page))
            .transpose()
    }
}

fn transcript_cache_key(replay: &TranscriptReplay) -> String {
    let mut hasher = DefaultHasher::new();
    replay.transcript_path.hash(&mut hasher);
    replay.revision.hash(&mut hasher);
    replay.projection_key.hash(&mut hasher);
    format!("v1-{:016x}", hasher.finish())
}

fn encode_cursor(cache_key: &str, before_event: usize) -> String {
    format!("{cache_key}:{before_event}")
}

fn decode_cursor(cursor: &str, expected_cache_key: &str) -> Result<usize, HarnessError> {
    let (cache_key, before_event) = cursor
        .rsplit_once(':')
        .ok_or_else(|| HarnessError::InvalidRequest("malformed transcript replay cursor".into()))?;
    if cache_key != expected_cache_key {
        return Err(HarnessError::InvalidRequest(
            "transcript replay cursor no longer matches the transcript revision".into(),
        ));
    }
    before_event
        .parse::<usize>()
        .map_err(|_| HarnessError::InvalidRequest("malformed transcript replay cursor".into()))
}

#[cfg(test)]
mod tests {
    use tempfile::NamedTempFile;

    use super::*;
    use crate::{
        EventCorrelation, EventId, HarnessEventPayloadV1, StreamId, TextEvent, UpdateSemantics,
    };
    use chrono::Utc;

    fn event(sequence: u64) -> HarnessEventV1 {
        HarnessEventV1 {
            event_id: EventId::new(format!("event-{sequence}")),
            stream_id: StreamId::new("replay/test"),
            sequence,
            correlation: EventCorrelation::default(),
            timestamp: Utc::now(),
            semantics: UpdateSemantics::Snapshot,
            provider_sequence: Some(sequence),
            payload: HarnessEventPayloadV1::Text(TextEvent {
                text: sequence.to_string(),
            }),
        }
    }

    #[test]
    fn replay_pages_prepend_to_the_full_chronological_order() {
        let transcript = NamedTempFile::new().expect("transcript");
        let replay = TranscriptReplay {
            transcript_path: transcript.path().to_path_buf(),
            revision: TranscriptRevision::capture(transcript.path()).expect("revision"),
            projection_key: "test-v1:replay/test".into(),
            events: (1..=7).map(event).collect(),
        };
        let newest = replay
            .page(&TranscriptReplayPageRequest {
                cursor: None,
                limit: Some(3),
            })
            .expect("newest page");
        let middle = replay
            .page(&TranscriptReplayPageRequest {
                cursor: newest.next_cursor.clone(),
                limit: Some(3),
            })
            .expect("middle page");
        let oldest = replay
            .page(&TranscriptReplayPageRequest {
                cursor: middle.next_cursor.clone(),
                limit: Some(3),
            })
            .expect("oldest page");

        assert_eq!(
            newest
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![5, 6, 7]
        );
        assert_eq!(
            middle
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert_eq!(
            oldest
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert!(!oldest.has_more);
        let reconstructed = oldest
            .events
            .iter()
            .chain(&middle.events)
            .chain(&newest.events)
            .map(|event| event.sequence)
            .collect::<Vec<_>>();
        assert_eq!(reconstructed, (1..=7).collect::<Vec<_>>());
    }

    #[test]
    fn replay_cursor_rejects_a_changed_transcript_revision() {
        let mut transcript = NamedTempFile::new().expect("transcript");
        std::io::Write::write_all(&mut transcript, b"first").expect("write transcript");
        let replay = TranscriptReplay {
            transcript_path: transcript.path().to_path_buf(),
            revision: TranscriptRevision::capture(transcript.path()).expect("revision"),
            projection_key: "test-v1:replay/test".into(),
            events: (1..=2).map(event).collect(),
        };
        let cursor = replay
            .page(&TranscriptReplayPageRequest {
                cursor: None,
                limit: Some(1),
            })
            .expect("first page")
            .next_cursor;
        std::io::Write::write_all(&mut transcript, b" changed").expect("change transcript");

        let changed_replay = TranscriptReplay {
            transcript_path: transcript.path().to_path_buf(),
            revision: TranscriptRevision::capture(transcript.path()).expect("changed revision"),
            projection_key: replay.projection_key.clone(),
            events: replay.events.clone(),
        };

        let error = changed_replay
            .page(&TranscriptReplayPageRequest {
                cursor,
                limit: Some(1),
            })
            .expect_err("stale cursor");
        assert!(error.to_string().contains("no longer matches"));
    }

    #[test]
    fn replay_cursor_is_namespaced_by_projection_identity() {
        let transcript = NamedTempFile::new().expect("transcript");
        let replay = TranscriptReplay {
            transcript_path: transcript.path().to_path_buf(),
            revision: TranscriptRevision::capture(transcript.path()).expect("revision"),
            projection_key: "claude-v1:local-replay/session-a".into(),
            events: (1..=2).map(event).collect(),
        };
        let cursor = replay
            .page(&TranscriptReplayPageRequest {
                cursor: None,
                limit: Some(1),
            })
            .expect("first page")
            .next_cursor;
        let other_projection = TranscriptReplay {
            projection_key: "claude-v1:local-replay/session-b".into(),
            ..replay
        };

        let error = other_projection
            .page(&TranscriptReplayPageRequest {
                cursor,
                limit: Some(1),
            })
            .expect_err("foreign projection cursor");
        assert!(error.to_string().contains("no longer matches"));
    }
}
