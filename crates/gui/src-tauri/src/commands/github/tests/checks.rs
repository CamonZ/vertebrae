use super::*;
use crate::commands::github::checks::{
    cancel_check, hold_off_secs, poll_prs, published_head, rerun_check, ChecksLookup,
    WorktreeBranch, WorktreePrPollResult,
};
use std::{collections::HashMap, sync::Mutex as TestMutex};
use vertebrae_github::{
    CheckCancel, CheckOutcome, CheckRerun, CheckStatus, PullRequestCheck, PullRequestChecks,
    PullRequestChecksBatch, RateLimitStatus,
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
    let mut pull_request = summary(number, "feature/retry", Some("example/demo-repo"));
    pull_request.title = format!("Fresh title {number}");
    PullRequestChecks {
        pull_request,
        head_sha: "abc123".into(),
        viewer_can_write: true,
        checks,
        truncated: false,
    }
}

fn batch(entries: Vec<(u64, Result<PullRequestChecks, GitHubError>)>) -> PullRequestChecksBatch {
    PullRequestChecksBatch {
        pull_requests: entries.into_iter().collect::<HashMap<_, _>>(),
        rate_limit: Some(RateLimitStatus {
            remaining: 4000,
            reset_in_secs: 600,
        }),
    }
}

#[derive(Default)]
struct FakeChecks {
    answer: Option<Result<PullRequestChecksBatch, GitHubError>>,
    write_result: Option<Result<(), GitHubError>>,
    lookups: TestMutex<Vec<(String, Vec<u64>)>>,
    reruns: TestMutex<Vec<u64>>,
    cancels: TestMutex<Vec<u64>>,
}

impl ChecksLookup for FakeChecks {
    async fn checks(
        &self,
        repo: &RepoRef,
        numbers: &[u64],
    ) -> Result<PullRequestChecksBatch, GitHubError> {
        self.lookups
            .lock()
            .unwrap()
            .push((repo.full_name(), numbers.to_vec()));
        self.answer.clone().expect("no answer configured")
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

fn target(ctx: &WorktreeGitContext) -> WorktreeBranch {
    WorktreeBranch {
        worktree_path: ctx.worktree_key.clone(),
        branch: ctx.branch.clone(),
    }
}

#[tokio::test]
async fn one_request_per_repository_refreshes_every_linked_worktree() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, stored_link("feature/retry", 7, NOW)).await;
    // A second worktree of the same repository, linked to another PR.
    let other_dir = tempfile::tempdir().unwrap();
    init_repo(other_dir.path(), "feature/other", &[ORIGIN]);
    let other = resolve_worktree_git_context(other_dir.path(), "feature/other").unwrap();
    fx.store
        .save_discovered(&other.key(), None, stored_link("feature/other", 8, NOW))
        .await
        .unwrap();
    // A third with no link: nothing to read.
    let unlinked_dir = tempfile::tempdir().unwrap();
    init_repo(unlinked_dir.path(), "feature/none", &[ORIGIN]);
    let unlinked = resolve_worktree_git_context(unlinked_dir.path(), "feature/none").unwrap();

    let lookup = FakeChecks {
        answer: Some(Ok(batch(vec![
            (
                7,
                Ok(snapshot(
                    7,
                    vec![
                        check("run:1", CheckStatus::Failed, Some(1)),
                        check("run:2", CheckStatus::Running, Some(2)),
                    ],
                )),
            ),
            (
                8,
                Err(GitHubError::NotFound {
                    message: "Pull request #8 not found".into(),
                }),
            ),
        ]))),
        ..FakeChecks::default()
    };
    let result = poll_prs(
        &fx.store,
        vec![
            (target(&fx.ctx), Ok(fx.ctx.clone())),
            (target(&other), Ok(other.clone())),
            (target(&unlinked), Ok(unlinked.clone())),
            (
                WorktreeBranch {
                    worktree_path: "/gone".into(),
                    branch: "x".into(),
                },
                Err(GithubFailure::other("Not a git repository")),
            ),
        ],
        &lookup,
        Some(1_700_000_100),
    )
    .await;

    assert_eq!(
        *lookup.lookups.lock().unwrap(),
        vec![("example/demo-repo".to_string(), vec![7, 8])]
    );
    assert_eq!(result.hold_off_secs, None);
    assert_eq!(result.results.len(), 4);
    match &result.results[0].result {
        WorktreePrPollResult::Linked {
            association,
            checks,
        } => {
            assert_eq!(linked_number(association), 7);
            assert_eq!(checks.pr_number, 7);
            assert_eq!(checks.repo, "example/demo-repo");
            assert_eq!(checks.checks[0].rerun, GithubCheckRerun::Allowed);
            assert_eq!(checks.checks[1].cancel, GithubCheckCancel::Allowed);
            assert_eq!(checks.checks[1].actions_run.as_deref(), Some("900"));
        }
        other => panic!("expected linked, got {other:?}"),
    }
    assert!(matches!(
        &result.results[1].result,
        WorktreePrPollResult::Failed { failure } if failure.kind == GithubErrorKind::NotFound
    ));
    assert_eq!(result.results[2].result, WorktreePrPollResult::NotLinked);
    assert!(matches!(
        &result.results[3].result,
        WorktreePrPollResult::Failed { failure } if failure.message == "Not a git repository"
    ));

    // The refreshed PR is written back, so association reads see it.
    match fx.store.load(&fx.ctx.key()).await.unwrap() {
        Some(StoredPrAssociation::Linked(record)) => {
            assert_eq!(record.pr.title, "Fresh title 7");
            assert_eq!(record.fetched_at, 1_700_000_100);
        }
        other => panic!("expected stored link, got {other:?}"),
    }
}

#[tokio::test]
async fn a_failed_request_fails_every_worktree_of_that_repository() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, stored_link("feature/retry", 7, NOW)).await;
    let lookup = FakeChecks {
        answer: Some(Err(GitHubError::RateLimited {
            retry_after_secs: Some(40),
            message: "API rate limit exceeded".into(),
        })),
        ..FakeChecks::default()
    };
    let result = poll_prs(
        &fx.store,
        vec![(target(&fx.ctx), Ok(fx.ctx.clone()))],
        &lookup,
        NOW,
    )
    .await;
    match &result.results[0].result {
        WorktreePrPollResult::Failed { failure } => {
            assert_eq!(failure.kind, GithubErrorKind::RateLimited);
            assert_eq!(failure.retry_after_secs, Some(40));
        }
        other => panic!("expected failure, got {other:?}"),
    }
}

#[tokio::test]
async fn unlinked_branches_never_query_github() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, StoredPrAssociation::Unlinked).await;
    let lookup = FakeChecks::default();
    let result = poll_prs(
        &fx.store,
        vec![(target(&fx.ctx), Ok(fx.ctx.clone()))],
        &lookup,
        NOW,
    )
    .await;
    assert_eq!(result.results[0].result, WorktreePrPollResult::NotLinked);
    assert!(lookup.lookups.lock().unwrap().is_empty());
}

#[test]
fn polling_holds_off_only_when_the_budget_is_nearly_spent() {
    assert_eq!(hold_off_secs(None), None);
    let limit = |remaining, reset_in_secs| {
        Some(RateLimitStatus {
            remaining,
            reset_in_secs,
        })
    };
    assert_eq!(hold_off_secs(limit(4000, 600)), None);
    assert_eq!(hold_off_secs(limit(10, 600)), Some(600));
}

#[tokio::test]
async fn rerun_and_cancel_post_only_for_currently_allowed_actions_jobs() {
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, stored_link("feature/retry", 7, NOW)).await;
    let mut no_permission = check("run:12", CheckStatus::Failed, Some(12));
    no_permission.rerun = CheckRerun::NoPermission;
    let mut closed = check("run:13", CheckStatus::Failed, Some(13));
    closed.rerun = CheckRerun::PullRequestClosed;
    let mut provider = check("status:ci", CheckStatus::Failed, None);
    provider.rerun = CheckRerun::Provider;
    let mut cannot_cancel = check("run:16", CheckStatus::Running, Some(16));
    cannot_cancel.cancel = CheckCancel::NoPermission;
    let lookup = FakeChecks {
        answer: Some(Ok(batch(vec![(
            7,
            Ok(snapshot(
                7,
                vec![
                    check("run:11", CheckStatus::Failed, Some(11)),
                    no_permission,
                    closed,
                    provider,
                    check("run:14", CheckStatus::Passed, Some(14)),
                    check("run:15", CheckStatus::Queued, Some(15)),
                    cannot_cancel,
                ],
            )),
        )]))),
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
    assert_eq!(*lookup.reruns.lock().unwrap(), vec![11]);

    cancel_check(&fx.store, &fx.ctx, "run:15", &lookup)
        .await
        .unwrap();
    for (id, reason) in [
        ("run:16", "write access"),
        ("run:14", "already finished"),
        ("run:999", "no longer on PR #7"),
    ] {
        let failure = cancel_check(&fx.store, &fx.ctx, id, &lookup)
            .await
            .unwrap_err();
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
    let fx = fixture("feature/retry", &[ORIGIN]);
    seed(&fx, stored_link("feature/retry", 7, NOW)).await;
    let lookup = FakeChecks {
        answer: Some(Ok(batch(vec![(
            7,
            Ok(snapshot(
                7,
                vec![
                    check("run:11", CheckStatus::Failed, Some(11)),
                    check("run:12", CheckStatus::Running, Some(12)),
                ],
            )),
        )]))),
        write_result: Some(Err(GitHubError::Network {
            message: "GitHub request timed out".into(),
        })),
        ..FakeChecks::default()
    };
    let failure = rerun_check(&fx.store, &fx.ctx, "run:11", &lookup)
        .await
        .unwrap_err();
    assert!(failure.message.contains("timed out"));
    let failure = cancel_check(&fx.store, &fx.ctx, "run:12", &lookup)
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
