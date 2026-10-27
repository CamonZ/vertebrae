//! Bounded incremental indexes of append-only provider transcripts. Adapters
//! retain only their own discovery state; unchanged bytes are never reparsed.
use crate::HarnessError;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_INDEX_BYTES: usize = 2 * 1024 * 1024;
const MAX_INDEXES: usize = 32;

type Entries<T> = VecDeque<(PathBuf, Arc<Mutex<FileIndex<T>>>)>;
pub struct TranscriptDiscoveryIndex<T> {
    entries: Mutex<Entries<T>>,
}
struct FileIndex<T> {
    state: T,
    offset: u64,
    ordinal: u64,
    length: u64,
    modified: Option<SystemTime>,
    identity: String,
}
impl<T: Default> Default for FileIndex<T> {
    fn default() -> Self {
        Self {
            state: T::default(),
            offset: 0,
            ordinal: 0,
            length: 0,
            modified: None,
            identity: String::new(),
        }
    }
}
impl<T> Default for TranscriptDiscoveryIndex<T> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(VecDeque::new()),
        }
    }
}
impl<T: Default + Clone + Serialize> TranscriptDiscoveryIndex<T> {
    pub fn read(
        &self,
        path: &Path,
        mut apply: impl FnMut(&mut T, &Value, u64) -> bool,
    ) -> Result<T, HarnessError> {
        let entry = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let found = entries
                .iter()
                .position(|(key, _)| key == path)
                .and_then(|index| entries.remove(index));
            let value = found
                .map(|(_, entry)| entry)
                .unwrap_or_else(|| Arc::new(Mutex::new(FileIndex::default())));
            entries.push_back((path.to_owned(), value.clone()));
            while entries.len() > MAX_INDEXES {
                entries.pop_front();
            }
            value
        };
        let mut index = entry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut file = File::open(path).map_err(|error| {
            HarnessError::Operation(format!(
                "could not index transcript {}: {error}",
                path.display()
            ))
        })?;
        let metadata = file
            .metadata()
            .map_err(|error| HarnessError::Operation(error.to_string()))?;
        let modified = metadata.modified().ok();
        let identity = file_identity(&metadata);
        if index.identity != identity
            || metadata.len() < index.length
            || (metadata.len() == index.length && index.modified != modified)
        {
            *index = FileIndex::default();
        }
        if index.identity == identity
            && index.length == metadata.len()
            && index.modified == modified
        {
            return Ok(index.state.clone());
        }
        file.seek(SeekFrom::Start(index.offset))
            .map_err(|error| HarnessError::Operation(error.to_string()))?;
        // Freeze this read at the observed length; later appends belong to the
        // next update. Partial final records are retried from their first byte.
        let mut reader = BufReader::new(file.take(metadata.len().saturating_sub(index.offset)));
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            let read = reader
                .by_ref()
                .take(MAX_RECORD_BYTES as u64 + 1)
                .read_until(b'\n', &mut bytes)
                .map_err(|error| {
                    HarnessError::Operation(format!(
                        "could not read transcript index {}: {error}",
                        path.display()
                    ))
                })?;
            if read == 0 {
                break;
            }
            if read > MAX_RECORD_BYTES {
                log::warn!(
                    "skipping oversized discovery record path={} ordinal={} limit={MAX_RECORD_BYTES}",
                    path.display(),
                    index.ordinal
                );
                let skipped = if bytes.ends_with(b"\n") {
                    0
                } else {
                    reader
                        .skip_until(b'\n')
                        .map_err(|error| HarnessError::Operation(error.to_string()))?
                };
                index.offset += (read + skipped) as u64;
                index.ordinal += 1;
                continue;
            }
            let complete = bytes.ends_with(b"\n");
            match std::str::from_utf8(&bytes)
                .ok()
                .and_then(|line| serde_json::from_str::<Value>(line).ok())
            {
                Some(raw) => {
                    let ordinal = index.ordinal;
                    if apply(&mut index.state, &raw, ordinal) {
                        let weight = serde_json::to_vec(&index.state)
                            .map_err(|error| HarnessError::Operation(error.to_string()))?
                            .len();
                        if weight > MAX_INDEX_BYTES {
                            *index = FileIndex::default();
                            return Err(HarnessError::Operation(format!(
                                "transcript discovery index exceeds {MAX_INDEX_BYTES} bytes: {}",
                                path.display()
                            )));
                        }
                    }
                }
                None if complete => log::warn!(
                    "skipping malformed discovery record path={} ordinal={}",
                    path.display(),
                    index.ordinal
                ),
                None => {} // The provider may still be writing this codepoint/JSON record.
            }
            if !complete {
                break;
            }
            index.offset += read as u64;
            index.ordinal += 1;
        }
        let weight = serde_json::to_vec(&index.state)
            .map_err(|error| HarnessError::Operation(error.to_string()))?
            .len();
        if weight > MAX_INDEX_BYTES {
            *index = FileIndex::default();
            return Err(HarnessError::Operation(format!(
                "transcript discovery index exceeds {MAX_INDEX_BYTES} bytes: {}",
                path.display()
            )));
        }
        index.length = metadata.len();
        index.modified = modified;
        index.identity = identity;
        Ok(index.state.clone())
    }
}
#[cfg(unix)]
fn file_identity(metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", metadata.dev(), metadata.ino())
}
#[cfg(not(unix))]
fn file_identity(metadata: &fs::Metadata) -> String {
    format!("{:?}", metadata.created().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn indexes_only_new_bytes_and_recovers_partial_utf8_and_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("records.jsonl");
        fs::write(&path, b"{\"id\":1}\n{\"id\":\"").unwrap();
        let cache = TranscriptDiscoveryIndex::<Vec<Value>>::default();
        let apply = |state: &mut Vec<Value>, raw: &Value, _: u64| {
            if !state.contains(raw) {
                state.push(raw.clone());
                return true;
            }
            false
        };
        assert_eq!(cache.read(&path, apply).unwrap().len(), 1);
        let mut append = fs::OpenOptions::new().append(true).open(&path).unwrap();
        append.write_all(&[0xc3]).unwrap();
        assert_eq!(cache.read(&path, apply).unwrap().len(), 1);
        append.write_all(&[0xa9, b'"', b'}', b'\n']).unwrap();
        assert_eq!(cache.read(&path, apply).unwrap().len(), 2);
        assert_eq!(
            cache
                .read(&path, |_, _, _| panic!("unchanged records were reparsed"))
                .unwrap()
                .len(),
            2
        );
        fs::write(&path, b"{\"id\":3}\n").unwrap();
        assert_eq!(
            cache.read(&path, apply).unwrap(),
            vec![serde_json::json!({"id":3})]
        );
    }
    #[test]
    fn rejects_oversized_retained_indexes_instead_of_caching_unbounded_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.jsonl");
        fs::write(
            &path,
            serde_json::json!({"text":"x".repeat(MAX_INDEX_BYTES)}).to_string() + "\n",
        )
        .unwrap();
        let cache = TranscriptDiscoveryIndex::<Vec<Value>>::default();
        assert!(
            cache
                .read(&path, |state, value, _| {
                    state.push(value.clone());
                    true
                })
                .is_err()
        );
    }

    #[test]
    fn cached_paths_are_scoped_and_avoid_repeated_tree_searches() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let path_a = first.path().join("same.jsonl");
        let path_b = second.path().join("same.jsonl");
        fs::write(&path_a, "").unwrap();
        fs::write(&path_b, "").unwrap();
        let path_a = fs::canonicalize(path_a).unwrap();
        let path_b = fs::canonicalize(path_b).unwrap();
        let cache = TranscriptDiscoveryPaths::default();
        assert_eq!(
            cache
                .find(first.path(), "same", || Ok(Some(path_a.clone())))
                .unwrap(),
            Some(path_a.clone())
        );
        assert_eq!(
            cache
                .find(second.path(), "same", || Ok(Some(path_b.clone())))
                .unwrap(),
            Some(path_b)
        );
        assert_eq!(
            cache
                .find(first.path(), "same", || panic!(
                    "cached path walked the tree"
                ))
                .unwrap(),
            Some(path_a.clone())
        );
        fs::remove_file(&path_a).unwrap();
        assert!(
            cache
                .find(first.path(), "same", || Ok(None))
                .unwrap()
                .is_none()
        );
        assert!(
            cache
                .find(first.path(), "same", || panic!(
                    "negative lookup ignored its retry backoff"
                ))
                .unwrap()
                .is_none()
        );
    }
}

/// Successful transcript paths avoid repeated provider-tree walks. Missing files
/// use capped exponential retry; no provider-specific filename knowledge lives here.
#[derive(Default)]
pub struct TranscriptDiscoveryPaths {
    entries: Mutex<VecDeque<PathEntry>>,
}
struct PathEntry {
    root: PathBuf,
    id: String,
    path: Option<PathBuf>,
    retry: std::time::Instant,
    misses: u32,
}
impl TranscriptDiscoveryPaths {
    pub fn find(
        &self,
        root: &Path,
        id: &str,
        search: impl FnOnce() -> Result<Option<PathBuf>, HarnessError>,
    ) -> Result<Option<PathBuf>, HarnessError> {
        if id.len() > 1024 {
            return Err(HarnessError::InvalidRequest(
                "provider transcript identifier exceeds 1024 bytes".into(),
            ));
        }
        let now = std::time::Instant::now();
        let previous = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            entries
                .iter()
                .position(|entry| entry.root == root && entry.id == id)
                .and_then(|index| entries.remove(index))
        };
        let mut misses = 0;
        if let Some(entry) = previous {
            misses = entry.misses;
            let valid = entry
                .path
                .as_ref()
                .and_then(|path| super::validated_file(root, path));
            if valid.is_some() || (entry.path.is_none() && now < entry.retry) {
                let result = valid;
                self.retain(entry);
                return Ok(result);
            }
        }
        let path = search()?.and_then(|candidate| super::validated_file(root, &candidate));
        misses = if path.is_some() {
            0
        } else {
            misses.saturating_add(1)
        };
        let delay = std::time::Duration::from_secs((1_u64 << misses.min(5)).min(30));
        self.retain(PathEntry {
            root: root.to_owned(),
            id: id.to_owned(),
            path: path.clone(),
            retry: now + delay,
            misses,
        });
        Ok(path)
    }
    fn retain(&self, entry: PathEntry) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|old| old.root != entry.root || old.id != entry.id);
        entries.push_back(entry);
        while entries.len() > 128 {
            entries.pop_front();
        }
    }
}
