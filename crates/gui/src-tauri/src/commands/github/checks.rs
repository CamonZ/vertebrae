//! Checks for the PR linked to a worktree branch, and re-running a failed
//! GitHub Actions job. The PR comes from the stored association, never from
//! the caller, so the frontend cannot point a re-run at an arbitrary repository.

use super::{
    push_remote_candidates, GitHubLookup, GithubErrorKind, GithubFailure, WorktreeGitContext,
};
use crate::{
    commands::chat_catalog::{PrAssociationStore, StoredPrAssociation, StoredPrRecord},
    local_chat::worktree_delta::git,
};
use serde::{Deserialize, Serialize};
use std::{future::Future, path::Path};
use vertebrae_github::{
    CheckOutcome, CheckRerun, CheckStatus, GitHubError, PullRequestCheck, PullRequestChecks,
    RepoRef,
};

/// Poll interval while any check is queued or running.
const PENDING_POLL_SECS: u32 = 15;
/// Below this many remaining requests, polling waits for the window to reset.
const LOW_RATE_LIMIT_REMAINING: u32 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubCheckStatus {
    Failed,
    Running,
    Queued,
    Passed,
}

impl From<CheckStatus> for GithubCheckStatus {
    fn from(status: CheckStatus) -> Self {
        match status {
            CheckStatus::Failed => Self::Failed,
            CheckStatus::Running => Self::Running,
            CheckStatus::Queued => Self::Queued,
            CheckStatus::Passed => Self::Passed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubCheckOutcome {
    Success,
    Neutral,
    Skipped,
    Failure,
    Cancelled,
    TimedOut,
    ActionRequired,
    StartupFailure,
    Stale,
    Error,
}

impl From<CheckOutcome> for GithubCheckOutcome {
    fn from(outcome: CheckOutcome) -> Self {
        match outcome {
            CheckOutcome::Success => Self::Success,
            CheckOutcome::Neutral => Self::Neutral,
            CheckOutcome::Skipped => Self::Skipped,
            CheckOutcome::Failure => Self::Failure,
            CheckOutcome::Cancelled => Self::Cancelled,
            CheckOutcome::TimedOut => Self::TimedOut,
            CheckOutcome::ActionRequired => Self::ActionRequired,
            CheckOutcome::StartupFailure => Self::StartupFailure,
            CheckOutcome::Stale => Self::Stale,
            CheckOutcome::Error => Self::Error,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubCheckRerun {
    Allowed,
    NoPermission,
    PullRequestClosed,
    Provider,
    NotApplicable,
}

impl From<CheckRerun> for GithubCheckRerun {
    fn from(rerun: CheckRerun) -> Self {
        match rerun {
            CheckRerun::Allowed => Self::Allowed,
            CheckRerun::NoPermission => Self::NoPermission,
            CheckRerun::PullRequestClosed => Self::PullRequestClosed,
            CheckRerun::Provider => Self::Provider,
            CheckRerun::NotApplicable => Self::NotApplicable,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrCheck {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub status: GithubCheckStatus,
    pub outcome: Option<GithubCheckOutcome>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub url: Option<String>,
    pub summary: Option<String>,
    pub failed_step: Option<String>,
    /// A GitHub Actions job: its page and logs live on GitHub.
    pub actions_job: bool,
    pub rerun: GithubCheckRerun,
}

impl From<PullRequestCheck> for GithubPrCheck {
    fn from(check: PullRequestCheck) -> Self {
        Self {
            id: check.id,
            name: check.name,
            provider: check.provider,
            status: check.status.into(),
            outcome: check.outcome.map(Into::into),
            started_at: check.started_at,
            completed_at: check.completed_at,
            url: check.url,
            summary: check.summary,
            failed_step: check.failed_step,
            actions_job: check.actions_job_id.is_some(),
            rerun: check.rerun.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrChecks {
    pub pr_number: u32,
    pub repo: String,
    pub head_sha: String,
    pub checks: Vec<GithubPrCheck>,
    pub truncated: bool,
    /// When to poll again; `None` once every check has finished.
    pub poll_after_secs: Option<u32>,
}

pub(super) fn poll_after_secs(checks: &PullRequestChecks) -> Option<u32> {
    if !checks.has_pending() {
        return None;
    }
    let wait_for_reset = checks
        .rate_limit
        .filter(|limit| limit.remaining < LOW_RATE_LIMIT_REMAINING)
        .map(|limit| u32::try_from(limit.reset_in_secs).unwrap_or(u32::MAX));
    Some(wait_for_reset.map_or(PENDING_POLL_SECS, |secs| secs.max(PENDING_POLL_SECS)))
}

impl GithubPrChecks {
    fn new(record: &StoredPrRecord, checks: PullRequestChecks) -> Result<Self, GithubFailure> {
        let pr_number = u32::try_from(checks.number).map_err(|_| {
            GithubFailure::other(format!(
                "Pull request number {} exceeds supported range",
                checks.number
            ))
        })?;
        let poll_after_secs = poll_after_secs(&checks);
        Ok(Self {
            pr_number,
            repo: format!("{}/{}", record.owner, record.repo),
            head_sha: checks.head_sha,
            checks: checks.checks.into_iter().map(Into::into).collect(),
            truncated: checks.truncated,
            poll_after_secs,
        })
    }
}

pub(super) trait ChecksLookup: Sync {
    fn checks(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> impl Future<Output = Result<PullRequestChecks, GitHubError>> + Send;

    fn rerun_job(
        &self,
        repo: &RepoRef,
        job_id: u64,
    ) -> impl Future<Output = Result<(), GitHubError>> + Send;
}

impl ChecksLookup for GitHubLookup {
    async fn checks(&self, repo: &RepoRef, number: u64) -> Result<PullRequestChecks, GitHubError> {
        let (client, token) = self.session().await?;
        client.pull_request_checks(&token, repo, number).await
    }

    async fn rerun_job(&self, repo: &RepoRef, job_id: u64) -> Result<(), GitHubError> {
        let (client, token) = self.session().await?;
        client.rerun_actions_job(&token, repo, job_id).await
    }
}

fn not_linked(ctx: &WorktreeGitContext) -> GithubFailure {
    GithubFailure {
        kind: GithubErrorKind::NotFound,
        message: format!("No pull request is linked to {}", ctx.branch),
        retry_after_secs: None,
    }
}

async fn linked_record(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
) -> Result<StoredPrRecord, GithubFailure> {
    match ctx.applicable(store.load(&ctx.key()).await?.as_ref()) {
        Some(StoredPrAssociation::Linked(record)) => Ok((**record).clone()),
        _ => Err(not_linked(ctx)),
    }
}

fn pr_repo(ctx: &WorktreeGitContext, record: &StoredPrRecord) -> RepoRef {
    RepoRef::new(ctx.head_repo.host.clone(), &record.owner, &record.repo)
}

pub(super) async fn pr_checks<L: ChecksLookup>(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
    lookup: &L,
) -> Result<GithubPrChecks, GithubFailure> {
    let record = linked_record(store, ctx).await?;
    let checks = lookup
        .checks(&pr_repo(ctx, &record), record.pr.number)
        .await?;
    GithubPrChecks::new(&record, checks)
}

/// Re-runs a check only after re-reading the PR's checks and confirming the
/// check is a failed Actions job the viewer may re-run. The request is sent
/// once; a lost response is reported, never retried here.
pub(super) async fn rerun_check<L: ChecksLookup>(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
    check_id: &str,
    lookup: &L,
) -> Result<(), GithubFailure> {
    let record = linked_record(store, ctx).await?;
    let repo = pr_repo(ctx, &record);
    let checks = lookup.checks(&repo, record.pr.number).await?;
    let check = checks
        .checks
        .iter()
        .find(|check| check.id == check_id)
        .ok_or_else(|| {
            GithubFailure::other(format!(
                "That check is no longer on PR #{}; refresh to see the latest",
                record.pr.number
            ))
        })?;
    let refusal = match (check.rerun, check.actions_job_id) {
        (CheckRerun::Allowed, Some(job_id)) => {
            return lookup
                .rerun_job(&repo, job_id)
                .await
                .map_err(GithubFailure::from)
        }
        (CheckRerun::Allowed, None) => "GitHub did not report a job for this check",
        (CheckRerun::NoPermission, _) => "Re-running jobs needs write access to the repository",
        (CheckRerun::PullRequestClosed, _) => "Jobs can only be re-run on an open pull request",
        (CheckRerun::Provider, _) => "This check re-runs from its provider, not GitHub Actions",
        (CheckRerun::NotApplicable, _) => "Only failed jobs can be re-run",
    };
    Err(GithubFailure::other(refusal))
}

/// The local remote-tracking commit `branch` is pushed to, e.g.
/// `refs/remotes/origin/my_branch`. A change means a push (or fetch) landed,
/// without asking GitHub.
pub(super) fn published_head(worktree_path: &Path, branch: &str) -> Option<String> {
    let repo = git::repository(worktree_path).ok()?;
    push_remote_candidates(&repo, branch)
        .into_iter()
        .find_map(|remote| {
            let reference = repo
                .find_reference(&format!("refs/remotes/{remote}/{branch}"))
                .ok()?;
            Some(reference.peel_to_commit().ok()?.id().to_string())
        })
}
