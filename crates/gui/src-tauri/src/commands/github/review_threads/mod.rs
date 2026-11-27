//! Review threads of a pull request (read-only), and where their published
//! anchors land in the comparison Changes shows. The caller names the PR:
//! the frontend owns each branch's link.
//!
//! Reading threads is the only GitHub request; placing them is local Git
//! work, rerun whenever the comparison reloads, so file edits never reach
//! GitHub.

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
                head_oid: read.head_oid,
                base_oid: read.base_oid,
                threads: read.threads.into_iter().map(Into::into).collect(),
                truncated: read.truncated,
            })
        })
        .await
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
