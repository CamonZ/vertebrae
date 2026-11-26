use super::*;
use crate::commands::github::checks::{
    cancel_check, hold_off_secs, poll, published_head, rerun_check, LOW_RATE_LIMIT_REMAINING,
    OPEN_PR_PAGES,
};
use std::{collections::HashMap, sync::Mutex as TestMutex};
use vertebrae_github::{
    CheckCancel, CheckOutcome, CheckRerun, CheckStatus, OpenPrSearchResult, PullRequestCheck,
    PullRequestChecks, PullRequestChecksBatch, RateLimitStatus, RepoRef,
};

fn check(id: &str, status: CheckStatus, job: Option<u64>) -> PullRequestCheck {
    let failed = status == CheckStatus::Failed;
    let pending = matches!(status, CheckStatus::Running | CheckStatus::Queued);
    PullRequestCheck {
        id: id.into(),
        name: format!("check {id}"),
        provider: "GitHub Actions".into(),
        status,
        outcome: failed.then_some(CheckOutcome::Failure),
        started_at: None,
        completed_at: None,
        url: None,
        summary: None,
        failed_step: None,
        actions_job_id: job,
        actions_run_id: job.map(|_| 900),
        rerun: if failed {
            CheckRerun::Allowed
        } else {
            CheckRerun::NotApplicable
        },
        cancel: if pending {
            CheckCancel::Allowed
        } else {
            CheckCancel::NotApplicable
        },
    }
}

fn snapshot(number: u64, checks: Vec<PullRequestCheck>) -> PullRequestChecks {
    PullRequestChecks {
        pull_request: summary(number, "feature/retry", Some("example/demo-repo")),
        head_sha: "abc123".into(),
        viewer_can_write: true,
        checks,
        truncated: false,
    }
}

fn batch(
    entries: Vec<(u64, Result<PullRequestChecks, GitHubError>)>,
    rate_limit: Option<RateLimitStatus>,
) -> PullRequestChecksBatch {
    PullRequestChecksBatch {
        pull_requests: entries.into_iter().collect::<HashMap<_, _>>(),
        rate_limit,
    }
}

fn demo() -> RepoRef {
    RepoRef::new("github.com", "example", "demo-repo")
}

fn listing(prs: Vec<PullRequestSummary>, has_more: bool) -> OpenPrSearchResult {
    OpenPrSearchResult {
        prs,
        has_more,
        rate_limit: None,
    }
}

/// Answers keyed by `owner/name`; every call is recorded.
#[derive(Default)]
struct FakeLookup {
    open: HashMap<String, Result<OpenPrSearchResult, GitHubError>>,
    for_branch: HashMap<(String, String), Result<OpenPrSearchResult, GitHubError>>,
    checks: HashMap<String, Result<PullRequestChecksBatch, GitHubError>>,
    write_result: Option<Result<(), GitHubError>>,
    calls: TestMutex<Vec<String>>,
    reruns: TestMutex<Vec<u64>>,
    cancels: TestMutex<Vec<u64>>,
}

impl FakeLookup {
    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn calls(&self) -> Vec<String> {
        let mut calls = self.calls.lock().unwrap().clone();
        calls.sort();
        calls
    }
}

fn missing(what: String) -> GitHubError {
    GitHubError::NotFound { message: what }
}

impl PrLookup for FakeLookup {
    async fn open_prs(
        &self,
        repo: &RepoRef,
        max_pages: usize,
    ) -> Result<OpenPrSearchResult, GitHubError> {
        assert_eq!(max_pages, OPEN_PR_PAGES);
        self.record(format!("open {}", repo.full_name()));
        self.open
            .get(&repo.full_name())
            .cloned()
            .unwrap_or_else(|| Err(missing(repo.full_name())))
    }

    async fn open_prs_for_branch(
        &self,
        repo: &RepoRef,
        branch: &str,
    ) -> Result<OpenPrSearchResult, GitHubError> {
        self.record(format!("branch {} {branch}", repo.full_name()));
        self.for_branch
            .get(&(repo.full_name(), branch.to_owned()))
            .cloned()
            .unwrap_or_else(|| Err(missing(branch.to_owned())))
    }

    async fn pull_request(
        &self,
        repo: &RepoRef,
        number: u64,
    ) -> Result<PullRequestSummary, GitHubError> {
        self.record(format!("pr {} {number}", repo.full_name()));
        Err(missing(number.to_string()))
    }

    async fn checks(
        &self,
        repo: &RepoRef,
        numbers: &[u64],
    ) -> Result<PullRequestChecksBatch, GitHubError> {
        self.record(format!("checks {} {numbers:?}", repo.full_name()));
        self.checks
            .get(&repo.full_name())
            .cloned()
            .unwrap_or_else(|| Err(missing(repo.full_name())))
    }

    async fn rerun_job(&self, _repo: &RepoRef, job_id: u64) -> Result<(), GitHubError> {
        self.reruns.lock().unwrap().push(job_id);
        self.write_result.clone().unwrap_or(Ok(()))
    }

    async fn cancel_run(&self, _repo: &RepoRef, run_id: u64) -> Result<(), GitHubError> {
        self.cancels.lock().unwrap().push(run_id);
        self.write_result.clone().unwrap_or(Ok(()))
    }
}

/// Polling holds off exactly while fewer than the threshold requests are
/// left, for as long as the window has to reset, saturating at `u32::MAX`
/// rather than wrapping.
#[hegel::test]
fn polling_holds_off_exactly_while_the_budget_is_nearly_spent(tc: hegel::TestCase) {
    use hegel::generators as gs;

    let limit = tc
        .draw(gs::weighted_booleans(0.9))
        .then(|| RateLimitStatus {
            remaining: if tc.draw(gs::booleans()) {
                // Around the threshold.
                tc.draw(gs::integers::<u32>().max_value(LOW_RATE_LIMIT_REMAINING + 2))
            } else {
                tc.draw(gs::integers::<u32>())
            },
            reset_in_secs: if tc.draw(gs::booleans()) {
                u64::from(u32::MAX) - 2 + tc.draw(gs::integers::<u64>().max_value(4))
            } else {
                tc.draw(gs::integers::<u64>())
            },
        });
    tc.note(&format!("{limit:?}"));
    let expected = match limit {
        Some(limit) if limit.remaining < LOW_RATE_LIMIT_REMAINING => {
            Some(u32::try_from(limit.reset_in_secs.min(u64::from(u32::MAX))).unwrap())
        }
        _ => None,
    };
    assert_eq!(hold_off_secs(limit), expected);
}

#[tokio::test]
async fn rerun_and_cancel_post_only_for_currently_allowed_actions_jobs() {
    let mut no_permission = check("run:12", CheckStatus::Failed, Some(12));
    no_permission.rerun = CheckRerun::NoPermission;
    let mut closed = check("run:13", CheckStatus::Failed, Some(13));
    closed.rerun = CheckRerun::PullRequestClosed;
    let mut provider = check("status:ci", CheckStatus::Failed, None);
    provider.rerun = CheckRerun::Provider;
    let mut run_going = check("run:17", CheckStatus::Failed, Some(17));
    run_going.rerun = CheckRerun::RunInProgress;
    let mut cannot_cancel = check("run:16", CheckStatus::Running, Some(16));
    cannot_cancel.cancel = CheckCancel::NoPermission;
    let mut lookup = FakeLookup::default();
    lookup.checks.insert(
        "example/demo-repo".into(),
        Ok(batch(
            vec![(
                7,
                Ok(snapshot(
                    7,
                    vec![
                        check("run:11", CheckStatus::Failed, Some(11)),
                        no_permission,
                        closed,
                        provider,
                        run_going,
                        check("run:14", CheckStatus::Passed, Some(14)),
                        check("run:15", CheckStatus::Queued, Some(15)),
                        cannot_cancel,
                    ],
                )),
            )],
            None,
        )),
    );

    rerun_check(&demo(), 7, "run:11", &lookup).await.unwrap();
    for (id, reason) in [
        ("run:12", "write access"),
        ("run:13", "open pull request"),
        ("status:ci", "provider"),
        ("run:17", "rest of their workflow run has finished"),
        ("run:14", "Only failed jobs"),
        ("run:999", "no longer on PR #7"),
    ] {
        let failure = rerun_check(&demo(), 7, id, &lookup).await.unwrap_err();
        assert!(
            failure.message.contains(reason),
            "{id}: {}",
            failure.message
        );
    }
    assert_eq!(*lookup.reruns.lock().unwrap(), vec![11]);
    assert!(rerun_check(&demo(), 8, "run:11", &lookup)
        .await
        .unwrap_err()
        .message
        .contains("#8 not found"));

    cancel_check(&demo(), 7, "run:15", &lookup).await.unwrap();
    for (id, reason) in [
        ("run:16", "write access"),
        ("run:14", "already finished"),
        ("run:999", "no longer on PR #7"),
    ] {
        let failure = cancel_check(&demo(), 7, id, &lookup).await.unwrap_err();
        assert!(
            failure.message.contains(reason),
            "{id}: {}",
            failure.message
        );
    }
    assert_eq!(*lookup.cancels.lock().unwrap(), vec![900]);
}

#[tokio::test]
async fn a_refused_write_is_reported_once() {
    let mut lookup = FakeLookup {
        write_result: Some(Err(GitHubError::Network {
            message: "GitHub request timed out".into(),
        })),
        ..FakeLookup::default()
    };
    lookup.checks.insert(
        "example/demo-repo".into(),
        Ok(batch(
            vec![(
                7,
                Ok(snapshot(
                    7,
                    vec![
                        check("run:11", CheckStatus::Failed, Some(11)),
                        check("run:12", CheckStatus::Running, Some(12)),
                    ],
                )),
            )],
            None,
        )),
    );
    let failure = rerun_check(&demo(), 7, "run:11", &lookup)
        .await
        .unwrap_err();
    assert!(failure.message.contains("timed out"));
    let failure = cancel_check(&demo(), 7, "run:12", &lookup)
        .await
        .unwrap_err();
    assert!(failure.message.contains("timed out"));
    assert_eq!(lookup.reruns.lock().unwrap().len(), 1);
    assert_eq!(lookup.cancels.lock().unwrap().len(), 1);
}

#[test]
fn published_head_reads_the_push_remote_tracking_ref() {
    let worktree = tempfile::tempdir().unwrap();
    let repo = init_repo(worktree.path(), "feature/retry", &[ORIGIN]);
    assert_eq!(published_head(worktree.path(), "feature/retry"), None);

    let head = repo.head().unwrap().peel_to_commit().unwrap().id();
    repo.reference(
        "refs/remotes/origin/feature/retry",
        head,
        true,
        "synthetic push",
    )
    .unwrap();
    assert_eq!(
        published_head(worktree.path(), "feature/retry"),
        Some(head.to_string())
    );

    let plain = tempfile::tempdir().unwrap();
    assert_eq!(published_head(plain.path(), "feature/retry"), None);
}

fn request(repo: &str, branches: &[&str], numbers: &[u32]) -> GithubPrPollRequest {
    GithubPrPollRequest {
        host: "github.com".into(),
        repo: repo.into(),
        branches: branches.iter().map(|branch| branch.to_string()).collect(),
        numbers: numbers.to_vec(),
    }
}

#[tokio::test]
async fn a_remote_without_branches_or_numbers_never_queries_github() {
    let lookup = FakeLookup::default();
    let polled = poll(vec![request("example/demo-repo", &[], &[])], &lookup).await;
    assert_eq!(lookup.calls(), Vec::<String>::new());
    assert_eq!(polled.remotes[0].open_prs, GithubOpenPrsPoll::NotRequested);
    assert!(polled.remotes[0].pull_requests.is_empty());
}

mod poll_oracle;
