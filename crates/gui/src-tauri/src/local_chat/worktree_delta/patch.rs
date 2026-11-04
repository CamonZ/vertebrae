//! Library-rendered patches between captured observations, never mutable files.

use super::git::{self, GitError, Limits, MarkerReason, Side, Snapshot};

use serde::Serialize;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct FileMarker {
    pub(crate) reason: MarkerReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct FileEntry {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) old_path: Option<String>,
    pub(crate) status: FileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) marker: Option<FileMarker>,
}

/// The change between two checkpoints of one worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Delta {
    pub(crate) base_head: Option<String>,
    pub(crate) head_changed: bool,
    pub(crate) patch: String,
    pub(crate) files: Vec<FileEntry>,
}

/// Resolve clean paths from immutable commit objects, dirty paths from the
/// checkpoint cache. In particular a reverted/deleted path is never reread.
fn sides(
    worktree: &Path,
    snapshot: &Snapshot,
    paths: &BTreeSet<String>,
    limits: &Limits,
) -> Result<BTreeMap<String, Side>, GitError> {
    let clean = paths
        .iter()
        .filter(|path| !snapshot.files.contains_key(*path))
        .map(|path| (path.clone(), git::DEFAULT_MODE))
        .collect::<Vec<_>>();

    let mut result = match &snapshot.head {
        Some(head) => git::commit_sides(worktree, head, &clean, limits)?,
        None => BTreeMap::new(),
    };

    result.extend(
        snapshot
            .files
            .iter()
            .filter(|(path, _)| paths.contains(*path))
            .map(|(path, side)| (path.clone(), side.clone())),
    );

    for path in paths {
        result.entry(path.clone()).or_insert_with(|| {
            if snapshot.dirty.contains(path) {
                snapshot
                    .files
                    .get(path)
                    .cloned()
                    .unwrap_or(Side::Unreadable)
            } else {
                Side::Absent
            }
        });
    }

    Ok(result)
}

pub(crate) fn compute(
    worktree: &Path,
    start: &Snapshot,
    end: &Snapshot,
    limits: &Limits,
) -> Result<Delta, GitError> {
    let head_changed = start.head != end.head;
    let mut paths: BTreeSet<_> = start
        .dirty
        .iter()
        .chain(end.dirty.iter())
        .cloned()
        .collect();

    if let Some(to) = &end.head {
        if head_changed {
            paths.extend(git::changed_between(worktree, start.head.as_deref(), to)?);
        }
    }

    if paths.len() > limits.status_entries {
        return Err(GitError::TooManyEntries(paths.len()));
    }

    let before = sides(worktree, start, &paths, limits)?;
    let after = sides(worktree, end, &paths, limits)?;
    let rendered = compare(&before, &after, limits)?;

    Ok(Delta {
        base_head: start.head.clone(),
        head_changed,
        patch: rendered.iter().map(|(_, text)| text.as_str()).collect(),
        files: rendered.into_iter().map(|(file, _)| file).collect(),
    })
}

fn marker(side: &Side) -> Option<MarkerReason> {
    match side {
        Side::Unreadable => Some(MarkerReason::Unreadable),
        Side::Opaque { reason, .. } => Some(*reason),
        _ => None,
    }
}

/// A private, memory-only libgit2 repository. Its ODB has only a mempack
/// backend, no path or disk backend. Neither blobs nor trees can reach the
/// user's object store, refs, index or worktree. Dropping it frees everything.
fn memory_repository() -> Result<git2::Repository, GitError> {
    let odb = git2::Odb::new()?;
    {
        let _memory = odb.add_new_mempack_backend(1000)?;
    }

    Ok(git2::Repository::from_odb(odb)?)
}

fn tree<'repo>(
    repo: &'repo git2::Repository,
    sides: &BTreeMap<String, Side>,
) -> Result<git2::Tree<'repo>, GitError> {
    let mut index = git2::Index::new()?;

    for (path, side) in sides {
        if let Side::Content { mode, bytes } = side {
            index.add(&git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: *mode,
                uid: 0,
                gid: 0,
                file_size: bytes.len() as u32,
                id: repo.blob(bytes)?,
                flags: 0,
                flags_extended: 0,
                path: path.as_bytes().to_vec(),
            })?;
        }
    }

    Ok(repo.find_tree(index.write_tree_to(repo)?)?)
}

/// Shared recorder/Changes renderer. Libgit2 owns rename matching, modes,
/// symlinks, path quoting, binary classification and patch/hunk formatting.
pub(crate) fn compare(
    before: &BTreeMap<String, Side>,
    after: &BTreeMap<String, Side>,
    limits: &Limits,
) -> Result<Vec<(FileEntry, String)>, GitError> {
    let repo = memory_repository()?;
    let mut old = BTreeMap::new();
    let mut new = BTreeMap::new();
    let mut markers = Vec::new();
    let paths: BTreeSet<_> = before.keys().chain(after.keys()).collect();

    for path in paths {
        let a = before.get(path).unwrap_or(&Side::Absent);
        let b = after.get(path).unwrap_or(&Side::Absent);

        if a.same_as(b) {
            continue;
        }

        if let Some(reason) = marker(a).or_else(|| marker(b)) {
            markers.push((
                FileEntry {
                    path: path.clone(),
                    old_path: None,
                    status: if matches!(a, Side::Absent) {
                        FileStatus::Added
                    } else if matches!(b, Side::Absent) {
                        FileStatus::Deleted
                    } else {
                        FileStatus::Modified
                    },
                    marker: Some(FileMarker { reason }),
                },
                String::new(),
            ));
        } else {
            old.insert(path.clone(), a.clone());
            new.insert(path.clone(), b.clone());
        }
    }

    let old_tree = tree(&repo, &old)?;
    let new_tree = tree(&repo, &new)?;
    let mut options = git2::DiffOptions::new();
    options
        .context_lines(3)
        .include_typechange(true)
        .update_index(false);
    let mut diff = repo.diff_tree_to_tree(Some(&old_tree), Some(&new_tree), Some(&mut options))?;

    let mut find = git2::DiffFindOptions::new();
    find.renames(true).rename_threshold(50).rename_limit(50);
    diff.find_similar(Some(&mut find))?;

    let mut result = Vec::new();
    let mut remaining = limits.patch_bytes;

    for i in 0..diff.deltas().len() {
        let mut patch = git2::Patch::from_diff(&diff, i)?
            .ok_or_else(|| GitError::Failed("missing patch".into()))?;
        let delta = patch.delta();
        let deleted = delta.status() == git2::Delta::Deleted;
        let renamed = delta.status() == git2::Delta::Renamed;

        let path = git::utf8_path(
            if deleted {
                delta.old_file().path_bytes()
            } else {
                delta.new_file().path_bytes()
            }
            .ok_or_else(|| GitError::Malformed("missing diff path".into()))?,
        )?;
        let old_path = if renamed {
            Some(git::utf8_path(
                delta.old_file().path_bytes().unwrap_or_default(),
            )?)
        } else {
            None
        };

        let invalid_text = [old.get(old_path.as_ref().unwrap_or(&path)), new.get(&path)]
            .into_iter()
            .flatten()
            .any(|side| {
                matches!(side, Side::Content { bytes, .. } if std::str::from_utf8(bytes).is_err())
            });

        let mut entry = FileEntry {
            path,
            old_path,
            status: match delta.status() {
                git2::Delta::Added => FileStatus::Added,
                git2::Delta::Deleted => FileStatus::Deleted,
                git2::Delta::Renamed => FileStatus::Renamed,
                _ => FileStatus::Modified,
            },
            marker: None,
        };

        if delta.old_file().is_binary() || delta.new_file().is_binary() || invalid_text {
            entry.marker = Some(FileMarker {
                reason: MarkerReason::Binary,
            });
            markers.push((entry, String::new()));
            continue;
        }

        let buffer = patch.to_buf()?;
        let file_limit = limits.file_patch_bytes.unwrap_or(remaining);
        if buffer.len() > remaining.min(file_limit) {
            entry.marker = Some(FileMarker {
                reason: if limits
                    .file_patch_bytes
                    .is_some_and(|limit| limit <= remaining)
                {
                    MarkerReason::TooLarge
                } else {
                    MarkerReason::PatchLimit
                },
            });
            markers.push((entry, String::new()));
        } else {
            let text = String::from_utf8(buffer.to_vec())
                .map_err(|_| GitError::Malformed("non-UTF-8 patch".into()))?;
            remaining -= text.len();
            result.push((entry, text));
        }
    }

    markers.sort_by(|(a, _), (b, _)| a.path.cmp(&b.path));
    result.extend(markers);

    Ok(result)
}
