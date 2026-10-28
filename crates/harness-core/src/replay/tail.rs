//! Provider-neutral bounded tail reading for durable JSONL transcripts.
//!
//! Cold newest-page requests read only the last N bytes of the transcript so
//! opening a long session stays O(tail) instead of O(transcript). Reading is
//! captured-length bounded: bytes appended after the read starts are ignored
//! so the tail matches one stable transcript revision.

use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

use crate::HarnessError;

const MIN_TAIL_READ_BYTES: usize = 64 * 1024;
const MAX_TAIL_READ_BYTES: usize = 1024 * 1024;

/// Byte budget for a cold newest-page read, scaled by the requested limit.
pub fn tail_read_budget(limit: usize) -> usize {
    limit
        .max(1)
        .saturating_mul(2 * 1024)
        .clamp(MIN_TAIL_READ_BYTES, MAX_TAIL_READ_BYTES)
}

/// Read at most `captured_len` bytes; bytes appended concurrently are ignored.
pub fn read_captured_tail(reader: impl Read, captured_len: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(captured_len);
    reader.take(captured_len as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The result of a bounded tail read: complete lines with their byte offsets
/// and whether older records exist before the window.
pub struct TranscriptTailLines {
    /// `(source byte offset + 1, line)` in chronological order.
    pub lines: Vec<(u64, String)>,
    /// True when the transcript has records before the read window.
    pub older_records_exist: bool,
    /// Bytes actually read from the transcript (bounded by the budget).
    pub bytes_read: usize,
}

impl TranscriptTailLines {
    /// Revision-keyed bounded discovery tails; at most eight 128-KiB windows.
    /// Replay itself retains its separate cursor/revision cache.
    pub fn read_cached(
        path: &Path,
        budget: usize,
        provider: &str,
    ) -> Result<std::sync::Arc<Self>, HarnessError> {
        use super::TranscriptRevision;
        use std::{
            collections::VecDeque,
            path::PathBuf,
            sync::{Arc, Mutex, OnceLock},
        };

        type Entry = (PathBuf, usize, TranscriptRevision, Arc<TranscriptTailLines>);
        static CACHE: OnceLock<Mutex<VecDeque<Entry>>> = OnceLock::new();

        let budget = budget.min(128 * 1024);
        let revision = TranscriptRevision::capture(path)?;
        let cache = CACHE.get_or_init(Mutex::default);
        {
            let mut entries = cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(index) = entries.iter().position(|(key, size, version, _)| {
                key == path && *size == budget && version == &revision
            }) {
                let entry = entries
                    .remove(index)
                    .expect("position came from this deque");
                let result = entry.3.clone();
                entries.push_back(entry);
                return Ok(result);
            }
        }

        let tail = Arc::new(Self::read(path, budget, provider)?);
        revision.verify(path)?;

        let mut entries = cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        entries.retain(|(key, _, _, _)| key != path);
        entries.push_back((path.to_owned(), budget, revision, tail.clone()));
        while entries.len() > 8 {
            entries.pop_front();
        }

        Ok(tail)
    }

    /// Read the last `budget` bytes of a JSONL transcript and split it into
    /// complete lines. The first partial line (cut by the window start) is
    /// discarded so only whole records are decoded.
    pub fn read(path: &Path, budget: usize, provider: &str) -> Result<Self, HarnessError> {
        let mut file = File::open(path).map_err(|error| {
            HarnessError::Operation(format!(
                "failed to open {provider} transcript {}: {error}",
                path.display()
            ))
        })?;
        let len = file
            .metadata()
            .map_err(|error| HarnessError::Operation(error.to_string()))?
            .len();

        let start = len.saturating_sub(budget as u64);
        file.seek(SeekFrom::Start(start))
            .map_err(|error| HarnessError::Operation(error.to_string()))?;
        let bytes = read_captured_tail(file, (len - start) as usize)
            .map_err(|error| HarnessError::Operation(error.to_string()))?;

        let discard = if start > 0 {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |index| index + 1)
        } else {
            0
        };

        let first_offset = start.saturating_add(discard as u64);
        let slice = &bytes[discard..];
        let text = match std::str::from_utf8(slice) {
            Ok(text) => text,
            // The writer can stop between the bytes of a final codepoint.
            // Keep its valid prefix so the adapter can defer incomplete JSON.
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&slice[..error.valid_up_to()])
                    .expect("UTF-8 decoder identified this valid prefix")
            }
            Err(error) => {
                return Err(HarnessError::Operation(format!(
                    "malformed UTF-8 in {provider} transcript {} tail: {error}",
                    path.display()
                )));
            }
        };

        let mut offset = first_offset;
        let lines = text
            .split_inclusive('\n')
            .map(|line| {
                let source = offset.saturating_add(1);
                offset = offset.saturating_add(line.len() as u64);
                (source, line.to_owned())
            })
            .collect();

        Ok(Self {
            lines,
            older_records_exist: first_offset > 0,
            bytes_read: bytes.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn cached_discovery_tail_reuses_unchanged_bytes_and_invalidates_on_append() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "one").unwrap();
        let first = TranscriptTailLines::read_cached(file.path(), 1024, "test").unwrap();
        let same = TranscriptTailLines::read_cached(file.path(), 1024, "test").unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &same));
        writeln!(file, "two").unwrap();
        let changed = TranscriptTailLines::read_cached(file.path(), 1024, "test").unwrap();
        assert!(!std::sync::Arc::ptr_eq(&first, &changed));
        assert_eq!(changed.lines.len(), 2);
        assert_eq!(first.lines.len(), 1);
    }

    #[test]
    fn captured_tail_reader_does_not_follow_appended_bytes() {
        let bytes = read_captured_tail(std::io::Cursor::new(b"snapshot-appended"), 8).unwrap();
        assert_eq!(bytes, b"snapshot");
    }

    #[test]
    fn tail_reads_discard_the_leading_partial_line_and_track_offsets() {
        let file = NamedTempFile::new().unwrap();
        // 21-byte first line so a 20-byte budget starts mid-line.
        file.as_file()
            .write_all(format!("{}\n{{\"a\":1}}\n{{\"a\":2}}\n", "x".repeat(20)).as_bytes())
            .unwrap();
        let tail = TranscriptTailLines::read(file.path(), 20, "test").unwrap();
        assert!(tail.older_records_exist);
        // The partial first line is discarded; sources are 1-based offsets of
        // the complete lines that follow byte 21.
        let sources: Vec<u64> = tail.lines.iter().map(|(source, _)| *source).collect();
        assert_eq!(sources, vec![22, 30]);
        assert!(tail.lines[0].1.starts_with("{\"a\":1}"));
        assert!(tail.lines[1].1.starts_with("{\"a\":2}"));
    }

    #[test]
    fn whole_file_tail_reads_have_no_older_records() {
        let file = NamedTempFile::new().unwrap();
        file.as_file().write_all(b"{\"a\":1}\n").unwrap();
        let tail = TranscriptTailLines::read(file.path(), 4096, "test").unwrap();
        assert!(!tail.older_records_exist);
        assert_eq!(tail.lines.len(), 1);
        assert_eq!(tail.lines[0].0, 1);
    }
}
