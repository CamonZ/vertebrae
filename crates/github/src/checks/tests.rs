use super::*;
use serde_json::{json, Value};
use wiremock::{
    matchers::{body_string_contains, header, method, path},
    Mock, MockServer, Request, ResponseTemplate,
};

const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
const REPO_PATH: &str = "/repos/example/demo-repo";

fn demo_repo() -> RepoRef {
    RepoRef::new("github.com", "example", "demo-repo")
}

fn token() -> GitHubToken {
    GitHubToken::new("gho_synthetic_token").unwrap()
}

fn actions_run(id: u64, name: &str, status: &str, conclusion: Option<&str>) -> Value {
    json!({
        "__typename": "CheckRun",
        "id": format!("CR_{id}"),
        "databaseId": id,
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "startedAt": "2026-11-24T12:00:00Z",
        "completedAt": conclusion.map(|_| "2026-11-24T12:04:12Z"),
        "url": format!("https://github.com/example/demo-repo/runs/{id}"),
        "detailsUrl": format!("https://github.com/example/demo-repo/actions/runs/900/job/{id}"),
        "title": conclusion.map(|c| format!("Job {c}")),
        "checkSuite": {
            "app": { "name": "GitHub Actions", "slug": "github-actions" },
            "workflowRun": { "databaseId": 900 }
        }
    })
}

fn external_run(id: u64, name: &str, status: &str, conclusion: Option<&str>) -> Value {
    json!({
        "__typename": "CheckRun",
        "id": format!("CR_{id}"),
        "databaseId": id,
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "startedAt": "2026-11-24T12:00:00Z",
        "completedAt": null,
        "url": format!("https://github.com/example/demo-repo/runs/{id}"),
        "detailsUrl": "https://ci.example.invalid/builds/42",
        "title": "replay suite failed",
        "checkSuite": { "app": { "name": "Synthetic CI", "slug": "synthetic-ci" }, "workflowRun": null }
    })
}

fn status(context: &str, state: &str) -> Value {
    json!({
        "__typename": "StatusContext",
        "context": context,
        "state": state,
        "description": format!("{context} {state}"),
        "targetUrl": "https://ci.example.invalid/status",
        "createdAt": "2026-11-24T12:01:00Z"
    })
}

fn pull(number: u64, state: &str, draft: bool, contexts: Vec<Value>, total: u64) -> Value {
    json!({
        "number": number,
        "title": format!("PR {number}"),
        "state": state,
        "isDraft": draft,
        "headRefName": "feature/retry",
        "headRepository": { "nameWithOwner": "example/demo-repo" },
        "baseRefName": "main",
        "url": format!("https://github.com/example/demo-repo/pull/{number}"),
        "author": { "login": "alice" },
        "updatedAt": "2026-11-24T12:00:00Z",
        "headRefOid": SHA,
        "commits": { "nodes": [{ "commit": { "statusCheckRollup": {
            "contexts": { "totalCount": total, "nodes": contexts }
        } } }] }
    })
}

fn open_pull(number: u64, contexts: Vec<Value>) -> Value {
    let total = contexts.len() as u64;
    pull(number, "OPEN", false, contexts, total)
}

fn checks_response(permission: &str, pulls: Vec<(u64, Value)>) -> Value {
    let mut repository = json!({ "viewerPermission": permission });
    for (number, pull) in pulls {
        repository[format!("pr{number}")] = pull;
    }
    json!({ "data": { "repository": repository } })
}

fn steps_response(runs: Vec<(u64, &str)>) -> Value {
    let nodes: Vec<Value> = runs
        .into_iter()
        .map(|(id, failed)| {
            json!({ "databaseId": id, "steps": { "nodes": [
                { "name": "Set up job", "conclusion": "SUCCESS" },
                { "name": failed, "conclusion": "FAILURE" },
                { "name": "Post job", "conclusion": "SKIPPED" }
            ] } })
        })
        .collect();
    json!({ "data": { "nodes": nodes } })
}

fn json_response(body: Value) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("x-ratelimit-remaining", "4900")
        .insert_header("x-ratelimit-reset", "9999999999")
        .set_body_json(body)
}

async fn mount_checks(server: &MockServer, body: Value) {
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("PullRequestChecks"))
        .respond_with(json_response(body))
        .mount(server)
        .await;
}

async fn mount_steps(server: &MockServer, body: Value, expected: u64) {
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("CheckRunSteps"))
        .respond_with(json_response(body))
        .expect(expected)
        .mount(server)
        .await;
}

fn by_name<'a>(checks: &'a PullRequestChecks, name: &str) -> &'a PullRequestCheck {
    checks
        .checks
        .iter()
        .find(|check| check.name == name)
        .unwrap_or_else(|| panic!("no check named {name}"))
}

#[tokio::test]
async fn normalizes_check_runs_and_statuses_in_display_order() {
    let server = MockServer::start().await;
    mount_checks(
        &server,
        checks_response(
            "WRITE",
            vec![(
                7,
                open_pull(
                    7,
                    vec![
                        actions_run(11, "test", "COMPLETED", Some("FAILURE")),
                        actions_run(12, "build", "IN_PROGRESS", None),
                        actions_run(13, "docs", "QUEUED", None),
                        actions_run(14, "fmt", "COMPLETED", Some("SKIPPED")),
                        external_run(15, "replay", "COMPLETED", Some("FAILURE")),
                        status("ci/external", "PENDING"),
                        status("ci/required", "EXPECTED"),
                        status("ci/lint", "ERROR"),
                    ],
                ),
            )],
        ),
    )
    .await;
    mount_steps(&server, steps_response(vec![(11, "Run cargo test")]), 1).await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let checks = client
        .pull_request_checks(&token(), &demo_repo(), 7)
        .await
        .unwrap();

    assert_eq!(checks.pull_request.number, 7);
    assert_eq!(checks.pull_request.state, PullRequestState::Open);
    assert_eq!(checks.head_sha, SHA);
    assert!(checks.viewer_can_write);
    assert!(!checks.truncated);
    assert!(checks.has_pending());
    let order: Vec<_> = checks
        .checks
        .iter()
        .map(|check| (check.name.as_str(), check.status))
        .collect();
    assert_eq!(
        order,
        vec![
            ("ci/lint", CheckStatus::Failed),
            ("replay", CheckStatus::Failed),
            ("test", CheckStatus::Failed),
            ("build", CheckStatus::Running),
            ("ci/external", CheckStatus::Running),
            ("ci/required", CheckStatus::Queued),
            ("docs", CheckStatus::Queued),
            ("fmt", CheckStatus::Passed),
        ]
    );

    let test = by_name(&checks, "test");
    assert_eq!(test.id, "run:11");
    assert_eq!(test.provider, "GitHub Actions");
    assert_eq!(test.outcome, Some(CheckOutcome::Failure));
    assert_eq!(test.failed_step.as_deref(), Some("Run cargo test"));
    assert_eq!(test.actions_job_id, Some(11));
    assert_eq!(test.actions_run_id, Some(900));
    assert_eq!(
        test.url.as_deref(),
        Some("https://github.com/example/demo-repo/runs/11")
    );
    assert_eq!(test.rerun, CheckRerun::Allowed);
    assert_eq!(test.cancel, CheckCancel::NotApplicable);

    let build = by_name(&checks, "build");
    assert_eq!(build.cancel, CheckCancel::Allowed);
    assert_eq!(build.rerun, CheckRerun::NotApplicable);
    assert_eq!(by_name(&checks, "docs").cancel, CheckCancel::Allowed);
    assert_eq!(by_name(&checks, "fmt").outcome, Some(CheckOutcome::Skipped));

    let replay = by_name(&checks, "replay");
    assert_eq!(replay.provider, "Synthetic CI");
    assert_eq!(
        replay.url.as_deref(),
        Some("https://ci.example.invalid/builds/42")
    );
    assert_eq!(replay.rerun, CheckRerun::Provider);
    assert_eq!(replay.actions_job_id, None);
    assert_eq!(replay.failed_step, None);

    let external = by_name(&checks, "ci/external");
    assert_eq!(external.id, "status:ci/external");
    assert_eq!(external.provider, "ci");
    assert_eq!(external.cancel, CheckCancel::Provider);
    assert_eq!(external.started_at.as_deref(), Some("2026-11-24T12:01:00Z"));
    let lint = by_name(&checks, "ci/lint");
    assert_eq!(lint.outcome, Some(CheckOutcome::Error));
    assert_eq!(lint.completed_at.as_deref(), Some("2026-11-24T12:01:00Z"));
    assert_eq!(lint.started_at, None);
}

#[tokio::test]
async fn re_run_and_cancel_need_write_access_and_re_run_an_open_pull_request() {
    let runs = || {
        vec![
            actions_run(11, "test", "COMPLETED", Some("FAILURE")),
            actions_run(12, "build", "IN_PROGRESS", None),
        ]
    };
    let server = MockServer::start().await;
    mount_checks(
        &server,
        checks_response(
            "READ",
            vec![
                (7, open_pull(7, runs())),
                (8, pull(8, "MERGED", false, runs(), 2)),
            ],
        ),
    )
    .await;
    mount_steps(&server, json!({ "data": { "nodes": [] } }), 1).await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let batch = client
        .pull_requests_checks(&token(), &demo_repo(), &[7, 8])
        .await
        .unwrap();

    let open = batch.pull_requests[&7].as_ref().unwrap();
    assert!(!open.viewer_can_write);
    assert_eq!(by_name(open, "test").rerun, CheckRerun::NoPermission);
    assert_eq!(by_name(open, "build").cancel, CheckCancel::NoPermission);
    let merged = batch.pull_requests[&8].as_ref().unwrap();
    assert_eq!(merged.pull_request.state, PullRequestState::Merged);
    assert_eq!(by_name(merged, "test").rerun, CheckRerun::PullRequestClosed);
}

#[tokio::test]
async fn one_query_answers_several_pull_requests_and_a_missing_one_fails_alone() {
    let server = MockServer::start().await;
    let mut body = checks_response(
        "ADMIN",
        vec![
            (
                7,
                open_pull(7, vec![actions_run(12, "build", "QUEUED", None)]),
            ),
            (9, Value::Null),
        ],
    );
    body["errors"] = json!([{
        "type": "NOT_FOUND",
        "path": ["repository", "pr9"],
        "message": "Could not resolve to a PullRequest with the number of 9."
    }]);
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("pr7: pullRequest(number: 7)"))
        .and(body_string_contains("pr9: pullRequest(number: 9)"))
        .and(header("authorization", "Bearer gho_synthetic_token"))
        .respond_with(json_response(body))
        .expect(1)
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let batch = client
        .pull_requests_checks(&token(), &demo_repo(), &[9, 7, 7])
        .await
        .unwrap();

    assert_eq!(batch.pull_requests.len(), 2);
    assert!(batch.pull_requests[&7].is_ok());
    assert!(matches!(
        batch.pull_requests[&9],
        Err(GitHubError::NotFound { .. })
    ));
    assert_eq!(batch.rate_limit.map(|limit| limit.remaining), Some(4900));
}

#[tokio::test]
async fn pull_requests_are_split_across_queries_of_bounded_size() {
    let server = MockServer::start().await;
    let numbers: Vec<u64> = (1..=PULL_REQUESTS_PER_QUERY as u64 + 2).collect();
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(|request: &Request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let query = body["query"].as_str().unwrap();
            let mut repository = json!({ "viewerPermission": "WRITE" });
            for number in 1..=PULL_REQUESTS_PER_QUERY as u64 + 2 {
                if query.contains(&format!("pr{number}: ")) {
                    repository[format!("pr{number}")] = open_pull(number, vec![]);
                }
            }
            json_response(json!({ "data": { "repository": repository } }))
        })
        .expect(2)
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let batch = client
        .pull_requests_checks(&token(), &demo_repo(), &numbers)
        .await
        .unwrap();
    assert_eq!(batch.pull_requests.len(), numbers.len());
    assert!(batch.pull_requests.values().all(Result::is_ok));
}

#[tokio::test]
async fn failing_steps_are_read_once_per_check_run() {
    let server = MockServer::start().await;
    mount_checks(
        &server,
        checks_response(
            "WRITE",
            vec![(
                7,
                open_pull(
                    7,
                    vec![actions_run(11, "test", "COMPLETED", Some("FAILURE"))],
                ),
            )],
        ),
    )
    .await;
    mount_steps(&server, steps_response(vec![(11, "Run cargo test")]), 1).await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    for _ in 0..3 {
        let checks = client
            .pull_request_checks(&token(), &demo_repo(), 7)
            .await
            .unwrap();
        assert_eq!(
            by_name(&checks, "test").failed_step.as_deref(),
            Some("Run cargo test")
        );
    }
}

#[tokio::test]
async fn a_failed_step_lookup_does_not_fail_the_refresh() {
    let server = MockServer::start().await;
    mount_checks(
        &server,
        checks_response(
            "WRITE",
            vec![(
                7,
                open_pull(
                    7,
                    vec![actions_run(11, "test", "COMPLETED", Some("FAILURE"))],
                ),
            )],
        ),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("CheckRunSteps"))
        .respond_with(ResponseTemplate::new(502))
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let checks = client
        .pull_request_checks(&token(), &demo_repo(), 7)
        .await
        .unwrap();
    let test = by_name(&checks, "test");
    assert_eq!(test.failed_step, None);
    assert_eq!(test.summary.as_deref(), Some("Job FAILURE"));
}

#[tokio::test]
async fn unknown_conclusions_and_status_states_are_decode_errors() {
    for context in [
        actions_run(11, "test", "COMPLETED", Some("EXPLODED")),
        status("ci/odd", "SIDEWAYS"),
    ] {
        let server = MockServer::start().await;
        mount_checks(
            &server,
            checks_response("WRITE", vec![(7, open_pull(7, vec![context]))]),
        )
        .await;
        let client = GitHubClient::with_base_url(&server.uri()).unwrap();
        assert!(matches!(
            client.pull_request_checks(&token(), &demo_repo(), 7).await,
            Err(GitHubError::Decode { .. })
        ));
    }
}

#[tokio::test]
async fn more_checks_than_one_query_reads_are_reported_as_truncated() {
    let server = MockServer::start().await;
    mount_checks(
        &server,
        checks_response(
            "WRITE",
            vec![(
                7,
                pull(
                    7,
                    "OPEN",
                    true,
                    vec![actions_run(12, "build", "QUEUED", None)],
                    140,
                ),
            )],
        ),
    )
    .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let checks = client
        .pull_request_checks(&token(), &demo_repo(), 7)
        .await
        .unwrap();
    assert!(checks.truncated);
    assert_eq!(checks.pull_request.state, PullRequestState::Draft);
}

#[tokio::test]
async fn a_commit_without_checks_has_an_empty_list() {
    let server = MockServer::start().await;
    let mut pull = open_pull(7, vec![]);
    pull["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = Value::Null;
    mount_checks(&server, checks_response("WRITE", vec![(7, pull)])).await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let checks = client
        .pull_request_checks(&token(), &demo_repo(), 7)
        .await
        .unwrap();
    assert!(checks.checks.is_empty());
    assert!(!checks.has_pending());
}

#[tokio::test]
async fn whole_request_failures_fail_the_batch() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header("x-ratelimit-remaining", "0")
                .insert_header("retry-after", "40")
                .set_body_json(json!({ "message": "API rate limit exceeded" })),
        )
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    assert_eq!(
        client
            .pull_requests_checks(&token(), &demo_repo(), &[7, 8])
            .await
            .unwrap_err(),
        GitHubError::RateLimited {
            retry_after_secs: Some(40),
            message: "API rate limit exceeded".into(),
        }
    );
    assert!(matches!(
        client
            .pull_requests_checks(&token(), &demo_repo(), &[0])
            .await,
        Err(GitHubError::InvalidInput { .. })
    ));

    let missing_repo = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(json_response(json!({
            "data": { "repository": null },
            "errors": [{ "type": "NOT_FOUND", "path": ["repository"], "message": "Could not resolve to a Repository" }]
        })))
        .mount(&missing_repo)
        .await;
    let client = GitHubClient::with_base_url(&missing_repo.uri()).unwrap();
    assert!(matches!(
        client
            .pull_requests_checks(&token(), &demo_repo(), &[7])
            .await,
        Err(GitHubError::NotFound { .. })
    ));
}

#[tokio::test]
async fn re_run_and_cancel_post_to_actions_and_map_refusals() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!("{REPO_PATH}/actions/jobs/71/rerun")))
        .and(header("authorization", "Bearer gho_synthetic_token"))
        .respond_with(ResponseTemplate::new(201))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("{REPO_PATH}/actions/runs/900/cancel")))
        .and(header("authorization", "Bearer gho_synthetic_token"))
        .respond_with(ResponseTemplate::new(202))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("{REPO_PATH}/actions/runs/901/cancel")))
        .respond_with(
            ResponseTemplate::new(409).set_body_json(
                json!({ "message": "Cannot cancel a workflow run that is completed." }),
            ),
        )
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    client
        .rerun_actions_job(&token(), &demo_repo(), 71)
        .await
        .unwrap();
    client
        .cancel_actions_run(&token(), &demo_repo(), 900)
        .await
        .unwrap();
    let refused = client
        .cancel_actions_run(&token(), &demo_repo(), 901)
        .await
        .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("Cannot cancel a workflow run that is completed."),
        "{refused:?}"
    );
}

#[tokio::test]
async fn rest_path_segments_are_escaped() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(|request: &Request| {
            ResponseTemplate::new(404)
                .set_body_json(json!({ "message": request.url.path().to_string() }))
        })
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let odd = RepoRef::new("github.com", "ex ample", "demo?repo");
    match client.cancel_actions_run(&token(), &odd, 900).await {
        Err(GitHubError::NotFound { message }) => {
            assert_eq!(
                message,
                "/repos/ex%20ample/demo%3Frepo/actions/runs/900/cancel"
            )
        }
        other => panic!("expected NotFound, got {other:?}"),
    }
}
