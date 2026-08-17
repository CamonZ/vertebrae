use std::{
    collections::{HashMap, VecDeque, hash_map::DefaultHasher},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::UNIX_EPOCH,
};

use crate::{HarnessError, HarnessEventDraftV1, HarnessEventV1, ProviderResumeId, StreamId};
use uuid::Uuid;

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

/// Bounded LRU cache for provider-normalized transcript revisions.
///
/// Providers own cache instances and all transcript discovery/decoding. This
/// shared container stores only the provider-neutral replay projection.
#[derive(Debug)]
pub struct TranscriptReplayCache {
    max_entries: usize,
    max_events: usize,
    max_bytes: usize,
    entries: Mutex<VecDeque<CachedReplay>>,
    in_flight: Mutex<HashMap<TranscriptReplayCacheKey, Arc<ReplayFlight>>>,
}

#[derive(Debug)]
struct CachedReplay {
    replay: Arc<TranscriptReplay>,
    events: usize,
    bytes: usize,
    older_records_exist: bool,
}

#[derive(Debug, Default)]
struct ReplayFlight {
    outcome: Mutex<Option<Result<Arc<TranscriptReplay>, String>>>,
    ready: Condvar,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TranscriptReplayCacheKey {
    transcript_path: PathBuf,
    revision: TranscriptRevision,
    projection_key: String,
}

impl TranscriptReplayCache {
    pub fn new(capacity: usize) -> Self {
        Self::with_limits(capacity, capacity.saturating_mul(100_000), 64 * 1024 * 1024)
    }

    pub fn with_limits(max_entries: usize, max_events: usize, max_bytes: usize) -> Self {
        Self {
            max_entries: max_entries.max(1),
            max_events: max_events.max(1),
            max_bytes: max_bytes.max(1),
            entries: Mutex::new(VecDeque::new()),
            in_flight: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(
        &self,
        transcript_path: &Path,
        revision: &TranscriptRevision,
        projection_key: &str,
    ) -> Result<Option<Arc<TranscriptReplay>>, HarnessError> {
        let mut entries = self.entries.lock().map_err(|_| {
            HarnessError::Operation("normalized transcript replay cache lock was poisoned".into())
        })?;
        let Some(index) = entries.iter().position(|entry| {
            !entry.older_records_exist
                && entry.replay.transcript_path == transcript_path
                && &entry.replay.revision == revision
                && entry.replay.projection_key == projection_key
        }) else {
            return Ok(None);
        };
        let entry = entries.remove(index).expect("cache index must exist");
        let replay = Arc::clone(&entry.replay);
        entries.push_back(entry);
        Ok(Some(replay))
    }

    pub fn insert(&self, replay: TranscriptReplay) -> Result<Arc<TranscriptReplay>, HarnessError> {
        let replay = Arc::new(replay);
        let events = replay.events.len();
        let bytes = replay
            .events
            .iter()
            .map(|event| serde_json::to_vec(event).map_or(0, |encoded| encoded.len()))
            .sum::<usize>();
        if events > self.max_events || bytes > self.max_bytes {
            self.retain_window_for_page(&replay, None)?;
            return Ok(replay);
        }
        let mut entries = self.entries.lock().map_err(|_| {
            HarnessError::Operation("normalized transcript replay cache lock was poisoned".into())
        })?;
        if entries.iter().any(|entry| {
            entry.replay.transcript_path == replay.transcript_path
                && entry.replay.projection_key == replay.projection_key
                && entry.replay.revision.is_newer_than(&replay.revision)
        }) {
            // A slower load of an old revision must not displace the current
            // normalized projection. The caller may still page its result.
            return Ok(replay);
        }
        entries.retain(|entry| {
            entry.replay.transcript_path != replay.transcript_path
                || entry.replay.projection_key != replay.projection_key
        });
        entries.push_back(CachedReplay {
            replay: Arc::clone(&replay),
            events,
            bytes,
            older_records_exist: false,
        });
        while entries.len() > self.max_entries
            || entries.iter().map(|entry| entry.events).sum::<usize>() > self.max_events
            || entries.iter().map(|entry| entry.bytes).sum::<usize>() > self.max_bytes
        {
            let _ = entries.pop_front();
        }
        Ok(replay)
    }

    /// Serve a cursor from a retained bounded normalized window, if present.
    pub fn page(
        &self,
        transcript_path: &Path,
        revision: &TranscriptRevision,
        projection_key: &str,
        request: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        let mut entries = self.entries.lock().map_err(|_| {
            HarnessError::Operation("normalized transcript replay cache lock was poisoned".into())
        })?;
        let Some(index) = entries.iter().position(|entry| {
            entry.replay.transcript_path == transcript_path
                && &entry.replay.revision == revision
                && entry.replay.projection_key == projection_key
        }) else {
            return Ok(None);
        };
        let entry = entries.remove(index).expect("cache index must exist");
        if entry.older_records_exist
            && request.cursor.as_deref().is_some_and(|cursor| {
                decode_cursor(cursor, &transcript_cache_key(&entry.replay)).is_ok_and(|boundary| {
                    matches!(
                        boundary,
                        CursorBoundary::Event(event_id)
                            if entry.replay.events.first().is_some_and(
                                |event| event.event_id.as_str() == event_id
                            )
                    )
                })
            })
        {
            entries.push_back(entry);
            return Ok(None);
        }
        let result = entry.replay.page_tail(request, entry.older_records_exist);
        entries.push_back(entry);
        match result {
            Ok(page) => Ok(Some(page)),
            Err(HarnessError::InvalidRequest(message))
                if message.contains("outside the retained event window") =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Retain the largest normalized event window within cache weight limits,
    /// ending at the requested cursor boundary.
    pub fn retain_window_for_page(
        &self,
        replay: &Arc<TranscriptReplay>,
        cursor: Option<&str>,
    ) -> Result<(), HarnessError> {
        let replay_bytes = replay
            .events
            .iter()
            .map(|event| serde_json::to_vec(event).map_or(0, |encoded| encoded.len()))
            .sum::<usize>();
        if replay.events.len() <= self.max_events && replay_bytes <= self.max_bytes {
            return Ok(());
        }
        let cache_key = transcript_cache_key(replay);
        let end = match cursor {
            None => replay.events.len(),
            Some(cursor) => match decode_cursor(cursor, &cache_key)? {
                CursorBoundary::TranscriptEnd => replay.events.len(),
                CursorBoundary::Event(event_id) => replay
                    .events
                    .iter()
                    .position(|event| event.event_id.as_str() == event_id)
                    .ok_or_else(|| {
                        HarnessError::InvalidRequest(
                            "transcript replay cursor is outside the available event range".into(),
                        )
                    })?,
            },
        };
        let mut start = end;
        let mut bytes = 0_usize;
        while start > 0 && end - start < self.max_events {
            let event_bytes =
                serde_json::to_vec(&replay.events[start - 1]).map_or(0, |encoded| encoded.len());
            if bytes.saturating_add(event_bytes) > self.max_bytes {
                break;
            }
            bytes = bytes.saturating_add(event_bytes);
            start -= 1;
        }
        if start == end {
            return Ok(());
        }
        let window = Arc::new(TranscriptReplay {
            transcript_path: replay.transcript_path.clone(),
            revision: replay.revision.clone(),
            projection_key: replay.projection_key.clone(),
            events: replay.events[start..end].to_vec(),
        });
        let mut entries = self.entries.lock().map_err(|_| {
            HarnessError::Operation("normalized transcript replay cache lock was poisoned".into())
        })?;
        if entries.iter().any(|entry| {
            entry.replay.transcript_path == replay.transcript_path
                && entry.replay.projection_key == replay.projection_key
                && entry.replay.revision.is_newer_than(&replay.revision)
        }) {
            // A late oversized load must not replace the bounded window for a
            // newer transcript revision.
            return Ok(());
        }
        entries.retain(|entry| {
            entry.replay.transcript_path != replay.transcript_path
                || entry.replay.projection_key != replay.projection_key
        });
        entries.push_back(CachedReplay {
            replay: window,
            events: end - start,
            bytes,
            older_records_exist: start > 0,
        });
        while entries.len() > self.max_entries
            || entries.iter().map(|entry| entry.events).sum::<usize>() > self.max_events
            || entries.iter().map(|entry| entry.bytes).sum::<usize>() > self.max_bytes
        {
            let _ = entries.pop_front();
        }
        Ok(())
    }

    /// Return a matching replay or normalize it once for this exact revision.
    /// Unrelated transcripts remain available while a provider decoder runs.
    pub fn get_or_try_insert_with<F>(
        &self,
        transcript_path: &Path,
        revision: &TranscriptRevision,
        projection_key: &str,
        loader: F,
    ) -> Result<Arc<TranscriptReplay>, HarnessError>
    where
        F: FnOnce() -> Result<TranscriptReplay, HarnessError>,
    {
        if let Some(replay) = self.get(transcript_path, revision, projection_key)? {
            return Ok(replay);
        }

        let key = TranscriptReplayCacheKey {
            transcript_path: transcript_path.to_path_buf(),
            revision: revision.clone(),
            projection_key: projection_key.to_owned(),
        };
        let (flight, leader) = {
            let mut in_flight = self.in_flight.lock().map_err(|_| {
                HarnessError::Operation(
                    "normalized transcript replay in-flight lock was poisoned".into(),
                )
            })?;
            match in_flight.entry(key.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => {
                    (Arc::clone(entry.get()), false)
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let flight = Arc::new(ReplayFlight::default());
                    entry.insert(Arc::clone(&flight));
                    (flight, true)
                }
            }
        };

        if leader {
            let result = (|| {
                if let Some(replay) = self.get(transcript_path, revision, projection_key)? {
                    Ok(replay)
                } else {
                    self.insert(loader()?)
                }
            })();
            let outcome = result.as_ref().map(Arc::clone).map_err(ToString::to_string);
            *flight.outcome.lock().map_err(|_| {
                HarnessError::Operation("normalized transcript replay flight was poisoned".into())
            })? = Some(outcome);
            flight.ready.notify_all();
            self.in_flight
                .lock()
                .map_err(|_| {
                    HarnessError::Operation(
                        "normalized transcript replay in-flight lock was poisoned".into(),
                    )
                })?
                .remove(&key);
            return result;
        }

        let mut outcome = flight.outcome.lock().map_err(|_| {
            HarnessError::Operation("normalized transcript replay flight was poisoned".into())
        })?;
        while outcome.is_none() {
            outcome = flight.ready.wait(outcome).map_err(|_| {
                HarnessError::Operation("normalized transcript replay flight was poisoned".into())
            })?;
        }
        match outcome.as_ref().expect("flight outcome must be set") {
            Ok(replay) => Ok(Arc::clone(replay)),
            Err(error) => Err(HarnessError::Operation(error.clone())),
        }
    }
}

impl TranscriptRevision {
    fn is_newer_than(&self, other: &Self) -> bool {
        (self.modified_nanos, self.byte_len) > (other.modified_nanos, other.byte_len)
    }
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

    /// Page a normalized tail window while indicating that older records exist
    /// outside the bounded provider read.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CursorBoundary<'a> {
    Event(&'a str),
    TranscriptEnd,
}

fn encode_event_cursor(cache_key: &str, before_event_id: &str) -> String {
    format!("{cache_key}:event:{before_event_id}")
}

fn encode_deferred_cursor(cache_key: &str) -> String {
    format!("{cache_key}:end")
}

fn decode_cursor<'a>(
    cursor: &'a str,
    expected_cache_key: &str,
) -> Result<CursorBoundary<'a>, HarnessError> {
    let Some(boundary) = cursor
        .strip_prefix(expected_cache_key)
        .and_then(|value| value.strip_prefix(':'))
    else {
        return Err(HarnessError::InvalidRequest(
            "transcript replay cursor no longer matches the transcript revision".into(),
        ));
    };
    if boundary == "end" {
        return Ok(CursorBoundary::TranscriptEnd);
    }
    let Some(event_id) = boundary.strip_prefix("event:") else {
        return Err(HarnessError::InvalidRequest(
            "malformed transcript replay cursor".into(),
        ));
    };
    if event_id.is_empty() {
        return Err(HarnessError::InvalidRequest(
            "malformed transcript replay cursor".into(),
        ));
    }
    Ok(CursorBoundary::Event(event_id))
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
    fn replay_cursor_round_trips_opaque_event_ids_without_sentinel_collisions() {
        let transcript = NamedTempFile::new().expect("transcript");
        let mut events = (1..=3).map(event).collect::<Vec<_>>();
        events[1].event_id = EventId::new("__transcript_end__");
        events[2].event_id = EventId::new("provider:opaque:event");
        let replay = TranscriptReplay {
            transcript_path: transcript.path().to_path_buf(),
            revision: TranscriptRevision::capture(transcript.path()).expect("revision"),
            projection_key: "test-v1:opaque-event-ids".into(),
            events,
        };

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

    #[test]
    fn normalized_replay_cache_reuses_matching_revisions_and_evicts_lru_entries() {
        let first_file = NamedTempFile::new().expect("first transcript");
        let second_file = NamedTempFile::new().expect("second transcript");
        let first = TranscriptReplay {
            transcript_path: first_file.path().to_path_buf(),
            revision: TranscriptRevision::capture(first_file.path()).expect("first revision"),
            projection_key: "claude-v1:stream".into(),
            events: vec![event(1)],
        };
        let first_revision = first.revision.clone();
        let cache = TranscriptReplayCache::new(1);
        let inserted = cache.insert(first).expect("insert first replay");
        let reused = cache
            .get(first_file.path(), &first_revision, "claude-v1:stream")
            .expect("cache lookup")
            .expect("cached first replay");
        assert!(Arc::ptr_eq(&inserted, &reused));
        assert_eq!(reused.events[0].sequence, 1);

        cache
            .insert(TranscriptReplay {
                transcript_path: second_file.path().to_path_buf(),
                revision: TranscriptRevision::capture(second_file.path()).expect("second revision"),
                projection_key: "codex-v1:stream".into(),
                events: vec![event(2)],
            })
            .expect("insert second replay");
        assert!(
            cache
                .get(first_file.path(), &first_revision, "claude-v1:stream")
                .expect("eviction lookup")
                .is_none()
        );
    }

    #[test]
    fn normalized_replay_cache_loads_each_projection_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let transcript = NamedTempFile::new().expect("transcript");
        let path = transcript.path().to_path_buf();
        let revision = TranscriptRevision::capture(&path).expect("revision");
        let loads = AtomicUsize::new(0);
        let cache = TranscriptReplayCache::new(2);
        let load = || {
            loads.fetch_add(1, Ordering::SeqCst);
            Ok(TranscriptReplay {
                transcript_path: path.clone(),
                revision: revision.clone(),
                projection_key: "claude-v1:stream".into(),
                events: vec![event(1)],
            })
        };
        let first = cache
            .get_or_try_insert_with(&path, &revision, "claude-v1:stream", load)
            .expect("initial cache load");
        let second = cache
            .get_or_try_insert_with(&path, &revision, "claude-v1:stream", load)
            .expect("cached replay");

        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn normalized_replay_cache_replaces_superseded_revisions() {
        let transcript = NamedTempFile::new().expect("transcript");
        let path = transcript.path().to_path_buf();
        let old_revision = TranscriptRevision {
            byte_len: 10,
            modified_nanos: 10,
        };
        let new_revision = TranscriptRevision {
            byte_len: 20,
            modified_nanos: 20,
        };
        let cache = TranscriptReplayCache::new(8);
        cache
            .insert(TranscriptReplay {
                transcript_path: path.clone(),
                revision: old_revision.clone(),
                projection_key: "claude-v1:stream".into(),
                events: vec![event(1)],
            })
            .expect("insert old revision");
        let current = cache
            .insert(TranscriptReplay {
                transcript_path: path.clone(),
                revision: new_revision.clone(),
                projection_key: "claude-v1:stream".into(),
                events: vec![event(2)],
            })
            .expect("insert current revision");

        assert!(
            cache
                .get(&path, &old_revision, "claude-v1:stream")
                .expect("old revision lookup")
                .is_none()
        );
        assert!(Arc::ptr_eq(
            &current,
            &cache
                .get(&path, &new_revision, "claude-v1:stream")
                .expect("current revision lookup")
                .expect("current revision")
        ));

        let late_old = cache
            .insert(TranscriptReplay {
                transcript_path: path.clone(),
                revision: old_revision.clone(),
                projection_key: "claude-v1:stream".into(),
                events: vec![event(3)],
            })
            .expect("finish stale load");
        assert_eq!(late_old.events[0].sequence, 3);
        assert!(
            cache
                .get(&path, &old_revision, "claude-v1:stream")
                .expect("late old revision lookup")
                .is_none()
        );
        assert!(Arc::ptr_eq(
            &current,
            &cache
                .get(&path, &new_revision, "claude-v1:stream")
                .expect("retained current revision lookup")
                .expect("retained current revision")
        ));
    }

    #[test]
    fn late_oversized_replay_does_not_replace_a_newer_revision_window() {
        let transcript = NamedTempFile::new().expect("transcript");
        let path = transcript.path().to_path_buf();
        let old_revision = TranscriptRevision {
            byte_len: 10,
            modified_nanos: 10,
        };
        let new_revision = TranscriptRevision {
            byte_len: 20,
            modified_nanos: 20,
        };
        let cache = TranscriptReplayCache::with_limits(8, 2, usize::MAX);
        let replay = |revision: TranscriptRevision, first_sequence| TranscriptReplay {
            transcript_path: path.clone(),
            revision,
            projection_key: "claude-v1:oversized".into(),
            events: (first_sequence..first_sequence + 3).map(event).collect(),
        };

        cache
            .insert(replay(old_revision.clone(), 1))
            .expect("insert old oversized replay");
        cache
            .insert(replay(new_revision.clone(), 10))
            .expect("insert new oversized replay");
        cache
            .insert(replay(old_revision, 20))
            .expect("finish stale oversized replay");

        let entries = cache.entries.lock().expect("cache entries");
        let retained = entries
            .iter()
            .filter(|entry| {
                entry.replay.transcript_path == path
                    && entry.replay.projection_key == "claude-v1:oversized"
            })
            .collect::<Vec<_>>();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].replay.revision, new_revision);
        assert_eq!(
            retained[0]
                .replay
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![11, 12]
        );
    }

    #[test]
    fn normalized_replay_cache_enforces_event_and_byte_weight_limits() {
        let first_file = NamedTempFile::new().expect("first transcript");
        let second_file = NamedTempFile::new().expect("second transcript");
        let oversized_file = NamedTempFile::new().expect("oversized transcript");
        let cache = TranscriptReplayCache::with_limits(8, 3, 1_500);
        let first_revision = TranscriptRevision::capture(first_file.path()).unwrap();
        let second_revision = TranscriptRevision::capture(second_file.path()).unwrap();
        cache
            .insert(TranscriptReplay {
                transcript_path: first_file.path().to_path_buf(),
                revision: first_revision.clone(),
                projection_key: "weighted:first".into(),
                events: vec![event(1), event(2)],
            })
            .unwrap();
        cache
            .insert(TranscriptReplay {
                transcript_path: second_file.path().to_path_buf(),
                revision: second_revision.clone(),
                projection_key: "weighted:second".into(),
                events: vec![event(3), event(4)],
            })
            .unwrap();

        assert!(
            cache
                .get(first_file.path(), &first_revision, "weighted:first")
                .unwrap()
                .is_none(),
            "oldest replay is evicted when aggregate event weight exceeds the limit"
        );
        assert!(
            cache
                .get(second_file.path(), &second_revision, "weighted:second")
                .unwrap()
                .is_some()
        );

        let oversized_revision = TranscriptRevision::capture(oversized_file.path()).unwrap();
        let oversized = cache
            .insert(TranscriptReplay {
                transcript_path: oversized_file.path().to_path_buf(),
                revision: oversized_revision.clone(),
                projection_key: "weighted:oversized".into(),
                events: vec![event(5), event(6), event(7), event(8)],
            })
            .unwrap();
        assert_eq!(oversized.events.len(), 4);
        assert!(
            cache
                .get(
                    oversized_file.path(),
                    &oversized_revision,
                    "weighted:oversized"
                )
                .unwrap()
                .is_none(),
            "an individually oversized replay is returned but never retained"
        );
        let newest_window = cache
            .page(
                oversized_file.path(),
                &oversized_revision,
                "weighted:oversized",
                &TranscriptReplayPageRequest {
                    cursor: None,
                    limit: Some(1),
                },
            )
            .unwrap()
            .expect("bounded oversized replay window");
        assert_eq!(newest_window.events[0].payload, event(8).payload);
        assert!(newest_window.has_more);
        let next_window = cache
            .page(
                oversized_file.path(),
                &oversized_revision,
                "weighted:oversized",
                &TranscriptReplayPageRequest {
                    cursor: newest_window.next_cursor,
                    limit: Some(1),
                },
            )
            .unwrap()
            .expect("next page from retained oversized window");
        assert_eq!(next_window.events[0].payload, event(7).payload);

        let byte_first = NamedTempFile::new().expect("byte first transcript");
        let byte_second = NamedTempFile::new().expect("byte second transcript");
        let one_event_bytes = serde_json::to_vec(&event(10)).unwrap().len();
        let byte_cache = TranscriptReplayCache::with_limits(8, 100, one_event_bytes + 8);
        let byte_first_revision = TranscriptRevision::capture(byte_first.path()).unwrap();
        byte_cache
            .insert(TranscriptReplay {
                transcript_path: byte_first.path().to_path_buf(),
                revision: byte_first_revision.clone(),
                projection_key: "bytes:first".into(),
                events: vec![event(10)],
            })
            .unwrap();
        byte_cache
            .insert(TranscriptReplay {
                transcript_path: byte_second.path().to_path_buf(),
                revision: TranscriptRevision::capture(byte_second.path()).unwrap(),
                projection_key: "bytes:second".into(),
                events: vec![event(11)],
            })
            .unwrap();
        assert!(
            byte_cache
                .get(byte_first.path(), &byte_first_revision, "bytes:first")
                .unwrap()
                .is_none(),
            "byte weight independently evicts the oldest replay"
        );
    }

    #[test]
    fn normalized_replay_cache_single_flights_per_key_without_blocking_other_keys() {
        use std::{
            sync::{
                atomic::{AtomicUsize, Ordering},
                mpsc,
            },
            thread,
            time::Duration,
        };

        let first_file = NamedTempFile::new().expect("first transcript");
        let second_file = NamedTempFile::new().expect("second transcript");
        let first_path = first_file.path().to_path_buf();
        let second_path = second_file.path().to_path_buf();
        let first_revision = TranscriptRevision::capture(&first_path).expect("first revision");
        let second_revision = TranscriptRevision::capture(&second_path).expect("second revision");
        let cache = Arc::new(TranscriptReplayCache::new(8));
        let loads = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::sync_channel(0);

        let first = {
            let cache = Arc::clone(&cache);
            let loads = Arc::clone(&loads);
            let path = first_path.clone();
            let revision = first_revision.clone();
            thread::spawn(move || {
                cache.get_or_try_insert_with(&path, &revision, "claude-v1:stream", || {
                    loads.fetch_add(1, Ordering::SeqCst);
                    started_tx.send(()).expect("signal loader start");
                    release_rx.recv().expect("release loader");
                    Ok(TranscriptReplay {
                        transcript_path: path.clone(),
                        revision: revision.clone(),
                        projection_key: "claude-v1:stream".into(),
                        events: vec![event(1)],
                    })
                })
            })
        };
        started_rx.recv().expect("loader started");

        let same_key = {
            let cache = Arc::clone(&cache);
            let loads = Arc::clone(&loads);
            let path = first_path.clone();
            let revision = first_revision.clone();
            thread::spawn(move || {
                cache.get_or_try_insert_with(&path, &revision, "claude-v1:stream", || {
                    loads.fetch_add(1, Ordering::SeqCst);
                    Ok(TranscriptReplay {
                        transcript_path: path.clone(),
                        revision: revision.clone(),
                        projection_key: "claude-v1:stream".into(),
                        events: vec![event(99)],
                    })
                })
            })
        };
        let (unrelated_tx, unrelated_rx) = mpsc::sync_channel(0);
        let unrelated = {
            let cache = Arc::clone(&cache);
            let path = second_path.clone();
            let revision = second_revision.clone();
            thread::spawn(move || {
                let result =
                    cache.get_or_try_insert_with(&path, &revision, "codex-v1:other-stream", || {
                        Ok(TranscriptReplay {
                            transcript_path: path.clone(),
                            revision: revision.clone(),
                            projection_key: "codex-v1:other-stream".into(),
                            events: vec![event(2)],
                        })
                    });
                unrelated_tx.send(result).expect("send unrelated result");
            })
        };
        let unrelated_result = unrelated_rx.recv_timeout(Duration::from_secs(1));
        release_tx.send(()).expect("release first loader");

        let first = first.join().expect("first thread").expect("first replay");
        let same_key = same_key
            .join()
            .expect("same-key thread")
            .expect("same-key replay");
        unrelated.join().expect("unrelated thread");
        let unrelated = unrelated_result
            .expect("unrelated key must not wait for first loader")
            .expect("unrelated replay");

        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&first, &same_key));
        assert_eq!(unrelated.events[0].sequence, 2);
    }
}
