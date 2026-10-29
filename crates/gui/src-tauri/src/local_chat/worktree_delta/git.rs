//! Read-only Git access for worktree checkpoints. Every command runs with
//! `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0`, so the index is never
//! refreshed or rewritten; only `status`, `rev-parse`, `diff --name-only` and
//! `cat-file` are used, and nothing is staged, committed or hashed into the
//! object store.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const GIT_TIMEOUT: Duration = Duration::from_secs(10);
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
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            side_bytes: 1024 * 1024,
            cache_paths: 2_000,
            cache_bytes: 64 * 1024 * 1024,
            status_entries: 5_000,
            patch_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GitError {
    Spawn(String),
    /// A blocking task panicked or was cancelled.
    Task(String),
    Failed(String),
    Timeout,
    OutputLimit,
    TooManyEntries(usize),
    Malformed(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(error) => write!(formatter, "could not run git: {error}"),
            Self::Task(error) => write!(formatter, "git task failed: {error}"),
            Self::Failed(error) => write!(formatter, "git failed: {error}"),
            Self::OutputLimit => write!(formatter, "git output size limit reached"),
            Self::Timeout => write!(formatter, "git timed out after {GIT_TIMEOUT:?}"),
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
    pub(crate) fn mode(&self) -> Option<u32> {
        match self {
            Self::Content { mode, .. } | Self::Opaque { mode, .. } => Some(*mode),
            Self::Absent | Self::Unreadable => None,
        }
    }

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

    /// Same content regardless of mode; used for exact rename pairing.
    pub(crate) fn same_content(&self, other: &Side) -> bool {
        match (self.fingerprint(), other.fingerprint()) {
            (Some((_, x, Some(p))), Some((_, y, Some(q)))) => x == y && p == q,
            _ => false,
        }
    }
}

/// Head mode of a dirty path; absent for untracked files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DirtyEntry {
    pub(crate) head_mode: Option<u32>,
}

/// HEAD plus every dirty path and its on-disk state when the snapshot ran.
#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    pub(crate) head: Option<String>,
    pub(crate) dirty: BTreeMap<String, DirtyEntry>,
    pub(crate) files: BTreeMap<String, Side>,
}

impl Snapshot {
    /// Whether two snapshots observed the same worktree state; used to settle.
    pub(crate) fn agrees_with(&self, other: &Snapshot) -> bool {
        self.head == other.head
            && self.dirty == other.dirty
            && self.files.len() == other.files.len()
            && self
                .files
                .iter()
                .zip(&other.files)
                .all(|((a, x), (b, y))| a == b && x.fingerprint() == y.fingerprint())
    }
}

pub(crate) fn run_git(
    worktree: &Path,
    args: &[&str],
    stdin: Option<Vec<u8>>,
) -> Result<Vec<u8>, GitError> {
    run_git_bounded(worktree, args, stdin, 128 * 1024 * 1024, &[0])
}

/// Shared runner with a retained-output budget and explicit accepted exit codes.
pub(crate) fn run_git_bounded(
    worktree: &Path,
    args: &[&str],
    stdin: Option<Vec<u8>>,
    output_limit: usize,
    accepted_codes: &[i32],
) -> Result<Vec<u8>, GitError> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(worktree)
        .args(args);
    for (variable, _) in std::env::vars_os() {
        if variable.to_string_lossy().starts_with("GIT_") {
            command.env_remove(variable);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| GitError::Spawn(error.to_string()))?;

    let writer = stdin.and_then(|input| {
        let mut pipe = child.stdin.take()?;
        Some(std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        }))
    });
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut output = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe
                    .by_ref()
                    .take(output_limit as u64 + 1)
                    .read_to_end(&mut output);
                let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            }
            output
        })
    };
    let stdout = reader(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > GIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(error) => return Err(GitError::Failed(error.to_string())),
        }
    };
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if stdout.len() > output_limit || stderr.len() > output_limit {
        Err(GitError::OutputLimit)
    } else if status
        .code()
        .is_some_and(|code| accepted_codes.contains(&code))
    {
        Ok(stdout)
    } else {
        Err(GitError::Failed(
            String::from_utf8_lossy(&stderr).trim().to_string(),
        ))
    }
}

/// The current HEAD commit, or `None` on an unborn branch.
fn head(worktree: &Path) -> Result<Option<String>, GitError> {
    // Fails outside a repository, which must not look like an unborn HEAD.
    run_git(worktree, &["rev-parse", "--git-dir"], None)?;
    match run_git(worktree, &["rev-parse", "--verify", "-q", "HEAD"], None) {
        Ok(output) => Ok(Some(String::from_utf8_lossy(&output).trim().to_string())),
        Err(GitError::Failed(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_mode(text: &str) -> Option<u32> {
    u32::from_str_radix(text, 8).ok().filter(|mode| *mode != 0)
}

/// Dirty paths from `git status --porcelain=v2 -z`, ignoring submodules.
/// Renamed index entries list both paths.
fn status(worktree: &Path, limits: &Limits) -> Result<BTreeMap<String, DirtyEntry>, GitError> {
    let output = run_git(
        worktree,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
            "--no-renames",
        ],
        None,
    )?;
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| String::from_utf8_lossy(record).into_owned());
    let mut dirty = BTreeMap::new();
    let mut entries = 0_usize;
    while let Some(record) = records.next() {
        entries += 1;
        if entries > limits.status_entries {
            return Err(GitError::TooManyEntries(entries));
        }
        let malformed = || GitError::Malformed(format!("status record {record:?}"));
        match record.as_bytes().first() {
            Some(b'1') => {
                let fields: Vec<_> = record.splitn(9, ' ').collect();
                let [_, _, sub, head_mode, _, _, _, _, path] = fields[..] else {
                    return Err(malformed());
                };
                if !sub.starts_with('S') {
                    dirty.insert(
                        path.to_string(),
                        DirtyEntry {
                            head_mode: parse_mode(head_mode),
                        },
                    );
                }
            }
            Some(b'2') => {
                let fields: Vec<_> = record.splitn(10, ' ').collect();
                let [_, _, sub, head_mode, _, _, _, _, _, path] = fields[..] else {
                    return Err(malformed());
                };
                let original = records.next().ok_or_else(malformed)?;
                if !sub.starts_with('S') {
                    dirty.insert(
                        path.to_string(),
                        DirtyEntry {
                            head_mode: parse_mode(head_mode),
                        },
                    );
                    dirty.insert(original, DirtyEntry { head_mode: None });
                }
            }
            Some(b'u') => {
                let fields: Vec<_> = record.splitn(11, ' ').collect();
                let [_, _, sub, head_mode, _, _, _, _, _, _, path] = fields[..] else {
                    return Err(malformed());
                };
                if !sub.starts_with('S') {
                    dirty.insert(
                        path.to_string(),
                        DirtyEntry {
                            head_mode: parse_mode(head_mode),
                        },
                    );
                }
            }
            Some(b'?') => {
                let path = record.get(2..).ok_or_else(malformed)?;
                dirty.insert(path.to_string(), DirtyEntry { head_mode: None });
            }
            _ => {}
        }
    }
    Ok(dirty)
}

/// Paths that differ between two commits.
pub(crate) fn changed_between(
    worktree: &Path,
    from: &str,
    to: &str,
) -> Result<BTreeSet<String>, GitError> {
    let output = run_git(
        worktree,
        &[
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            "--ignore-submodules=all",
            from,
            to,
            "--",
        ],
        None,
    )?;
    Ok(output
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect())
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

    pub(crate) fn unlimited() -> Self {
        Self {
            paths: usize::MAX,
            bytes: u64::MAX,
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
    if metadata.len() <= limits.side_bytes {
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        if file.read_to_end(&mut bytes).is_err() {
            return Side::Unreadable;
        }
        return keep_or_digest(mode, bytes, limits, budget);
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
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
pub(crate) fn snapshot(worktree: &Path, limits: &Limits) -> Result<Snapshot, GitError> {
    let head = head(worktree)?;
    let dirty = status(worktree, limits)?;
    let mut budget = CacheBudget::new(limits);
    let files = dirty
        .keys()
        .map(|path| (path.clone(), read_side(worktree, path, limits, &mut budget)))
        .collect();
    Ok(Snapshot { head, dirty, files })
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
    let mut sides = BTreeMap::new();
    let mut queried = Vec::new();
    let mut input = Vec::new();
    for (path, mode) in paths {
        if path.contains('\n') {
            sides.insert(path.clone(), Side::Unreadable);
            continue;
        }
        input.extend_from_slice(format!("{commit}:{path}\n").as_bytes());
        queried.push((path.clone(), *mode));
    }
    if queried.is_empty() {
        return Ok(sides);
    }

    let check = run_git(
        worktree,
        &["cat-file", "--batch-check=%(objecttype) %(objectsize)"],
        Some(input),
    )?;
    let mut wanted = Vec::new();
    let mut content_input = Vec::new();
    let check = String::from_utf8_lossy(&check);
    let mut lines = check.lines();
    for (path, mode) in queried {
        let line = lines
            .next()
            .ok_or_else(|| GitError::Malformed("short cat-file output".into()))?;
        let mut fields = line.split(' ');
        match (
            fields.next(),
            fields.next().and_then(|size| size.parse::<u64>().ok()),
        ) {
            (Some("blob"), Some(size)) if size <= limits.side_bytes => {
                content_input.extend_from_slice(format!("{commit}:{path}\n").as_bytes());
                wanted.push((path, mode));
            }
            (Some("blob"), Some(size)) => {
                sides.insert(
                    path,
                    Side::Opaque {
                        mode,
                        size,
                        digest: None,
                        reason: MarkerReason::TooLarge,
                    },
                );
            }
            _ if line.ends_with(" missing") => {
                sides.insert(path, Side::Absent);
            }
            _ => {
                sides.insert(path, Side::Unreadable);
            }
        }
    }
    if wanted.is_empty() {
        return Ok(sides);
    }

    let output = run_git(
        worktree,
        &["cat-file", "--batch=%(objectsize)"],
        Some(content_input),
    )?;
    let mut cursor = 0_usize;
    for (path, mode) in wanted {
        let newline = output[cursor..]
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| GitError::Malformed("truncated cat-file header".into()))?;
        let size: usize = String::from_utf8_lossy(&output[cursor..cursor + newline])
            .trim()
            .parse()
            .map_err(|_| GitError::Malformed("cat-file size".into()))?;
        let start = cursor + newline + 1;
        let end = start + size;
        if end > output.len() {
            return Err(GitError::Malformed("truncated cat-file body".into()));
        }
        sides.insert(
            path,
            Side::Content {
                mode,
                bytes: output[start..end].into(),
            },
        );
        cursor = end + 1;
    }
    Ok(sides)
}

pub(crate) const DEFAULT_MODE: u32 = REGULAR_MODE;
