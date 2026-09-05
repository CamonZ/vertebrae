//! Provider-neutral durable transcript replay contract.
//!
//! Provider adapters implement discovery, parsing, and normalization for their
//! own durable transcript formats. Callers never need to inspect a provider
//! JSONL line or know where that provider stores it. Paging, cursors, revision
//! consistency, caching, and bounded cold reads are shared here.

mod adapter;
mod cache;
mod cursor;
mod revision;
mod tail;

pub use adapter::{record_timestamp, safe_filename, validated_file};
pub use cache::TranscriptReplayCache;
pub use revision::TranscriptRevision;
pub use tail::{TranscriptTailLines, tail_read_budget};

use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    path::PathBuf,
};

use uuid::Uuid;

use crate::{HarnessError, HarnessEventDraftV1, HarnessEventV1, ProviderResumeId, StreamId};

use cursor::{CursorBoundary, decode_cursor, encode_deferred_cursor, encode_event_cursor};

pub const DEFAULT_TRANSCRIPT_REPLAY_PAGE_SIZE: usize = 200;

pub const MAX_TRANSCRIPT_REPLAY_PAGE_SIZE: usize = 1_000;

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

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptReplayPage {
    /// Opaque identity for the provider transcript revision used by this page.
    pub cache_key: String,
    pub events: Vec<HarnessEventV1>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

/// One bounded cold tail read of provider records, in provider-decoded draft
/// form. Providers implement the decode step; the driver below owns paging.
pub struct TailReadOutcome {
    /// Normalized drafts from the bounded tail, in order.
    pub drafts: Vec<HarnessEventDraftV1>,
    /// True when the transcript has records before the read window.
    pub older_records_exist: bool,
    /// Bytes actually read from the transcript, for bounded-read assertions.
    pub bytes_read: usize,
}

impl TranscriptReplay {
    pub fn page(
        &self,
        request: &TranscriptReplayPageRequest,
    ) -> Result<TranscriptReplayPage, HarnessError> {
        self.revision.verify(&self.transcript_path)?;
        let cache_key = transcript_cache_key(self);
        let end = match request.cursor.as_deref() {
            Some(cursor) => match decode_cursor(cursor, &cache_key)? {
                CursorBoundary::TranscriptEnd => self.events.len(),
                CursorBoundary::Event(before_event_id) => self
                    .events
                    .iter()
                    .position(|event| event.event_id.as_str() == before_event_id)
                    .ok_or_else(|| {
                        HarnessError::InvalidRequest(
                            "transcript replay cursor is outside the retained event window".into(),
                        )
                    })?,
            },
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
            next_cursor: has_more
                .then(|| encode_event_cursor(&cache_key, self.events[start].event_id.as_str())),
            has_more,
        })
    }

    pub fn page_tail(
        &self,
        request: &TranscriptReplayPageRequest,
        older_records_exist: bool,
    ) -> Result<TranscriptReplayPage, HarnessError> {
        let mut page = self.page(request)?;
        if older_records_exist && !self.events.is_empty() {
            page.has_more = true;
            if page.next_cursor.is_none() {
                page.next_cursor = Some(encode_event_cursor(
                    &page.cache_key,
                    self.events[0].event_id.as_str(),
                ));
            }
        }
        Ok(page)
    }

    pub fn deferred_tail_page(&self) -> Result<TranscriptReplayPage, HarnessError> {
        self.revision.verify(&self.transcript_path)?;
        let cache_key = transcript_cache_key(self);
        Ok(TranscriptReplayPage {
            cache_key: cache_key.clone(),
            events: Vec::new(),
            next_cursor: Some(encode_deferred_cursor(&cache_key)),
            has_more: true,
        })
    }
}

/// Assign replay-only deterministic IDs and source-position ordering.
/// Provider sequence is the durable JSONL byte position, and the low bits
/// distinguish multiple normalized events emitted from the same record.
pub fn sequence_replay_drafts(
    projection_key: &str,
    drafts: impl IntoIterator<Item = HarnessEventDraftV1>,
) -> Vec<HarnessEventV1> {
    let mut occurrences = HashMap::<u64, u64>::new();
    drafts
        .into_iter()
        .map(|draft| {
            let source = draft.provider_sequence.unwrap_or_default();
            let occurrence = occurrences.entry(source).or_default();
            *occurrence = occurrence.saturating_add(1);
            let sequence = source.saturating_mul(65_536).saturating_add(*occurrence);
            let event_id = crate::EventId::new(format!(
                "replay-{}",
                Uuid::new_v5(
                    &Uuid::NAMESPACE_OID,
                    format!("{projection_key}:{sequence}").as_bytes(),
                )
            ));
            HarnessEventV1 {
                event_id,
                stream_id: draft.stream_id,
                sequence,
                correlation: draft.correlation,
                timestamp: draft.timestamp,
                semantics: draft.semantics,
                provider_sequence: draft.provider_sequence,
                payload: draft.payload,
            }
        })
        .collect()
}

/// Provider adapters implement discovery, parsing, and normalization for
/// their own durable transcript formats.
pub trait TranscriptReplayAdapter: Send + Sync {
    fn replay(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError>;

    /// Load one normalized replay page.
    ///
    /// The shared [`load_transcript_page`] driver implements the three-step
    /// paging flow; adapters wire it up with their cache and provider-owned
    /// closures and delegate here.
    fn replay_page(
        &self,
        request: &TranscriptReplayRequest,
        page: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError>;
}

/// Shared driver for the adapter `replay_page` methods.
///
/// Adapters supply their discovered transcript identity, projection key, cache
/// instance, and two provider-owned closures: a bounded tail reader and a full
/// normalizer. This function owns every branching decision, cursor check, and
/// cache interaction so both adapters share one implementation of the flow.
pub fn load_transcript_page(
    page: &TranscriptReplayPageRequest,
    cache: &TranscriptReplayCache,
    transcript_path: PathBuf,
    revision: TranscriptRevision,
    projection_key: &str,
    read_tail: impl FnOnce() -> Result<TailReadOutcome, HarnessError>,
    normalize: impl FnOnce() -> Result<TranscriptReplay, HarnessError>,
) -> Result<Option<TranscriptReplayPage>, HarnessError> {
    if page.cursor.is_none() {
        return load_cold_newest_page(transcript_path, revision, projection_key, page, read_tail);
    }
    if let Some(cached) = cache.page(&transcript_path, &revision, projection_key, page)? {
        return Ok(Some(cached));
    }
    let replay =
        cache.get_or_try_insert_with(&transcript_path, &revision, projection_key, normalize)?;
    cache.retain_window_for_page(&replay, page.cursor.as_deref())?;
    replay.page(page).map(Some)
}

fn load_cold_newest_page(
    transcript_path: PathBuf,
    revision: TranscriptRevision,
    projection_key: &str,
    page: &TranscriptReplayPageRequest,
    read_tail: impl FnOnce() -> Result<TailReadOutcome, HarnessError>,
) -> Result<Option<TranscriptReplayPage>, HarnessError> {
    let tail = read_tail()?;
    revision.verify(&transcript_path)?;
    let replay = TranscriptReplay {
        transcript_path,
        revision,
        projection_key: projection_key.to_owned(),
        events: sequence_replay_drafts(projection_key, tail.drafts),
    };
    if replay.events.is_empty() && tail.older_records_exist {
        // The bounded tail produced no decodable records but older ones exist:
        // defer to the full normalization path via a deferred cursor.
        return replay.deferred_tail_page().map(Some);
    }
    replay.page_tail(page, tail.older_records_exist).map(Some)
}

fn transcript_cache_key(replay: &TranscriptReplay) -> String {
    let mut hasher = DefaultHasher::new();
    replay.transcript_path.hash(&mut hasher);
    replay.revision.hash(&mut hasher);
    replay.projection_key.hash(&mut hasher);
    format!("v1-{:016x}", hasher.finish())
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
                ..Default::default()
            }),
        }
    }

    fn replay_with_events(path: &std::path::Path, events: Vec<HarnessEventV1>) -> TranscriptReplay {
        TranscriptReplay {
            transcript_path: path.to_path_buf(),
            revision: TranscriptRevision::capture(path).expect("revision"),
            projection_key: "test-v1:replay/test".into(),
            events,
        }
    }

    #[test]
    fn replay_pages_prepend_to_the_full_chronological_order() {
        let transcript = NamedTempFile::new().expect("transcript");
        let replay = replay_with_events(transcript.path(), (1..=7).map(event).collect());
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
    fn replay_cursor_round_trips_opaque_event_ids_without_sentinel_collisions() {
        let transcript = NamedTempFile::new().expect("transcript");
        let mut events = (1..=3).map(event).collect::<Vec<_>>();
        events[1].event_id = EventId::new("__transcript_end__");
        events[2].event_id = EventId::new("provider:opaque:event");
        let replay = replay_with_events(transcript.path(), events);

        let newest = replay
            .page(&TranscriptReplayPageRequest {
                cursor: None,
                limit: Some(1),
            })
            .expect("newest page");
        let middle = replay
            .page(&TranscriptReplayPageRequest {
                cursor: newest.next_cursor,
                limit: Some(1),
            })
            .expect("middle page");
        let oldest = replay
            .page(&TranscriptReplayPageRequest {
                cursor: middle.next_cursor,
                limit: Some(1),
            })
            .expect("oldest page");

        assert_eq!(newest.events[0].event_id.as_str(), "provider:opaque:event");
        assert_eq!(middle.events[0].event_id.as_str(), "__transcript_end__");
        assert_eq!(oldest.events[0].event_id.as_str(), "event-1");
        assert!(!oldest.has_more);
    }

    #[test]
    fn replay_cursor_rejects_a_changed_transcript_revision() {
        let mut transcript = NamedTempFile::new().expect("transcript");
        std::io::Write::write_all(&mut transcript, b"first").expect("write transcript");
        let replay = replay_with_events(transcript.path(), (1..=2).map(event).collect());
        let cursor = replay
            .page(&TranscriptReplayPageRequest {
                cursor: None,
                limit: Some(1),
            })
            .expect("first page")
            .next_cursor;
        std::io::Write::write_all(&mut transcript, b" changed").expect("change transcript");

        let changed_replay = TranscriptReplay {
            revision: TranscriptRevision::capture(transcript.path()).expect("changed revision"),
            ..replay
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
        let replay = replay_with_events(transcript.path(), (1..=2).map(event).collect());
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
