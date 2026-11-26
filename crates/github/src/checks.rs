//! Pull request checks over GraphQL: one query per repository returns every
//! requested PR with its head commit's check runs and commit statuses, so a
//! refresh of many worktrees costs one request per repository. Re-running a
//! job and cancelling a workflow run are REST writes.

use crate::{
    client::map_graphql_errors,
    error::bounded_message,
    rate_limit::RateLimitStatus,
    wire::{
        CheckContext, CheckRunSteps, CheckStepsQueryData, ChecksPullRequestNode, ChecksQueryData,
        GraphQlCheckRun, GraphQlError, GraphQlStatusContext,
    },
    GitHubClient, GitHubError, GitHubToken, PullRequestState, PullRequestSummary, RepoRef,
};
use serde_json::json;
use std::collections::HashMap;

/// Contexts read per pull request; more are reported as `truncated`.
const CONTEXTS_PER_PR: u32 = 100;
/// Pull requests per query, bounding response size and query cost.
pub const PULL_REQUESTS_PER_QUERY: usize = 10;
/// Step lookups per refresh; later refreshes pick up the rest from the cache.
const MAX_FAILED_STEP_LOOKUPS: usize = 20;
const GITHUB_ACTIONS_SLUG: &str = "github-actions";

const CHECK_STEPS_QUERY: &str = r#"
query CheckRunSteps($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on CheckRun {
      databaseId
      steps(first: 100) { nodes { name conclusion } }
    }
  }
}
"#;

/// The query for a set of pull requests in one repository. Numbers are
/// integers, so interpolating them as aliases and arguments is safe.
fn checks_query(numbers: &[u64]) -> String {
    let pulls: String = numbers
        .iter()
        .map(|number| format!("    pr{number}: pullRequest(number: {number}) {{ ...PrChecks }}\n"))
        .collect();
    format!(
        r#"query PullRequestChecks($owner: String!, $repo: String!) {{
  repository(owner: $owner, name: $repo) {{
    viewerPermission
{pulls}  }}
}}

fragment PrChecks on PullRequest {{
  number
  title
  state
  isDraft
  headRefName
  headRepository {{ nameWithOwner }}
  baseRefName
  url
  author {{ login }}
  updatedAt
  headRefOid
  commits(last: 1) {{
    nodes {{
      commit {{
        statusCheckRollup {{
          contexts(first: {CONTEXTS_PER_PR}) {{
            totalCount
            nodes {{
              __typename
              ... on CheckRun {{
                id
                databaseId
                name
                status
                conclusion
                startedAt
                completedAt
                url
                detailsUrl
                title
                checkSuite {{
                  app {{ name slug }}
                  workflowRun {{ databaseId }}
                }}
              }}
              ... on StatusContext {{
                context
                state
                description
                targetUrl
                createdAt
              }}
            }}
          }}
        }}
      }}
    }}
  }}
}}
"#
    )
}

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
    /// A commit status reported `ERROR`.
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
            "SUCCESS" => Self::Success,
            "NEUTRAL" => Self::Neutral,
            "SKIPPED" => Self::Skipped,
            "FAILURE" => Self::Failure,
            "CANCELLED" => Self::Cancelled,
            "TIMED_OUT" => Self::TimedOut,
            "ACTION_REQUIRED" => Self::ActionRequired,
            "STARTUP_FAILURE" => Self::StartupFailure,
            "STALE" => Self::Stale,
            _ => return None,
        })
    }
}

/// Whether a failed check can be re-run from Vertebrae, and why not otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckRerun {
    /// A failed GitHub Actions job the viewer may re-run.
    Allowed,
    /// A failed Actions job, but the viewer lacks write access.
    NoPermission,
    /// A failed Actions job on a merged or closed pull request.
    PullRequestClosed,
    /// A failed Actions job whose workflow run still has jobs queued or
    /// running; GitHub accepts a job re-run only once the run has finished.
    RunInProgress,
    /// A failed check from another provider; it re-runs there.
    Provider,
    /// The check has not failed.
    NotApplicable,
}

/// Whether a queued or running check can be cancelled from Vertebrae. GitHub
/// cancels whole workflow runs, never a single job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckCancel {
    /// A pending Actions job whose workflow run the viewer may cancel.
    Allowed,
    /// A pending Actions job, but the viewer lacks write access.
    NoPermission,
    /// A pending check from another provider; it is cancelled there.
    Provider,
    /// The check is not pending.
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
    /// The check's page: the job on GitHub for Actions, the provider's page
    /// for other apps and commit statuses.
    pub url: Option<String>,
    /// The provider's one-line result (check title or status description),
    /// bounded.
    pub summary: Option<String>,
    /// For failed Actions jobs: the first step that failed.
    pub failed_step: Option<String>,
    /// Set for GitHub Actions jobs, whose check run id is the job id.
    pub actions_job_id: Option<u64>,
    /// The Actions workflow run the job belongs to.
    pub actions_run_id: Option<u64>,
    pub rerun: CheckRerun,
    pub cancel: CheckCancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestChecks {
    pub pull_request: PullRequestSummary,
    pub head_sha: String,
    /// The viewer may re-run and cancel Actions jobs (write access or above).
    pub viewer_can_write: bool,
    /// Sorted failed, running, queued, passed, then by name.
    pub checks: Vec<PullRequestCheck>,
    /// GitHub reported more checks than one query reads.
    pub truncated: bool,
}

impl PullRequestChecks {
    pub fn has_pending(&self) -> bool {
        self.checks
            .iter()
            .any(|check| matches!(check.status, CheckStatus::Running | CheckStatus::Queued))
    }
}

/// The answer for several pull requests of one repository. A missing pull
/// request fails alone; failures of the whole request are returned as `Err`
/// by [`GitHubClient::pull_requests_checks`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestChecksBatch {
    pub pull_requests: HashMap<u64, Result<PullRequestChecks, GitHubError>>,
    pub rate_limit: Option<RateLimitStatus>,
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.map(|text| bounded_message(&text))
        .filter(|text| !text.is_empty())
}

struct Policy {
    viewer_can_write: bool,
    pr_open: bool,
}

impl Policy {
    fn rerun(&self, is_actions: bool, status: CheckStatus) -> CheckRerun {
        match (status, is_actions) {
            (CheckStatus::Failed, false) => CheckRerun::Provider,
            (CheckStatus::Failed, true) if !self.pr_open => CheckRerun::PullRequestClosed,
            (CheckStatus::Failed, true) if !self.viewer_can_write => CheckRerun::NoPermission,
            (CheckStatus::Failed, true) => CheckRerun::Allowed,
            _ => CheckRerun::NotApplicable,
        }
    }

    fn cancel(&self, actions_run: bool, status: CheckStatus) -> CheckCancel {
        match (status, actions_run) {
            (CheckStatus::Running | CheckStatus::Queued, false) => CheckCancel::Provider,
            (CheckStatus::Running | CheckStatus::Queued, true) if !self.viewer_can_write => {
                CheckCancel::NoPermission
            }
            (CheckStatus::Running | CheckStatus::Queued, true) => CheckCancel::Allowed,
            _ => CheckCancel::NotApplicable,
        }
    }
}

fn check_from_run(run: GraphQlCheckRun, policy: &Policy) -> Result<PullRequestCheck, GitHubError> {
    let outcome = match run.status.as_str() {
        "COMPLETED" => {
            let raw = run.conclusion.as_deref().unwrap_or("");
            Some(
                CheckOutcome::parse_conclusion(raw).ok_or_else(|| GitHubError::Decode {
                    message: format!(
                        "Unknown conclusion {} for check {}",
                        bounded_message(raw),
                        run.database_id
                    ),
                })?,
            )
        }
        _ => None,
    };
    let status = match (run.status.as_str(), outcome) {
        (_, Some(outcome)) => outcome.status(),
        ("IN_PROGRESS", None) => CheckStatus::Running,
        // QUEUED, REQUESTED, WAITING, PENDING
        _ => CheckStatus::Queued,
    };
    let suite = run.check_suite.as_ref();
    let app = suite.and_then(|suite| suite.app.as_ref());
    let is_actions = app.and_then(|app| app.slug.as_deref()) == Some(GITHUB_ACTIONS_SLUG);
    let run_id = is_actions
        .then(|| suite.and_then(|suite| suite.workflow_run.as_ref()))
        .flatten()
        .map(|run| run.database_id);
    // Actions jobs live on GitHub; other apps link to their own page.
    let url = if is_actions {
        run.url.or(run.details_url)
    } else {
        run.details_url.or(run.url)
    };
    Ok(PullRequestCheck {
        id: format!("run:{}", run.database_id),
        provider: app.map_or_else(|| "GitHub".into(), |app| app.name.clone()),
        name: run.name,
        status,
        outcome,
        started_at: run.started_at,
        completed_at: run.completed_at,
        url,
        summary: non_empty(run.title),
        failed_step: None,
        actions_job_id: is_actions.then_some(run.database_id),
        actions_run_id: run_id,
        rerun: policy.rerun(is_actions, status),
        cancel: policy.cancel(run_id.is_some(), status),
    })
}

fn check_from_status(
    status: GraphQlStatusContext,
    policy: &Policy,
) -> Result<PullRequestCheck, GitHubError> {
    let (bucket, outcome) = match status.state.as_str() {
        "SUCCESS" => (CheckStatus::Passed, Some(CheckOutcome::Success)),
        "FAILURE" => (CheckStatus::Failed, Some(CheckOutcome::Failure)),
        "ERROR" => (CheckStatus::Failed, Some(CheckOutcome::Error)),
        // Commit statuses cannot say whether a pending context has started.
        "PENDING" => (CheckStatus::Running, None),
        // Required by branch protection but not reported yet.
        "EXPECTED" => (CheckStatus::Queued, None),
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
    // A status is a point-in-time report: when it is final, that is its end.
    let (started_at, completed_at) = if outcome.is_some() {
        (None, status.created_at)
    } else {
        (status.created_at, None)
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
        started_at,
        completed_at,
        url: status.target_url.filter(|url| !url.is_empty()),
        summary: non_empty(status.description),
        failed_step: None,
        actions_job_id: None,
        actions_run_id: None,
        rerun: policy.rerun(false, bucket),
        cancel: policy.cancel(false, bucket),
    })
}

fn can_write(permission: Option<&str>) -> bool {
    matches!(permission, Some("ADMIN" | "MAINTAIN" | "WRITE"))
}

/// Normalizes one pull request; failed Actions runs come back with their
/// node ids so the caller can look up the failing step.
fn checks_from_node(
    node: ChecksPullRequestNode,
    viewer_can_write: bool,
) -> Result<(PullRequestChecks, Vec<(u64, String)>), GitHubError> {
    let pull_request = PullRequestSummary::try_from(node.summary)?;
    let policy = Policy {
        viewer_can_write,
        pr_open: matches!(
            pull_request.state,
            PullRequestState::Open | PullRequestState::Draft
        ),
    };
    let contexts = node
        .commits
        .nodes
        .into_iter()
        .flatten()
        .next_back()
        .and_then(|commit| commit.commit.status_check_rollup)
        .map(|rollup| rollup.contexts);
    let truncated = contexts
        .as_ref()
        .is_some_and(|contexts| contexts.total_count > contexts.nodes.len() as u64);

    let mut failed_runs = Vec::new();
    let mut checks = Vec::new();
    for context in contexts.into_iter().flat_map(|c| c.nodes).flatten() {
        let check = match context {
            CheckContext::CheckRun(run) => {
                let node_id = run.id.clone();
                let check = check_from_run(run, &policy)?;
                if check.status == CheckStatus::Failed {
                    if let Some(job_id) = check.actions_job_id {
                        failed_runs.push((job_id, node_id));
                    }
                }
                check
            }
            CheckContext::StatusContext(status) => check_from_status(status, &policy)?,
        };
        checks.push(check);
    }
    hold_reruns_until_runs_finish(&mut checks);
    checks.sort_by(|a, b| a.status.cmp(&b.status).then_with(|| a.name.cmp(&b.name)));
    Ok((
        PullRequestChecks {
            pull_request,
            head_sha: node.head_ref_oid,
            viewer_can_write,
            checks,
            truncated,
        },
        failed_runs,
    ))
}

fn hold_reruns_until_runs_finish(checks: &mut [PullRequestCheck]) {
    let pending_runs: Vec<u64> = checks
        .iter()
        .filter(|check| matches!(check.status, CheckStatus::Running | CheckStatus::Queued))
        .filter_map(|check| check.actions_run_id)
        .collect();
    for check in checks {
        let run_pending = check
            .actions_run_id
            .is_some_and(|run| pending_runs.contains(&run));
        if check.rerun == CheckRerun::Allowed && run_pending {
            check.rerun = CheckRerun::RunInProgress;
        }
    }
}

fn first_failed_step(run: CheckRunSteps) -> Option<String> {
    run.steps
        .nodes
        .into_iter()
        .flatten()
        .find(|step| {
            step.conclusion
                .as_deref()
                .and_then(CheckOutcome::parse_conclusion)
                .is_some_and(|outcome| outcome.status() == CheckStatus::Failed)
        })
        .map(|step| bounded_message(&step.name))
}

/// The alias an error applies to, from a path like `["repository", "pr7"]`.
fn error_alias(error: &GraphQlError) -> Option<&str> {
    match error.path.as_slice() {
        [first, alias, ..] if first.as_str() == Some("repository") => alias.as_str(),
        _ => None,
    }
}

impl GitHubClient {
    /// Every check reported for the head commit of each pull request, in
    /// one GraphQL request per [`PULL_REQUESTS_PER_QUERY`] pull requests,
    /// plus at most one request for the failing steps of newly failed jobs.
    pub async fn pull_requests_checks(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        numbers: &[u64],
    ) -> Result<PullRequestChecksBatch, GitHubError> {
        if numbers.contains(&0) {
            return Err(GitHubError::InvalidInput {
                message: "Pull request number must be greater than zero".into(),
            });
        }
        let mut unique = numbers.to_vec();
        unique.sort_unstable();
        unique.dedup();

        let mut batch = PullRequestChecksBatch {
            pull_requests: HashMap::new(),
            rate_limit: None,
        };
        let mut failed_runs = Vec::new();
        for chunk in unique.chunks(PULL_REQUESTS_PER_QUERY) {
            let (envelope, rate_limit) = self
                .graphql_envelope::<ChecksQueryData>(
                    token,
                    &checks_query(chunk),
                    json!({ "owner": repo.owner, "repo": repo.repo }),
                )
                .await?;
            batch.rate_limit = RateLimitStatus::tightest(batch.rate_limit, rate_limit);

            let (alias_errors, request_errors): (Vec<_>, Vec<_>) = envelope
                .errors
                .into_iter()
                .partition(|error| error_alias(error).is_some());
            let Some(repository) = envelope.data.and_then(|data| data.repository) else {
                return Err(if request_errors.is_empty() {
                    GitHubError::NotFound {
                        message: format!("Repository {} not found", repo.full_name()),
                    }
                } else {
                    map_graphql_errors(request_errors)
                });
            };
            if !request_errors.is_empty() {
                return Err(map_graphql_errors(request_errors));
            }

            let viewer_can_write = can_write(repository.viewer_permission.as_deref());
            let mut nodes = repository.pull_requests;
            for &number in chunk {
                let alias = format!("pr{number}");
                let errors: Vec<_> = alias_errors
                    .iter()
                    .filter(|error| error_alias(error) == Some(alias.as_str()))
                    .cloned()
                    .collect();
                let result = match nodes.remove(&alias).flatten() {
                    // A partly resolved PR could show missing checks as none.
                    Some(_) if !errors.is_empty() => Err(map_graphql_errors(errors)),
                    Some(node) => checks_from_node(node, viewer_can_write).map(|(checks, runs)| {
                        failed_runs.extend(runs.into_iter().map(|run| (number, run)));
                        checks
                    }),
                    None if errors.is_empty() => Err(GitHubError::NotFound {
                        message: format!(
                            "Pull request #{number} not found in {}",
                            repo.full_name()
                        ),
                    }),
                    None => Err(map_graphql_errors(errors)),
                };
                batch.pull_requests.insert(number, result);
            }
        }

        self.fill_failed_steps(token, &mut batch, failed_runs).await;
        Ok(batch)
    }

    /// The checks of one pull request.
    pub async fn pull_request_checks(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestChecks, GitHubError> {
        let mut batch = self.pull_requests_checks(token, repo, &[number]).await?;
        batch.pull_requests.remove(&number).unwrap_or_else(|| {
            Err(GitHubError::NotFound {
                message: format!("Pull request #{number} not found in {}", repo.full_name()),
            })
        })
    }

    /// The failing step is enrichment: a failed lookup leaves the check's own
    /// summary in place rather than failing the refresh.
    async fn fill_failed_steps(
        &self,
        token: &GitHubToken,
        batch: &mut PullRequestChecksBatch,
        failed_runs: Vec<(u64, (u64, String))>,
    ) {
        let cache = &self.failed_steps;
        let missing: Vec<(u64, String)> = failed_runs
            .iter()
            .map(|(_, run)| run)
            .filter(|(job_id, _)| cache.get(*job_id).is_none())
            .take(MAX_FAILED_STEP_LOOKUPS)
            .cloned()
            .collect();
        if !missing.is_empty() {
            let ids: Vec<&str> = missing
                .iter()
                .map(|(_, node_id)| node_id.as_str())
                .collect();
            if let Ok((envelope, rate_limit)) = self
                .graphql_envelope::<CheckStepsQueryData>(
                    token,
                    CHECK_STEPS_QUERY,
                    json!({ "ids": ids }),
                )
                .await
            {
                batch.rate_limit = RateLimitStatus::tightest(batch.rate_limit, rate_limit);
                let mut answered: HashMap<u64, Option<String>> = envelope
                    .data
                    .into_iter()
                    .flat_map(|data| data.nodes)
                    .flatten()
                    .map(|run| (run.database_id, first_failed_step(run)))
                    .collect();
                // A run GitHub answered without steps is remembered as having
                // none, so later refreshes look up the runs after it. When the
                // answer carries errors a missing run may be transient, so only
                // the runs actually returned are remembered.
                let complete = envelope.errors.is_empty();
                for (job_id, _) in missing {
                    match answered.remove(&job_id) {
                        Some(step) => cache.insert(job_id, step),
                        None if complete => cache.insert(job_id, None),
                        None => {}
                    }
                }
            }
        }
        for (number, (job_id, _)) in failed_runs {
            let Some(step) = cache.get(job_id).flatten() else {
                continue;
            };
            if let Some(Ok(checks)) = batch.pull_requests.get_mut(&number) {
                if let Some(check) = checks
                    .checks
                    .iter_mut()
                    .find(|check| check.actions_job_id == Some(job_id))
                {
                    check.failed_step = Some(step);
                }
            }
        }
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

    /// Asks GitHub Actions to cancel a workflow run and every job in it.
    /// Not retried automatically, for the same reason as re-runs.
    pub async fn cancel_actions_run(
        &self,
        token: &GitHubToken,
        repo: &RepoRef,
        run_id: u64,
    ) -> Result<(), GitHubError> {
        let run = run_id.to_string();
        self.rest_post_empty(
            token,
            &[
                "repos",
                repo.owner.as_str(),
                repo.repo.as_str(),
                "actions",
                "runs",
                run.as_str(),
                "cancel",
            ],
        )
        .await
    }
}

#[cfg(test)]
mod tests;
