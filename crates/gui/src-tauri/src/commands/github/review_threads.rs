//! Review threads of a worktree branch's linked pull request (read-only),
//! and where their published anchors land in the comparison Changes shows.
//!
//! Reading threads is the only GitHub request; placing them is local Git
//! work, rerun whenever the comparison reloads, so file edits never reach
//! GitHub.

use super::{GitHubLookup, GithubFailure, WorktreeGitContext};
use crate::{
    commands::chat_catalog::{
        commit_lines, place_published_anchor, PrAssociationStore, PublishedPlacement,
        ReviewThreadSide, StoredPrAssociation,
    },
    local_chat::worktree_delta::git,
};
use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    future::Future,
    path::PathBuf,
    sync::{Mutex as StdMutex, OnceLock},
    time::{Duration, Instant},
};
use vertebrae_github::{
    DiffSide, GitHubError, PullRequestReviewThreads, RepoRef, ReviewComment, ReviewThread,
};

/// Below the frontend's 30 s revalidation so each tick reaches GitHub.
const THREADS_CACHE_TTL: Duration = Duration::from_secs(20);
/// Lines of published context shown around an edited or outdated anchor.
const SNIPPET_BEFORE: u32 = 2;
const SNIPPET_AFTER: u32 = 1;
/// More than one read can return (see `vertebrae_github`), with headroom.
const MAX_MAPPED_THREADS: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubDiffSide {
    Left,
    Right,
}

impl From<DiffSide> for GithubDiffSide {
    fn from(side: DiffSide) -> Self {
        match side {
            DiffSide::Left => Self::Left,
            DiffSide::Right => Self::Right,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewAuthor {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewComment {
    pub id: String,
    pub author: Option<GithubReviewAuthor>,
    /// GitHub-flavoured Markdown as written; untrusted.
    pub body: String,
    pub created_at: Option<String>,
    pub url: String,
}

impl From<ReviewComment> for GithubReviewComment {
    fn from(comment: ReviewComment) -> Self {
        Self {
            id: comment.id,
            author: comment.author.map(|author| GithubReviewAuthor {
                login: author.login,
                avatar_url: author.avatar_url,
            }),
            body: comment.body,
            created_at: comment.created_at,
            url: comment.url,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewThread {
    pub id: String,
    pub path: String,
    pub side: GithubDiffSide,
    /// Published anchor on the PR head; `None` once the thread is outdated.
    pub line: Option<u32>,
    pub start_line: Option<u32>,
    pub original_line: Option<u32>,
    pub original_start_line: Option<u32>,
    pub original_commit_oid: Option<String>,
    pub file_level: bool,
    pub outdated: bool,
    pub resolved: bool,
    pub viewer_can_resolve: bool,
    pub viewer_can_unresolve: bool,
    pub viewer_can_reply: bool,
    pub comments: Vec<GithubReviewComment>,
    pub comments_truncated: bool,
}

impl From<ReviewThread> for GithubReviewThread {
    fn from(thread: ReviewThread) -> Self {
        Self {
            id: thread.id,
            path: thread.path,
            side: thread.side.into(),
            line: thread.line,
            start_line: thread.start_line,
            original_line: thread.original_line,
            original_start_line: thread.original_start_line,
            original_commit_oid: thread.original_commit_oid,
            file_level: thread.file_level,
            outdated: thread.outdated,
            resolved: thread.resolved,
            viewer_can_resolve: thread.viewer_can_resolve,
            viewer_can_unresolve: thread.viewer_can_unresolve,
            viewer_can_reply: thread.viewer_can_reply,
            comments: thread.comments.into_iter().map(Into::into).collect(),
            comments_truncated: thread.comments_truncated,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorktreePrReviewThreads {
    /// The branch has no linked PR (or no GitHub context): nothing to read.
    NotLinked,
    #[serde(rename_all = "camelCase")]
    Loaded {
        repo: String,
        pr_number: u32,
        /// Commit the published `Right` anchors refer to.
        head_oid: String,
        base_oid: String,
        threads: Vec<GithubReviewThread>,
        truncated: bool,
    },
}

trait ThreadLookup: Sync {
    fn review_threads(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> impl Future<Output = Result<PullRequestReviewThreads, GitHubError>> + Send;
}

impl ThreadLookup for GitHubLookup {
    async fn review_threads(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestReviewThreads, GitHubError> {
        let (client, token) = self.session().await?;
        client.list_review_threads(&token, repo, number).await
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ThreadsCacheKey {
    worktree_key: String,
    branch: String,
    repo: String,
    number: u64,
}

fn threads_cache(
) -> &'static StdMutex<BTreeMap<ThreadsCacheKey, (Instant, WorktreePrReviewThreads)>> {
    static CACHE: OnceLock<
        StdMutex<BTreeMap<ThreadsCacheKey, (Instant, WorktreePrReviewThreads)>>,
    > = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(BTreeMap::new()))
}

fn cached_threads(key: &ThreadsCacheKey, ttl: Duration) -> Option<WorktreePrReviewThreads> {
    let mut cache = threads_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    cache.retain(|_, (at, _)| now.duration_since(*at) < ttl);
    cache.get(key).map(|(_, threads)| threads.clone())
}

fn cache_threads(key: ThreadsCacheKey, threads: &WorktreePrReviewThreads) {
    threads_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, (Instant::now(), threads.clone()));
}

async fn review_threads<L: ThreadLookup>(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
    refresh: bool,
    lookup: &L,
) -> Result<WorktreePrReviewThreads, GithubFailure> {
    let stored = store.load(&ctx.key()).await?;
    let Some(StoredPrAssociation::Linked(record)) = ctx.applicable(stored.as_ref()) else {
        return Ok(WorktreePrReviewThreads::NotLinked);
    };
    let repo = RepoRef::new(ctx.head_repo.host.clone(), &record.owner, &record.repo);
    let number = record.pr.number;
    let key = ThreadsCacheKey {
        worktree_key: ctx.worktree_key.clone(),
        branch: ctx.branch.clone(),
        repo: repo.full_name(),
        number,
    };
    if !refresh {
        if let Some(cached) = cached_threads(&key, THREADS_CACHE_TTL) {
            return Ok(cached);
        }
    }
    let pr_number = u32::try_from(number).map_err(|_| {
        GithubFailure::other(format!(
            "Pull request number {number} exceeds supported range"
        ))
    })?;
    let read = lookup.review_threads(&repo, number).await?;
    let threads = WorktreePrReviewThreads::Loaded {
        repo: repo.full_name(),
        pr_number,
        head_oid: read.head_oid,
        base_oid: read.base_oid,
        threads: read.threads.into_iter().map(Into::into).collect(),
        truncated: read.truncated,
    };
    cache_threads(key, &threads);
    Ok(threads)
}

/// Review threads of the PR linked to `branch` of a worktree. Answers from
/// a short-lived cache unless `refresh`; never writes to GitHub, and never
/// searches for a PR (`not_linked` until the association links one).
#[tauri::command]
#[specta::specta]
pub async fn get_worktree_pr_review_threads(
    worktree_path: String,
    branch: String,
    refresh: Option<bool>,
) -> Result<WorktreePrReviewThreads, GithubFailure> {
    let ctx = match super::resolve_git_context(worktree_path, branch).await? {
        Ok(ctx) => ctx,
        Err(_) => return Ok(WorktreePrReviewThreads::NotLinked),
    };
    let store = PrAssociationStore::app().await?;
    review_threads(
        &store,
        &ctx,
        refresh.unwrap_or(false),
        &GitHubLookup::default(),
    )
    .await
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubThreadAnchor {
    pub thread_id: String,
    pub path: String,
    pub side: GithubDiffSide,
    pub line: Option<u32>,
    pub start_line: Option<u32>,
    pub original_line: Option<u32>,
    pub original_commit_oid: Option<String>,
    pub file_level: bool,
    pub outdated: bool,
}

/// The published commits and the comparison Changes shows.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubThreadMappingRequest {
    pub head_oid: String,
    pub base_oid: String,
    /// The shown new side: a commit, or the working tree when `None`.
    pub shown_target: Option<String>,
    /// The shown old side; `None` reads HEAD.
    pub shown_base: Option<String>,
    pub threads: Vec<GithubThreadAnchor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubSnippetLine {
    pub number: u32,
    pub text: String,
    /// One of the commented lines.
    pub focus: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GithubThreadPlacement {
    /// The commented lines are unchanged in the shown comparison; local
    /// edits above them may have moved them from `published_line`.
    #[serde(rename_all = "camelCase")]
    Anchored {
        start_line: u32,
        line: u32,
        published_line: u32,
    },
    /// Local edits changed the commented lines: the thread stays at its
    /// published line, with the published text.
    #[serde(rename_all = "camelCase")]
    Edited {
        line: u32,
        published: Vec<GithubSnippetLine>,
    },
    /// GitHub no longer places the thread on the PR's diff; `original` is
    /// the commented code where the original commit is available locally.
    #[serde(rename_all = "camelCase")]
    Outdated {
        original_line: Option<u32>,
        original: Vec<GithubSnippetLine>,
    },
    /// The published commit is not available locally (fetch to verify):
    /// shown at the published line as GitHub reports it.
    #[serde(rename_all = "camelCase")]
    Unverified { line: u32 },
    /// The thread comments on the whole file.
    FileLevel,
    /// The file is absent from the shown side of the comparison.
    NotShown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubThreadPosition {
    pub thread_id: String,
    pub placement: GithubThreadPlacement,
}

fn parse_oid(raw: &str) -> Result<Oid, GithubFailure> {
    Oid::from_str(raw).map_err(|_| GithubFailure::other(format!("{raw:?} is not a commit id")))
}

fn parse_optional_oid(raw: Option<&str>) -> Result<Option<Oid>, GithubFailure> {
    raw.map(parse_oid).transpose()
}

fn snippet(
    repo: &Repository,
    commit: Oid,
    path: &str,
    start_line: u32,
    line: u32,
) -> Vec<GithubSnippetLine> {
    let from = start_line.saturating_sub(SNIPPET_BEFORE);
    match commit_lines(repo, commit, path, from, line.saturating_add(SNIPPET_AFTER)) {
        Ok(lines) => lines
            .into_iter()
            .map(|(number, text)| GithubSnippetLine {
                number,
                text,
                focus: (start_line..=line).contains(&number),
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

struct Commits {
    head: Oid,
    /// GitHub's `Left` side is the merge base of the PR's base and head.
    published_base: Oid,
    shown_target: Option<Oid>,
    shown_base: Option<Oid>,
}

fn place(
    repo: &Repository,
    commits: &Commits,
    anchor: &GithubThreadAnchor,
) -> GithubThreadPlacement {
    if anchor.file_level {
        return GithubThreadPlacement::FileLevel;
    }
    let Some(line) = anchor.line.filter(|_| !anchor.outdated) else {
        let original = match (
            parse_optional_oid(anchor.original_commit_oid.as_deref())
                .ok()
                .flatten(),
            anchor.original_line,
        ) {
            (Some(commit), Some(line)) => snippet(repo, commit, &anchor.path, line, line),
            _ => Vec::new(),
        };
        return GithubThreadPlacement::Outdated {
            original_line: anchor.original_line,
            original,
        };
    };
    let start_line = anchor.start_line.unwrap_or(line).min(line);
    let (published, shown, side) = match anchor.side {
        GithubDiffSide::Right => (commits.head, commits.shown_target, ReviewThreadSide::Right),
        GithubDiffSide::Left => (
            commits.published_base,
            Some(commits.shown_base.unwrap_or(commits.published_base)),
            ReviewThreadSide::Left,
        ),
    };
    match place_published_anchor(repo, published, shown, &anchor.path, side, start_line, line) {
        Ok(PublishedPlacement::Mapped {
            start_line,
            line: mapped,
        }) => GithubThreadPlacement::Anchored {
            start_line,
            line: mapped,
            published_line: line,
        },
        Ok(PublishedPlacement::Edited) => GithubThreadPlacement::Edited {
            line,
            published: snippet(repo, published, &anchor.path, start_line, line),
        },
        Ok(PublishedPlacement::Missing) => GithubThreadPlacement::NotShown,
        Err(_) => GithubThreadPlacement::Unverified { line },
    }
}

fn map_threads(
    repo: &Repository,
    request: &GithubThreadMappingRequest,
) -> Result<Vec<GithubThreadPosition>, GithubFailure> {
    if request.threads.len() > MAX_MAPPED_THREADS {
        return Err(GithubFailure::other(format!(
            "Too many review threads to place ({})",
            request.threads.len()
        )));
    }
    let head = parse_oid(&request.head_oid)?;
    let base = parse_oid(&request.base_oid)?;
    let commits = Commits {
        head,
        published_base: repo.merge_base(base, head).unwrap_or(base),
        shown_target: parse_optional_oid(request.shown_target.as_deref())?,
        shown_base: parse_optional_oid(request.shown_base.as_deref())?,
    };
    Ok(request
        .threads
        .iter()
        .map(|anchor| GithubThreadPosition {
            thread_id: anchor.thread_id.clone(),
            placement: place(repo, &commits, anchor),
        })
        .collect())
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
        map_threads(&repo, &request)
    })
    .await
    .map_err(|err| GithubFailure::other(format!("Thread placement task failed: {err}")))?
}

#[cfg(test)]
mod tests;
