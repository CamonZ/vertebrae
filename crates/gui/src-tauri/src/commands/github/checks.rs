//! One round of PR polling per remote: the open PRs of watched branches and
//! the linked PRs with their checks. Plus re-running a failed Actions job and
//! cancelling a running workflow run, each re-checked against GitHub first.

use super::{push_remote_candidates, GitHubLookup, GithubFailure, GithubPullRequest};
use crate::local_chat::worktree_delta::git;
use serde::{Deserialize, Serialize};
use std::{future::Future, path::Path};
use vertebrae_github::{
    CheckCancel, CheckOutcome, CheckRerun, CheckStatus, GitHubError, OpenPrSearchResult,
    PullRequestCheck, PullRequestChecks, PullRequestChecksBatch, PullRequestSummary,
    RateLimitStatus, RepoRef,
};

/// Below this many remaining points, polling waits for the window to reset.
pub(super) const LOW_RATE_LIMIT_REMAINING: u32 = 50;
/// Pages of 50 open PRs read per remote and round. A longer list is not
/// complete, so its branches are looked up one by one instead.
pub(super) const OPEN_PR_PAGES: usize = 3;

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
    RunInProgress,
    Provider,
    NotApplicable,
}

impl From<CheckRerun> for GithubCheckRerun {
    fn from(rerun: CheckRerun) -> Self {
        match rerun {
            CheckRerun::Allowed => Self::Allowed,
            CheckRerun::NoPermission => Self::NoPermission,
            CheckRerun::PullRequestClosed => Self::PullRequestClosed,
            CheckRerun::RunInProgress => Self::RunInProgress,
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
    pub(super) fn new(repo: &RepoRef, checks: PullRequestChecks) -> Result<Self, GithubFailure> {
        let number = checks.pull_request.number;
        let pr_number = u32::try_from(number).map_err(|_| {
            GithubFailure::other(format!(
                "Pull request number {number} exceeds supported range"
            ))
        })?;
        Ok(Self {
            pr_number,
            repo: repo.full_name(),
            head_sha: checks.head_sha,
            checks: checks.checks.into_iter().map(Into::into).collect(),
            truncated: checks.truncated,
        })
    }
}

/// What to read from one remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrPollRequest {
    pub host: String,
    /// `owner/name`.
    pub repo: String,
    /// Branches whose open PRs to list.
    pub branches: Vec<String>,
    /// Linked PRs to read with their checks.
    pub numbers: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPrPollBatch {
    pub remotes: Vec<GithubRemotePoll>,
    /// Seconds to hold off polling: GitHub's hourly budget is nearly spent.
    pub hold_off_secs: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubRemotePoll {
    pub host: String,
    pub repo: String,
    pub open_prs: GithubOpenPrsPoll,
    pub pull_requests: Vec<GithubPolledPr>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum GithubOpenPrsPoll {
    /// No branch was asked about.
    NotRequested,
    Read {
        branches: Vec<GithubBranchPrs>,
    },
    Failed {
        failure: GithubFailure,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubBranchPrs {
    pub branch: String,
    /// Open PRs whose head is the branch, from any repository.
    pub prs: Vec<GithubPullRequest>,
    /// Every open PR of the branch is listed; never auto-link otherwise.
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubPolledPr {
    pub number: u32,
    pub result: GithubPolledPrResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum GithubPolledPrResult {
    Read {
        pr: Box<GithubPullRequest>,
        checks: Box<GithubPrChecks>,
    },
    Failed {
        failure: GithubFailure,
    },
}

pub(super) fn hold_off_secs(rate_limit: Option<RateLimitStatus>) -> Option<u32> {
    rate_limit
        .filter(|limit| limit.remaining < LOW_RATE_LIMIT_REMAINING)
        .map(|limit| u32::try_from(limit.reset_in_secs).unwrap_or(u32::MAX))
}

pub(super) trait PrLookup: Sync {
    fn open_prs(
        &self,
        repo: &RepoRef,
        max_pages: usize,
    ) -> impl Future<Output = Result<OpenPrSearchResult, GitHubError>> + Send;

    fn pull_request(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> impl Future<Output = Result<PullRequestSummary, GitHubError>> + Send;

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

impl PrLookup for GitHubLookup {
    async fn open_prs(
        &self,
        repo: &RepoRef,
        max_pages: usize,
    ) -> Result<OpenPrSearchResult, GitHubError> {
        let (client, token) = self.session().await?;
        client.list_open_prs(&token, repo, max_pages).await
    }

    async fn pull_request(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestSummary, GitHubError> {
        let (client, token) = self.session().await?;
        client.get_pull_request(&token, repo, number).await
    }

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

fn repo_ref(request: &GithubPrPollRequest) -> Result<RepoRef, GithubFailure> {
    request
        .repo
        .split_once('/')
        .filter(|(owner, name)| !owner.is_empty() && !name.is_empty() && !name.contains('/'))
        .map(|(owner, name)| RepoRef::new(request.host.clone(), owner, name))
        .ok_or_else(|| GithubFailure::other(format!("{:?} is not owner/name", request.repo)))
}

fn summaries(
    repo: &RepoRef,
    prs: &[PullRequestSummary],
) -> Result<Vec<GithubPullRequest>, GithubFailure> {
    prs.iter()
        .map(|pr| GithubPullRequest::from_summary(&repo.owner, &repo.repo, pr))
        .collect()
}

/// The open PRs of each branch, from one listing of the repository's open
/// PRs (up to `OPEN_PR_PAGES` pages).
async fn open_prs_of_branches<L: PrLookup>(
    repo: &RepoRef,
    branches: &[String],
    lookup: &L,
) -> (GithubOpenPrsPoll, Option<RateLimitStatus>) {
    if branches.is_empty() {
        return (GithubOpenPrsPoll::NotRequested, None);
    }
    let listed = match lookup.open_prs(repo, OPEN_PR_PAGES).await {
        Ok(listed) => listed,
        Err(err) => return (failed_open_prs(err.into()), None),
    };
    // Past the pages read, a branch's PRs may be missing: it is incomplete,
    // so nothing links on its own, and the user links by hand.
    let mut read = Vec::with_capacity(branches.len());
    for branch in branches {
        let own: Vec<_> = listed
            .prs
            .iter()
            .filter(|pr| pr.head_ref == *branch)
            .cloned()
            .collect();
        match summaries(repo, &own) {
            Ok(prs) => read.push(GithubBranchPrs {
                branch: branch.clone(),
                prs,
                complete: !listed.has_more,
            }),
            Err(failure) => return (failed_open_prs(failure), listed.rate_limit),
        }
    }
    (
        GithubOpenPrsPoll::Read { branches: read },
        listed.rate_limit,
    )
}

fn failed_open_prs(failure: GithubFailure) -> GithubOpenPrsPoll {
    GithubOpenPrsPoll::Failed { failure }
}

fn polled_pr(repo: &RepoRef, checks: PullRequestChecks) -> GithubPolledPrResult {
    let read = GithubPullRequest::from_summary(&repo.owner, &repo.repo, &checks.pull_request)
        .and_then(|pr| Ok((pr, GithubPrChecks::new(repo, checks)?)));
    match read {
        Ok((pr, checks)) => GithubPolledPrResult::Read {
            pr: Box::new(pr),
            checks: Box::new(checks),
        },
        Err(failure) => GithubPolledPrResult::Failed { failure },
    }
}

/// The given PRs with their checks, in one batched read.
async fn pull_requests<L: PrLookup>(
    repo: &RepoRef,
    numbers: &[u32],
    lookup: &L,
) -> (Vec<GithubPolledPr>, Option<RateLimitStatus>) {
    if numbers.is_empty() {
        return (Vec::new(), None);
    }
    let wanted: Vec<u64> = numbers.iter().copied().map(u64::from).collect();
    let mut batch = match lookup.checks(repo, &wanted).await {
        Ok(batch) => batch,
        Err(err) => {
            let failure = GithubFailure::from(err);
            let failed = numbers
                .iter()
                .map(|&number| GithubPolledPr {
                    number,
                    result: GithubPolledPrResult::Failed {
                        failure: failure.clone(),
                    },
                })
                .collect();
            return (failed, None);
        }
    };
    let polled = numbers
        .iter()
        .map(|&number| GithubPolledPr {
            number,
            result: match batch.pull_requests.remove(&u64::from(number)) {
                Some(Ok(checks)) => polled_pr(repo, checks),
                Some(Err(err)) => GithubPolledPrResult::Failed {
                    failure: err.into(),
                },
                None => GithubPolledPrResult::Failed {
                    failure: GithubFailure::other(format!(
                        "GitHub returned nothing for PR #{number}"
                    )),
                },
            },
        })
        .collect();
    (polled, batch.rate_limit)
}

async fn poll_remote<L: PrLookup>(
    mut request: GithubPrPollRequest,
    lookup: &L,
) -> (GithubRemotePoll, Option<RateLimitStatus>) {
    request.branches.sort();
    request.branches.dedup();
    request.numbers.sort_unstable();
    request.numbers.dedup();
    let repo = match repo_ref(&request) {
        Ok(repo) => repo,
        Err(failure) => {
            let pull_requests = request
                .numbers
                .iter()
                .map(|&number| GithubPolledPr {
                    number,
                    result: GithubPolledPrResult::Failed {
                        failure: failure.clone(),
                    },
                })
                .collect();
            let open_prs = if request.branches.is_empty() {
                GithubOpenPrsPoll::NotRequested
            } else {
                failed_open_prs(failure)
            };
            return (
                GithubRemotePoll {
                    host: request.host,
                    repo: request.repo,
                    open_prs,
                    pull_requests,
                },
                None,
            );
        }
    };
    let ((open_prs, listed), (pull_requests, read)) = futures::future::join(
        open_prs_of_branches(&repo, &request.branches, lookup),
        pull_requests(&repo, &request.numbers, lookup),
    )
    .await;
    (
        GithubRemotePoll {
            host: request.host,
            repo: request.repo,
            open_prs,
            pull_requests,
        },
        RateLimitStatus::tightest(listed, read),
    )
}

/// Reads every remote concurrently. A failure is reported where it happened
/// (a remote's listing, one PR, or the whole checks read) and never hides
/// the other answers.
pub(super) async fn poll<L: PrLookup>(
    requests: Vec<GithubPrPollRequest>,
    lookup: &L,
) -> GithubPrPollBatch {
    let polled = futures::future::join_all(
        requests
            .into_iter()
            .map(|request| poll_remote(request, lookup)),
    )
    .await;
    let mut rate_limit = None;
    let mut remotes = Vec::with_capacity(polled.len());
    for (remote, limit) in polled {
        rate_limit = RateLimitStatus::tightest(rate_limit, limit);
        remotes.push(remote);
    }
    GithubPrPollBatch {
        remotes,
        hold_off_secs: hold_off_secs(rate_limit),
    }
}

/// The current state of one check, re-read from GitHub before any write.
async fn current_check<L: PrLookup>(
    repo: &RepoRef,
    pr_number: u32,
    check_id: &str,
    lookup: &L,
) -> Result<PullRequestCheck, GithubFailure> {
    let number = u64::from(pr_number);
    let checks = lookup
        .checks(repo, &[number])
        .await?
        .pull_requests
        .remove(&number)
        .unwrap_or_else(|| {
            Err(GitHubError::NotFound {
                message: format!("Pull request #{number} not found"),
            })
        })?;
    checks
        .checks
        .into_iter()
        .find(|check| check.id == check_id)
        .ok_or_else(|| {
            GithubFailure::other(format!(
                "That check is no longer on PR #{number}; refresh to see the latest"
            ))
        })
}

/// Re-runs a check only after re-reading the PR's checks and confirming the
/// check is a failed Actions job the viewer may re-run. The request is sent
/// once; a lost response is reported, never retried here.
pub(super) async fn rerun_check<L: PrLookup>(
    repo: &RepoRef,
    pr_number: u32,
    check_id: &str,
    lookup: &L,
) -> Result<(), GithubFailure> {
    let check = current_check(repo, pr_number, check_id, lookup).await?;
    let refusal = match (check.rerun, check.actions_job_id) {
        (CheckRerun::Allowed, Some(job_id)) => {
            return lookup
                .rerun_job(repo, job_id)
                .await
                .map_err(GithubFailure::from)
        }
        (CheckRerun::Allowed, None) => "GitHub did not report a job for this check",
        (CheckRerun::NoPermission, _) => "Re-running jobs needs write access to the repository",
        (CheckRerun::PullRequestClosed, _) => "Jobs can only be re-run on an open pull request",
        (CheckRerun::RunInProgress, _) => {
            "Jobs can be re-run once the rest of their workflow run has finished"
        }
        (CheckRerun::Provider, _) => "This check re-runs from its provider, not GitHub Actions",
        (CheckRerun::NotApplicable, _) => "Only failed jobs can be re-run",
    };
    Err(GithubFailure::other(refusal))
}

/// Cancels the workflow run of a queued or running Actions job, after the
/// same re-read as [`rerun_check`]. Sent once.
pub(super) async fn cancel_check<L: PrLookup>(
    repo: &RepoRef,
    pr_number: u32,
    check_id: &str,
    lookup: &L,
) -> Result<(), GithubFailure> {
    let check = current_check(repo, pr_number, check_id, lookup).await?;
    let refusal = match (check.cancel, check.actions_run_id) {
        (CheckCancel::Allowed, Some(run_id)) => {
            return lookup
                .cancel_run(repo, run_id)
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
