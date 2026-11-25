//! GitHub reads and writes for chat worktree branches. Nothing here keeps
//! PR state: the frontend owns each chat's linked PR and asks, per remote,
//! for the open PRs of the branches it watches and for the linked PRs with
//! their checks. The branch is always the caller's (the chat's pinned
//! branch), never the worktree's checked-out HEAD.

use crate::{
    helpers::find_gh_binary_with_shell_environment, shell_environment::user_shell_environment,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::OnceLock};
use vertebrae_github::{
    GhCliAuth, GitHubClient, GitHubError, GitHubToken, PullRequestState, PullRequestSummary,
};

mod checks;
mod git_context;
use checks::PrLookup;
pub use checks::{
    GithubBranchPrs, GithubCheckCancel, GithubCheckOutcome, GithubCheckRerun, GithubCheckStatus,
    GithubOpenPrsPoll, GithubPolledPr, GithubPolledPrResult, GithubPrCheck, GithubPrChecks,
    GithubPrPollBatch, GithubPrPollRequest, GithubRemotePoll,
};
pub use git_context::WorktreeGithub;
use git_context::{push_remote_candidates, require_git_context, resolve_git_context};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubPrState {
    Open,
    Draft,
    Merged,
    Closed,
}

impl From<PullRequestState> for GithubPrState {
    fn from(state: PullRequestState) -> Self {
        match state {
            PullRequestState::Open => Self::Open,
            PullRequestState::Draft => Self::Draft,
            PullRequestState::Merged => Self::Merged,
            PullRequestState::Closed => Self::Closed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequest {
    pub owner: String,
    pub repo: String,
    pub number: u32,
    pub title: String,
    pub state: GithubPrState,
    pub head_ref: String,
    pub head_repo: Option<String>,
    pub base_ref: String,
    pub url: String,
    pub author: Option<String>,
    pub updated_at: Option<String>,
}

impl GithubPullRequest {
    pub(super) fn from_summary(
        owner: &str,
        repo: &str,
        pr: &PullRequestSummary,
    ) -> Result<Self, GithubFailure> {
        let number = u32::try_from(pr.number).map_err(|_| {
            GithubFailure::other(format!(
                "Pull request number {} exceeds supported range",
                pr.number
            ))
        })?;
        Ok(Self {
            owner: owner.to_string(),
            repo: repo.to_string(),
            number,
            title: pr.title.clone(),
            state: pr.state.into(),
            head_ref: pr.head_ref.clone(),
            head_repo: pr.head_repo.clone(),
            base_ref: pr.base_ref.clone(),
            url: pr.url.clone(),
            author: pr.author.clone(),
            updated_at: pr.updated_at.clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubErrorKind {
    GhMissing,
    AuthExpired,
    RateLimited,
    NotFound,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubFailure {
    pub kind: GithubErrorKind,
    pub message: String,
    pub retry_after_secs: Option<u32>,
}

impl GithubFailure {
    pub(super) fn other(message: impl Into<String>) -> Self {
        Self {
            kind: GithubErrorKind::Other,
            message: message.into(),
            retry_after_secs: None,
        }
    }
}

impl From<&GitHubError> for GithubFailure {
    fn from(err: &GitHubError) -> Self {
        let (kind, retry_after_secs) = match err {
            GitHubError::GhMissing => (GithubErrorKind::GhMissing, None),
            GitHubError::AuthExpired { .. } => (GithubErrorKind::AuthExpired, None),
            GitHubError::RateLimited {
                retry_after_secs, ..
            } => (
                GithubErrorKind::RateLimited,
                retry_after_secs.map(|secs| u32::try_from(secs).unwrap_or(u32::MAX)),
            ),
            GitHubError::NotFound { .. } => (GithubErrorKind::NotFound, None),
            _ => (GithubErrorKind::Other, None),
        };
        Self {
            kind,
            message: err.to_string(),
            retry_after_secs,
        }
    }
}

impl From<GitHubError> for GithubFailure {
    fn from(err: GitHubError) -> Self {
        Self::from(&err)
    }
}

/// Production lookups: one shared HTTP client; the token is resolved lazily,
/// at most once per command, and only if GitHub is actually queried.
#[derive(Default)]
struct GitHubLookup {
    token: tokio::sync::OnceCell<Result<GitHubToken, GitHubError>>,
}

fn shared_client() -> Result<&'static GitHubClient, GitHubError> {
    static CLIENT: OnceLock<Result<GitHubClient, GitHubError>> = OnceLock::new();
    CLIENT
        .get_or_init(GitHubClient::new)
        .as_ref()
        .map_err(Clone::clone)
}

fn user_gh_auth() -> GhCliAuth {
    let shell = user_shell_environment();
    let gh = find_gh_binary_with_shell_environment(&shell);
    let auth = GhCliAuth::from_env(shell.variables);
    match gh {
        Ok(path) => auth.with_gh_binary(path),
        Err(_) => auth,
    }
}

async fn resolve_user_token() -> Result<GitHubToken, GitHubError> {
    let auth = tokio::task::spawn_blocking(user_gh_auth)
        .await
        .map_err(|err| GitHubError::GhFailed {
            message: format!("Could not prepare GitHub CLI lookup: {err}"),
        })?;
    auth.resolve().await
}

impl GitHubLookup {
    async fn session(&self) -> Result<(&'static GitHubClient, GitHubToken), GitHubError> {
        let client = shared_client()?;
        let token = self.token.get_or_init(resolve_user_token).await.clone()?;
        Ok((client, token))
    }
}

/// Where the branch's PRs live on GitHub, from git config alone. The
/// repository's default branch and non-GitHub worktrees are `not_applicable`.
#[tauri::command]
#[specta::specta]
pub async fn resolve_worktree_github(
    worktree_path: String,
    branch: String,
) -> Result<WorktreeGithub, GithubFailure> {
    Ok(match resolve_git_context(worktree_path, branch).await? {
        Ok(ctx) => ctx.github(),
        Err(not_applicable) => not_applicable.into(),
    })
}

/// One round of PR polling: per remote, the open PRs of the given branches
/// and the given PRs with their checks. Remotes are read concurrently.
#[tauri::command]
#[specta::specta]
pub async fn poll_github_prs(
    requests: Vec<GithubPrPollRequest>,
) -> Result<GithubPrPollBatch, GithubFailure> {
    Ok(checks::poll(requests, &GitHubLookup::default()).await)
}

/// Open pull requests in `repo` (one of the worktree's GitHub remotes;
/// defaults to the base repository), most recently updated first, for
/// linking `branch` by hand.
#[tauri::command]
#[specta::specta]
pub async fn list_github_open_prs(
    worktree_path: String,
    branch: String,
    repo: Option<String>,
) -> Result<Vec<GithubPullRequest>, GithubFailure> {
    let ctx = require_git_context(worktree_path, branch).await?;
    let repo = ctx.remote(repo.as_deref())?;
    GitHubLookup::default()
        .open_prs(repo, checks::OPEN_PR_PAGES)
        .await?
        .prs
        .iter()
        .map(|pr| GithubPullRequest::from_summary(&repo.owner, &repo.repo, pr))
        .collect()
}

/// PR `pr_number` in `repo` (one of the worktree's GitHub remotes; defaults
/// to the base repository), read before the frontend links it.
#[tauri::command]
#[specta::specta]
pub async fn get_github_pr(
    worktree_path: String,
    branch: String,
    repo: Option<String>,
    pr_number: u32,
) -> Result<GithubPullRequest, GithubFailure> {
    if pr_number == 0 {
        return Err(GithubFailure::other(
            "Pull request number must be greater than zero",
        ));
    }
    let ctx = require_git_context(worktree_path, branch).await?;
    let repo = ctx.remote(repo.as_deref())?;
    let pr = GitHubLookup::default()
        .pull_request(repo, u64::from(pr_number))
        .await?;
    GithubPullRequest::from_summary(&repo.owner, &repo.repo, &pr)
}

/// Re-run one failed GitHub Actions job (`checkId` from [`poll_github_prs`])
/// of PR `pr_number` in `repo`, which must be a GitHub remote of the
/// worktree. Posts to GitHub.
#[tauri::command]
#[specta::specta]
pub async fn rerun_github_pr_check(
    worktree_path: String,
    branch: String,
    repo: String,
    pr_number: u32,
    check_id: String,
) -> Result<(), GithubFailure> {
    let ctx = require_git_context(worktree_path, branch).await?;
    let repo = ctx.remote(Some(&repo))?;
    checks::rerun_check(repo, pr_number, &check_id, &GitHubLookup::default()).await
}

/// Cancel the GitHub Actions workflow run of a queued or running job
/// (`checkId` from [`poll_github_prs`]); every job in that run stops.
/// Posts to GitHub.
#[tauri::command]
#[specta::specta]
pub async fn cancel_github_pr_check(
    worktree_path: String,
    branch: String,
    repo: String,
    pr_number: u32,
    check_id: String,
) -> Result<(), GithubFailure> {
    let ctx = require_git_context(worktree_path, branch).await?;
    let repo = ctx.remote(Some(&repo))?;
    checks::cancel_check(repo, pr_number, &check_id, &GitHubLookup::default()).await
}

/// The local remote-tracking commit `branch` is pushed to; never queries GitHub.
#[tauri::command]
#[specta::specta]
pub async fn get_worktree_published_head(
    worktree_path: String,
    branch: String,
) -> Result<Option<String>, GithubFailure> {
    tokio::task::spawn_blocking(move || {
        checks::published_head(&PathBuf::from(worktree_path), &branch)
    })
    .await
    .map_err(|err| GithubFailure::other(format!("Git lookup task failed: {err}")))
}

mod review_threads;
pub use review_threads::*;

#[cfg(test)]
mod tests;
