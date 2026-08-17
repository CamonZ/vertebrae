use std::{
    collections::{HashMap, VecDeque, hash_map::DefaultHasher},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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

/// Bounded LRU cache for provider-normalized transcript revisions.
///
/// Providers own cache instances and all transcript discovery/decoding. This
/// shared container stores only the provider-neutral replay projection.
#[derive(Debug)]
pub struct TranscriptReplayCache {
    capacity: usize,
    entries: Mutex<VecDeque<Arc<TranscriptReplay>>>,
    in_flight: Mutex<HashMap<TranscriptReplayCacheKey, Arc<Mutex<()>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TranscriptReplayCacheKey {
    transcript_path: PathBuf,
    revision: TranscriptRevision,
    projection_key: String,
}

impl TranscriptReplayCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
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
            entry.transcript_path == transcript_path
                && &entry.revision == revision
                && entry.projection_key == projection_key
        }) else {
            return Ok(None);
        };
        let entry = entries.remove(index).expect("cache index must exist");
        entries.push_back(Arc::clone(&entry));
        Ok(Some(entry))
    }

    pub fn insert(&self, replay: TranscriptReplay) -> Result<Arc<TranscriptReplay>, HarnessError> {
        let replay = Arc::new(replay);
        let mut entries = self.entries.lock().map_err(|_| {
            HarnessError::Operation("normalized transcript replay cache lock was poisoned".into())
        })?;
        if entries.iter().any(|entry| {
            entry.transcript_path == replay.transcript_path
                && entry.projection_key == replay.projection_key
                && entry.revision.is_newer_than(&replay.revision)
        }) {
            // A slower load of an old revision must not displace the current
            // normalized projection. The caller may still page its result.
            return Ok(replay);
        }
        entries.retain(|entry| {
            entry.transcript_path != replay.transcript_path
                || entry.projection_key != replay.projection_key
        });
        entries.push_back(Arc::clone(&replay));
        while entries.len() > self.capacity {
            entries.pop_front();
        }
        Ok(replay)
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
        let flight = {
            let mut in_flight = self.in_flight.lock().map_err(|_| {
                HarnessError::Operation(
                    "normalized transcript replay in-flight lock was poisoned".into(),
                )
            })?;
            Arc::clone(
                in_flight
                    .entry(key.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };

        let result = match flight.lock() {
            Ok(_guard) => (|| {
                if let Some(replay) = self.get(transcript_path, revision, projection_key)? {
                    Ok(replay)
                } else {
                    self.insert(loader()?)
                }
            })(),
            Err(_) => Err(HarnessError::Operation(
                "normalized transcript replay single-flight lock was poisoned".into(),
            )),
        };

        let mut in_flight = self.in_flight.lock().map_err(|_| {
            HarnessError::Operation(
                "normalized transcript replay in-flight lock was poisoned".into(),
            )
        })?;
        if Arc::strong_count(&flight) == 2
            && in_flight
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &flight))
        {
            in_flight.remove(&key);
        }
        result
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
        let mut same_key_waiting = false;
        for _ in 0..10_000 {
            same_key_waiting = cache
                .in_flight
                .lock()
                .expect("in-flight map")
                .values()
                .next()
                .is_some_and(|flight| Arc::strong_count(flight) >= 3);
            if same_key_waiting {
                break;
            }
            thread::yield_now();
        }

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
        assert!(
            same_key_waiting,
            "same-key request joined the in-flight load"
        );
        assert!(Arc::ptr_eq(&first, &same_key));
        assert_eq!(unrelated.events[0].sequence, 2);
    }
}
