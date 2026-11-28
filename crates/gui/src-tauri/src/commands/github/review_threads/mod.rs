//! Review threads of a pull request, the user's writes to them, and where
//! their published anchors land in the comparison Changes shows. The caller
//! names the PR: the frontend owns each branch's link.
//!
//! Reads and the user's explicit writes are the only GitHub requests;
//! placing threads is local Git work, rerun whenever the comparison reloads,
//! so file edits never reach GitHub.

mod cache;
mod placement;
mod types;

pub use cache::ReviewThreadsCache;
pub use types::*;

use super::{require_git_context, GitHubLookup, GithubFailure, PrLookup};
use crate::local_chat::worktree_delta::git;
use cache::ThreadsKey;
use std::path::PathBuf;
use tauri::State;
use vertebrae_github::RepoRef;

pub(super) async fn review_threads<L: PrLookup>(
    cache: &ReviewThreadsCache,
    repo: &RepoRef,
    pr_number: u32,
    refresh: bool,
    lookup: &L,
) -> Result<GithubPrReviewThreads, GithubFailure> {
    let number = u64::from(pr_number);
    cache
        .read(ThreadsKey::new(repo, number), refresh, || async {
            let read = lookup.review_threads(repo, number).await?;
            Ok(GithubPrReviewThreads {
                repo: repo.full_name(),
                pr_number,
                viewer_login: read.viewer_login,
                head_oid: read.head_oid,
                base_oid: read.base_oid,
                threads: read.threads.into_iter().map(Into::into).collect(),
                truncated: read.truncated,
            })
        })
        .await
}

/// Sends `write` once. Whatever GitHub answers, the PR's cached read is
/// dropped so the caller's next read shows what GitHub applied.
pub(super) async fn write_review_thread<L: PrLookup>(
    cache: &ReviewThreadsCache,
    repo: &RepoRef,
    pr_number: u32,
    write: GithubThreadWrite,
    lookup: &L,
) -> Result<String, GithubFailure> {
    let number = u64::from(pr_number);
    let result = lookup
        .write_review_thread(repo, number, &write.into())
        .await;
    cache.invalidate(&ThreadsKey::new(repo, number));
    result.map_err(GithubFailure::from)
}

/// Review threads of PR `pr_number` in `repo` (one of the worktree's GitHub
/// remotes). Answers from a short-lived cache unless `refresh`; never writes
/// to GitHub.
#[tauri::command]
#[specta::specta]
pub async fn get_github_pr_review_threads(
    cache: State<'_, ReviewThreadsCache>,
    worktree_path: String,
    branch: String,
    repo: String,
    pr_number: u32,
    refresh: Option<bool>,
) -> Result<GithubPrReviewThreads, GithubFailure> {
    if pr_number == 0 {
        return Err(GithubFailure::other(
            "Pull request number must be greater than zero",
        ));
    }
    let ctx = require_git_context(worktree_path, branch).await?;
    let repo = ctx.remote(Some(&repo))?;
    review_threads(
        &cache,
        repo,
        pr_number,
        refresh.unwrap_or(false),
        &GitHubLookup::default(),
    )
    .await
}

/// Reply to, resolve, reopen or start a review thread on PR `pr_number` in
/// `repo` (one of the worktree's GitHub remotes); the ID of the thread
/// written. Posts to GitHub, once.
#[tauri::command]
#[specta::specta]
pub async fn write_github_pr_review_thread(
    cache: State<'_, ReviewThreadsCache>,
    worktree_path: String,
    branch: String,
    repo: String,
    pr_number: u32,
    write: GithubThreadWrite,
) -> Result<String, GithubFailure> {
    if pr_number == 0 {
        return Err(GithubFailure::other(
            "Pull request number must be greater than zero",
        ));
    }
    let ctx = require_git_context(worktree_path, branch).await?;
    let repo = ctx.remote(Some(&repo))?;
    write_review_thread(&cache, repo, pr_number, write, &GitHubLookup::default()).await
}

/// Place published review-thread anchors on the shown comparison. Local only.
#[tauri::command]
#[specta::specta]
pub async fn map_worktree_pr_review_threads(
    worktree_path: String,
    request: GithubThreadMappingRequest,
) -> Result<Vec<GithubThreadPosition>, GithubFailure> {
    tokio::task::spawn_blocking(move || {
        let repo = git::repository(&PathBuf::from(&worktree_path))
            .map_err(|_| GithubFailure::other("Worktree is not a Git repository"))?;
        placement::map_threads(&repo, &request)
    })
    .await
    .map_err(|err| GithubFailure::other(format!("Thread placement task failed: {err}")))?
}

#[cfg(test)]
mod tests;
