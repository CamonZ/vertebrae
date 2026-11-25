//! The branch is always the caller's (the chat's pinned branch), never the
//! worktree's checked-out HEAD, so switching branches in the repository leaves
//! every association unchanged. The repository's default branch is never
//! looked up on GitHub.
//!
//! A plain reload (`refresh = false`) is answered from the store or from a
//! short-lived in-memory cache and only reaches GitHub when neither applies, so
//! the frontend's file-change reloads can never become a request loop.

use super::chat_catalog::{
    PrAssociationStore, PrKey, PrSave, PrStoreError, StoredPrAssociation, StoredPrRecord,
    UserPrMutation,
};
use crate::{
    helpers::find_gh_binary_with_shell_environment,
    local_chat::{changes::default_branch_name, worktree_delta::git},
    shell_environment::user_shell_environment,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    future::Future,
    path::{Path, PathBuf},
    sync::{Mutex as StdMutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use vertebrae_github::{
    parse_github_remote_url, GhCliAuth, GitHubClient, GitHubError, GitHubToken, OpenPrSearchResult,
    PullRequestState, PullRequestSummary, RepoRef,
};

// Below the frontend's 30 s revalidation so each tick reaches GitHub.
const LINKED_STALE_TTL_SECS: i64 = 20;
const DISPLAY_CACHE_TTL: Duration = Duration::from_secs(60);

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
    fn from_summary(
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
    fn other(message: impl Into<String>) -> Self {
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

impl From<PrStoreError> for GithubFailure {
    fn from(err: PrStoreError) -> Self {
        Self::other(err.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorktreePrAssociation {
    #[serde(rename_all = "camelCase")]
    Linked {
        branch: String,
        repo: String,
        pr: Box<GithubPullRequest>,
        stale_error: Option<GithubFailure>,
    },
    #[serde(rename_all = "camelCase")]
    None {
        branch: String,
        repo: String,
        create_pr_url: String,
    },
    #[serde(rename_all = "camelCase")]
    Ambiguous {
        branch: String,
        repo: String,
        candidates: Vec<GithubPullRequest>,
    },
    #[serde(rename_all = "camelCase")]
    GhMissing { branch: String, repo: String },
    #[serde(rename_all = "camelCase")]
    AuthExpired {
        branch: String,
        repo: String,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    Unavailable {
        branch: String,
        repo: String,
        error: GithubFailure,
    },
    /// There is no GitHub branch to look up (no Git repository, an invalid
    /// branch name, the repository's default branch, or no GitHub remote);
    /// GitHub is not queried and the UI stays quiet.
    #[serde(rename_all = "camelCase")]
    NotApplicable {
        branch: Option<String>,
        reason: String,
    },
}

impl WorktreePrAssociation {
    fn retry_hint(&self) -> Option<Duration> {
        let failure = match self {
            Self::Linked {
                stale_error: Some(failure),
                ..
            }
            | Self::Unavailable { error: failure, .. } => failure,
            _ => return None,
        };
        failure
            .retry_after_secs
            .map(|secs| Duration::from_secs(u64::from(secs)))
    }
}

#[derive(Debug, Clone)]
struct WorktreeGitContext {
    worktree_key: String,
    branch: String,
    /// Repository the branch is pushed to; a PR's head must live here to auto-link.
    head_repo: RepoRef,
    /// Repository new PRs should target: the `upstream` parent when configured.
    base_repo: RepoRef,
    github_remotes: Vec<RepoRef>,
}

impl WorktreeGitContext {
    fn key(&self) -> PrKey {
        PrKey {
            worktree: self.worktree_key.clone(),
            branch: self.branch.clone(),
        }
    }

    /// The stored entry for this branch, unless it links a PR in a repository
    /// that is no longer one of the worktree's GitHub remotes.
    fn applicable<'a>(
        &self,
        stored: Option<&'a StoredPrAssociation>,
    ) -> Option<&'a StoredPrAssociation> {
        stored.filter(|entry| match entry {
            StoredPrAssociation::Linked(record) => self
                .github_remotes
                .iter()
                .any(|remote| remote.is_same(&record.owner, &record.repo)),
            StoredPrAssociation::Unlinked => true,
        })
    }

    fn remote(&self, full_name: Option<&str>) -> Result<&RepoRef, GithubFailure> {
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

    fn is_own_head(&self, pr: &PullRequestSummary) -> bool {
        pr.head_repo
            .as_deref()
            .is_some_and(|head| self.head_repo.is_named(head))
    }

    fn no_pr(&self) -> WorktreePrAssociation {
        WorktreePrAssociation::None {
            branch: self.branch.clone(),
            repo: self.base_repo.full_name(),
            create_pr_url: self.base_repo.create_pr_url(&self.head_repo, &self.branch),
        }
    }

    fn linked(
        &self,
        record: &StoredPrRecord,
        stale_error: Option<GithubFailure>,
    ) -> Result<WorktreePrAssociation, GithubFailure> {
        Ok(WorktreePrAssociation::Linked {
            branch: self.branch.clone(),
            repo: format!("{}/{}", record.owner, record.repo),
            pr: Box::new(GithubPullRequest::from_summary(
                &record.owner,
                &record.repo,
                &record.pr,
            )?),
            stale_error,
        })
    }

    fn ambiguous(
        &self,
        repo: &RepoRef,
        prs: &[PullRequestSummary],
    ) -> Result<WorktreePrAssociation, GithubFailure> {
        Ok(WorktreePrAssociation::Ambiguous {
            branch: self.branch.clone(),
            repo: repo.full_name(),
            candidates: prs
                .iter()
                .map(|pr| GithubPullRequest::from_summary(&repo.owner, &repo.repo, pr))
                .collect::<Result<_, _>>()?,
        })
    }

    fn association_for_error(&self, err: GitHubError) -> WorktreePrAssociation {
        let (branch, repo) = (self.branch.clone(), self.head_repo.full_name());
        match err {
            GitHubError::GhMissing => WorktreePrAssociation::GhMissing { branch, repo },
            GitHubError::AuthExpired { message } => WorktreePrAssociation::AuthExpired {
                branch,
                repo,
                reason: message,
            },
            other => WorktreePrAssociation::Unavailable {
                branch,
                repo,
                error: other.into(),
            },
        }
    }

    fn association_from_stored(
        &self,
        stored: Option<&StoredPrAssociation>,
    ) -> Result<WorktreePrAssociation, GithubFailure> {
        match self.applicable(stored) {
            Some(StoredPrAssociation::Linked(record)) => self.linked(record, None),
            _ => Ok(self.no_pr()),
        }
    }

    fn cache_key(&self) -> CacheKey {
        CacheKey {
            worktree_key: self.worktree_key.clone(),
            branch: self.branch.clone(),
            head_repo: self.head_repo.full_name(),
        }
    }
}

fn now_unix_secs() -> Option<i64> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(elapsed.as_secs()).ok()
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct CacheKey {
    worktree_key: String,
    branch: String,
    head_repo: String,
}

struct CachedAssociation {
    association: WorktreePrAssociation,
    based_on: Option<StoredPrAssociation>,
    /// `None` keeps the answer until the stored entry changes.
    expires_at: Option<Instant>,
}

fn display_cache() -> &'static StdMutex<BTreeMap<CacheKey, CachedAssociation>> {
    static CACHE: OnceLock<StdMutex<BTreeMap<CacheKey, CachedAssociation>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(BTreeMap::new()))
}

fn lock_display_cache() -> std::sync::MutexGuard<'static, BTreeMap<CacheKey, CachedAssociation>> {
    display_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cached_association(
    key: &CacheKey,
    stored: Option<&StoredPrAssociation>,
) -> Option<WorktreePrAssociation> {
    let cache = lock_display_cache();
    let cached = cache.get(key)?;
    let live = cached
        .expires_at
        .is_none_or(|expires_at| Instant::now() < expires_at);
    (live && cached.based_on.as_ref() == stored).then(|| cached.association.clone())
}

fn cache_association(
    key: CacheKey,
    based_on: Option<StoredPrAssociation>,
    association: &WorktreePrAssociation,
    ttl: Option<Duration>,
) {
    let now = Instant::now();
    let mut cache = lock_display_cache();
    cache.retain(|_, cached| cached.expires_at.is_none_or(|expires_at| now < expires_at));
    cache.insert(
        key,
        CachedAssociation {
            association: association.clone(),
            based_on,
            expires_at: ttl.map(|ttl| now + ttl),
        },
    );
}

fn forget_cached_associations(ctx: &WorktreeGitContext) {
    lock_display_cache()
        .retain(|key, _| key.worktree_key != ctx.worktree_key || key.branch != ctx.branch);
}

fn not_applicable(branch: Option<&str>, reason: impl Into<String>) -> WorktreePrAssociation {
    WorktreePrAssociation::NotApplicable {
        branch: branch.map(str::to_owned),
        reason: reason.into(),
    }
}

fn canonical_worktree_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Resolves the GitHub context of `branch` in the worktree. The branch is the
/// caller's pinned branch; it need not be checked out (or even exist locally,
/// e.g. after a merged branch was deleted). HEAD is never read.
fn resolve_worktree_git_context(
    worktree_path: &Path,
    branch: &str,
) -> Result<WorktreeGitContext, WorktreePrAssociation> {
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
        worktree_key: canonical_worktree_key(worktree_path),
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

fn github_remotes(repo: &git2::Repository) -> Vec<RepoRef> {
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
fn push_remote_candidates(repo: &git2::Repository, branch: &str) -> Vec<String> {
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

async fn resolve_git_context(
    worktree_path: String,
    branch: String,
) -> Result<Result<WorktreeGitContext, WorktreePrAssociation>, GithubFailure> {
    tokio::task::spawn_blocking(move || {
        resolve_worktree_git_context(&PathBuf::from(worktree_path), &branch)
    })
    .await
    .map_err(|err| GithubFailure::other(format!("Git context task failed: {err}")))
}

async fn require_git_context(
    worktree_path: String,
    branch: String,
) -> Result<WorktreeGitContext, GithubFailure> {
    resolve_git_context(worktree_path, branch)
        .await?
        .map_err(|association| match association {
            WorktreePrAssociation::NotApplicable { reason, .. } => GithubFailure::other(reason),
            _ => GithubFailure::other("GitHub repository unavailable for this worktree"),
        })
}

trait PrLookup: Sync {
    fn open_prs_for_branch(
        &self,
        repo: &RepoRef,
        branch: &str,
    ) -> impl Future<Output = Result<OpenPrSearchResult, GitHubError>> + Send;

    fn open_prs(
        &self,
        repo: &RepoRef,
    ) -> impl Future<Output = Result<OpenPrSearchResult, GitHubError>> + Send;

    fn pull_request(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> impl Future<Output = Result<PullRequestSummary, GitHubError>> + Send;
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

impl PrLookup for GitHubLookup {
    async fn open_prs_for_branch(
        &self,
        repo: &RepoRef,
        branch: &str,
    ) -> Result<OpenPrSearchResult, GitHubError> {
        let (client, token) = self.session().await?;
        client.list_open_prs_for_branch(&token, repo, branch).await
    }

    async fn open_prs(&self, repo: &RepoRef) -> Result<OpenPrSearchResult, GitHubError> {
        let (client, token) = self.session().await?;
        client.list_open_prs(&token, repo).await
    }

    async fn pull_request(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestSummary, GitHubError> {
        let (client, token) = self.session().await?;
        client.get_pull_request(&token, repo, number).await
    }
}

struct DiscoveryOutcome {
    association: WorktreePrAssociation,
    persist: Option<StoredPrAssociation>,
}

impl DiscoveryOutcome {
    fn display_only(association: WorktreePrAssociation) -> Self {
        Self {
            association,
            persist: None,
        }
    }

    fn link(ctx: &WorktreeGitContext, record: StoredPrRecord) -> Result<Self, GithubFailure> {
        Ok(Self {
            association: ctx.linked(&record, None)?,
            persist: Some(StoredPrAssociation::Linked(Box::new(record))),
        })
    }
}

fn answer_without_github(
    ctx: &WorktreeGitContext,
    stored: Option<&StoredPrAssociation>,
    now: Option<i64>,
) -> Result<Option<WorktreePrAssociation>, GithubFailure> {
    let applicable = ctx.applicable(stored);
    if let Some(StoredPrAssociation::Linked(record)) = applicable {
        if !record.is_stale(now, LINKED_STALE_TTL_SECS) {
            return ctx.linked(record, None).map(Some);
        }
    }
    if let Some(cached) = cached_association(&ctx.cache_key(), stored) {
        return Ok(Some(cached));
    }
    Ok(matches!(applicable, Some(StoredPrAssociation::Unlinked)).then(|| ctx.no_pr()))
}

async fn discover<L: PrLookup>(
    ctx: &WorktreeGitContext,
    stored: Option<&StoredPrAssociation>,
    lookup: &L,
    now: Option<i64>,
) -> Result<DiscoveryOutcome, GithubFailure> {
    match ctx.applicable(stored) {
        Some(StoredPrAssociation::Linked(record)) => refresh_linked(ctx, record, lookup, now).await,
        // An explicit unlink may surface candidates but never auto-links.
        Some(StoredPrAssociation::Unlinked) => search(ctx, lookup, false, now).await,
        None => search(ctx, lookup, true, now).await,
    }
}

async fn refresh_linked<L: PrLookup>(
    ctx: &WorktreeGitContext,
    record: &StoredPrRecord,
    lookup: &L,
    now: Option<i64>,
) -> Result<DiscoveryOutcome, GithubFailure> {
    let repo = RepoRef::new(ctx.head_repo.host.clone(), &record.owner, &record.repo);
    match lookup.pull_request(&repo, record.pr.number).await {
        Ok(fresh) => DiscoveryOutcome::link(
            ctx,
            StoredPrRecord::new(&record.owner, &record.repo, now, fresh),
        ),
        Err(err) => Ok(DiscoveryOutcome::display_only(
            ctx.linked(record, Some(err.into()))?,
        )),
    }
}

async fn search<L: PrLookup>(
    ctx: &WorktreeGitContext,
    lookup: &L,
    auto_link: bool,
    now: Option<i64>,
) -> Result<DiscoveryOutcome, GithubFailure> {
    for (index, repo) in ctx.github_remotes.iter().enumerate() {
        let result = match lookup.open_prs_for_branch(repo, &ctx.branch).await {
            Ok(result) => result,
            // A stale secondary remote must not hide the head repository's answer.
            Err(GitHubError::NotFound { .. }) if index > 0 => continue,
            Err(err) => {
                return Ok(DiscoveryOutcome::display_only(
                    ctx.association_for_error(err),
                ))
            }
        };
        if result.prs.is_empty() && !result.has_more {
            continue;
        }
        return classify(ctx, repo, result, auto_link, now);
    }
    Ok(DiscoveryOutcome::display_only(ctx.no_pr()))
}

fn classify(
    ctx: &WorktreeGitContext,
    repo: &RepoRef,
    OpenPrSearchResult { prs, has_more }: OpenPrSearchResult,
    auto_link: bool,
    now: Option<i64>,
) -> Result<DiscoveryOutcome, GithubFailure> {
    match <[PullRequestSummary; 1]>::try_from(prs) {
        Ok([pr]) if auto_link && !has_more && ctx.is_own_head(&pr) => {
            DiscoveryOutcome::link(ctx, StoredPrRecord::new(&repo.owner, &repo.repo, now, pr))
        }
        Ok(single) => ctx
            .ambiguous(repo, &single)
            .map(DiscoveryOutcome::display_only),
        Err(several) => ctx
            .ambiguous(repo, &several)
            .map(DiscoveryOutcome::display_only),
    }
}

async fn association<L: PrLookup>(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
    refresh: bool,
    lookup: &L,
    now: Option<i64>,
) -> Result<WorktreePrAssociation, GithubFailure> {
    let stored = store.load(&ctx.key()).await?;
    if !refresh {
        if let Some(answer) = answer_without_github(ctx, stored.as_ref(), now)? {
            return Ok(answer);
        }
    }

    // An explicit "check again" after unlinking keeps its answer until the
    // stored entry changes; everything else is reused for a bounded time.
    let ttl = if refresh
        && matches!(
            ctx.applicable(stored.as_ref()),
            Some(StoredPrAssociation::Unlinked)
        ) {
        None
    } else {
        Some(DISPLAY_CACHE_TTL)
    };

    let outcome = discover(ctx, stored.as_ref(), lookup, now).await?;
    let (association, on_disk) = match outcome.persist {
        None => (outcome.association, stored),
        Some(entry) => match store
            .save_discovered(&ctx.key(), stored.clone(), entry.clone())
            .await
        {
            Ok(PrSave::Saved) => (outcome.association, Some(entry)),
            Ok(PrSave::Superseded(latest)) => {
                (ctx.association_from_stored(latest.as_ref())?, latest)
            }
            Err(err) => {
                tracing::warn!(error = %err, "Could not persist discovered PR association");
                (outcome.association, stored)
            }
        },
    };
    let ttl = ttl.map(|ttl| association.retry_hint().map_or(ttl, |hint| hint.max(ttl)));
    cache_association(ctx.cache_key(), on_disk, &association, ttl);
    Ok(association)
}

async fn open_prs<L: PrLookup>(
    ctx: &WorktreeGitContext,
    lookup: &L,
) -> Result<Vec<GithubPullRequest>, GithubFailure> {
    let repo = &ctx.base_repo;
    // `has_more` is not surfaced yet; the list is the most recent page.
    let result = lookup.open_prs(repo).await?;
    result
        .prs
        .iter()
        .map(|pr| GithubPullRequest::from_summary(&repo.owner, &repo.repo, pr))
        .collect()
}

async fn link<L: PrLookup>(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
    pr_number: u32,
    repo: Option<&str>,
    lookup: &L,
    now: Option<i64>,
) -> Result<WorktreePrAssociation, GithubFailure> {
    if pr_number == 0 {
        return Err(GithubFailure::other(
            "Pull request number must be greater than zero",
        ));
    }
    let target = ctx.remote(repo)?;
    let mutation = UserPrMutation::begin(&ctx.key());
    let pr = lookup.pull_request(target, u64::from(pr_number)).await?;
    let record = StoredPrRecord::new(&target.owner, &target.repo, now, pr);
    let association = ctx.linked(&record, None)?;
    commit_user_choice(
        store,
        ctx,
        &mutation,
        StoredPrAssociation::Linked(Box::new(record)),
        association,
    )
    .await
}

async fn unlink(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
) -> Result<WorktreePrAssociation, GithubFailure> {
    let mutation = UserPrMutation::begin(&ctx.key());
    commit_user_choice(
        store,
        ctx,
        &mutation,
        StoredPrAssociation::Unlinked,
        ctx.no_pr(),
    )
    .await
}

async fn commit_user_choice(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
    mutation: &UserPrMutation,
    entry: StoredPrAssociation,
    association: WorktreePrAssociation,
) -> Result<WorktreePrAssociation, GithubFailure> {
    match store.save_user(mutation, entry).await? {
        PrSave::Saved => {
            forget_cached_associations(ctx);
            Ok(association)
        }
        PrSave::Superseded(latest) => ctx.association_from_stored(latest.as_ref()),
    }
}

/// Auto-links when exactly one open PR's head is the branch in the repository
/// it is pushed to; offers candidates otherwise. Plain calls are answered
/// locally whenever possible. The default branch is `not_applicable` without
/// any GitHub call. Never writes to GitHub.
#[tauri::command]
#[specta::specta]
pub async fn get_worktree_pr_association(
    worktree_path: String,
    branch: String,
    refresh: Option<bool>,
) -> Result<WorktreePrAssociation, GithubFailure> {
    let ctx = match resolve_git_context(worktree_path, branch).await? {
        Ok(ctx) => ctx,
        Err(not_applicable) => return Ok(not_applicable),
    };
    let store = PrAssociationStore::app().await?;
    association(
        &store,
        &ctx,
        refresh.unwrap_or(false),
        &GitHubLookup::default(),
        now_unix_secs(),
    )
    .await
}

/// List open pull requests in the worktree's base repository for manually
/// linking `branch`.
#[tauri::command]
#[specta::specta]
pub async fn list_worktree_open_prs(
    worktree_path: String,
    branch: String,
) -> Result<Vec<GithubPullRequest>, GithubFailure> {
    let ctx = require_git_context(worktree_path, branch).await?;
    open_prs(&ctx, &GitHubLookup::default()).await
}

/// Locally associate `branch` of a worktree with PR `pr_number` in `repo`
/// (`owner/name` of one of its GitHub remotes; defaults to the base repository).
#[tauri::command]
#[specta::specta]
pub async fn link_worktree_pr(
    worktree_path: String,
    branch: String,
    pr_number: u32,
    repo: Option<String>,
) -> Result<WorktreePrAssociation, GithubFailure> {
    let ctx = require_git_context(worktree_path, branch).await?;
    let store = PrAssociationStore::app().await?;
    link(
        &store,
        &ctx,
        pr_number,
        repo.as_deref(),
        &GitHubLookup::default(),
        now_unix_secs(),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn unlink_worktree_pr(
    worktree_path: String,
    branch: String,
) -> Result<WorktreePrAssociation, GithubFailure> {
    let ctx = match resolve_git_context(worktree_path, branch).await? {
        Ok(ctx) => ctx,
        Err(not_applicable) => return Ok(not_applicable),
    };
    let store = PrAssociationStore::app().await?;
    unlink(&store, &ctx).await
}

#[cfg(test)]
mod tests;
