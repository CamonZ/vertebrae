//! Shared, short-lived directory inventories. Filename interpretation stays in adapters.
use super::validated_file;
use crate::HarnessError;
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(30);
const MAX_ROOTS: usize = 4;
const MAX_PATH_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;

struct Snapshot {
    root: PathBuf,
    expires: Instant,
    files: Vec<PathBuf>,
}

/// A root inventory survives per-ID cache eviction, including negative lookups.
/// The synchronous lock shares concurrent scans and limits scans to one at a time.
/// A failed/oversized scan retains an empty inventory for TTL to avoid hot retries,
/// but reports an error rather than silently returning incomplete discovery.
#[derive(Default)]
pub struct TranscriptDirectorySnapshot {
    entries: Mutex<VecDeque<(Snapshot, Option<String>)>>,
}

impl TranscriptDirectorySnapshot {
    pub fn find(
        &self,
        root: &Path,
        matches: impl Fn(&Path) -> bool,
    ) -> Result<Option<PathBuf>, HarnessError> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let existing = entries
            .iter()
            .position(|(entry, _)| entry.root == root)
            .and_then(|index| entries.remove(index));
        let snapshot = match existing {
            Some(entry) if Instant::now() < entry.0.expires => entry,
            _ => {
                let mut examined = 0;
                let mut files = Vec::new();
                let mut bytes = 0;
                let error = walk(root, 0, &mut files, &mut bytes, &mut examined)
                    .err()
                    .map(|error| error.to_string());
                if error.is_some() {
                    files.clear();
                }
                (
                    Snapshot {
                        root: root.to_owned(),
                        expires: Instant::now() + TTL,
                        files,
                    },
                    error,
                )
            }
        };
        let result = if let Some(error) = &snapshot.1 {
            Err(HarnessError::Operation(error.clone()))
        } else {
            Ok(snapshot
                .0
                .files
                .iter()
                .filter(|path| matches(path))
                .find_map(|path| validated_file(root, path)))
        };
        entries.push_back(snapshot);
        while entries.len() > MAX_ROOTS {
            entries.pop_front();
        }
        result
    }
}

fn walk(
    root: &Path,
    depth: usize,
    files: &mut Vec<PathBuf>,
    bytes: &mut usize,
    examined: &mut usize,
) -> std::io::Result<()> {
    if depth > 64 {
        return Err(std::io::Error::other(
            "transcript directory depth exceeds 64",
        ));
    }
    let directory = match fs::read_dir(root) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in directory {
        *examined += 1;
        if *examined > MAX_ENTRIES {
            return Err(std::io::Error::other(
                "transcript directory inventory exceeds entry budget",
            ));
        }
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, depth + 1, files, bytes, examined)?;
        } else if kind.is_file() {
            *bytes += path.as_os_str().len();
            if *bytes > MAX_PATH_BYTES {
                return Err(std::io::Error::other(
                    "transcript directory inventory exceeds byte budget",
                ));
            }
            files.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entry_budget_is_shared_across_nested_directories() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested/file"), "").unwrap();
        let mut files = Vec::new();
        let mut bytes = 0;
        let mut examined = MAX_ENTRIES - 1;
        assert!(walk(dir.path(), 0, &mut files, &mut bytes, &mut examined).is_err());
        assert!(files.is_empty());
        assert_eq!(examined, MAX_ENTRIES + 1);
    }

    #[test]
    fn negative_inventory_survives_large_working_sets_and_expires() {
        let dir = tempfile::tempdir().unwrap();
        let cache = TranscriptDirectorySnapshot::default();
        for id in 0..346 {
            assert!(
                cache
                    .find(dir.path(), |p| p.ends_with(id.to_string()))
                    .unwrap()
                    .is_none()
            );
        }
        let path = dir.path().join("new");
        fs::write(&path, "").unwrap();
        assert!(cache.find(dir.path(), |_| true).unwrap().is_none());
        cache.entries.lock().unwrap()[0].0.expires = Instant::now();
        assert_eq!(
            cache.find(dir.path(), |_| true).unwrap(),
            Some(fs::canonicalize(path).unwrap())
        );
    }
    #[test]
    fn bounds_roots_and_retries_failed_scans_after_expiry() {
        let cache = TranscriptDirectorySnapshot::default();
        let dirs: Vec<_> = (0..=MAX_ROOTS)
            .map(|_| tempfile::tempdir().unwrap())
            .collect();
        for dir in &dirs {
            cache.find(dir.path(), |_| true).unwrap();
        }
        assert_eq!(cache.entries.lock().unwrap().len(), MAX_ROOTS);
        let root = dirs.last().unwrap().path();
        let mut entries = cache.entries.lock().unwrap();
        entries.back_mut().unwrap().1 = Some("test scan failure".into());
        drop(entries);
        assert!(cache.find(root, |_| true).is_err());
        cache.entries.lock().unwrap().back_mut().unwrap().0.expires = Instant::now();
        assert!(cache.find(root, |_| true).unwrap().is_none());
    }

    #[test]
    fn concurrent_requests_share_a_scan_and_roots_are_isolated() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("first"), "").unwrap();
        let cache = TranscriptDirectorySnapshot::default();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let cache = &cache;
                let root = dir.path();
                scope.spawn(move || assert!(cache.find(root, |_| true).unwrap().is_some()));
            }
        });
        assert_eq!(cache.entries.lock().unwrap().len(), 1);
        let other = tempfile::tempdir().unwrap();
        assert!(cache.find(other.path(), |_| true).unwrap().is_none());
    }
}
