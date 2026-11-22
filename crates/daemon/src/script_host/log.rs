//! Attempt-scoped logs shared by Rhai and command stdout.

use std::sync::Arc;

use rhai::{Dynamic, Module};
use vertebrae_core::ExecutionService;
use vertebrae_harness_core::{
    EventSequencer, EventSink, HarnessEventDraftV1, HarnessEventPayloadV1, HarnessEventV1,
    StreamId, TextEvent, UpdateSemantics,
};

use super::{set_host_fn, string_argument};
use crate::script_worker::{HostContext, HostError, HostErrorKind};
use crate::session_log_event_sink::SessionLogEventSink;

pub(super) const NAMESPACE: &str = "vtb::log";
pub(super) const MAX_LOG_BYTES: usize = 8 * 1024;

pub(crate) struct ScriptLog {
    stream_id: StreamId,
    sequencer: EventSequencer,
    sink: SessionLogEventSink,
}

impl ScriptLog {
    pub(crate) fn new(execution_id: &str, service: Arc<dyn ExecutionService>) -> Self {
        Self {
            stream_id: StreamId::new(execution_id.to_owned()),
            sequencer: EventSequencer::default(),
            sink: SessionLogEventSink::new(execution_id, service),
        }
    }

    fn record(&self, text: String) -> HarnessEventV1 {
        let mut record = self.sequencer.sequence_draft(HarnessEventDraftV1::new(
            self.stream_id.clone(),
            UpdateSemantics::Snapshot,
            HarnessEventPayloadV1::Text(TextEvent {
                text,
                completion_status: None,
            }),
        ));
        record.correlation.item_id = Some(record.event_id.as_str().into());
        record
    }

    /// Give queued stdout a chance to reach Sacrum before terminal reporting.
    /// A slow backend can keep draining after the attempt settles.
    pub(crate) async fn flush(&self) {
        if !matches!(
            tokio::time::timeout(std::time::Duration::from_secs(2), self.sink.flush()).await,
            Ok(Ok(()))
        ) {
            tracing::warn!(execution_id = %self.stream_id.as_str(), "Execute session logs are still pending");
        }
    }

    pub(super) fn offer_stdout(&self, text: String) -> bool {
        self.sink.try_enqueue(self.record(text))
    }
}

pub(super) fn module(host: &HostContext) -> Module {
    let mut module = Module::new();
    set_host_fn(&mut module, host, NAMESPACE, "info", info);
    module
}

fn info(host: &HostContext, message: Dynamic) -> Result<Dynamic, HostError> {
    let text = string_argument(message, "Log message")?;
    if text.len() > MAX_LOG_BYTES {
        return Err(HostError::invalid(format!(
            "Log message exceeds {MAX_LOG_BYTES} UTF-8 bytes"
        )));
    }
    host.block_on_owned(|mut cancel| async move {
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(HostError::cancelled()),
            result = host.log.sink.emit(host.log.record(text)) => {
                result.map(|()| Dynamic::UNIT).map_err(|error| {
                    HostError::new(HostErrorKind::Transport, error.to_string())
                })
            }
        }
    })
}
