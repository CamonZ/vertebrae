//! On-demand worktree comparisons using the shared libgit2 observation engine.

use super::worktree_delta::{
    git::{self, GitError, Limits, MarkerReason, Side},
    patch, FileStatus,
};
use std::{collections::BTreeMap, path::Path};

const FILE_LIMIT: usize = 512 * 1024;
const TOTAL_LIMIT: usize = 4 * 1024 * 1024;

#[cfg(test)]
const LIST_LIMIT: usize = 1024 * 1024;

/// Endpoints resolve to commits once per request. Only WorkingTree includes dirty files.
#[derive(Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ComparisonEndpoint {
    WorkingTree,
    Head,
    Ref(String),
    Worktree(String),
}

#[derive(serde::Deserialize, specta::Type)]
pub struct ComparisonRequest {
    pub base: Option<ComparisonEndpoint>,
    pub target: ComparisonEndpoint,
    pub merge_base: bool,
}

#[derive(serde::Serialize, specta::Type)]
pub struct ComparisonChoice {
    pub label: String,
    pub endpoint: ComparisonEndpoint,
}

#[derive(serde::Serialize, specta::Type)]
pub struct ComparisonSnapshot {
    pub base_commit: String,
    pub selected_base_commit: String,
    pub target_commit: String,
    pub working_tree: bool,
    pub merge_base: bool,
}

#[derive(Default, serde::Serialize, specta::Type)]
pub struct DiffTotals {
    pub additions: u32,
    pub deletions: u32,
    pub binary_files: u32,
}

pub fn choices(root: &Path) -> Result<Vec<ComparisonChoice>, GitError> {
    let repo = git::repository(root)?;
    let mut choices = Vec::new();

    for reference in repo.references()? {
        let reference = reference?;
        if reference.is_branch() || reference.is_remote() {
            let name = git::utf8_path(reference.name_bytes())?;
            choices.push(ComparisonChoice {
                label: name.clone(),
                endpoint: ComparisonEndpoint::Ref(name),
            });
        }
        if choices.len() > 2_000 {
            return Err(GitError::TooManyEntries(choices.len()));
        }
    }

    let primary = git2::Repository::open(repo.commondir())?;
    if let Some(path) = primary.workdir() {
        let path = path
            .to_str()
            .ok_or_else(|| GitError::Malformed("non-UTF-8 worktree path".into()))?;
        choices.push(ComparisonChoice {
            label: format!("Worktree · {path}"),
            endpoint: ComparisonEndpoint::Worktree(path.into()),
        });
    }

    for name in repo.worktrees()?.iter() {
        let name = name
            .map_err(|error| GitError::Failed(error.to_string()))?
            .ok_or_else(|| GitError::Malformed("non-UTF-8 worktree name".into()))?;
        let tree = repo.find_worktree(name)?;
        let path = tree
            .path()
            .to_str()
            .ok_or_else(|| GitError::Malformed("non-UTF-8 worktree path".into()))?;
        choices.push(ComparisonChoice {
            label: format!("Worktree · {path}"),
            endpoint: ComparisonEndpoint::Worktree(path.into()),
        });
        if choices.len() > 2_000 {
            return Err(GitError::TooManyEntries(choices.len()));
        }
    }

    Ok(choices)
}

pub(crate) fn resolve_commit(root: &Path, reference: &str) -> Result<String, GitError> {
    let repo = git::repository(root)?;
    let object = repo.revparse_single(reference)?;
    let commit = object.peel_to_commit()?;

    Ok(commit.id().to_string())
}

fn resolve_endpoint(root: &Path, endpoint: &ComparisonEndpoint) -> Result<String, GitError> {
    match endpoint {
        ComparisonEndpoint::Head | ComparisonEndpoint::WorkingTree => resolve_commit(root, "HEAD"),
        ComparisonEndpoint::Ref(name) => resolve_commit(root, name),
        ComparisonEndpoint::Worktree(path) => {
            // Refuse removed/pruned/foreign paths rather than using a different repository.
            let canonical = Path::new(path)
                .canonicalize()
                .map_err(|error| GitError::Failed(error.to_string()))?;
            let known = choices(root)?.into_iter().any(|choice| {
                matches!(
                    choice.endpoint,
                    ComparisonEndpoint::Worktree(candidate)
                        if Path::new(&candidate).canonicalize().ok().as_ref() == Some(&canonical)
                )
            });

            if !known || !Path::new(path).is_dir() {
                return Err(GitError::Failed("Linked worktree is unavailable".into()));
            }

            resolve_commit(Path::new(path), "HEAD")
        }
    }
}

#[derive(serde::Serialize, specta::Type)]
pub struct WorktreeChanges {
    pub base_branch: Option<String>,
    pub base_unavailable: Option<String>,
    pub files: Vec<WorktreeChange>,
    pub comparison: ComparisonSnapshot,
    pub totals: DiffTotals,
}

#[derive(serde::Serialize, specta::Type)]
pub struct WorktreeChange {
    pub path: String,
    pub old_path: Option<String>,
    pub(crate) status: FileStatus,
    pub patch: String,
    pub totals: DiffTotals,
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

#[cfg(test)]
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

#[cfg(test)]
pub(crate) fn load(root: &Path, whole_branch: bool) -> Result<WorktreeChanges, GitError> {
    load_comparison(
        root,
        ComparisonRequest {
            base: if whole_branch {
                None
            } else {
                Some(ComparisonEndpoint::Head)
            },
            target: ComparisonEndpoint::WorkingTree,
            merge_base: whole_branch,
        },
    )
}

pub fn load_comparison(
    root: &Path,
    request: ComparisonRequest,
) -> Result<WorktreeChanges, GitError> {
    let repo = git::repository(root)?;

    if matches!(request.base, Some(ComparisonEndpoint::WorkingTree)) {
        return Err(GitError::Failed(
            "Working tree is only supported as the target".into(),
        ));
    }

    let target_commit = resolve_endpoint(root, &request.target)?;
    let working_tree = matches!(request.target, ComparisonEndpoint::WorkingTree);
    let default_base = branch_base(&repo)?;

    let (base_branch, base_commit) = match request.base {
        Some(ref endpoint) => (
            None,
            if endpoint == &request.target
                || (matches!(endpoint, ComparisonEndpoint::Head) && working_tree)
            {
                target_commit.clone()
            } else {
                resolve_endpoint(root, endpoint)?
            },
        ),
        None => {
            let name = default_base
                .as_ref()
                .ok_or_else(|| {
                    GitError::Failed(
                        "Default base is unavailable; choose another base or HEAD for uncommitted changes."
                            .into(),
                    )
                })?
                .0
                .clone();
            let commit = resolve_commit(root, &name)?;
            (Some(name), commit)
        }
    };

    let selected_base_commit = base_commit.clone();
    let base_commit = if request.merge_base {
        repo.merge_base(
            git2::Oid::from_str(&base_commit)?,
            git2::Oid::from_str(&target_commit)?,
        )?
        .to_string()
    } else {
        base_commit
    };

    let comparison = ComparisonSnapshot {
        base_commit,
        selected_base_commit,
        target_commit,
        working_tree,
        merge_base: request.merge_base,
    };

    let limits = Limits {
        side_bytes: FILE_LIMIT as u64,
        cache_paths: 2_000,
        status_entries: 2_000,
        patch_bytes: TOTAL_LIMIT,
        file_patch_bytes: Some(FILE_LIMIT),
        ..Limits::default()
    };

    let mut paths = git::changed_between(
        root,
        Some(&comparison.base_commit),
        &comparison.target_commit,
    )?;
    if working_tree {
        paths.extend(git::status(root, &limits)?);
    }
    if paths.len() > limits.status_entries {
        return Err(GitError::TooManyEntries(paths.len()));
    }

    let requested: Vec<_> = paths
        .iter()
        .map(|path| (path.clone(), git::DEFAULT_MODE))
        .collect();
    let before = git::commit_sides(root, &comparison.base_commit, &requested, &limits)?;
    let after: BTreeMap<String, Side> = if working_tree {
        let mut budget = git::CacheBudget::new(&limits);
        paths
            .iter()
            .map(|path| {
                (
                    path.clone(),
                    git::read_side(root, path, &limits, &mut budget),
                )
            })
            .collect()
    } else {
        git::commit_sides(root, &comparison.target_commit, &requested, &limits)?
    };

    let rendered = patch::compare(&before, &after, &limits)?;

    let base_tree = repo
        .find_commit(git2::Oid::from_str(&comparison.base_commit)?)?
        .tree()?;
    let target_tree = repo
        .find_commit(git2::Oid::from_str(&comparison.target_commit)?)?
        .tree()?;
    let mut files = Vec::with_capacity(rendered.len());

    for (entry, patch) in rendered {
        let totals = file_totals(
            &repo,
            &base_tree,
            &target_tree,
            working_tree,
            &entry.path,
            entry.old_path.as_deref(),
        )?;
        files.push(WorktreeChange {
            path: entry.path,
            old_path: entry.old_path,
            status: entry.status,
            patch,
            marker: entry.marker.map(|marker| marker.reason),
            totals,
        });
    }

    Ok(WorktreeChanges {
        base_unavailable: default_base.is_none().then(|| {
            "Default branch is unavailable; explicit comparison endpoints are in use.".into()
        }),
        base_branch: base_branch.or_else(|| default_base.map(|(name, _)| name)),
        comparison,
        totals: files
            .iter()
            .try_fold(DiffTotals::default(), |mut sum, file| {
                let overflow = || GitError::Malformed("diff totals overflow".into());
                sum.additions = sum
                    .additions
                    .checked_add(file.totals.additions)
                    .ok_or_else(overflow)?;
                sum.deletions = sum
                    .deletions
                    .checked_add(file.totals.deletions)
                    .ok_or_else(overflow)?;
                sum.binary_files += file.totals.binary_files;
                Ok::<_, GitError>(sum)
            })?,
        files,
    })
}

/// Count independently of the renderer's content and patch budgets. Libgit2
/// owns line statistics and binary classification; no Git subprocess is used.
fn file_totals(
    repo: &git2::Repository,
    base: &git2::Tree<'_>,
    target: &git2::Tree<'_>,
    working_tree: bool,
    path: &str,
    old_path: Option<&str>,
) -> Result<DiffTotals, GitError> {
    let mut options = git2::DiffOptions::new();
    options
        .update_index(false)
        .ignore_submodules(true)
        .disable_pathspec_match(true)
        .pathspec(path)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    if let Some(old) = old_path {
        options.pathspec(old);
    }

    let mut diff = if working_tree {
        repo.diff_tree_to_workdir_with_index(Some(base), Some(&mut options))?
    } else {
        repo.diff_tree_to_tree(Some(base), Some(target), Some(&mut options))?
    };

    if old_path.is_some() {
        let mut find = git2::DiffFindOptions::new();
        find.renames(true)
            .for_untracked(true)
            .rename_threshold(50)
            .rename_limit(50);
        diff.find_similar(Some(&mut find))?;
    }

    let stats = diff.stats()?;
    let mut binary_files = 0;

    for delta in diff.deltas() {
        if delta.flags().contains(git2::DiffFlags::BINARY) {
            binary_files += 1;
        }
    }

    let count = |value| {
        u32::try_from(value).map_err(|_| GitError::Malformed("diff totals overflow".into()))
    };

    Ok(DiffTotals {
        additions: count(stats.insertions())?,
        deletions: count(stats.deletions())?,
        binary_files,
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

#[cfg(test)]
fn parse_numstat(bytes: &[u8]) -> Result<DiffTotals, GitError> {
    if !bytes.is_empty() && !bytes.ends_with(&[0]) {
        return Err(GitError::Malformed("unterminated numstat".into()));
    }
    let mut records = bytes.split(|byte| *byte == 0);
    let mut sum = DiffTotals::default();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let invalid = || GitError::Malformed("invalid numstat record".into());
        let added = fields.next().ok_or_else(invalid)?;
        let deleted = fields.next().ok_or_else(invalid)?;
        let path = fields.next().ok_or_else(invalid)?;
        if path.is_empty() {
            for _ in 0..2 {
                if records.next().filter(|p| !p.is_empty()).is_none() {
                    return Err(invalid());
                }
            }
        }
        if added == b"-" && deleted == b"-" {
            sum.binary_files += 1;
        } else {
            let number = |value: &[u8]| {
                std::str::from_utf8(value)
                    .ok()
                    .and_then(|value| value.parse::<u32>().ok())
                    .ok_or_else(invalid)
            };
            sum.additions = sum
                .additions
                .checked_add(number(added)?)
                .ok_or_else(invalid)?;
            sum.deletions = sum
                .deletions
                .checked_add(number(deleted)?)
                .ok_or_else(invalid)?;
        }
    }
    Ok(sum)
}

#[cfg(test)]
mod comparison_tests {
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

    fn git_ok(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        git_ok(root, &["init", "-b", "main"]);
        git_ok(root, &["config", "user.email", "test@example.com"]);
        git_ok(root, &["config", "user.name", "Test"]);
        fs::write(root.join("original"), "one\ntwo\n").unwrap();
        git_ok(root, &["add", "."]);
        git_ok(root, &["commit", "-m", "initial"]);

        dir
    }

    fn commit_file(root: &Path, path: &str) {
        fs::write(root.join(path), format!("{path}\n")).unwrap();
        git_ok(root, &["add", "."]);
        git_ok(root, &["commit", "-m", path]);
    }

    fn request(base: &str, target: ComparisonEndpoint, merge_base: bool) -> ComparisonRequest {
        ComparisonRequest {
            base: Some(ComparisonEndpoint::Ref(base.into())),
            target,
            merge_base,
        }
    }

    #[test]
    fn feature_chain_linked_worktrees_and_direct_vs_merge_base() {
        let dir = fixture();
        let root = dir.path();

        git_ok(root, &["checkout", "-b", "feature-A"]);
        commit_file(root, "a");
        git_ok(root, &["checkout", "-b", "feature-B"]);
        commit_file(root, "b");
        git_ok(root, &["checkout", "feature-A"]);
        commit_file(root, "a-later");
        let holder = tempfile::tempdir().unwrap();
        let linked = holder.path().join("linked tree");
        git_ok(
            root,
            &["worktree", "add", linked.to_str().unwrap(), "feature-B"],
        );
        fs::write(linked.join("dirty"), "excluded\n").unwrap();
        let endpoint = ComparisonEndpoint::Worktree(linked.to_str().unwrap().into());
        let merged = load_comparison(root, request("feature-A", endpoint.clone(), true)).unwrap();
        assert_eq!(
            merged
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["b"]
        );
        assert_eq!(merged.totals.additions, 1);
        assert_ne!(
            merged.comparison.base_commit,
            merged.comparison.selected_base_commit
        );
        let direct = load_comparison(root, request("feature-A", endpoint, false)).unwrap();
        assert_eq!(direct.files.len(), 2);
        assert!(direct
            .files
            .iter()
            .any(|file| file.path == "a-later" && file.status == FileStatus::Deleted));
        assert!(choices(root).unwrap().iter().any(|c| matches!(
            &c.endpoint,
            ComparisonEndpoint::Worktree(path)
                if Path::new(path).canonicalize().unwrap() == linked.canonicalize().unwrap()
        )));
        let selected = merged.comparison.target_commit;
        git_ok(root, &["update-ref", "refs/heads/feature-B", "feature-A"]);
        assert!(matches!(
            super::super::worktree_files::read_commit(root, "b", &selected).unwrap(),
            super::super::worktree_files::FileBody::Text { contents, .. }
                if contents == "b\n"
        ));
        fs::remove_dir_all(&linked).unwrap();
        assert!(load_comparison(
            root,
            request(
                "feature-A",
                ComparisonEndpoint::Worktree(linked.to_str().unwrap().into()),
                false
            )
        )
        .is_err());
    }

    #[test]
    fn totals_are_uncapped_and_include_staged_unstaged_untracked_binary_and_empty() {
        let dir = fixture();
        let root = dir.path();

        git_ok(root, &["mv", "original", "renamed\twith\nUnicode-λ"]);
        fs::write(root.join("renamed\twith\nUnicode-λ"), "one\ntwo\nthree\n").unwrap();
        fs::write(root.join(":(exclude)space file"), "new\n").unwrap();
        fs::write(root.join("empty"), "").unwrap();
        fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        fs::write(root.join("huge"), "line\n".repeat(FILE_LIMIT)).unwrap();
        let result = load_comparison(
            root,
            request("HEAD", ComparisonEndpoint::WorkingTree, false),
        )
        .unwrap();

        assert_eq!(result.totals.additions, FILE_LIMIT as u32 + 2);
        assert_eq!(result.totals.deletions, 0);
        assert_eq!(result.totals.binary_files, 1);
        assert!(result.files.iter().any(|f| f.path == "huge"
            && f.marker == Some(MarkerReason::TooLarge)
            && f.totals.additions == FILE_LIMIT as u32));
        let independent =
            parse_numstat(&git(root, &["diff", "HEAD", "--numstat", "-z"], LIST_LIMIT).unwrap())
                .unwrap();

        assert_eq!(independent.additions, 1);
        assert_eq!(independent.deletions, result.totals.deletions);
        git_ok(root, &["checkout", "--detach"]);
        assert!(load_comparison(
            root,
            request("HEAD", ComparisonEndpoint::WorkingTree, false)
        )
        .is_ok());
        assert!(
            load_comparison(root, request("missing", ComparisonEndpoint::Head, false)).is_err()
        );
        assert!(resolve_commit(root, "--output=oops").is_err());
        git_ok(root, &["checkout", "--orphan", "unrelated"]);
        git_ok(root, &["commit", "--allow-empty", "-m", "unrelated"]);
        assert!(load_comparison(root, request("main", ComparisonEndpoint::Head, true)).is_err());
    }

    #[hegel::test]
    fn generated_library_totals_agree_with_git_numstat(tc: hegel::TestCase) {
        use hegel::generators as gs;
        let dir = fixture();
        let root = dir.path();

        git_ok(root, &["mv", "original", "renamed with\tλ\n"]);
        let count = tc.draw(gs::integers::<usize>().max_value(6));
        let mut additions = 0;
        let mut binary = 0;

        for index in 0..count {
            let lines = tc.draw(gs::integers::<u8>().max_value(100));
            let is_binary = tc.draw(gs::booleans());
            let bytes = if is_binary {
                binary += 1;
                vec![0, 1, 2]
            } else {
                additions += u32::from(lines);
                "line\n".repeat(usize::from(lines)).into_bytes()
            };
            fs::write(root.join(format!(":(literal) file {index}\tλ\n")), bytes).unwrap();
        }

        git_ok(root, &["add", "."]);
        let result = load_comparison(
            root,
            request("HEAD", ComparisonEndpoint::WorkingTree, false),
        )
        .unwrap();
        let independent =
            parse_numstat(&git(root, &["diff", "HEAD", "--numstat", "-z"], LIST_LIMIT).unwrap())
                .unwrap();

        assert_eq!(
            (
                result.totals.additions,
                result.totals.deletions,
                result.totals.binary_files
            ),
            (additions, 0, binary)
        );
        assert_eq!(
            (
                result.totals.additions,
                result.totals.deletions,
                result.totals.binary_files
            ),
            (
                independent.additions,
                independent.deletions,
                independent.binary_files
            )
        );
        assert!(result
            .files
            .iter()
            .any(|file| file.path == "renamed with\tλ\n"
                && file.old_path.as_deref() == Some("original")));
    }
}
