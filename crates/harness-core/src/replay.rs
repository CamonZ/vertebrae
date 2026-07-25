use std::path::PathBuf;

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
    pub events: Vec<HarnessEventV1>,
}

/// Provider adapters implement discovery, parsing, and normalization for
/// their own durable transcript formats. Callers never need to inspect a
/// provider JSONL line or know where that provider stores it.
pub trait TranscriptReplayAdapter: Send + Sync {
    fn replay(
        &self,
        request: &TranscriptReplayRequest,
    ) -> Result<Option<TranscriptReplay>, HarnessError>;
}
