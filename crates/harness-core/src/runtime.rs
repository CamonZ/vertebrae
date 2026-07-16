use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use uuid::Uuid;

use crate::{EventId, EventSink, HarnessError, HarnessEventDraftV1, HarnessEventV1, StreamId};

pub trait EventIdGenerator: Send + Sync {
    fn next_id(&self) -> EventId;
}

#[derive(Debug, Default)]
pub struct UuidEventIdGenerator;

impl EventIdGenerator for UuidEventIdGenerator {
    fn next_id(&self) -> EventId {
        EventId::new(Uuid::new_v4().to_string())
    }
}

/// Assigns canonical, per-stream sequence numbers to neutral event drafts.
pub struct EventSequencer {
    next_sequences: Mutex<HashMap<StreamId, u64>>,
    failed_streams: Mutex<HashSet<StreamId>>,
    id_generator: Arc<dyn EventIdGenerator>,
    dispatch_lock: tokio::sync::Mutex<()>,
}

impl Default for EventSequencer {
    fn default() -> Self {
        Self::new(Arc::new(UuidEventIdGenerator))
    }
}

impl EventSequencer {
    pub fn new(id_generator: Arc<dyn EventIdGenerator>) -> Self {
        Self {
            next_sequences: Mutex::new(HashMap::new()),
            failed_streams: Mutex::new(HashSet::new()),
            id_generator,
            dispatch_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn sequence(&self, draft: HarnessEventDraftV1) -> HarnessEventV1 {
        let mut sequences = self
            .next_sequences
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let sequence = sequences.entry(draft.stream_id.clone()).or_insert(1);
        let event = HarnessEventV1 {
            event_id: self.id_generator.next_id(),
            stream_id: draft.stream_id,
            sequence: *sequence,
            correlation: draft.correlation,
            timestamp: draft.timestamp,
            semantics: draft.semantics,
            provider_sequence: draft.provider_sequence,
            payload: draft.payload,
        };
        *sequence = sequence.saturating_add(1);
        event
    }

    fn stream_failed(&self, stream_id: &StreamId) -> bool {
        self.failed_streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(stream_id)
    }

    fn mark_stream_failed(&self, stream_id: StreamId) {
        self.failed_streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(stream_id);
    }
}

/// Serializes sequencing and downstream dispatch so provider callback races do
/// not determine canonical order.
pub struct SequencedEventSink {
    sequencer: Arc<EventSequencer>,
    sink: Arc<dyn EventSink>,
}

struct DispatchFailureGuard<'a> {
    sequencer: &'a EventSequencer,
    stream_id: Option<StreamId>,
}

impl DispatchFailureGuard<'_> {
    fn complete(mut self) {
        self.stream_id = None;
    }
}

impl Drop for DispatchFailureGuard<'_> {
    fn drop(&mut self) {
        if let Some(stream_id) = self.stream_id.take() {
            self.sequencer.mark_stream_failed(stream_id);
        }
    }
}

impl SequencedEventSink {
    pub fn new(sequencer: Arc<EventSequencer>, sink: Arc<dyn EventSink>) -> Self {
        Self { sequencer, sink }
    }

    pub async fn emit(&self, draft: HarnessEventDraftV1) -> Result<HarnessEventV1, HarnessError> {
        // The lock belongs to the shared sequencer rather than this wrapper so
        // multiple provider callbacks cannot race through separate wrappers.
        let _guard = self.sequencer.dispatch_lock.lock().await;
        if self.sequencer.stream_failed(&draft.stream_id) {
            return Err(HarnessError::EventSink(format!(
                "stream {} is closed after a prior dispatch failure",
                draft.stream_id
            )));
        }
        let event = self.sequencer.sequence(draft);
        // Delivery errors are not transactional: the sink may have accepted
        // the event before reporting failure. The guard also handles task
        // cancellation or panic while dispatch is awaiting the sink.
        let failure_guard = DispatchFailureGuard {
            sequencer: &self.sequencer,
            stream_id: Some(event.stream_id.clone()),
        };
        match self.sink.emit(event.clone()).await {
            Ok(()) => failure_guard.complete(),
            Err(error) => return Err(error),
        }
        Ok(event)
    }
}
