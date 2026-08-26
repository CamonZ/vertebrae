//! Transcript revision tracking for consistent replay pages.

use std::{fs, path::Path, time::UNIX_EPOCH};

use crate::HarnessError;

/// Captured before provider decoding and verified afterward so pages from
/// different transcript states cannot be mixed.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TranscriptRevision {
    byte_len: u64,
    modified_nanos: u128,
}

impl TranscriptRevision {
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

    pub fn verify(&self, path: &Path) -> Result<(), HarnessError> {
        if &Self::capture(path)? == self {
            return Ok(());
        }
        Err(HarnessError::Operation(
            "provider transcript changed while replay was being decoded; retry the replay".into(),
        ))
    }

    pub(crate) fn is_newer_than(&self, other: &Self) -> bool {
        (self.modified_nanos, self.byte_len) > (other.modified_nanos, other.byte_len)
    }

    /// Synthetic revision for tests: deterministic and comparable.
    #[cfg(test)]
    pub(crate) fn synthetic(rank: u128) -> Self {
        Self {
            byte_len: rank as u64,
            modified_nanos: rank,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn unchanged_transcripts_verify_and_changes_do_not() {
        let mut transcript = NamedTempFile::new().unwrap();
        transcript.write_all(b"first").unwrap();
        let revision = TranscriptRevision::capture(transcript.path()).unwrap();
        revision.verify(transcript.path()).unwrap();
        transcript.write_all(b" changed").unwrap();
        assert!(revision.verify(transcript.path()).is_err());
    }

    #[test]
    fn newer_revisions_compare_by_mtime_then_length() {
        let old = TranscriptRevision {
            byte_len: 10,
            modified_nanos: 10,
        };
        let newer = TranscriptRevision {
            byte_len: 5,
            modified_nanos: 11,
        };
        let same_time_longer = TranscriptRevision {
            byte_len: 20,
            modified_nanos: 10,
        };
        assert!(newer.is_newer_than(&old));
        assert!(same_time_longer.is_newer_than(&old));
        assert!(!old.is_newer_than(&newer));
    }
}
