//! Pull request checks: GitHub check runs and commit statuses for the PR's
//! head commit, normalized into one list, plus re-running GitHub Actions jobs.

use crate::{
    error::bounded_message,
    rest::{RateLimitStatus, RestResponse},
    wire::{
        RestCheckRun, RestCheckRunsPage, RestCombinedStatus, RestCommitStatus, RestJob,
        RestPullRequest, RestRepository,
    },
    GitHubClient, GitHubError, GitHubToken, PullRequestState, RepoRef,
};

const PAGE_SIZE: &str = "100";
/// Failed Actions jobs whose failing step is looked up per refresh. Completed
/// jobs never change, so repeat lookups are answered with `304`.
const MAX_FAILED_STEP_LOOKUPS: usize = 8;
const GITHUB_ACTIONS_SLUG: &str = "github-actions";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CheckStatus {
    Failed,
    Running,
    Queued,
    Passed,
}

/// How a completed check ended, kept distinct from the four display buckets
/// so a cancelled or skipped check is never described as failed or passed
/// without saying so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckOutcome {
    Success,
    Neutral,
    Skipped,
    Failure,
    Cancelled,
    TimedOut,
    ActionRequired,
    StartupFailure,
    Stale,
    /// A commit status reported `error`.
    Error,
}

impl CheckOutcome {
    fn status(self) -> CheckStatus {
        match self {
            Self::Success | Self::Neutral | Self::Skipped => CheckStatus::Passed,
            Self::Failure
            | Self::Cancelled
            | Self::TimedOut
            | Self::ActionRequired
            | Self::StartupFailure
            | Self::Stale
            | Self::Error => CheckStatus::Failed,
        }
    }

    fn parse_conclusion(raw: &str) -> Option<Self> {
        Some(match raw {
            "success" => Self::Success,
            "neutral" => Self::Neutral,
            "skipped" => Self::Skipped,
            "failure" => Self::Failure,
            "cancelled" => Self::Cancelled,
            "timed_out" => Self::TimedOut,
            "action_required" => Self::ActionRequired,
            "startup_failure" => Self::StartupFailure,
            "stale" => Self::Stale,
            _ => return None,
        })
    }
}

/// Whether the check can be re-run from Vertebrae, and why not otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckRerun {
    /// A failed GitHub Actions job the viewer may re-run.
    Allowed,
    /// A failed Actions job, but the viewer lacks write access.
    NoPermission,
    /// A failed Actions job on a merged or closed pull request.
    PullRequestClosed,
    /// A failed check from another provider; it re-runs there.
    Provider,
    /// The check has not failed.
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestCheck {
    /// Unique within one snapshot: `run:<check run id>` or `status:<context>`.
    /// A re-run attempt gets a new check run, hence a new id.
    pub id: String,
    pub name: String,
    /// The app or service that reported the check ("GitHub Actions",
    /// "Buildkite", or the commit status context's provider).
    pub provider: String,
    pub status: CheckStatus,
    pub outcome: Option<CheckOutcome>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// The check's page: GitHub's job page for Actions, the provider's page
    /// for other apps and commit statuses.
    pub url: Option<String>,
    /// The provider's one-line result (check output title or status
    /// description), bounded.
    pub summary: Option<String>,
    /// For failed Actions jobs: the first step that failed.
    pub failed_step: Option<String>,
    /// Set for GitHub Actions jobs, whose check run id is the job id.
    pub actions_job_id: Option<u64>,
    pub rerun: CheckRerun,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestChecks {
    pub number: u64,
    pub state: PullRequestState,
    pub head_sha: String,
    pub viewer_can_rerun: bool,
    /// Sorted failed, running, queued, passed, then by name.
    pub checks: Vec<PullRequestCheck>,
    /// GitHub reported more check runs or statuses than one page holds.
    pub truncated: bool,
    pub rate_limit: Option<RateLimitStatus>,
}

impl PullRequestChecks {
    pub fn has_pending(&self) -> bool {
        self.checks
            .iter()
            .any(|check| matches!(check.status, CheckStatus::Running | CheckStatus::Queued))
    }
}

fn pr_state(pr: &RestPullRequest) -> PullRequestState {
    if pr.merged_at.is_some() {
        PullRequestState::Merged
    } else if pr.state == "closed" {
        PullRequestState::Closed
    } else if pr.draft.unwrap_or(false) {
        PullRequestState::Draft
    } else {
        PullRequestState::Open
    }
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.map(|text| bounded_message(&text))
        .filter(|text| !text.is_empty())
}

struct RerunPolicy {
    viewer_can_rerun: bool,
    pr_open: bool,
}

impl RerunPolicy {
    fn for_check(&self, is_actions: bool, status: CheckStatus) -> CheckRerun {
        match (status, is_actions) {
            (CheckStatus::Failed, false) => CheckRerun::Provider,
            (CheckStatus::Failed, true) if !self.pr_open => CheckRerun::PullRequestClosed,
            (CheckStatus::Failed, true) if !self.viewer_can_rerun => CheckRerun::NoPermission,
            (CheckStatus::Failed, true) => CheckRerun::Allowed,
            _ => CheckRerun::NotApplicable,
        }
    }
}

fn check_from_run(
    run: RestCheckRun,
    policy: &RerunPolicy,
) -> Result<PullRequestCheck, GitHubError> {
    let outcome = match run.status.as_str() {
        "completed" => {
            let raw = run.conclusion.as_deref().unwrap_or("");
            Some(
                CheckOutcome::parse_conclusion(raw).ok_or_else(|| GitHubError::Decode {
                    message: format!(
                        "Unknown conclusion {} for check {}",
                        bounded_message(raw),
                        run.id
                    ),
                })?,
            )
        }
        _ => None,
    };
    let status = match (run.status.as_str(), outcome) {
        (_, Some(outcome)) => outcome.status(),
        ("in_progress", None) => CheckStatus::Running,
        // queued, requested, waiting, pending
        _ => CheckStatus::Queued,
    };
    let is_actions =
        run.app.as_ref().and_then(|app| app.slug.as_deref()) == Some(GITHUB_ACTIONS_SLUG);
    let rerun = policy.for_check(is_actions, status);
    let provider = run
        .app
        .as_ref()
        .map(|app| app.name.clone())
        .unwrap_or_else(|| "GitHub".into());
    // Actions jobs live on GitHub; other apps link to their own page.
    let url = if is_actions {
        run.html_url.or(run.details_url)
    } else {
        run.details_url.or(run.html_url)
    };
    Ok(PullRequestCheck {
        id: format!("run:{}", run.id),
        name: run.name,
        provider,
        status,
        outcome,
        started_at: run.started_at,
        completed_at: run.completed_at,
        url,
        summary: non_empty(run.output.and_then(|output| output.title)),
        failed_step: None,
        actions_job_id: is_actions.then_some(run.id),
        rerun,
    })
}

fn check_from_status(status: RestCommitStatus) -> Result<PullRequestCheck, GitHubError> {
    let (bucket, outcome) = match status.state.as_str() {
        "success" => (CheckStatus::Passed, Some(CheckOutcome::Success)),
        "failure" => (CheckStatus::Failed, Some(CheckOutcome::Failure)),
        "error" => (CheckStatus::Failed, Some(CheckOutcome::Error)),
        // Commit statuses cannot say whether a pending context has started.
        "pending" => (CheckStatus::Running, None),
        unknown => {
            return Err(GitHubError::Decode {
                message: format!(
                    "Unknown state {} for status {}",
                    bounded_message(unknown),
                    bounded_message(&status.context)
                ),
            })
        }
    };
    let rerun = if bucket == CheckStatus::Failed {
        CheckRerun::Provider
    } else {
        CheckRerun::NotApplicable
    };
    Ok(PullRequestCheck {
        id: format!("status:{}", status.context),
        provider: status.context.split_once('/').map_or_else(
            || status.context.clone(),
            |(provider, _)| provider.to_string(),
        ),
        name: status.context,
        status: bucket,
        outcome,
        started_at: status.created_at,
        completed_at: outcome.and(status.updated_at),
        url: status.target_url.filter(|url| !url.is_empty()),
        summary: non_empty(status.description),
        failed_step: None,
        actions_job_id: None,
        rerun,
    })
}

fn first_failed_step(job: RestJob) -> Option<String> {
    job.steps?
        .into_iter()
        .find(|step| {
            step.conclusion
                .as_deref()
                .and_then(CheckOutcome::parse_conclusion)
                .is_some_and(|outcome| outcome.status() == CheckStatus::Failed)
        })
        .map(|step| bounded_message(&step.name))
}

impl GitHubClient {
    /// Every check reported for the pull request's current head commit. Each
    /// request is conditional, so an unchanged PR costs no rate limit.
    pub async fn pull_request_checks(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestChecks, GitHubError> {
        if number == 0 {
            return Err(GitHubError::InvalidInput {
                message: "Pull request number must be greater than zero".into(),
            });
        }
        let number_segment = number.to_string();
        let base = ["repos", repo.owner.as_str(), repo.repo.as_str()];

        let pr: RestResponse<RestPullRequest> = self
            .rest_get(
                token,
                &[&base[..], &["pulls", &number_segment]].concat(),
                &[],
            )
            .await?;
        let head_sha = pr.data.head.sha.clone();
        let commit = [&base[..], &["commits", head_sha.as_str()]].concat();
        let runs_path = [&commit[..], &["check-runs"]].concat();
        let status_path = [&commit[..], &["status"]].concat();
        let page = [("per_page", PAGE_SIZE)];

        let (repository, runs, statuses) = tokio::try_join!(
            self.rest_get::<RestRepository>(token, &base, &[]),
            self.rest_get::<RestCheckRunsPage>(token, &runs_path, &page),
            self.rest_get::<RestCombinedStatus>(token, &status_path, &page),
        )?;

        let state = pr_state(&pr.data);
        let viewer_can_rerun = repository
            .data
            .permissions
            .is_some_and(|permissions| permissions.can_write());
        let policy = RerunPolicy {
            viewer_can_rerun,
            pr_open: matches!(state, PullRequestState::Open | PullRequestState::Draft),
        };

        let truncated = runs.data.total_count > runs.data.check_runs.len() as u64
            || statuses.data.total_count > statuses.data.statuses.len() as u64;
        let mut checks = runs
            .data
            .check_runs
            .into_iter()
            .map(|run| check_from_run(run, &policy))
            .chain(statuses.data.statuses.into_iter().map(check_from_status))
            .collect::<Result<Vec<_>, _>>()?;

        let mut rate_limit = [pr.rate_limit, repository.rate_limit, runs.rate_limit]
            .into_iter()
            .chain([statuses.rate_limit])
            .fold(None, RateLimitStatus::tightest);
        for (job_id, check) in checks
            .iter_mut()
            .filter(|check| check.status == CheckStatus::Failed)
            .filter_map(|check| Some((check.actions_job_id?.to_string(), check)))
            .take(MAX_FAILED_STEP_LOOKUPS)
        {
            let job_segments = [&base[..], &["actions", "jobs", job_id.as_str()]].concat();
            // The failing step is enrichment: a failed lookup leaves the
            // check's own summary in place rather than failing the refresh.
            if let Ok(job) = self.rest_get::<RestJob>(token, &job_segments, &[]).await {
                rate_limit = RateLimitStatus::tightest(rate_limit, job.rate_limit);
                check.failed_step = first_failed_step(job.data);
            }
        }

        checks.sort_by(|a, b| a.status.cmp(&b.status).then_with(|| a.name.cmp(&b.name)));
        Ok(PullRequestChecks {
            number,
            state,
            head_sha,
            viewer_can_rerun,
            checks,
            truncated,
            rate_limit,
        })
    }

    /// Asks GitHub Actions to re-run one job (and the jobs that depend on it).
    /// This writes to GitHub; it is not retried automatically, because a lost
    /// response does not prove the re-run was not queued.
    pub async fn rerun_actions_job(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        job_id: u64,
    ) -> Result<(), GitHubError> {
        let job = job_id.to_string();
        self.rest_post_empty(
            token,
            &[
                "repos",
                repo.owner.as_str(),
                repo.repo.as_str(),
                "actions",
                "jobs",
                job.as_str(),
                "rerun",
            ],
        )
        .await
    }
}

#[cfg(test)]
mod tests;
