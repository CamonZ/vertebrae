//! On-demand, read-only worktree diffs. All Git access uses the recorder's runner.
use std::path::Path;

use super::worktree_delta::git::{run_git_bounded, GitError, MarkerReason};
use super::worktree_delta::FileStatus;

const FILE_LIMIT: usize = 512 * 1024;
const TOTAL_LIMIT: usize = 4 * 1024 * 1024;
const LIST_LIMIT: usize = 1024 * 1024;

#[derive(serde::Serialize, specta::Type)]
pub struct WorktreeChanges {
    pub base_branch: Option<String>,
    pub base_unavailable: Option<String>,
    pub files: Vec<WorktreeChange>,
}

#[derive(serde::Serialize, specta::Type)]
pub struct WorktreeChange {
    pub path: String,
    pub old_path: Option<String>,
    pub(crate) status: FileStatus,
    pub patch: String,
    pub(crate) marker: Option<MarkerReason>,
}

fn git(root: &Path, args: &[&str], limit: usize) -> Result<Vec<u8>, GitError> {
    run_git_bounded(root, args, None, limit, &[0])
}

fn text(bytes: Vec<u8>) -> Result<String, GitError> {
    String::from_utf8(bytes).map_err(|_| GitError::Malformed("non-UTF-8 Git output".into()))
}

fn branch_base(root: &Path) -> Result<Option<(String, String)>, GitError> {
    let remote = match git(
        root,
        &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
        LIST_LIMIT,
    ) {
        Ok(bytes) => Some(text(bytes)?.trim().to_owned()),
        Err(GitError::Failed(_)) => None,
        Err(error) => return Err(error),
    };
    for candidate in remote
        .into_iter()
        .chain(["refs/heads/master".into(), "refs/heads/main".into()])
    {
        match git(root, &["merge-base", "HEAD", &candidate], LIST_LIMIT) {
            Ok(bytes) => return Ok(Some((candidate, text(bytes)?.trim().to_owned()))),
            Err(GitError::Failed(_)) => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn parse_files(bytes: Vec<u8>) -> Result<Vec<WorktreeChange>, GitError> {
    let output = text(bytes)?;
    let mut records = output.split('\0').filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(status) = records.next() {
        let first = records
            .next()
            .ok_or_else(|| GitError::Malformed("missing diff path".into()))?;
        let (path, old_path) = if status.starts_with('R') {
            (
                records
                    .next()
                    .ok_or_else(|| GitError::Malformed("missing rename path".into()))?,
                Some(first.to_owned()),
            )
        } else {
            (first, None)
        };
        files.push(WorktreeChange {
            path: path.into(),
            old_path,
            status: match status.as_bytes().first() {
                Some(b'A') => FileStatus::Added,
                Some(b'D') => FileStatus::Deleted,
                Some(b'R') => FileStatus::Renamed,
                _ => FileStatus::Modified,
            },
            patch: String::new(),
            marker: None,
        });
    }
    Ok(files)
}

pub fn load(root: &Path, whole_branch: bool) -> Result<WorktreeChanges, GitError> {
    git(root, &["rev-parse", "--show-toplevel"], LIST_LIMIT)?;
    // HEAD must exist: an unborn repository produces a visible baseline error.
    git(root, &["rev-parse", "--verify", "HEAD"], LIST_LIMIT)?;
    let base = branch_base(root)?;
    let base_unavailable = base.is_none().then(|| "No merge-base with origin/HEAD, master or main; only uncommitted changes are available.".into());
    let baseline = if whole_branch {
        &base
            .as_ref()
            .ok_or_else(|| {
                GitError::Failed("Whole-branch baseline is unavailable; select Uncommitted.".into())
            })?
            .1
    } else {
        "HEAD"
    };
    let mut files = parse_files(git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--no-textconv",
            "--find-renames",
            "--name-status",
            "-z",
            baseline,
            "--",
        ],
        LIST_LIMIT,
    )?)?;
    let untracked = text(git(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        LIST_LIMIT,
    )?)?;
    for path in untracked.split('\0').filter(|s| !s.is_empty()) {
        if !files.iter().any(|file| file.path == path) {
            files.push(WorktreeChange {
                path: path.into(),
                old_path: None,
                status: FileStatus::Added,
                patch: String::new(),
                marker: None,
            });
        }
    }
    if files.len() > 2_000 {
        return Err(GitError::TooManyEntries(files.len()));
    }
    let mut remaining = TOTAL_LIMIT;
    for file in &mut files {
        if remaining == 0 {
            file.marker = Some(MarkerReason::PatchLimit);
            continue;
        }
        let is_untracked = untracked.split('\0').any(|path| path == file.path);
        let mut args = vec![
            "-c",
            "core.quotePath=false",
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--no-textconv",
            "--find-renames",
        ];
        if is_untracked {
            args.extend(["--no-index", "--", "/dev/null", &file.path]);
        } else {
            args.extend([baseline, "--", &file.path]);
            if let Some(old) = &file.old_path {
                args.push(old);
            }
        }
        let limit = FILE_LIMIT.min(remaining);
        match run_git_bounded(
            root,
            &args,
            None,
            limit,
            if is_untracked { &[0, 1] } else { &[0] },
        ) {
            Ok(bytes) => {
                remaining -= bytes.len();
                let patch = text(bytes)?;
                if patch
                    .lines()
                    .any(|line| line.starts_with("Binary files ") && line.ends_with(" differ"))
                {
                    file.marker = Some(MarkerReason::Binary);
                } else {
                    file.patch = patch;
                }
            }
            Err(GitError::OutputLimit) => {
                file.marker = Some(if limit < FILE_LIMIT {
                    MarkerReason::PatchLimit
                } else {
                    MarkerReason::TooLarge
                });
                remaining = remaining.saturating_sub(limit);
            }
            Err(GitError::Failed(_)) => file.marker = Some(MarkerReason::Unreadable),
            Err(error) => return Err(error),
        }
    }
    Ok(WorktreeChanges {
        base_branch: base.map(|(name, _)| name),
        base_unavailable,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

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

    fn repo(branch: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        command(dir.path(), &["init", "-b", branch]);
        command(dir.path(), &["config", "user.email", "test@example.com"]);
        command(dir.path(), &["config", "user.name", "Test"]);
        fs::write(dir.path().join("original.txt"), "before\n").unwrap();
        command(dir.path(), &["add", "."]);
        command(dir.path(), &["commit", "-m", "baseline"]);
        dir
    }

    #[test]
    fn includes_staged_unstaged_untracked_binary_and_renames_without_mutation() {
        let dir = repo("main");
        let root = dir.path();
        command(root, &["mv", "original.txt", "renamed.txt"]);
        fs::write(root.join("new file.txt"), "new\n").unwrap();
        fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        let before = git(root, &["status", "--porcelain=v2", "-z"], LIST_LIMIT).unwrap();
        let result = load(root, false).unwrap();
        assert_eq!(result.base_branch.as_deref(), Some("refs/heads/main"));
        let renamed = result
            .files
            .iter()
            .find(|f| f.path == "renamed.txt")
            .unwrap();
        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("original.txt"));
        assert!(renamed.patch.contains("rename from original.txt"));
        let added = result
            .files
            .iter()
            .find(|f| f.path == "new file.txt")
            .unwrap();
        assert!(added.patch.starts_with("diff --git "));
        assert!(added.patch.contains("+new\n"));
        assert_eq!(
            result
                .files
                .iter()
                .find(|f| f.path == "binary")
                .unwrap()
                .marker,
            Some(MarkerReason::Binary)
        );
        assert_eq!(
            before,
            git(root, &["status", "--porcelain=v2", "-z"], LIST_LIMIT).unwrap()
        );
        fs::write(root.join("renamed.txt"), "after\n").unwrap();
        let result = load(root, false).unwrap();
        assert!(result.files.iter().any(|f| f.patch.contains("+after\n")));
    }

    #[test]
    fn whole_branch_uses_merge_base_and_prefers_origin_head() {
        let dir = repo("main");
        let root = dir.path();
        command(root, &["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
        command(
            root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/trunk",
            ],
        );
        command(root, &["checkout", "-b", "feature"]);
        fs::write(root.join("original.txt"), "branch\n").unwrap();
        command(root, &["commit", "-am", "branch change"]);
        assert!(load(root, false).unwrap().files.is_empty());
        let result = load(root, true).unwrap();
        assert_eq!(
            result.base_branch.as_deref(),
            Some("refs/remotes/origin/trunk")
        );
        assert!(result.files[0].patch.contains("+branch\n"));
    }

    #[test]
    fn unavailable_base_bad_worktree_and_size_limits_are_explicit() {
        let dir = repo("feature");
        let root = dir.path();
        let result = load(root, false).unwrap();
        assert!(result.base_branch.is_none());
        assert!(result.base_unavailable.is_some());
        assert!(load(root, true).is_err());
        assert!(load(&root.join("missing"), false).is_err());
        let outside = tempfile::tempdir().unwrap();
        assert!(load(outside.path(), false).is_err());
        fs::write(root.join("huge"), "x\n".repeat(FILE_LIMIT)).unwrap();
        assert_eq!(
            load(root, false).unwrap().files[0].marker,
            Some(MarkerReason::TooLarge)
        );
    }
    #[test]
    fn deletions_literal_paths_and_total_budget_are_preserved() {
        let dir = repo("master");
        let root = dir.path();
        fs::remove_file(root.join("original.txt")).unwrap();
        fs::write(root.join(":(exclude)magic"), "literal\n").unwrap();
        for index in 0..12 {
            fs::write(root.join(format!("file-{index:02}")), "x\n".repeat(140_000)).unwrap();
        }
        let result = load(root, false).unwrap();
        assert!(result.files.iter().any(|f| f.path == "original.txt"
            && f.status == FileStatus::Deleted
            && f.patch.contains("-before")));
        assert!(result
            .files
            .iter()
            .any(|f| f.path == ":(exclude)magic" && f.patch.contains("+literal")));
        assert!(result
            .files
            .iter()
            .any(|f| f.marker == Some(MarkerReason::PatchLimit)));
        assert!(result.files.iter().map(|f| f.patch.len()).sum::<usize>() <= TOTAL_LIMIT);
    }
}
