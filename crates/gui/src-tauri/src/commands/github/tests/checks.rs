use super::*;
use crate::commands::github::checks::{
    poll_after_secs, pr_checks, published_head, rerun_check, ChecksLookup,
};
use std::sync::Mutex as TestMutex;
use vertebrae_github::{
    CheckOutcome, CheckRerun, CheckStatus, PullRequestCheck, PullRequestChecks, RateLimitStatus,
};

fn check(id: &str, status: CheckStatus, rerun: CheckRerun, job: Option<u64>) -> PullRequestCheck {
    PullRequestCheck {
        id: id.into(),
        name: format!("check {id}"),
        provider: "GitHub Actions".into(),
        status,
        outcome: (status == CheckStatus::Failed).then_some(CheckOutcome::Failure),
        started_at: None,
        completed_at: None,
        url: None,
        summary: None,
        failed_step: None,
        actions_job_id: job,
        rerun,
    }
}

fn snapshot(number: u64, checks: Vec<PullRequestCheck>) -> PullRequestChecks {
    PullRequestChecks {
        number,
        state: PullRequestState::Open,
        head_sha: "abc123".into(),
        viewer_can_rerun: true,
        checks,
        truncated: false,
        rate_limit: None,
    }
}

#[derive(Default)]
struct FakeChecks {
    snapshot: Option<Result<PullRequestChecks, GitHubError>>,
    rerun_result: Option<Result<(), GitHubError>>,
    lookups: TestMutex<Vec<(String, u64)>>,
    reruns: TestMutex<Vec<(String, u64)>>,
}

impl ChecksLookup for FakeChecks {
    async fn checks(&self, repo: &RepoRef, number: u64) -> Result<PullRequestChecks, GitHubError> {
        self.lookups
            .lock()
            .unwrap()
            .push((repo.full_name(), number));
        self.snapshot.clone().expect("no snapshot configured")
    }

    async fn rerun_job(&self, repo: &RepoRef, job_id: u64) -> Result<(), GitHubError> {
        self.reruns.lock().unwrap().push((repo.full_name(), job_id));
        self.rerun_result.clone().unwrap_or(Ok(()))
    }
}

#[tokio::test]
async fn checks_use_the_stored_link_and_carry_poll_hints() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, stored_link("feature/retry", 7, NOW)).await;
    let lookup = FakeChecks {
        snapshot: Some(Ok(snapshot(
            7,
            vec![
                check("run:1", CheckStatus::Failed, CheckRerun::Allowed, Some(1)),
                check(
                    "run:2",
                    CheckStatus::Running,
                    CheckRerun::NotApplicable,
                    Some(2),
                ),
            ],
        ))),
        ..FakeChecks::default()
    };

    let checks = pr_checks(&fx.store, &fx.ctx, &lookup).await.unwrap();
    assert_eq!(checks.pr_number, 7);
    assert_eq!(checks.repo, "example/demo-repo");
    assert_eq!(checks.head_sha, "abc123");
    assert_eq!(checks.poll_after_secs, Some(15));
    assert_eq!(checks.checks[0].status, GithubCheckStatus::Failed);
    assert_eq!(checks.checks[0].rerun, GithubCheckRerun::Allowed);
    assert_eq!(
        *lookup.lookups.lock().unwrap(),
        vec![("example/demo-repo".to_string(), 7)]
    );
}

#[tokio::test]
async fn checks_without_a_linked_pr_are_not_found_and_never_query_github() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    let lookup = FakeChecks::default();
    let failure = pr_checks(&fx.store, &fx.ctx, &lookup).await.unwrap_err();
    assert_eq!(failure.kind, GithubErrorKind::NotFound);

    seed(&fx, StoredPrAssociation::Unlinked).await;
    let failure = pr_checks(&fx.store, &fx.ctx, &lookup).await.unwrap_err();
    assert_eq!(failure.kind, GithubErrorKind::NotFound);
    assert!(lookup.lookups.lock().unwrap().is_empty());
}

#[tokio::test]
async fn github_failures_keep_their_kind_and_retry_hint() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, stored_link("feature/retry", 7, NOW)).await;
    let lookup = FakeChecks {
        snapshot: Some(Err(GitHubError::RateLimited {
            retry_after_secs: Some(40),
            message: "API rate limit exceeded".into(),
        })),
        ..FakeChecks::default()
    };
    let failure = pr_checks(&fx.store, &fx.ctx, &lookup).await.unwrap_err();
    assert_eq!(failure.kind, GithubErrorKind::RateLimited);
    assert_eq!(failure.retry_after_secs, Some(40));
}

#[test]
fn polling_stops_when_checks_finish_and_backs_off_near_the_rate_limit() {
    let done = snapshot(
        7,
        vec![check(
            "run:1",
            CheckStatus::Passed,
            CheckRerun::NotApplicable,
            Some(1),
        )],
    );
    assert_eq!(poll_after_secs(&done), None);

    let mut pending = snapshot(
        7,
        vec![check(
            "run:1",
            CheckStatus::Queued,
            CheckRerun::NotApplicable,
            Some(1),
        )],
    );
    pending.rate_limit = Some(RateLimitStatus {
        remaining: 4000,
        reset_in_secs: 600,
    });
    assert_eq!(poll_after_secs(&pending), Some(15));

    pending.rate_limit = Some(RateLimitStatus {
        remaining: 10,
        reset_in_secs: 600,
    });
    assert_eq!(poll_after_secs(&pending), Some(600));

    pending.rate_limit = Some(RateLimitStatus {
        remaining: 0,
        reset_in_secs: 3,
    });
    assert_eq!(poll_after_secs(&pending), Some(15));
}

#[tokio::test]
async fn rerun_posts_only_for_a_currently_allowed_actions_job() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, stored_link("feature/retry", 7, NOW)).await;
    let lookup = FakeChecks {
        snapshot: Some(Ok(snapshot(
            7,
            vec![
                check("run:11", CheckStatus::Failed, CheckRerun::Allowed, Some(11)),
                check(
                    "run:12",
                    CheckStatus::Failed,
                    CheckRerun::NoPermission,
                    Some(12),
                ),
                check(
                    "run:13",
                    CheckStatus::Failed,
                    CheckRerun::PullRequestClosed,
                    Some(13),
                ),
                check("status:ci", CheckStatus::Failed, CheckRerun::Provider, None),
                check(
                    "run:14",
                    CheckStatus::Passed,
                    CheckRerun::NotApplicable,
                    Some(14),
                ),
            ],
        ))),
        ..FakeChecks::default()
    };

    rerun_check(&fx.store, &fx.ctx, "run:11", &lookup)
        .await
        .unwrap();
    for (id, reason) in [
        ("run:12", "write access"),
        ("run:13", "open pull request"),
        ("status:ci", "provider"),
        ("run:14", "Only failed jobs"),
        ("run:999", "no longer on PR #7"),
    ] {
        let failure = rerun_check(&fx.store, &fx.ctx, id, &lookup)
            .await
            .unwrap_err();
        assert!(
            failure.message.contains(reason),
            "{id}: {}",
            failure.message
        );
    }
    assert_eq!(
        *lookup.reruns.lock().unwrap(),
        vec![("example/demo-repo".to_string(), 11)]
    );
}

#[tokio::test]
async fn rerun_refusal_from_github_is_reported_once() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, stored_link("feature/retry", 7, NOW)).await;
    let lookup = FakeChecks {
        snapshot: Some(Ok(snapshot(
            7,
            vec![check(
                "run:11",
                CheckStatus::Failed,
                CheckRerun::Allowed,
                Some(11),
            )],
        ))),
        rerun_result: Some(Err(GitHubError::Network {
            message: "GitHub request timed out".into(),
        })),
        ..FakeChecks::default()
    };
    let failure = rerun_check(&fx.store, &fx.ctx, "run:11", &lookup)
        .await
        .unwrap_err();
    assert!(failure.message.contains("timed out"));
    assert_eq!(lookup.reruns.lock().unwrap().len(), 1);
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
