//! Worktree-scoped file browsing and editing for the chat Changes workspace.
//!
//! The worktree must be the top level of a Git worktree. Every path is
//! relative to it and is resolved through the filesystem before use:
//! absolute paths, `..`, `.git` and symlinks whose target leaves the worktree
//! are refused. The worktree is a trusted local directory, not a sandbox
//! against concurrent hostile filesystem changes.
//!
//! A document is the file as it was when read; nothing tracks later edits.
//! Saves are revision-checked so a file changed after it was read is not
//! overwritten without the user choosing to, and a missing file is never
//! recreated. The check and the replacing rename are not one atomic step, so
//! a write landing between them can still be replaced.

use std::fmt;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::changes::baseline;
use super::worktree_delta::git::{self, GitError};

/// Largest file opened as an editable text document or saved.
pub(crate) const EDIT_LIMIT: u64 = 2 * 1024 * 1024;
/// Entries read for one directory; the rest are reported as truncated.
const DIRECTORY_LIMIT: usize = 5_000;
/// Leading bytes searched for NUL when classifying text.
const BINARY_SNIFF: usize = 8_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FilesError {
    /// The path is malformed or names the wrong kind of entry.
    Invalid(String),
    /// The path resolves outside the worktree.
    Outside(String),
    Io(String),
    Git(GitError),
}

impl fmt::Display for FilesError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => formatter.write_str(reason),
            Self::Outside(path) => write!(formatter, "{path} is outside the worktree"),
            Self::Io(error) => write!(formatter, "file access failed: {error}"),
            Self::Git(error) => error.fmt(formatter),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Directory,
    /// Special files, and symlinks that dangle or leave the worktree.
    Other,
}

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct DirectoryEntry {
    pub name: String,
    /// Worktree-relative path with `/` separators.
    pub path: String,
    /// What the entry is, following a symlink that stays in the worktree.
    pub kind: EntryKind,
    pub symlink: bool,
}

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
    pub truncated: bool,
}

/// One side of a document. `revision` is the SHA-256 of the bytes read.
#[derive(Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileBody {
    Text { contents: String, revision: String },
    Binary,
    TooLarge,
    Missing,
    Unreadable { message: String },
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SaveOutcome {
    Saved {
        revision: String,
    },
    /// The file no longer matches the expected revision; nothing was written.
    /// `current` is absent when the file is missing or not a text document.
    Conflict {
        current: Option<String>,
    },
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn revision(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn io(error: std::io::Error) -> FilesError {
    FilesError::Io(error.to_string())
}

fn is_git_dir(component: &std::ffi::OsStr) -> bool {
    component.eq_ignore_ascii_case(".git")
}

/// Canonicalize the worktree, which must be a Git worktree's top level so a
/// subdirectory or an unrelated directory is never treated as one.
fn worktree_root(worktree: &Path) -> Result<PathBuf, FilesError> {
    let root = fs::canonicalize(worktree).map_err(io)?;
    let not_worktree =
        || FilesError::Invalid(format!("{} is not a Git worktree", worktree.display()));
    if !root.is_dir() {
        return Err(not_worktree());
    }
    let repo = git::repository(&root).map_err(|_| not_worktree())?;
    let top = repo.workdir().ok_or_else(not_worktree)?;
    if fs::canonicalize(top).map_err(io)? == root {
        Ok(root)
    } else {
        Err(not_worktree())
    }
}

/// Validate a worktree-relative path, returning it with `/` separators.
fn relative(path: &str) -> Result<String, FilesError> {
    let mut parts = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) if !is_git_dir(part) => parts.push(
                part.to_str()
                    .ok_or_else(|| FilesError::Invalid("path is not UTF-8".into()))?,
            ),
            Component::CurDir => {}
            _ => {
                return Err(FilesError::Invalid(format!(
                    "invalid worktree path: {path}"
                )))
            }
        }
    }
    if parts.is_empty() {
        return Err(FilesError::Invalid("empty worktree path".into()));
    }
    Ok(parts.join("/"))
}

/// Resolve a validated path through symlinks; `None` when nothing exists there.
fn resolve(root: &Path, path: &str) -> Result<Option<PathBuf>, FilesError> {
    match fs::canonicalize(root.join(path)) {
        Ok(target) => {
            let inside = target
                .strip_prefix(root)
                .map(|rest| !rest.iter().any(is_git_dir))
                .unwrap_or(false);
            if inside {
                Ok(Some(target))
            } else {
                Err(FilesError::Outside(path.into()))
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io(error)),
    }
}

fn classify(bytes: Vec<u8>) -> FileBody {
    if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
        return FileBody::Binary;
    }
    let revision = revision(&bytes);
    match String::from_utf8(bytes) {
        Ok(contents) => FileBody::Text { contents, revision },
        Err(_) => FileBody::Binary,
    }
}

fn read_bounded(target: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    fs::File::open(target)?
        .take(EDIT_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= EDIT_LIMIT).then_some(bytes))
}

/// List one directory; `""` is the worktree root. `.git` is never listed.
pub(crate) fn list_directory(worktree: &Path, path: &str) -> Result<DirectoryListing, FilesError> {
    let root = worktree_root(worktree)?;
    let path = if path.is_empty() {
        String::new()
    } else {
        relative(path)?
    };
    let directory = if path.is_empty() {
        root.clone()
    } else {
        resolve(&root, &path)?
            .ok_or_else(|| FilesError::Invalid(format!("{path} does not exist")))?
    };
    if !directory.is_dir() {
        return Err(FilesError::Invalid(format!("{path} is not a directory")));
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&directory).map_err(io)? {
        let entry = entry.map_err(io)?;
        let file_name = entry.file_name();
        // Names that cannot round-trip through the UI are left out.
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if is_git_dir(&file_name) {
            continue;
        }
        // Stop reading rather than hold an unbounded directory in memory.
        if entries.len() == DIRECTORY_LIMIT {
            truncated = true;
            break;
        }
        let entry_path = if path.is_empty() {
            name.to_owned()
        } else {
            format!("{path}/{name}")
        };
        let file_type = entry.file_type().map_err(io)?;
        let symlink = file_type.is_symlink();
        let kind = if symlink {
            match resolve(&root, &entry_path) {
                Ok(Some(target)) if target.is_dir() => EntryKind::Directory,
                Ok(Some(target)) if target.is_file() => EntryKind::File,
                _ => EntryKind::Other,
            }
        } else if file_type.is_dir() {
            EntryKind::Directory
        } else if file_type.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        };
        entries.push(DirectoryEntry {
            name: name.into(),
            path: entry_path,
            kind,
            symlink,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != EntryKind::Directory)
            .cmp(&(b.kind != EntryKind::Directory))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(DirectoryListing {
        path,
        entries,
        truncated,
    })
}

/// Read the working copy of one file.
pub(crate) fn read_file(worktree: &Path, path: &str) -> Result<FileBody, FilesError> {
    let root = worktree_root(worktree)?;
    let path = relative(path)?;
    let Some(target) = resolve(&root, &path)? else {
        return Ok(FileBody::Missing);
    };
    if !target.is_file() {
        return Err(FilesError::Invalid(format!("{path} is not a regular file")));
    }
    Ok(match read_bounded(&target) {
        Ok(Some(bytes)) => classify(bytes),
        Ok(None) => FileBody::TooLarge,
        Err(error) => FileBody::Unreadable {
            message: error.to_string(),
        },
    })
}

/// Read one file at the selected baseline: `HEAD`, or the branch merge-base.
pub(crate) fn read_baseline(
    worktree: &Path,
    path: &str,
    whole_branch: bool,
) -> Result<FileBody, FilesError> {
    let root = worktree_root(worktree)?;
    let path = relative(path)?;
    let (_, commit) = baseline(&root, whole_branch).map_err(FilesError::Git)?;

    let repo = git::repository(&root).map_err(FilesError::Git)?;
    let tree = repo
        .revparse_single(&commit)
        .and_then(|object| object.peel_to_tree())
        .map_err(|error| FilesError::Git(error.into()))?;
    let entry = match tree.get_path(Path::new(&path)) {
        Ok(entry) => entry,
        Err(error) if error.code() == git2::ErrorCode::NotFound => return Ok(FileBody::Missing),
        Err(error) => return Err(FilesError::Git(error.into())),
    };

    if entry.kind() != Some(git2::ObjectType::Blob) {
        return Ok(FileBody::Unreadable {
            message: format!("{path} is not a file at the baseline"),
        });
    }

    let odb = repo.odb().map_err(|error| FilesError::Git(error.into()))?;
    let (size, _) = odb
        .read_header(entry.id())
        .map_err(|error| FilesError::Git(error.into()))?;

    if size as u64 > EDIT_LIMIT {
        return Ok(FileBody::TooLarge);
    }

    let blob = repo
        .find_blob(entry.id())
        .map_err(|error| FilesError::Git(error.into()))?;

    Ok(classify(blob.content().to_vec()))
}

/// Replace a text file only if it still holds `expected_revision`.
pub(crate) fn save_file(
    worktree: &Path,
    path: &str,
    contents: &str,
    expected_revision: &str,
) -> Result<SaveOutcome, FilesError> {
    let root = worktree_root(worktree)?;
    let path = relative(path)?;
    if contents.len() as u64 > EDIT_LIMIT {
        return Err(FilesError::Invalid(format!(
            "{path} exceeds the {} MiB edit limit",
            EDIT_LIMIT / 1024 / 1024
        )));
    }
    let Some(target) = resolve(&root, &path)? else {
        return Ok(SaveOutcome::Conflict { current: None });
    };
    if !target.is_file() {
        return Err(FilesError::Invalid(format!("{path} is not a regular file")));
    }
    let current = match read_bounded(&target).map_err(io)? {
        Some(bytes) => match classify(bytes) {
            FileBody::Text { revision, .. } => Some(revision),
            _ => None,
        },
        None => None,
    };
    if current.as_deref() != Some(expected_revision) {
        return Ok(SaveOutcome::Conflict { current });
    }
    write_atomic(&target, contents.as_bytes())?;
    Ok(SaveOutcome::Saved {
        revision: revision(contents.as_bytes()),
    })
}

/// Write beside the target and rename over it, keeping its permissions.
fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), FilesError> {
    let directory = target
        .parent()
        .ok_or_else(|| FilesError::Invalid("file has no parent directory".into()))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| FilesError::Invalid("file name is not UTF-8".into()))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let temporary = directory.join(format!(".{name}.vtb-save-{}-{nonce}", std::process::id()));
    let permissions = fs::metadata(target).map_err(io)?.permissions();
    let result = (|| {
        let mut file = fs::File::create_new(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::set_permissions(&temporary, permissions)?;
        fs::rename(&temporary, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn command(root: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        command(root, &["init", "-b", "main"]);
        command(root, &["config", "user.email", "test@example.com"]);
        command(root, &["config", "user.name", "Test"]);
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/lib.rs"), "before\n").unwrap();
        fs::write(root.join("src/nested/deep.rs"), "deep\n").unwrap();
        fs::write(root.join("README.md"), "readme\n").unwrap();
        command(root, &["add", "."]);
        command(root, &["commit", "-m", "baseline"]);
        dir
    }

    fn text(body: FileBody) -> (String, String) {
        match body {
            FileBody::Text { contents, revision } => (contents, revision),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn lists_directories_lazily_without_git_metadata() {
        let dir = repo();
        let root = dir.path();
        let listing = list_directory(root, "").unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["src", "README.md"]);
        assert_eq!(listing.entries[0].kind, EntryKind::Directory);
        assert!(!listing.truncated);
        let nested = list_directory(root, "src").unwrap();
        assert_eq!(nested.entries[0].path, "src/nested");
        assert_eq!(nested.entries[1].path, "src/lib.rs");
        assert_eq!(
            list_directory(root, "src/nested/").unwrap().entries[0].path,
            "src/nested/deep.rs"
        );
        assert!(list_directory(root, ".git").is_err());
        assert!(list_directory(root, "README.md").is_err());
        assert!(list_directory(&root.join("missing"), "").is_err());
    }

    #[test]
    fn rejects_traversal_absolute_git_and_escaping_symlinks() {
        let dir = repo();
        let root = dir.path();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "secret\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), root.join("escape")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape-dir")).unwrap();
        std::os::unix::fs::symlink("src/lib.rs", root.join("inside")).unwrap();
        for path in [
            "../x",
            "src/../../x",
            "/etc/passwd",
            ".git/config",
            ".GIT/HEAD",
            "",
        ] {
            assert!(
                matches!(read_file(root, path), Err(FilesError::Invalid(_))),
                "{path}"
            );
        }
        assert!(matches!(
            read_file(root, "escape"),
            Err(FilesError::Outside(_))
        ));
        assert!(matches!(
            list_directory(root, "escape-dir"),
            Err(FilesError::Outside(_))
        ));
        assert!(matches!(
            save_file(root, "escape", "x", &revision(b"secret\n")),
            Err(FilesError::Outside(_))
        ));
        let listing = list_directory(root, "").unwrap();
        let entry = |name: &str| {
            let entry = listing.entries.iter().find(|e| e.name == name).unwrap();
            (entry.kind, entry.symlink)
        };
        assert_eq!(entry("escape"), (EntryKind::Other, true));
        assert_eq!(entry("escape-dir"), (EntryKind::Other, true));
        assert_eq!(entry("inside"), (EntryKind::File, true));
        assert_eq!(text(read_file(root, "inside").unwrap()).0, "before\n");
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "secret\n"
        );
    }

    #[test]
    fn reads_text_binary_missing_and_oversized_files() {
        let dir = repo();
        let root = dir.path();
        let (contents, first) = text(read_file(root, "src/lib.rs").unwrap());
        assert_eq!(contents, "before\n");
        assert_eq!(first, text(read_file(root, "./src/lib.rs").unwrap()).1);
        fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        fs::write(root.join("latin1"), [0xe9]).unwrap();
        fs::write(root.join("huge"), vec![b'x'; EDIT_LIMIT as usize + 1]).unwrap();
        assert_eq!(read_file(root, "binary").unwrap(), FileBody::Binary);
        assert_eq!(read_file(root, "latin1").unwrap(), FileBody::Binary);
        assert_eq!(read_file(root, "huge").unwrap(), FileBody::TooLarge);
        assert_eq!(read_file(root, "absent").unwrap(), FileBody::Missing);
        assert!(read_file(root, "src").is_err());
    }

    #[test]
    fn reads_baselines_for_head_and_whole_branch() {
        let dir = repo();
        let root = dir.path();
        command(root, &["checkout", "-b", "feature"]);
        fs::write(root.join("src/lib.rs"), "committed\n").unwrap();
        command(root, &["commit", "-am", "branch change"]);
        fs::write(root.join("src/lib.rs"), "working\n").unwrap();
        fs::write(root.join("untracked"), "new\n").unwrap();
        assert_eq!(
            text(read_baseline(root, "src/lib.rs", false).unwrap()).0,
            "committed\n"
        );
        assert_eq!(
            text(read_baseline(root, "src/lib.rs", true).unwrap()).0,
            "before\n"
        );
        assert_eq!(
            read_baseline(root, "untracked", false).unwrap(),
            FileBody::Missing
        );
        assert!(matches!(
            read_baseline(root, "src", false).unwrap(),
            FileBody::Unreadable { .. }
        ));
        fs::remove_file(root.join("src/lib.rs")).unwrap();
        assert_eq!(
            text(read_baseline(root, "src/lib.rs", false).unwrap()).0,
            "committed\n"
        );
    }

    #[test]
    fn saves_only_matching_revisions_and_never_recreates_files() {
        let dir = repo();
        let root = dir.path();
        let (_, revision_read) = text(read_file(root, "src/lib.rs").unwrap());
        let saved = save_file(root, "src/lib.rs", "after\n", &revision_read).unwrap();
        let (contents, revision_now) = text(read_file(root, "src/lib.rs").unwrap());
        assert_eq!(contents, "after\n");
        assert_eq!(
            saved,
            SaveOutcome::Saved {
                revision: revision_now.clone()
            }
        );
        // An external edit after the read wins until the user reconciles.
        fs::write(root.join("src/lib.rs"), "agent\n").unwrap();
        assert_eq!(
            save_file(root, "src/lib.rs", "mine\n", &revision_now).unwrap(),
            SaveOutcome::Conflict {
                current: Some(revision(b"agent\n"))
            }
        );
        assert_eq!(
            fs::read_to_string(root.join("src/lib.rs")).unwrap(),
            "agent\n"
        );
        fs::remove_file(root.join("README.md")).unwrap();
        assert_eq!(
            save_file(root, "README.md", "back\n", &revision(b"readme\n")).unwrap(),
            SaveOutcome::Conflict { current: None }
        );
        assert!(!root.join("README.md").exists());
        assert!(save_file(
            root,
            "src/lib.rs",
            &"x".repeat(EDIT_LIMIT as usize + 1),
            &revision(b"agent\n")
        )
        .is_err());
        let leftovers = fs::read_dir(root.join("src"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("vtb-save")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn saves_through_symlinks_and_keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = repo();
        let root = dir.path();
        let script = root.join("run.sh");
        fs::write(&script, "echo\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("run.sh", root.join("link")).unwrap();
        let outcome = save_file(root, "link", "echo hi\n", &revision(b"echo\n")).unwrap();
        assert!(matches!(outcome, SaveOutcome::Saved { .. }));
        assert!(fs::symlink_metadata(root.join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&script).unwrap(), "echo hi\n");
        assert_eq!(
            fs::metadata(&script).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn reads_long_new_paths_as_missing_at_either_baseline() {
        // Git's "path does not exist" message names the path and the commit,
        // so a long path or a merge-base SHA once overflowed a tiny bound.
        let dir = repo();
        let root = dir.path();
        command(root, &["checkout", "-b", "feature"]);
        let long = "crates/gui/src/components/ChatWindow/workspace/NewFile.tsx";
        fs::create_dir_all(root.join("crates/gui/src/components/ChatWindow/workspace")).unwrap();
        fs::write(root.join("branch-added.rs"), "added\n").unwrap();
        command(root, &["add", "branch-added.rs"]);
        command(root, &["commit", "-m", "add on branch"]);
        fs::write(root.join(long), "new\n").unwrap();
        for whole_branch in [false, true] {
            assert_eq!(
                read_baseline(root, long, whole_branch).unwrap(),
                FileBody::Missing,
                "whole_branch={whole_branch}"
            );
        }
        assert_eq!(
            read_baseline(root, "branch-added.rs", true).unwrap(),
            FileBody::Missing
        );
        assert_eq!(
            text(read_baseline(root, "branch-added.rs", false).unwrap()).0,
            "added\n"
        );
    }

    #[test]
    fn requires_the_worktree_top_level() {
        let dir = repo();
        let root = dir.path();
        assert!(matches!(
            read_file(&root.join("src"), "lib.rs"),
            Err(FilesError::Invalid(_))
        ));
        let plain = tempfile::tempdir().unwrap();
        fs::write(plain.path().join("file"), "x\n").unwrap();
        assert!(matches!(
            save_file(plain.path(), "file", "y\n", &revision(b"x\n")),
            Err(FilesError::Invalid(_))
        ));
        assert_eq!(
            fs::read_to_string(plain.path().join("file")).unwrap(),
            "x\n"
        );
    }

    #[test]
    fn browses_symlinked_folders_inside_the_worktree() {
        let dir = repo();
        let root = dir.path();
        std::os::unix::fs::symlink("src/nested", root.join("alias")).unwrap();
        let listing = list_directory(root, "").unwrap();
        let alias = listing.entries.iter().find(|e| e.name == "alias").unwrap();
        assert_eq!((alias.kind, alias.symlink), (EntryKind::Directory, true));
        assert_eq!(
            list_directory(root, "alias").unwrap().entries[0].path,
            "alias/deep.rs"
        );
    }

    #[test]
    fn stops_reading_large_directories_at_the_limit() {
        let dir = repo();
        let root = dir.path();
        let wide = root.join("wide");
        fs::create_dir(&wide).unwrap();
        for index in 0..=DIRECTORY_LIMIT {
            fs::write(wide.join(format!("f{index:05}")), "").unwrap();
        }
        let listing = list_directory(root, "wide").unwrap();
        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), DIRECTORY_LIMIT);
        let src = list_directory(root, "src").unwrap();
        assert!(!src.truncated);
    }
}
