//! Where a worktree branch lives on GitHub: the repository it is pushed to,
//! the one new PRs target, and every GitHub remote, read from git config.

use super::GithubFailure;
use crate::local_chat::{changes::default_branch_name, worktree_delta::git};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use vertebrae_github::{parse_github_remote_url, RepoRef};

/// Where a worktree branch's pull requests live. Read from git config only;
/// GitHub is never asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorktreeGithub {
    #[serde(rename_all = "camelCase")]
    Github {
        branch: String,
        host: String,
        /// `owner/name` the branch is pushed to; a PR's head must live here
        /// to be linked automatically.
        head_repo: String,
        /// `owner/name` new PRs target: the `upstream` parent when configured.
        base_repo: String,
        /// Every GitHub remote, head repository first, then the base.
        search_repos: Vec<String>,
        create_pr_url: String,
    },
    /// There is no GitHub branch to look up (no Git repository, an invalid
    /// branch name, the repository's default branch, or no GitHub remote).
    #[serde(rename_all = "camelCase")]
    NotApplicable {
        branch: Option<String>,
        reason: String,
    },
}

/// Why a worktree branch has no GitHub context: `WorktreeGithub::NotApplicable`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NotApplicable {
    pub(super) branch: Option<String>,
    pub(super) reason: String,
}

impl From<NotApplicable> for WorktreeGithub {
    fn from(NotApplicable { branch, reason }: NotApplicable) -> Self {
        WorktreeGithub::NotApplicable { branch, reason }
    }
}

fn not_applicable(branch: Option<&str>, reason: impl Into<String>) -> NotApplicable {
    NotApplicable {
        branch: branch.map(str::to_owned),
        reason: reason.into(),
    }
}

#[derive(Debug, Clone)]
pub(super) struct WorktreeGitContext {
    pub(super) branch: String,
    pub(super) head_repo: RepoRef,
    pub(super) base_repo: RepoRef,
    /// Head repository first, then the base, then the other remotes.
    pub(super) github_remotes: Vec<RepoRef>,
}

impl WorktreeGitContext {
    /// One of the worktree's GitHub remotes, by `owner/name`; the base
    /// repository when none is given.
    pub(super) fn remote(&self, full_name: Option<&str>) -> Result<&RepoRef, GithubFailure> {
        let Some(full_name) = full_name else {
            return Ok(&self.base_repo);
        };
        self.github_remotes
            .iter()
            .find(|remote| remote.is_named(full_name))
            .ok_or_else(|| {
                GithubFailure::other(format!(
                    "{full_name} is not a GitHub remote of this worktree"
                ))
            })
    }

    pub(super) fn github(&self) -> WorktreeGithub {
        WorktreeGithub::Github {
            branch: self.branch.clone(),
            host: self.head_repo.host.clone(),
            head_repo: self.head_repo.full_name(),
            base_repo: self.base_repo.full_name(),
            search_repos: self.github_remotes.iter().map(RepoRef::full_name).collect(),
            create_pr_url: self.base_repo.create_pr_url(&self.head_repo, &self.branch),
        }
    }
}

/// Resolves the GitHub context of `branch` in the worktree. The branch is the
/// caller's pinned branch; it need not be checked out (or even exist locally,
/// e.g. after a merged branch was deleted). HEAD is never read.
pub(super) fn resolve_worktree_git_context(
    worktree_path: &Path,
    branch: &str,
) -> Result<WorktreeGitContext, NotApplicable> {
    let repo = git::repository(worktree_path)
        .map_err(|_| not_applicable(None, "Worktree is not a Git repository"))?;
    if !git2::Branch::name_is_valid(branch).unwrap_or(false) {
        return Err(not_applicable(
            None,
            format!("{branch:?} is not a valid branch name"),
        ));
    }
    let branch = branch.to_owned();
    match default_branch_name(&repo) {
        Ok(Some(default)) if default == branch => {
            return Err(not_applicable(
                Some(&branch),
                format!("{branch} is the repository's default branch"),
            ))
        }
        Ok(_) => {}
        // Unknown default: look the branch up rather than hide its PR.
        Err(err) => tracing::warn!(error = %err, "Could not read the default branch"),
    }

    let remotes = github_remotes(&repo);
    let head_repo = push_remote_candidates(&repo, &branch)
        .into_iter()
        .find_map(|name| github_remote(&repo, &name))
        .or_else(|| remotes.first().cloned())
        .ok_or_else(|| {
            not_applicable(
                Some(&branch),
                "No GitHub remote configured for this repository",
            )
        })?;
    let base_repo = github_remote(&repo, "upstream").unwrap_or_else(|| head_repo.clone());

    let mut search_order = vec![head_repo.clone()];
    for remote in std::iter::once(&base_repo).chain(&remotes) {
        if !search_order.contains(remote) {
            search_order.push(remote.clone());
        }
    }

    Ok(WorktreeGitContext {
        branch,
        head_repo,
        base_repo,
        github_remotes: search_order,
    })
}

fn github_remote(repo: &git2::Repository, remote_name: &str) -> Option<RepoRef> {
    let remote = repo.find_remote(remote_name).ok()?;
    parse_github_remote_url(remote.url().ok()?)
}

pub(super) fn github_remotes(repo: &git2::Repository) -> Vec<RepoRef> {
    let mut found = Vec::new();
    let Ok(names) = repo.remotes() else {
        return found;
    };
    for name in names.iter().flatten().flatten() {
        if let Some(remote) = github_remote(repo, name) {
            if !found.contains(&remote) {
                found.push(remote);
            }
        }
    }
    found
}

/// Remote names Git would push `branch` to, in Git's precedence order:
/// `branch.<name>.pushRemote`, `remote.pushDefault`, `branch.<name>.remote`,
/// then `origin`.
pub(super) fn push_remote_candidates(repo: &git2::Repository, branch: &str) -> Vec<String> {
    let config = repo.config().and_then(|mut config| config.snapshot()).ok();
    let get = |key: &str| config.as_ref()?.get_string(key).ok();
    [
        get(&format!("branch.{branch}.pushRemote")),
        get("remote.pushDefault"),
        get(&format!("branch.{branch}.remote")),
        Some("origin".to_string()),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub(super) async fn resolve_git_context(
    worktree_path: String,
    branch: String,
) -> Result<Result<WorktreeGitContext, NotApplicable>, GithubFailure> {
    tokio::task::spawn_blocking(move || {
        resolve_worktree_git_context(&PathBuf::from(worktree_path), &branch)
    })
    .await
    .map_err(|err| GithubFailure::other(format!("Git context task failed: {err}")))
}

pub(super) async fn require_git_context(
    worktree_path: String,
    branch: String,
) -> Result<WorktreeGitContext, GithubFailure> {
    resolve_git_context(worktree_path, branch)
        .await?
        .map_err(|not_applicable| GithubFailure::other(not_applicable.reason))
}
