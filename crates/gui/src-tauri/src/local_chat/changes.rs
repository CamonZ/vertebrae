//! On-demand worktree diffs using the recorder's shared observation engine.

use super::worktree_delta::{
    git::{self, GitError, Limits, MarkerReason, Side},
    patch, FileStatus,
};

use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

const FILE_LIMIT: usize = 512 * 1024;
const TOTAL_LIMIT: usize = 4 * 1024 * 1024;

#[cfg(test)]
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

fn branch_base(repo: &git2::Repository) -> Result<Option<(String, String)>, GitError> {
    let head = repo.head()?.peel_to_commit()?.id();
    let remote = match repo.find_reference("refs/remotes/origin/HEAD") {
        Ok(reference) => reference.symbolic_target()?.map(str::to_owned),
        Err(error) if error.code() == git2::ErrorCode::NotFound => None,
        Err(error) => return Err(error.into()),
    };

    for candidate in remote
        .into_iter()
        .chain(["refs/heads/master".into(), "refs/heads/main".into()])
    {
        match repo
            .revparse_single(&candidate)
            .and_then(|object| object.peel_to_commit())
            .and_then(|commit| repo.merge_base(head, commit.id()))
        {
            Ok(base) => return Ok(Some((candidate, base.to_string()))),
            Err(error)
                if matches!(
                    error.code(),
                    git2::ErrorCode::NotFound | git2::ErrorCode::UnbornBranch
                ) =>
            {
                continue
            }
            Err(error) => return Err(error.into()),
        }
    }

    Ok(None)
}

pub(crate) fn baseline(
    root: &Path,
    whole_branch: bool,
) -> Result<(Option<(String, String)>, String), GitError> {
    let repo = git::repository(root)?;
    let head = repo.head()?.peel_to_commit()?.id().to_string();
    let base = branch_base(&repo)?;

    let selected = if whole_branch {
        base.as_ref()
            .ok_or_else(|| {
                GitError::Failed("Whole-branch baseline is unavailable; select Uncommitted.".into())
            })?
            .1
            .clone()
    } else {
        head
    };

    Ok((base, selected))
}

pub fn load(root: &Path, whole_branch: bool) -> Result<WorktreeChanges, GitError> {
    let (base, baseline) = baseline(root, whole_branch)?;
    let repo = git::repository(root)?;
    let head = repo.head()?.peel_to_commit()?.id().to_string();

    let limits = Limits {
        side_bytes: FILE_LIMIT as u64,
        cache_paths: 2_000,
        status_entries: 2_000,
        patch_bytes: TOTAL_LIMIT,
        file_patch_bytes: Some(FILE_LIMIT),
        ..Limits::default()
    };

    let dirty = git::status(root, &limits)?;
    let mut paths: BTreeSet<_> = dirty.iter().cloned().collect();

    if baseline != head {
        paths.extend(git::changed_between(root, Some(&baseline), &head)?);
    }

    if paths.len() > limits.status_entries {
        return Err(GitError::TooManyEntries(paths.len()));
    }

    let requested: Vec<_> = paths
        .iter()
        .map(|path| (path.clone(), git::DEFAULT_MODE))
        .collect();
    let before = git::commit_sides(root, &baseline, &requested, &limits)?;
    let mut budget = git::CacheBudget::new(&limits);
    let after: BTreeMap<String, Side> = paths
        .iter()
        .map(|path| {
            (
                path.clone(),
                git::read_side(root, path, &limits, &mut budget),
            )
        })
        .collect();

    let rendered = patch::compare(&before, &after, &limits)?;
    let files = rendered
        .into_iter()
        .map(|(entry, patch)| WorktreeChange {
            path: entry.path,
            old_path: entry.old_path,
            status: entry.status,
            patch,
            marker: entry.marker.map(|marker| marker.reason),
        })
        .collect();

    Ok(WorktreeChanges {
        base_unavailable: base.is_none().then(|| {
            "No merge-base with origin/HEAD, master or main; only uncommitted changes are available.".into()
        }),
        base_branch: base.map(|(name, _)| name),
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    fn git(root: &Path, args: &[&str], _limit: usize) -> Result<Vec<u8>, GitError> {
        let output = Command::new("git")
            .arg("--no-optional-locks")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();

        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(GitError::Failed("test oracle failed".into()))
        }
    }

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
    fn per_file_patch_budget_counts_both_sides_of_a_replacement() {
        let dir = repo("main");
        let root = dir.path();

        fs::write(root.join("original.txt"), "a".repeat(400_000)).unwrap();
        command(root, &["commit", "-am", "large baseline"]);
        fs::write(root.join("original.txt"), "b".repeat(400_000)).unwrap();
        let result = load(root, false).unwrap();

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].marker, Some(MarkerReason::TooLarge));
        assert!(result.files[0].patch.is_empty());
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
