//! Join replayed replies to immutable, session-local capture subjects.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use vertebrae_harness_core::{
    EventId, HarnessEventPayloadV1, HarnessEventV1, TranscriptReplayRequest, TurnId,
};

use super::{reply_key, HISTORY_KIND};
use crate::local_chat::{annotations::AnnotationSubject, LocalChatAnnotation};

pub(crate) struct ReplayCaptureIndex {
    replies: HashMap<String, Option<TurnId>>,
    legacy: Vec<LegacyCapture>,
}

#[derive(Clone, PartialEq, Eq)]
struct LegacyCapture {
    turn: TurnId,
    origin: DateTime<Utc>,
    captured: DateTime<Utc>,
}

type ReplyTurns = HashMap<EventId, TurnId>;

const LEGACY_CACHE_ENTRIES: usize = 8;
const LEGACY_CACHE_ENTRY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct LegacyReplayCache(Mutex<VecDeque<CachedLegacyReplay>>);

struct CachedLegacyReplay {
    revision: String,
    windows: Vec<LegacyCapture>,
    replies: Arc<ReplyTurns>,
}

impl LegacyReplayCache {
    pub(crate) fn get_or_build(
        &self,
        revision: &str,
        captures: &ReplayCaptureIndex,
        build: impl FnOnce() -> Option<ReplyTurns>,
    ) -> Option<Arc<ReplyTurns>> {
        if !captures.needs_legacy_context() {
            return None;
        }
        {
            let mut entries = self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(position) = entries
                .iter()
                .position(|entry| entry.revision == revision && entry.windows == captures.legacy)
            {
                let entry = entries
                    .remove(position)
                    .expect("position came from the cache");
                let replies = Arc::clone(&entry.replies);
                entries.push_back(entry);
                return Some(replies);
            }
        }

        // Load outside the lock. Concurrent misses may compute the same map
        // independently, without blocking replay of other sessions.
        let replies = Arc::new(build()?);
        // Oversize maps still resolve this page. They are rebuilt on demand
        // so an unusually large transcript cannot inflate the retained cache.
        let retained_bytes =
            replies
                .iter()
                .map(|(event, turn)| {
                    std::mem::size_of::<(EventId, TurnId)>()
                        + event.as_str().len()
                        + turn.as_str().len()
                })
                .chain(captures.legacy.iter().map(|window| {
                    std::mem::size_of::<LegacyCapture>() + window.turn.as_str().len()
                }))
                .fold(0_usize, usize::saturating_add);
        if retained_bytes <= LEGACY_CACHE_ENTRY_BYTES {
            let mut entries = self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            entries.retain(|entry| entry.revision != revision);
            if entries.len() == LEGACY_CACHE_ENTRIES {
                entries.pop_front();
            }
            entries.push_back(CachedLegacyReplay {
                revision: revision.to_owned(),
                windows: captures.legacy.clone(),
                replies: Arc::clone(&replies),
            });
        }
        Some(replies)
    }
}

fn recorded_at(entry: &LocalChatAnnotation) -> Option<DateTime<Utc>> {
    entry.recorded_at.parse().ok()
}

impl ReplayCaptureIndex {
    pub(crate) fn new(entries: &[LocalChatAnnotation]) -> Self {
        Self {
            replies: exact_replies(entries),
            legacy: legacy_windows(entries),
        }
    }

    pub(crate) fn needs_legacy_context(&self) -> bool {
        !self.legacy.is_empty()
    }

    pub(crate) fn attach(
        &self,
        request: &TranscriptReplayRequest,
        events: &mut [HarnessEventV1],
        legacy: Option<&ReplyTurns>,
    ) {
        for event in events {
            if !is_reply(event) || !is_root(event, request) {
                continue;
            }
            let exact = event
                .correlation
                .thread_id
                .as_ref()
                .zip(
                    event
                        .correlation
                        .message_id
                        .as_ref()
                        .or(event.correlation.item_id.as_ref()),
                )
                .and_then(|(thread, item)| {
                    self.replies.get(&reply_key(thread.as_str(), item.as_str()))
                });
            event.correlation.turn_id = match exact {
                Some(turn) => turn.clone(),
                None => legacy
                    .and_then(|replies| replies.get(&event.event_id))
                    .cloned(),
            };
        }
    }

    pub(crate) fn legacy_replies(
        &self,
        request: &TranscriptReplayRequest,
        events: &[HarnessEventV1],
    ) -> HashMap<EventId, TurnId> {
        let mut matches = HashMap::new();
        if self.legacy.is_empty() {
            return matches;
        }
        let turns = group_turns(request, events);
        let mut previous_end = DateTime::UNIX_EPOCH;
        for (index, turn) in turns.iter().enumerate() {
            let next_start = turns.get(index + 1).map(|next| next.start.timestamp);
            if let Some(first_reply) = turn.replies.iter().map(|reply| reply.timestamp).min() {
                let candidate = self
                    .legacy
                    .partition_point(|capture| capture.origin <= first_reply);
                if let Some(capture) = candidate.checked_sub(1).map(|i| &self.legacy[i]) {
                    if capture.admits(turn, previous_end, next_start, first_reply) {
                        matches.extend(
                            turn.replies
                                .iter()
                                .map(|reply| (reply.event_id.clone(), capture.turn.clone())),
                        );
                    }
                }
            }
            previous_end = previous_end.max(turn.end());
        }
        matches
    }
}

fn capture_turn(entry: &LocalChatAnnotation) -> Option<&str> {
    match &entry.subject {
        Some(AnnotationSubject::Turn(id)) if entry.kind == HISTORY_KIND => Some(id),
        _ => None,
    }
}

fn exact_replies(entries: &[LocalChatAnnotation]) -> HashMap<String, Option<TurnId>> {
    let mut index: HashMap<String, Option<TurnId>> = HashMap::new();
    for (id, keys) in entries.iter().filter_map(|entry| {
        Some((
            capture_turn(entry)?,
            entry.payload.get("replies")?.as_array()?,
        ))
    }) {
        let turn = TurnId::new(id);
        for key in keys.iter().filter_map(|key| key.as_str()) {
            index
                .entry(key.to_owned())
                .and_modify(|stored| {
                    if stored.as_ref() != Some(&turn) {
                        *stored = None;
                    }
                })
                .or_insert_with(|| Some(turn.clone()));
        }
    }
    index
}

fn legacy_windows(entries: &[LocalChatAnnotation]) -> Vec<LegacyCapture> {
    let origins: HashMap<_, _> = entries
        .iter()
        .filter_map(|entry| match (&entry.subject, entry.kind.as_str()) {
            (Some(AnnotationSubject::Turn(id)), "worktree_origin") => Some((id.as_str(), entry)),
            _ => None,
        })
        .collect();
    let mut windows: Vec<_> = entries
        .iter()
        .filter_map(|entry| {
            if entry.payload.get("replies").is_some() {
                return None;
            }
            let id = capture_turn(entry)?;
            let origin = origins.get(id)?;
            let start = recorded_at(origin)?;
            let end = recorded_at(entry)?;
            let same_checkout = ["epoch", "worktree"].iter().all(|key| {
                origin
                    .payload
                    .get(key)
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| {
                        !value.is_empty()
                            && entry.payload.get(key).and_then(|v| v.as_str()) == Some(value)
                    })
            });
            (start < end && same_checkout).then(|| LegacyCapture {
                turn: TurnId::new(id),
                origin: start,
                captured: end,
            })
        })
        .collect();

    // An origin counts even when its turn never produced a capture.
    let mut starts: Vec<_> = origins
        .values()
        .filter_map(|entry| recorded_at(entry))
        .collect();
    starts.sort_unstable();
    windows.sort_unstable_by_key(|capture| capture.origin);
    let mut preceding_end = None;
    windows.retain(|capture| {
        let overlaps = preceding_end.is_some_and(|end| end >= capture.origin);
        preceding_end = preceding_end.max(Some(capture.captured));
        let first = starts.partition_point(|start| *start < capture.origin);
        let last = starts.partition_point(|start| *start <= capture.captured);
        !overlaps && last - first == 1
    });
    windows
}

struct TranscriptTurn<'a> {
    start: &'a HarnessEventV1,
    last_activity: DateTime<Utc>,
    terminal: Option<&'a HarnessEventV1>,
    replies: Vec<&'a HarnessEventV1>,
}

impl TranscriptTurn<'_> {
    fn end(&self) -> DateTime<Utc> {
        match self
            .terminal
            .filter(|_| self.start.correlation.turn_id.is_some())
        {
            Some(terminal) => self.start.timestamp.max(terminal.timestamp),
            None => self.last_activity,
        }
    }

    fn has_valid_terminal(&self, captured: DateTime<Utc>) -> bool {
        // A known provider turn must have a terminal before capture, with all
        // of its replies recorded before the terminal.
        self.start.correlation.turn_id.is_none()
            || self.terminal.is_some_and(|terminal| {
                terminal.timestamp <= captured
                    && self.replies.iter().all(|reply| {
                        reply.sequence < terminal.sequence && reply.timestamp <= terminal.timestamp
                    })
            })
    }
}

impl LegacyCapture {
    fn admits(
        &self,
        turn: &TranscriptTurn<'_>,
        previous_end: DateTime<Utc>,
        next_start: Option<DateTime<Utc>>,
        first_reply: DateTime<Utc>,
    ) -> bool {
        // The recorder may establish the origin after the provider starts.
        if turn.start.timestamp <= previous_end
            || self.origin <= previous_end
            || turn.start.timestamp > first_reply
            || self.origin > first_reply
        {
            return false;
        }
        if next_start.is_some_and(|next| next <= self.captured) {
            return false;
        }
        let replies_belong_to_turn = turn.replies.iter().all(|reply| {
            reply.timestamp <= self.captured
                && reply
                    .correlation
                    .turn_id
                    .as_ref()
                    .is_none_or(|id| Some(id) == turn.start.correlation.turn_id.as_ref())
        });
        replies_belong_to_turn && turn.has_valid_terminal(self.captured)
    }
}

fn group_turns<'a>(
    request: &TranscriptReplayRequest,
    events: &'a [HarnessEventV1],
) -> Vec<TranscriptTurn<'a>> {
    let mut turns: Vec<TranscriptTurn<'a>> = Vec::new();
    for event in events.iter().filter(|event| is_root(event, request)) {
        if matches!(event.payload, HarnessEventPayloadV1::TurnStarted(_)) {
            turns.push(TranscriptTurn {
                start: event,
                last_activity: event.timestamp,
                terminal: None,
                replies: Vec::new(),
            });
            continue;
        }
        let Some(turn) = turns.last_mut() else {
            continue;
        };
        if !matches!(event.payload, HarnessEventPayloadV1::SessionStarted(_)) {
            turn.last_activity = turn.last_activity.max(event.timestamp);
        }
        if turn.terminal.is_none()
            && matches!(event.payload, HarnessEventPayloadV1::TurnFinished(_))
            && event.correlation.turn_id == turn.start.correlation.turn_id
        {
            turn.terminal = Some(event);
        }
        if is_reply(event) {
            turn.replies.push(event);
        }
    }
    turns
}

fn is_root(event: &HarnessEventV1, request: &TranscriptReplayRequest) -> bool {
    event.stream_id == request.stream_id && event.correlation.parent_tool_call_id.is_none()
}

fn is_reply(event: &HarnessEventV1) -> bool {
    match &event.payload {
        HarnessEventPayloadV1::Text(_) => true,
        HarnessEventPayloadV1::TurnFinished(outcome) => outcome.result_text.is_some(),
        HarnessEventPayloadV1::RunFinished(outcome) => outcome.result_text.is_some(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_harness_core::{StreamId, TextEvent, TurnStarted, UpdateSemantics};

    fn time(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).unwrap()
    }

    fn event(seconds: u64, payload: HarnessEventPayloadV1) -> HarnessEventV1 {
        HarnessEventV1 {
            event_id: EventId::new(seconds.to_string()),
            stream_id: StreamId::new("replay"),
            sequence: seconds,
            correlation: Default::default(),
            timestamp: time(seconds as i64),
            semantics: UpdateSemantics::Snapshot,
            provider_sequence: None,
            payload,
        }
    }

    #[test]
    fn legacy_cache_reuses_results_only_for_the_same_revision_and_capture_windows() {
        let cache = LegacyReplayCache::default();
        let mut captures = ReplayCaptureIndex {
            replies: HashMap::new(),
            legacy: vec![LegacyCapture {
                turn: TurnId::new("live"),
                origin: time(1),
                captured: time(5),
            }],
        };
        let first = cache
            .get_or_build("revision-1", &captures, || Some(HashMap::new()))
            .unwrap();
        let cached = cache
            .get_or_build("revision-1", &captures, || panic!("cache miss"))
            .unwrap();
        assert!(Arc::ptr_eq(&first, &cached));
        let revised = cache
            .get_or_build("revision-2", &captures, || Some(HashMap::new()))
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &revised));
        captures.legacy[0].captured = time(6);
        let updated = cache
            .get_or_build("revision-2", &captures, || Some(HashMap::new()))
            .unwrap();
        assert!(!Arc::ptr_eq(&revised, &updated));
    }

    #[test]
    fn legacy_window_requires_turn_and_reply_boundaries() {
        let capture = LegacyCapture {
            turn: TurnId::new("live"),
            origin: time(12),
            captured: time(20),
        };
        let mut start = event(
            10,
            HarnessEventPayloadV1::TurnStarted(TurnStarted {
                input_summary: None,
            }),
        );
        let reply = event(
            15,
            HarnessEventPayloadV1::Text(TextEvent {
                text: "reply".into(),
                completion_status: None,
            }),
        );
        let late_reply = event(21, reply.payload.clone());
        let mut turn = TranscriptTurn {
            start: &start,
            last_activity: reply.timestamp,
            replies: vec![&reply],
            terminal: None,
        };
        assert!(capture.admits(&turn, time(9), Some(time(21)), reply.timestamp));
        assert!(!capture.admits(&turn, time(10), None, reply.timestamp));
        assert!(!capture.admits(&turn, time(9), None, time(11)));
        assert!(!capture.admits(&turn, time(9), Some(time(20)), reply.timestamp));

        turn.replies.push(&late_reply);
        assert!(!capture.admits(&turn, time(9), None, reply.timestamp));

        start.correlation.turn_id = Some(TurnId::new("provider"));
        let turn = TranscriptTurn {
            start: &start,
            last_activity: reply.timestamp,
            replies: vec![&reply],
            terminal: None,
        };
        assert!(!capture.admits(&turn, time(9), None, reply.timestamp));
    }
}
