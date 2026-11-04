//! Read-only repository observations through libgit2. Filesystem contents are
//! captured once; clean sides are resolved from immutable commit objects.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};

const SYMLINK_MODE: u32 = 0o120000;
const EXECUTABLE_MODE: u32 = 0o100755;
const REGULAR_MODE: u32 = 0o100644;

/// Bounds for one session's checkpoints and annotations.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    /// Largest file side kept as content; larger files become markers.
    pub(crate) side_bytes: u64,
    /// Dirty paths whose content a checkpoint may cache.
    pub(crate) cache_paths: usize,
    /// Total content bytes a checkpoint may cache.
    pub(crate) cache_bytes: u64,
    /// Status entries beyond which a segment is skipped.
    pub(crate) status_entries: usize,
    /// Largest patch text of one annotation.
    pub(crate) patch_bytes: usize,
    /// Optional per-file patch cap used by the Changes view.
    pub(crate) file_patch_bytes: Option<usize>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            side_bytes: 1024 * 1024,
            cache_paths: 2_000,
            cache_bytes: 64 * 1024 * 1024,
            status_entries: 5_000,
            patch_bytes: 1024 * 1024,
            file_patch_bytes: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GitError {
    /// A blocking task panicked or was cancelled.
    Task(String),
    Failed(String),
    TooManyEntries(usize),
    Malformed(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Task(error) => write!(formatter, "git task failed: {error}"),
            Self::Failed(error) => write!(formatter, "git failed: {error}"),
            Self::TooManyEntries(count) => {
                write!(formatter, "worktree has {count} status entries")
            }
            Self::Malformed(reason) => write!(formatter, "unexpected git output: {reason}"),
        }
    }
}

/// Why a changed file is listed without hunks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MarkerReason {
    Binary,
    TooLarge,
    BaselineUnavailable,
    PatchLimit,
    Unreadable,
}

/// One side of a path: its content when cached, otherwise only its identity.
#[derive(Debug, Clone)]
pub(crate) enum Side {
    Absent,
    Content {
        mode: u32,
        bytes: Arc<[u8]>,
    },
    /// Content was not kept. `digest` is absent when it was never read.
    Opaque {
        mode: u32,
        size: u64,
        digest: Option<[u8; 32]>,
        reason: MarkerReason,
    },
    Unreadable,
}

impl Side {
    fn fingerprint(&self) -> Option<(u32, u64, Option<[u8; 32]>)> {
        match self {
            Self::Content { mode, bytes } => Some((
                *mode,
                bytes.len() as u64,
                Some(Sha256::digest(bytes).into()),
            )),
            Self::Opaque {
                mode, size, digest, ..
            } => Some((*mode, *size, *digest)),
            Self::Absent | Self::Unreadable => None,
        }
    }

    /// Whether both sides certainly hold the same file. Unknown identities
    /// and unreadable files compare as different.
    pub(crate) fn same_as(&self, other: &Side) -> bool {
        match (self, other) {
            (Self::Absent, Self::Absent) => true,
            (Self::Content { mode: a, bytes: x }, Self::Content { mode: b, bytes: y }) => {
                a == b && x == y
            }
            (Self::Unreadable, _) | (_, Self::Unreadable) => false,
            (Self::Absent, _) | (_, Self::Absent) => false,
            _ => match (self.fingerprint(), other.fingerprint()) {
                (Some((a, x, Some(p))), Some((b, y, Some(q)))) => a == b && x == y && p == q,
                _ => false,
            },
        }
    }
}

/// HEAD plus every dirty path and its on-disk state when the snapshot ran.
#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    pub(crate) head: Option<String>,
    pub(crate) branch: String,
    pub(crate) dirty: BTreeSet<String>,
    pub(crate) files: BTreeMap<String, Side>,
}

impl Snapshot {
    /// Whether two snapshots observed the same worktree state; used to settle.
    pub(crate) fn agrees_with(&self, other: &Snapshot) -> bool {
        self.branch == other.branch
            && self.head == other.head
            && self.dirty == other.dirty
            && self.files.len() == other.files.len()
            && self
                .files
                .iter()
                .zip(&other.files)
                .all(|((a, x), (b, y))| a == b && x.fingerprint() == y.fingerprint())
    }
}

impl From<git2::Error> for GitError {
    fn from(error: git2::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

/// Open precisely this worktree, without consulting process GIT_* variables.
/// No index write/refresh API is used. Status explicitly disables index updates.
pub(crate) fn repository(worktree: &Path) -> Result<git2::Repository, GitError> {
    let repo = git2::Repository::open(worktree)?;
    let root = repo
        .workdir()
        .ok_or_else(|| GitError::Failed("bare repository".into()))?;

    if root.canonicalize().ok() != worktree.canonicalize().ok() {
        return Err(GitError::Failed("not a worktree root".into()));
    }

    Ok(repo)
}

pub(crate) fn head_id(repo: &git2::Repository) -> Result<Option<String>, GitError> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_commit()?.id().to_string())),
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn branch(worktree: &Path) -> Result<Option<String>, GitError> {
    let repo = repository(worktree)?;
    let head = repo.find_reference("HEAD")?;

    Ok(head
        .symbolic_target()?
        .and_then(|name| name.strip_prefix("refs/heads/"))
        .map(str::to_owned))
}

/// String annotation paths must round-trip; never replace invalid bytes with
/// U+FFFD and risk attributing a different file.
pub(crate) fn utf8_path(path: &[u8]) -> Result<String, GitError> {
    String::from_utf8(path.to_vec())
        .map_err(|_| GitError::Malformed("non-UTF-8 path is unsupported".into()))
}

pub(crate) fn status(worktree: &Path, limits: &Limits) -> Result<BTreeSet<String>, GitError> {
    let repo = repository(worktree)?;
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false)
        .update_index(false);

    let entries = repo.statuses(Some(&mut options))?;

    if entries.len() > limits.status_entries {
        return Err(GitError::TooManyEntries(entries.len()));
    }

    entries
        .iter()
        .map(|entry| utf8_path(entry.path_bytes()))
        .collect()
}

pub(crate) fn changed_between(
    worktree: &Path,
    from: Option<&str>,
    to: &str,
) -> Result<BTreeSet<String>, GitError> {
    let repo = repository(worktree)?;
    let old = from
        .map(|from| repo.revparse_single(from)?.peel_to_tree())
        .transpose()?;
    let new = repo.revparse_single(to)?.peel_to_tree()?;

    let mut options = git2::DiffOptions::new();
    options.update_index(false);
    let diff = repo.diff_tree_to_tree(old.as_ref(), Some(&new), Some(&mut options))?;

    let mut paths = BTreeSet::new();

    for delta in diff.deltas() {
        if delta.old_file().mode() == git2::FileMode::Commit
            || delta.new_file().mode() == git2::FileMode::Commit
        {
            continue;
        }
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(path) = file.path_bytes() {
                paths.insert(utf8_path(path)?);
            }
        }
    }

    Ok(paths)
}

/// Running budget for content kept by one checkpoint.
pub(crate) struct CacheBudget {
    paths: usize,
    bytes: u64,
}

impl CacheBudget {
    pub(crate) fn new(limits: &Limits) -> Self {
        Self {
            paths: limits.cache_paths,
            bytes: limits.cache_bytes,
        }
    }

    fn take(&mut self, size: u64) -> bool {
        if self.paths == 0 || self.bytes < size {
            return false;
        }
        self.paths -= 1;
        self.bytes -= size;
        true
    }
}

/// Read a path from disk. Content is kept when the side cap and the budget
/// allow it; otherwise only size and digest are recorded.
pub(crate) fn read_side(
    worktree: &Path,
    path: &str,
    limits: &Limits,
    budget: &mut CacheBudget,
) -> Side {
    let full = worktree.join(path);
    let metadata = match fs::symlink_metadata(&full) {
        Ok(metadata) => metadata,
        Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {
            return Side::Absent
        }
        Err(_) => return Side::Unreadable,
    };

    if metadata.file_type().is_symlink() {
        let Ok(target) = fs::read_link(&full) else {
            return Side::Unreadable;
        };
        let bytes = target.to_string_lossy().into_owned().into_bytes();
        return keep_or_digest(SYMLINK_MODE, bytes, limits, budget);
    }

    if !metadata.is_file() {
        return Side::Absent;
    }

    let mode = file_mode(&metadata);
    let Ok(mut file) = File::open(&full) else {
        return Side::Unreadable;
    };

    let mut hasher = Sha256::new();
    let mut size = 0_u64;

    if metadata.len() <= limits.side_bytes {
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        if file
            .by_ref()
            .take(limits.side_bytes + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return Side::Unreadable;
        }
        if bytes.len() as u64 <= limits.side_bytes {
            return keep_or_digest(mode, bytes, limits, budget);
        }
        // A growing file crossed the cap after metadata. Hash its remaining
        // bytes too, rather than treating a prefix digest as a file identity.
        hasher.update(&bytes);
        size = bytes.len() as u64;
    }

    let mut buffer = vec![0_u8; 64 * 1024];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);

    loop {
        if std::time::Instant::now() >= deadline {
            return Side::Unreadable;
        }

        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                hasher.update(&buffer[..read]);
                size += read as u64;
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(_) => return Side::Unreadable,
        }
    }

    Side::Opaque {
        mode,
        size,
        digest: Some(hasher.finalize().into()),
        reason: MarkerReason::TooLarge,
    }
}

fn keep_or_digest(mode: u32, bytes: Vec<u8>, limits: &Limits, budget: &mut CacheBudget) -> Side {
    let size = bytes.len() as u64;

    if size > limits.side_bytes {
        return Side::Opaque {
            mode,
            size,
            digest: Some(Sha256::digest(&bytes).into()),
            reason: MarkerReason::TooLarge,
        };
    }

    if budget.take(size) {
        Side::Content {
            mode,
            bytes: bytes.into(),
        }
    } else {
        Side::Opaque {
            mode,
            size,
            digest: Some(Sha256::digest(&bytes).into()),
            reason: MarkerReason::BaselineUnavailable,
        }
    }
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    if metadata.permissions().mode() & 0o111 != 0 {
        EXECUTABLE_MODE
    } else {
        REGULAR_MODE
    }
}

#[cfg(not(unix))]
fn file_mode(_metadata: &fs::Metadata) -> u32 {
    REGULAR_MODE
}

/// Checkpoint the worktree: HEAD, dirty paths and their on-disk state.
pub(crate) fn snapshot(
    worktree: &Path,
    limits: &Limits,
    intended_branch: &str,
) -> Result<Snapshot, GitError> {
    if branch(worktree)?.as_deref() != Some(intended_branch) {
        return Err(GitError::Failed(
            "worktree is not on the intended branch".into(),
        ));
    }

    let head = head_id(&repository(worktree)?)?;
    let dirty = status(worktree, limits)?;

    let mut budget = CacheBudget::new(limits);
    let files = dirty
        .iter()
        .map(|path| (path.clone(), read_side(worktree, path, limits, &mut budget)))
        .collect();

    if branch(worktree)?.as_deref() != Some(intended_branch) {
        return Err(GitError::Failed("branch changed during checkpoint".into()));
    }

    Ok(Snapshot {
        head,
        branch: intended_branch.to_owned(),
        dirty,
        files,
    })
}

/// Capture end candidates, including paths which became clean (or were
/// committed) during a tool. Physical end bytes must be observed here, even
/// when attributes make a file compare clean against its commit blob.
pub(crate) fn snapshot_since(
    worktree: &Path,
    limits: &Limits,
    intended_branch: &str,
    start: Option<&Snapshot>,
) -> Result<Snapshot, GitError> {
    let mut end = snapshot(worktree, limits, intended_branch)?;

    if let Some(start) = start {
        let mut paths: BTreeSet<_> = start
            .dirty
            .iter()
            .chain(end.dirty.iter())
            .cloned()
            .collect();

        if let Some(to) = &end.head {
            if start.head != end.head {
                paths.extend(changed_between(worktree, start.head.as_deref(), to)?);
            }
        }

        if paths.len() > limits.status_entries {
            return Err(GitError::TooManyEntries(paths.len()));
        }

        // Reuse captured dirty sides, accounting for their retained content.
        let mut budget = CacheBudget::new(limits);
        for side in end.files.values() {
            if let Side::Content { bytes, .. } = side {
                budget.take(bytes.len() as u64);
            }
        }

        for path in paths {
            end.files
                .entry(path.clone())
                .or_insert_with(|| read_side(worktree, &path, limits, &mut budget));
        }

        if branch(worktree)?.as_deref() != Some(intended_branch) {
            return Err(GitError::Failed(
                "branch changed during end checkpoint".into(),
            ));
        }
    }

    Ok(end)
}

/// Blob contents of `paths` at `commit`. Paths absent from the commit map to
/// `Side::Absent`; blobs over the side cap keep only their size. `modes`
/// supplies the commit's file mode where it is known.
pub(crate) fn commit_sides(
    worktree: &Path,
    commit: &str,
    paths: &[(String, u32)],
    limits: &Limits,
) -> Result<BTreeMap<String, Side>, GitError> {
    let repo = repository(worktree)?;
    let tree = repo.revparse_single(commit)?.peel_to_tree()?;
    let odb = repo.odb()?;
    let mut sides = BTreeMap::new();
    let mut budget = CacheBudget::new(limits);

    for (path, _) in paths {
        let side = match tree.get_path(Path::new(path)) {
            Ok(entry) => {
                let mode = entry.filemode() as u32;
                let (size, kind) = odb.read_header(entry.id())?;
                if kind != git2::ObjectType::Blob {
                    Side::Unreadable
                } else if size as u64 > limits.side_bytes {
                    Side::Opaque {
                        mode,
                        size: size as u64,
                        digest: None,
                        reason: MarkerReason::TooLarge,
                    }
                } else {
                    keep_or_digest(
                        mode,
                        repo.find_blob(entry.id())?.content().to_vec(),
                        limits,
                        &mut budget,
                    )
                }
            }
            Err(error) if error.code() == git2::ErrorCode::NotFound => Side::Absent,
            Err(error) => return Err(error.into()),
        };
        sides.insert(path.clone(), side);
    }

    Ok(sides)
}

pub(crate) const DEFAULT_MODE: u32 = REGULAR_MODE;
