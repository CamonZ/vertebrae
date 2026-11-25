//! Pull request state and checks for worktree branches, polled for many
//! worktrees at once (one GitHub request per repository), plus re-running a
//! failed Actions job and cancelling a running workflow run. The PR comes from
//! the stored association, never from the caller, so the frontend cannot point
//! a write at an arbitrary repository.

use super::{
    push_remote_candidates, GitHubLookup, GithubErrorKind, GithubFailure, WorktreeGitContext,
    WorktreePrAssociation,
};
use crate::{
    commands::chat_catalog::{PrAssociationStore, PrSave, StoredPrAssociation, StoredPrRecord},
    local_chat::worktree_delta::git,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, future::Future, path::Path};
use vertebrae_github::{
    CheckCancel, CheckOutcome, CheckRerun, CheckStatus, GitHubError, PullRequestCheck,
    PullRequestChecks, PullRequestChecksBatch, RateLimitStatus, RepoRef,
};

/// Below this many remaining points, polling waits for the window to reset.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GithubCheckCancel {
    Allowed,
    NoPermission,
    Provider,
    NotApplicable,
}

impl From<CheckCancel> for GithubCheckCancel {
    fn from(cancel: CheckCancel) -> Self {
        match cancel {
            CheckCancel::Allowed => Self::Allowed,
            CheckCancel::NoPermission => Self::NoPermission,
            CheckCancel::Provider => Self::Provider,
            CheckCancel::NotApplicable => Self::NotApplicable,
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
    /// The Actions workflow run the job belongs to; cancelling cancels every
    /// job sharing it.
    pub actions_run: Option<String>,
    pub rerun: GithubCheckRerun,
    pub cancel: GithubCheckCancel,
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
            actions_run: check.actions_run_id.map(|id| id.to_string()),
            rerun: check.rerun.into(),
            cancel: check.cancel.into(),
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
}

impl GithubPrChecks {
    fn new(record: &StoredPrRecord, checks: PullRequestChecks) -> Result<Self, GithubFailure> {
        let number = checks.pull_request.number;
        let pr_number = u32::try_from(number).map_err(|_| {
            GithubFailure::other(format!(
                "Pull request number {number} exceeds supported range"
            ))
        })?;
        Ok(Self {
            pr_number,
            repo: format!("{}/{}", record.owner, record.repo),
            head_sha: checks.head_sha,
            checks: checks.checks.into_iter().map(Into::into).collect(),
            truncated: checks.truncated,
        })
    }
}

/// A worktree branch to poll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBranch {
    pub worktree_path: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorktreePrPollResult {
    /// The linked PR, refreshed, with its checks.
    Linked {
        association: WorktreePrAssociation,
        checks: GithubPrChecks,
    },
    /// No PR is linked; polling has nothing to read for this branch.
    NotLinked,
    Failed {
        failure: GithubFailure,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePrPoll {
    pub worktree_path: String,
    pub branch: String,
    pub result: WorktreePrPollResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePrPollBatch {
    pub results: Vec<WorktreePrPoll>,
    /// Seconds to hold off polling: GitHub's hourly budget is nearly spent.
    pub hold_off_secs: Option<u32>,
}

pub(super) fn hold_off_secs(rate_limit: Option<RateLimitStatus>) -> Option<u32> {
    rate_limit
        .filter(|limit| limit.remaining < LOW_RATE_LIMIT_REMAINING)
        .map(|limit| u32::try_from(limit.reset_in_secs).unwrap_or(u32::MAX))
}

pub(super) trait ChecksLookup: Sync {
    fn checks(
        &self,
        repo: &RepoRef,
        numbers: &[u64],
    ) -> impl Future<Output = Result<PullRequestChecksBatch, GitHubError>> + Send;

    fn rerun_job(
        &self,
        repo: &RepoRef,
        job_id: u64,
    ) -> impl Future<Output = Result<(), GitHubError>> + Send;

    fn cancel_run(
        &self,
        repo: &RepoRef,
        run_id: u64,
    ) -> impl Future<Output = Result<(), GitHubError>> + Send;
}

impl ChecksLookup for GitHubLookup {
    async fn checks(
        &self,
        repo: &RepoRef,
        numbers: &[u64],
    ) -> Result<PullRequestChecksBatch, GitHubError> {
        let (client, token) = self.session().await?;
        client.pull_requests_checks(&token, repo, numbers).await
    }

    async fn rerun_job(&self, repo: &RepoRef, job_id: u64) -> Result<(), GitHubError> {
        let (client, token) = self.session().await?;
        client.rerun_actions_job(&token, repo, job_id).await
    }

    async fn cancel_run(&self, repo: &RepoRef, run_id: u64) -> Result<(), GitHubError> {
        let (client, token) = self.session().await?;
        client.cancel_actions_run(&token, repo, run_id).await
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

/// One linked branch waiting for its PR's checks.
struct Linked<'a> {
    index: usize,
    ctx: &'a WorktreeGitContext,
    stored: StoredPrRecord,
}

/// Refreshes the linked PR and checks of every target: one GitHub request per
/// repository however many worktrees point at it. Each refreshed PR is written
/// back to the stored link so association reads stay current without asking
/// GitHub again.
pub(super) async fn poll_prs<L: ChecksLookup>(
    store: &PrAssociationStore,
    targets: Vec<(WorktreeBranch, Result<WorktreeGitContext, GithubFailure>)>,
    lookup: &L,
    now: Option<i64>,
) -> WorktreePrPollBatch {
    let mut results: Vec<WorktreePrPollResult> = Vec::with_capacity(targets.len());
    let mut by_repo: BTreeMap<(String, String, String), Vec<Linked<'_>>> = BTreeMap::new();
    for (index, (_, ctx)) in targets.iter().enumerate() {
        results.push(WorktreePrPollResult::NotLinked);
        let ctx = match ctx {
            Ok(ctx) => ctx,
            Err(failure) => {
                results[index] = WorktreePrPollResult::Failed {
                    failure: failure.clone(),
                };
                continue;
            }
        };
        match linked_record(store, ctx).await {
            Ok(stored) => by_repo
                .entry((
                    ctx.head_repo.host.to_ascii_lowercase(),
                    stored.owner.to_ascii_lowercase(),
                    stored.repo.to_ascii_lowercase(),
                ))
                .or_default()
                .push(Linked { index, ctx, stored }),
            Err(failure) if failure.kind == GithubErrorKind::NotFound => {}
            Err(failure) => results[index] = WorktreePrPollResult::Failed { failure },
        }
    }

    let mut rate_limit = None;
    for linked in by_repo.into_values() {
        let repo = pr_repo(linked[0].ctx, &linked[0].stored);
        let numbers: Vec<u64> = linked.iter().map(|entry| entry.stored.pr.number).collect();
        let mut batch = match lookup.checks(&repo, &numbers).await {
            Ok(batch) => batch,
            Err(err) => {
                let failure = GithubFailure::from(err);
                for entry in linked {
                    results[entry.index] = WorktreePrPollResult::Failed {
                        failure: failure.clone(),
                    };
                }
                continue;
            }
        };
        rate_limit = RateLimitStatus::tightest(rate_limit, batch.rate_limit);
        for entry in linked {
            let number = entry.stored.pr.number;
            let result = match batch.pull_requests.remove(&number) {
                Some(Ok(checks)) => refreshed(store, &entry, checks, now).await,
                Some(Err(err)) => Err(err.into()),
                None => Err(GithubFailure::other(format!(
                    "GitHub returned nothing for PR #{number}"
                ))),
            };
            results[entry.index] =
                result.unwrap_or_else(|failure| WorktreePrPollResult::Failed { failure });
        }
    }

    WorktreePrPollBatch {
        results: targets
            .into_iter()
            .zip(results)
            .map(|((target, _), result)| WorktreePrPoll {
                worktree_path: target.worktree_path,
                branch: target.branch,
                result,
            })
            .collect(),
        hold_off_secs: hold_off_secs(rate_limit),
    }
}

async fn refreshed(
    store: &PrAssociationStore,
    entry: &Linked<'_>,
    checks: PullRequestChecks,
    now: Option<i64>,
) -> Result<WorktreePrPollResult, GithubFailure> {
    let fresh = StoredPrRecord::new(
        &entry.stored.owner,
        &entry.stored.repo,
        now,
        checks.pull_request.clone(),
    );
    let association = entry.ctx.linked(&fresh, None)?;
    let checks = GithubPrChecks::new(&fresh, checks)?;
    let expected = Some(StoredPrAssociation::Linked(Box::new(entry.stored.clone())));
    let saved = store
        .save_discovered(
            &entry.ctx.key(),
            expected,
            StoredPrAssociation::Linked(Box::new(fresh)),
        )
        .await;
    match saved {
        Ok(PrSave::Saved) => Ok(WorktreePrPollResult::Linked {
            association,
            checks,
        }),
        // The user linked or unlinked meanwhile: this read is for a PR the
        // branch no longer points at.
        Ok(PrSave::Superseded(_)) => Err(GithubFailure::other(
            "The linked pull request changed while refreshing; refresh again",
        )),
        Err(err) => {
            tracing::warn!(error = %err, "Could not persist refreshed PR");
            Ok(WorktreePrPollResult::Linked {
                association,
                checks,
            })
        }
    }
}

/// The current state of one check, re-read from GitHub before any write.
async fn current_check<L: ChecksLookup>(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
    check_id: &str,
    lookup: &L,
) -> Result<(RepoRef, PullRequestCheck), GithubFailure> {
    let record = linked_record(store, ctx).await?;
    let repo = pr_repo(ctx, &record);
    let number = record.pr.number;
    let checks = lookup
        .checks(&repo, &[number])
        .await?
        .pull_requests
        .remove(&number)
        .unwrap_or_else(|| {
            Err(GitHubError::NotFound {
                message: format!("Pull request #{number} not found"),
            })
        })?;
    let check = checks
        .checks
        .into_iter()
        .find(|check| check.id == check_id)
        .ok_or_else(|| {
            GithubFailure::other(format!(
                "That check is no longer on PR #{number}; refresh to see the latest"
            ))
        })?;
    Ok((repo, check))
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
    let (repo, check) = current_check(store, ctx, check_id, lookup).await?;
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

/// Cancels the workflow run of a queued or running Actions job, after the
/// same re-read as [`rerun_check`]. Sent once.
pub(super) async fn cancel_check<L: ChecksLookup>(
    store: &PrAssociationStore,
    ctx: &WorktreeGitContext,
    check_id: &str,
    lookup: &L,
) -> Result<(), GithubFailure> {
    let (repo, check) = current_check(store, ctx, check_id, lookup).await?;
    let refusal = match (check.cancel, check.actions_run_id) {
        (CheckCancel::Allowed, Some(run_id)) => {
            return lookup
                .cancel_run(&repo, run_id)
                .await
                .map_err(GithubFailure::from)
        }
        (CheckCancel::Allowed, None) => "GitHub did not report a workflow run for this check",
        (CheckCancel::NoPermission, _) => {
            "Cancelling workflow runs needs write access to the repository"
        }
        (CheckCancel::Provider, _) => {
            "This check is cancelled from its provider, not GitHub Actions"
        }
        (CheckCancel::NotApplicable, _) => "The check has already finished",
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
