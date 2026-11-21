//! The files a request reads: a worktree, a commit, or (in tests) memory.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotError(pub String);

impl fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SnapshotError {}

/// One version of a tree of files. Paths are relative, with `/`
/// separators. Providers read only what a request needs; caching by
/// content is theirs.
pub trait Snapshot {
    /// Every file path, sorted. Called at most once per request.
    fn paths(&self) -> Result<Vec<String>, SnapshotError>;

    /// A file's text; `None` when it is missing, not UTF-8 text, or larger
    /// than `max_bytes`.
    fn read(&self, path: &str, max_bytes: usize) -> Result<Option<String>, SnapshotError>;

    /// Reuse shared source text when several requests read the same snapshot.
    fn read_shared(&self, path: &str, max_bytes: usize) -> Result<Option<Arc<str>>, SnapshotError> {
        self.read(path, max_bytes).map(|text| text.map(Arc::from))
    }
}

/// Files held in memory.
#[derive(Debug, Clone, Default)]
pub struct MemorySnapshot {
    files: BTreeMap<String, String>,
}

impl MemorySnapshot {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds or replaces a file.
    pub fn insert(&mut self, path: impl Into<String>, text: impl Into<String>) {
        self.files.insert(path.into(), text.into());
    }

    pub fn remove(&mut self, path: &str) {
        self.files.remove(path);
    }
}

impl<P: Into<String>, T: Into<String>> FromIterator<(P, T)> for MemorySnapshot {
    fn from_iter<I: IntoIterator<Item = (P, T)>>(files: I) -> Self {
        Self {
            files: files
                .into_iter()
                .map(|(path, text)| (path.into(), text.into()))
                .collect(),
        }
    }
}

impl Snapshot for MemorySnapshot {
    fn paths(&self) -> Result<Vec<String>, SnapshotError> {
        Ok(self.files.keys().cloned().collect())
    }

    fn read(&self, path: &str, max_bytes: usize) -> Result<Option<String>, SnapshotError> {
        Ok(self
            .files
            .get(path)
            .filter(|text| text.len() <= max_bytes)
            .cloned())
    }
}
