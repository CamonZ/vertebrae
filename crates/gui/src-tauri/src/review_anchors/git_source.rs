//! Reading a file's content from a commit or the working tree of a
//! checkout, within the same size limits the Changes diff uses.

use git2::{ErrorCode, Oid, Repository};
use std::path::Path;

use super::AnchorError;
use crate::local_chat::{
    worktree_delta::git::{self, CacheBudget, Limits, Side},
    worktree_files,
};

/// One side of a comparison.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Source {
    Commit(Oid),
    WorkingTree,
}

pub(crate) fn open_head(repo: &Repository) -> Result<Oid, AnchorError> {
    Ok(repo
        .head()
        .map_err(|error| match error.code() {
            ErrorCode::UnbornBranch | ErrorCode::NotFound => AnchorError::UnbornHead,
            _ => error.into(),
        })?
        .peel_to_commit()?
        .id())
}

/// `relative` (a normalized repository path) at `commit`; `None` when the
/// commit has no such file.
pub(crate) fn commit_file(
    repo: &Repository,
    commit: Oid,
    relative: &str,
) -> Result<Option<Vec<u8>>, AnchorError> {
    let commit = repo.find_commit(commit).map_err(|error| {
        if error.code() == ErrorCode::NotFound {
            AnchorError::MissingCommit
        } else {
            error.into()
        }
    })?;
    match commit.tree()?.get_path(Path::new(relative)) {
        Ok(entry) => {
            let (size, kind) = repo.odb()?.read_header(entry.id())?;
            if kind != git2::ObjectType::Blob || size as u64 > Limits::default().side_bytes {
                return Err(AnchorError::Unreadable);
            }
            Ok(Some(repo.find_blob(entry.id())?.content().to_vec()))
        }
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// `relative` (a normalized repository path) in the working tree; `None`
/// when absent.
pub(crate) fn working_file(
    repo: &Repository,
    relative: &str,
) -> Result<Option<Vec<u8>>, AnchorError> {
    // The app only opens user-selected checkouts. Within that trust
    // boundary, reject directory symlinks before the recorder reads the Git
    // path. The final component may itself be a Git symlink.
    let root = repo
        .workdir()
        .ok_or(AnchorError::NotRepository)?
        .canonicalize()
        .map_err(|_| AnchorError::InvalidPath)?;
    let parent = root.join(
        Path::new(relative)
            .parent()
            .ok_or(AnchorError::InvalidPath)?,
    );
    match parent.canonicalize() {
        Ok(resolved) if resolved == parent => {}
        Ok(_) => return Err(AnchorError::InvalidPath),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None)
        }
        Err(_) => return Err(AnchorError::Unreadable),
    }
    let limits = Limits::default();
    match git::read_side(&root, relative, &limits, &mut CacheBudget::new(&limits)) {
        Side::Content { bytes, .. } => Ok(Some(bytes.to_vec())),
        Side::Absent => Ok(None),
        _ => Err(AnchorError::Unreadable),
    }
}

/// The UTF-8 text (without NUL bytes) of `path` at `source`; `None` when
/// absent.
pub(crate) fn read_text(
    repo: &Repository,
    source: Source,
    path: &str,
) -> Result<Option<Vec<u8>>, AnchorError> {
    let relative = worktree_files::relative(path).map_err(|_| AnchorError::InvalidPath)?;
    let bytes = match source {
        Source::Commit(commit) => commit_file(repo, commit, &relative)?,
        Source::WorkingTree => working_file(repo, &relative)?,
    };
    match bytes {
        Some(bytes) if std::str::from_utf8(&bytes).is_err() || bytes.contains(&0) => {
            Err(AnchorError::Unreadable)
        }
        bytes => Ok(bytes),
    }
}

#[cfg(test)]
mod tests;
