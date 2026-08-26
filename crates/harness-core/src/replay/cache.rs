//! Bounded LRU cache for provider-normalized transcript revisions.
//!
//! Providers own cache instances and all transcript discovery/decoding. This
//! shared container stores only the provider-neutral replay projection.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard},
};

use crate::{
    HarnessError, HarnessEventV1, TranscriptReplay, TranscriptReplayPage,
    TranscriptReplayPageRequest, TranscriptRevision,
};

use super::{CursorBoundary, decode_cursor, transcript_cache_key};

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

    fn lock_entries(&self) -> Result<MutexGuard<'_, VecDeque<CachedReplay>>, HarnessError> {
        self.entries.lock().map_err(|_| {
            HarnessError::Operation("normalized transcript replay cache lock was poisoned".into())
        })
    }

    fn lock_in_flight(
        &self,
    ) -> Result<MutexGuard<'_, HashMap<TranscriptReplayCacheKey, Arc<ReplayFlight>>>, HarnessError>
    {
        self.in_flight.lock().map_err(|_| {
            HarnessError::Operation(
                "normalized transcript replay in-flight lock was poisoned".into(),
            )
        })
    }

    pub fn get(
        &self,
        transcript_path: &Path,
        revision: &TranscriptRevision,
        projection_key: &str,
    ) -> Result<Option<Arc<TranscriptReplay>>, HarnessError> {
        let mut entries = self.lock_entries()?;
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

    /// Store one normalized replay, evicting as needed. Oversized replays are
    /// returned to the caller without being retained whole; their newest
    /// window is retained for paging through
    /// [`Self::retain_window_for_page`].
    pub fn insert(&self, replay: TranscriptReplay) -> Result<Arc<TranscriptReplay>, HarnessError> {
        let replay = Arc::new(replay);
        let events = replay.events.len();
        let bytes = serialized_event_bytes(&replay.events);
        if events > self.max_events || bytes > self.max_bytes {
            self.retain_window_for_page(&replay, None)?;
            return Ok(replay);
        }
        let mut entries = self.lock_entries()?;
        self.store_entry(
            &mut entries,
            CachedReplay {
                replay: Arc::clone(&replay),
                events,
                bytes,
                older_records_exist: false,
            },
        );
        Ok(replay)
    }

    /// Retain one bounded window of an oversized replay, keyed so older-page
    /// cursors can be served without re-normalizing the full transcript.
    pub fn retain_window_for_page(
        &self,
        replay: &TranscriptReplay,
        cursor: Option<&str>,
    ) -> Result<(), HarnessError> {
        let replay_bytes = serialized_event_bytes(&replay.events);
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
        let mut entries = self.lock_entries()?;
        self.store_entry(
            &mut entries,
            CachedReplay {
                replay: window,
                events: end - start,
                bytes,
                older_records_exist: start > 0,
            },
        );
        Ok(())
    }

    /// Page a retained replay. Returns `Ok(None)` when the retained window
    /// cannot serve this cursor, so the caller normalizes the full transcript
    /// instead. A cursor naming a foreign revision is an error: it cannot be
    /// served by any window of this transcript state.
    pub fn page(
        &self,
        transcript_path: &Path,
        revision: &TranscriptRevision,
        projection_key: &str,
        request: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        let mut entries = self.lock_entries()?;
        let Some(index) = entries.iter().position(|entry| {
            entry.replay.transcript_path == transcript_path
                && &entry.replay.revision == revision
                && entry.replay.projection_key == projection_key
        }) else {
            return Ok(None);
        };
        let entry = entries.remove(index).expect("cache index must exist");
        let outcome = self.window_page(&entry, request);
        entries.push_back(entry);
        outcome
    }

    /// Resolve one page against a retained window, or `Ok(None)` on a miss.
    fn window_page(
        &self,
        entry: &CachedReplay,
        request: &TranscriptReplayPageRequest,
    ) -> Result<Option<TranscriptReplayPage>, HarnessError> {
        if let Some(cursor) = request.cursor.as_deref() {
            let cache_key = transcript_cache_key(&entry.replay);
            match decode_cursor(cursor, &cache_key)? {
                CursorBoundary::TranscriptEnd => {}
                CursorBoundary::Event(event_id) => {
                    let serves_cursor = entry
                        .replay
                        .events
                        .iter()
                        .any(|event| event.event_id.as_str() == event_id)
                        && !(entry.older_records_exist
                            && entry
                                .replay
                                .events
                                .first()
                                .is_some_and(|event| event.event_id.as_str() == event_id));
                    if !serves_cursor {
                        return Ok(None);
                    }
                }
            }
        }
        entry
            .replay
            .page_tail(request, entry.older_records_exist)
            .map(Some)
    }

    /// Coordinates per-revision single-flight loading without holding the cache
    /// lock during provider decoding.
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
            let mut in_flight = self.lock_in_flight()?;
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
            self.lock_in_flight()?.remove(&key);
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

    /// Store an entry, superseding same-identity entries with older revisions
    /// while preserving a newer one, then evicting until all limits hold.
    fn store_entry(&self, entries: &mut VecDeque<CachedReplay>, candidate: CachedReplay) {
        if entries.iter().any(|entry| {
            entry.replay.transcript_path == candidate.replay.transcript_path
                && entry.replay.projection_key == candidate.replay.projection_key
                && entry
                    .replay
                    .revision
                    .is_newer_than(&candidate.replay.revision)
        }) {
            // A slower load of an old revision must not displace the current
            // normalized projection. The caller may still page its result.
            return;
        }
        entries.retain(|entry| {
            entry.replay.transcript_path != candidate.replay.transcript_path
                || entry.replay.projection_key != candidate.replay.projection_key
        });
        entries.push_back(candidate);
        let mut total_events = entries.iter().map(|entry| entry.events).sum::<usize>();
        let mut total_bytes = entries.iter().map(|entry| entry.bytes).sum::<usize>();
        while entries.len() > self.max_entries
            || total_events > self.max_events
            || total_bytes > self.max_bytes
        {
            let Some(evicted) = entries.pop_front() else {
                break;
            };
            total_events -= evicted.events;
            total_bytes -= evicted.bytes;
        }
    }
}

fn serialized_event_bytes(events: &[HarnessEventV1]) -> usize {
    events
        .iter()
        .map(|event| serde_json::to_vec(event).map_or(0, |encoded| encoded.len()))
        .sum()
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::Duration,
    };

    use tempfile::NamedTempFile;

    use super::super::encode_event_cursor;
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

    fn replay_for(
        path: &Path,
        sequence_range: std::ops::Range<u64>,
        projection: &str,
    ) -> TranscriptReplay {
        TranscriptReplay {
            transcript_path: path.to_path_buf(),
            revision: TranscriptRevision::capture(path).expect("revision"),
            projection_key: projection.into(),
            events: sequence_range.map(event).collect(),
        }
    }

    #[test]
    fn normalized_replay_cache_reuses_matching_revisions_and_evicts_lru_entries() {
        let first_file = NamedTempFile::new().expect("first transcript");
        let second_file = NamedTempFile::new().expect("second transcript");
        let first = replay_for(first_file.path(), 1..2, "claude-v1:stream");
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
            .insert(replay_for(second_file.path(), 2..3, "codex-v1:stream"))
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
        let transcript = NamedTempFile::new().expect("transcript");
        let path = transcript.path().to_path_buf();
        let revision = TranscriptRevision::capture(&path).expect("revision");
        let loads = AtomicUsize::new(0);
        let cache = TranscriptReplayCache::new(2);
        let load = || {
            loads.fetch_add(1, Ordering::SeqCst);
            Ok(replay_for(&path, 1..2, "claude-v1:stream"))
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
        let old_revision = TranscriptRevision::synthetic(10);
        let new_revision = TranscriptRevision::synthetic(20);
        let cache = TranscriptReplayCache::new(8);
        let replay = |revision: &TranscriptRevision, sequence: u64| TranscriptReplay {
            transcript_path: path.clone(),
            revision: revision.clone(),
            projection_key: "claude-v1:stream".into(),
            events: vec![event(sequence)],
        };
        cache
            .insert(replay(&old_revision, 1))
            .expect("insert old revision");
        let current = cache
            .insert(replay(&new_revision, 2))
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
            .insert(replay(&old_revision, 3))
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
        let old_revision = TranscriptRevision::synthetic(10);
        let new_revision = TranscriptRevision::synthetic(20);
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
            .insert(replay_for(first_file.path(), 1..3, "weighted:first"))
            .unwrap();
        cache
            .insert(replay_for(second_file.path(), 3..5, "weighted:second"))
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
            .insert(replay_for(
                oversized_file.path(),
                5..9,
                "weighted:oversized",
            ))
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
            .insert(replay_for(byte_first.path(), 10..11, "bytes:first"))
            .unwrap();
        byte_cache
            .insert(replay_for(byte_second.path(), 11..12, "bytes:second"))
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
    fn retained_window_reports_a_miss_for_cursors_it_cannot_serve() {
        let transcript = NamedTempFile::new().expect("transcript");
        std::io::Write::write_all(&mut transcript.as_file(), b"transcript").unwrap();
        let path = transcript.path().to_path_buf();
        let revision = TranscriptRevision::capture(&path).expect("revision");
        let cache = TranscriptReplayCache::with_limits(8, 2, usize::MAX);
        // Inserting five events with a two-event limit retains only the newest
        // window (events 4, 5) with `older_records_exist`.
        let replay = TranscriptReplay {
            transcript_path: path.clone(),
            revision: revision.clone(),
            projection_key: "claude-v1:window".into(),
            events: (1..=5).map(event).collect(),
        };
        let replay_cache_key = transcript_cache_key(&replay);
        cache.insert(replay).expect("insert oversized replay");

        let newest = cache
            .page(
                &path,
                &revision,
                "claude-v1:window",
                &TranscriptReplayPageRequest {
                    cursor: None,
                    limit: Some(1),
                },
            )
            .unwrap()
            .expect("newest window page");
        assert_eq!(newest.events[0].sequence, 5);

        // A cursor naming an event that fell outside the retained window is a
        // typed miss, not an error: the caller must re-normalize.
        let outside_cursor = encode_event_cursor(&replay_cache_key, "event-2");
        let miss = cache
            .page(
                &path,
                &revision,
                "claude-v1:window",
                &TranscriptReplayPageRequest {
                    cursor: Some(outside_cursor),
                    limit: Some(1),
                },
            )
            .unwrap();
        assert!(miss.is_none());

        // A cursor from a different transcript revision is rejected outright.
        let foreign_cursor = encode_event_cursor("v1-ffffffffffffffff", "event-1");
        assert!(
            cache
                .page(
                    &path,
                    &revision,
                    "claude-v1:window",
                    &TranscriptReplayPageRequest {
                        cursor: Some(foreign_cursor),
                        limit: Some(1),
                    },
                )
                .is_err()
        );
    }

    #[test]
    fn normalized_replay_cache_single_flights_per_key_without_blocking_other_keys() {
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
                    Ok(replay_for(&path, 1..2, "claude-v1:stream"))
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
                    Ok(replay_for(&path, 99..100, "claude-v1:stream"))
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
                        Ok(replay_for(&path, 2..3, "codex-v1:other-stream"))
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
