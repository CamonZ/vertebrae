use super::*;
use serde_json::{json, Value};
use wiremock::{
    matchers::{header, header_exists, method, path},
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

fn pull(state: &str, draft: bool, merged: bool) -> Value {
    json!({
        "number": 7,
        "state": state,
        "draft": draft,
        "merged_at": if merged { json!("2026-11-24T12:00:00Z") } else { Value::Null },
        "head": { "sha": SHA }
    })
}

fn repository(push: bool) -> Value {
    json!({ "permissions": { "admin": false, "maintain": false, "push": push, "pull": true } })
}

fn actions_run(id: u64, name: &str, status: &str, conclusion: Option<&str>) -> Value {
    json!({
        "id": id,
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "started_at": "2026-11-24T12:00:00Z",
        "completed_at": conclusion.map(|_| "2026-11-24T12:04:12Z"),
        "html_url": format!("https://github.com/example/demo-repo/actions/runs/1/job/{id}"),
        "details_url": format!("https://github.com/example/demo-repo/actions/runs/1/job/{id}"),
        "app": { "slug": "github-actions", "name": "GitHub Actions" },
        "output": { "title": conclusion.map(|c| format!("Job {c}")) }
    })
}

fn external_run(id: u64, name: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "status": "completed",
        "conclusion": "failure",
        "started_at": "2026-11-24T12:00:00Z",
        "completed_at": "2026-11-24T12:09:03Z",
        "html_url": format!("https://github.com/example/demo-repo/runs/{id}"),
        "details_url": "https://ci.example.invalid/builds/42",
        "app": { "slug": "synthetic-ci", "name": "Synthetic CI" },
        "output": { "title": "replay suite failed" }
    })
}

fn runs_page(runs: Vec<Value>) -> Value {
    json!({ "total_count": runs.len(), "check_runs": runs })
}

fn statuses(list: Vec<Value>) -> Value {
    json!({ "state": "pending", "total_count": list.len(), "statuses": list })
}

fn job_with_failed_step(step: &str) -> Value {
    json!({
        "steps": [
            { "name": "Set up job", "conclusion": "success", "number": 1 },
            { "name": step, "conclusion": "failure", "number": 2 },
            { "name": "Post job", "conclusion": "skipped", "number": 3 }
        ]
    })
}

struct Scenario {
    pull: Value,
    repository: Value,
    runs: Value,
    statuses: Value,
    jobs: Vec<(u64, Value)>,
}

impl Default for Scenario {
    fn default() -> Self {
        Self {
            pull: pull("open", false, false),
            repository: repository(true),
            runs: runs_page(vec![]),
            statuses: statuses(vec![]),
            jobs: vec![],
        }
    }
}

async fn mount(server: &MockServer, scenario: Scenario) {
    let json = |body: Value| ResponseTemplate::new(200).set_body_json(body);
    Mock::given(method("GET"))
        .and(path(format!("{REPO_PATH}/pulls/7")))
        .respond_with(json(scenario.pull))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(REPO_PATH))
        .respond_with(json(scenario.repository))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO_PATH}/commits/{SHA}/check-runs")))
        .respond_with(json(scenario.runs))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{REPO_PATH}/commits/{SHA}/status")))
        .respond_with(json(scenario.statuses))
        .mount(server)
        .await;
    for (id, job) in scenario.jobs {
        Mock::given(method("GET"))
            .and(path(format!("{REPO_PATH}/actions/jobs/{id}")))
            .respond_with(json(job))
            .mount(server)
            .await;
    }
}

async fn checks_for(scenario: Scenario) -> Result<PullRequestChecks, GitHubError> {
    let server = MockServer::start().await;
    mount(&server, scenario).await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    client.pull_request_checks(&token(), &demo_repo(), 7).await
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
    let checks = checks_for(Scenario {
        runs: runs_page(vec![
            actions_run(11, "fmt", "completed", Some("success")),
            actions_run(12, "clippy", "in_progress", None),
            actions_run(13, "test (linux)", "completed", Some("failure")),
            actions_run(14, "docs", "queued", None),
            actions_run(15, "bench", "completed", Some("cancelled")),
            external_run(16, "integration"),
        ]),
        statuses: statuses(vec![json!({
            "context": "ci/legacy",
            "state": "pending",
            "description": "Build started",
            "target_url": "https://legacy.example.invalid/7",
            "created_at": "2026-11-24T12:00:00Z",
            "updated_at": "2026-11-24T12:01:00Z"
        })]),
        jobs: vec![
            (13, job_with_failed_step("cargo test")),
            (15, json!({ "steps": [] })),
        ],
        ..Scenario::default()
    })
    .await
    .unwrap();

    let order: Vec<_> = checks
        .checks
        .iter()
        .map(|c| (c.status, c.name.as_str()))
        .collect();
    assert_eq!(
        order,
        vec![
            (CheckStatus::Failed, "bench"),
            (CheckStatus::Failed, "integration"),
            (CheckStatus::Failed, "test (linux)"),
            (CheckStatus::Running, "ci/legacy"),
            (CheckStatus::Running, "clippy"),
            (CheckStatus::Queued, "docs"),
            (CheckStatus::Passed, "fmt"),
        ]
    );
    assert_eq!(checks.head_sha, SHA);
    assert_eq!(checks.state, PullRequestState::Open);
    assert!(checks.viewer_can_rerun);
    assert!(checks.has_pending());
    assert!(!checks.truncated);

    let test = by_name(&checks, "test (linux)");
    assert_eq!(test.id, "run:13");
    assert_eq!(test.rerun, CheckRerun::Allowed);
    assert_eq!(test.actions_job_id, Some(13));
    assert_eq!(test.failed_step.as_deref(), Some("cargo test"));
    assert_eq!(test.outcome, Some(CheckOutcome::Failure));
    assert_eq!(test.summary.as_deref(), Some("Job failure"));
    assert_eq!(
        test.url.as_deref(),
        Some("https://github.com/example/demo-repo/actions/runs/1/job/13")
    );

    let bench = by_name(&checks, "bench");
    assert_eq!(bench.outcome, Some(CheckOutcome::Cancelled));
    assert_eq!(bench.failed_step, None);

    let external = by_name(&checks, "integration");
    assert_eq!(external.rerun, CheckRerun::Provider);
    assert_eq!(external.provider, "Synthetic CI");
    assert_eq!(external.actions_job_id, None);
    assert_eq!(
        external.url.as_deref(),
        Some("https://ci.example.invalid/builds/42")
    );

    let legacy = by_name(&checks, "ci/legacy");
    assert_eq!(legacy.id, "status:ci/legacy");
    assert_eq!(legacy.provider, "ci");
    assert_eq!(legacy.outcome, None);
    assert_eq!(legacy.completed_at, None);
    assert_eq!(legacy.summary.as_deref(), Some("Build started"));

    assert_eq!(by_name(&checks, "clippy").rerun, CheckRerun::NotApplicable);
}

#[tokio::test]
async fn rerun_requires_write_access_and_an_open_pull_request() {
    let failed = || runs_page(vec![actions_run(21, "test", "completed", Some("failure"))]);

    let read_only = checks_for(Scenario {
        repository: repository(false),
        runs: failed(),
        ..Scenario::default()
    })
    .await
    .unwrap();
    assert!(!read_only.viewer_can_rerun);
    assert_eq!(read_only.checks[0].rerun, CheckRerun::NoPermission);

    let anonymous = checks_for(Scenario {
        repository: json!({}),
        runs: failed(),
        ..Scenario::default()
    })
    .await
    .unwrap();
    assert_eq!(anonymous.checks[0].rerun, CheckRerun::NoPermission);

    for (pull, state) in [
        (pull("closed", false, true), PullRequestState::Merged),
        (pull("closed", false, false), PullRequestState::Closed),
    ] {
        let closed = checks_for(Scenario {
            pull,
            runs: failed(),
            ..Scenario::default()
        })
        .await
        .unwrap();
        assert_eq!(closed.state, state);
        assert_eq!(closed.checks[0].rerun, CheckRerun::PullRequestClosed);
    }

    let draft = checks_for(Scenario {
        pull: pull("open", true, false),
        runs: failed(),
        ..Scenario::default()
    })
    .await
    .unwrap();
    assert_eq!(draft.state, PullRequestState::Draft);
    assert_eq!(draft.checks[0].rerun, CheckRerun::Allowed);
}

#[tokio::test]
async fn failed_step_lookup_errors_do_not_fail_the_refresh() {
    let checks = checks_for(Scenario {
        runs: runs_page(vec![actions_run(31, "test", "completed", Some("failure"))]),
        // No job mock: the lookup returns 404.
        ..Scenario::default()
    })
    .await
    .unwrap();
    assert_eq!(checks.checks[0].failed_step, None);
    assert_eq!(checks.checks[0].status, CheckStatus::Failed);
}

#[tokio::test]
async fn unknown_conclusions_and_status_states_are_decode_errors() {
    let err = checks_for(Scenario {
        runs: runs_page(vec![actions_run(41, "odd", "completed", Some("exploded"))]),
        ..Scenario::default()
    })
    .await
    .unwrap_err();
    assert!(matches!(err, GitHubError::Decode { ref message } if message.contains("exploded")));

    let err = checks_for(Scenario {
        statuses: statuses(vec![json!({ "context": "ci", "state": "weird" })]),
        ..Scenario::default()
    })
    .await
    .unwrap_err();
    assert!(matches!(err, GitHubError::Decode { ref message } if message.contains("weird")));
}

#[tokio::test]
async fn more_checks_than_one_page_are_reported_as_truncated() {
    let checks = checks_for(Scenario {
        runs: json!({
            "total_count": 150,
            "check_runs": [actions_run(51, "fmt", "completed", Some("success"))]
        }),
        ..Scenario::default()
    })
    .await
    .unwrap();
    assert!(checks.truncated);
}

#[tokio::test]
async fn repeat_refreshes_send_etags_and_reuse_not_modified_bodies() {
    let server = MockServer::start().await;
    let etagged = |body: Value, etag: &str| {
        ResponseTemplate::new(200)
            .insert_header("etag", etag)
            .insert_header("x-ratelimit-remaining", "4000")
            .insert_header("x-ratelimit-reset", "9999999999")
            .set_body_json(body)
    };
    let not_modified = ResponseTemplate::new(304)
        .insert_header("x-ratelimit-remaining", "3999")
        .insert_header("x-ratelimit-reset", "9999999999");
    let resources = [
        (format!("{REPO_PATH}/pulls/7"), pull("open", false, false)),
        (REPO_PATH.to_string(), repository(true)),
        (
            format!("{REPO_PATH}/commits/{SHA}/check-runs"),
            runs_page(vec![actions_run(61, "fmt", "completed", Some("success"))]),
        ),
        (
            format!("{REPO_PATH}/commits/{SHA}/status"),
            statuses(vec![]),
        ),
    ];
    for (index, (resource, body)) in resources.into_iter().enumerate() {
        let etag = format!("\"etag-{index}\"");
        Mock::given(method("GET"))
            .and(path(resource.clone()))
            .and(header("if-none-match", etag.as_str()))
            .respond_with(not_modified.clone())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(resource))
            .respond_with(etagged(body, &etag))
            .expect(1)
            .mount(&server)
            .await;
    }

    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let first = client
        .pull_request_checks(&token(), &demo_repo(), 7)
        .await
        .unwrap();
    assert_eq!(first.rate_limit.map(|limit| limit.remaining), Some(4000));
    assert_eq!(client.conditional.len(), 4);

    let second = client
        .pull_request_checks(&token(), &demo_repo(), 7)
        .await
        .unwrap();
    assert_eq!(second.checks, first.checks);
    assert_eq!(second.rate_limit.map(|limit| limit.remaining), Some(3999));
}

#[tokio::test]
async fn not_modified_without_a_cached_body_is_a_decode_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(304))
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    assert!(matches!(
        client.pull_request_checks(&token(), &demo_repo(), 7).await,
        Err(GitHubError::Decode { .. })
    ));
}

#[tokio::test]
async fn rate_limited_refresh_carries_the_retry_hint() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
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
            .pull_request_checks(&token(), &demo_repo(), 7)
            .await
            .unwrap_err(),
        GitHubError::RateLimited {
            retry_after_secs: Some(40),
            message: "API rate limit exceeded".into(),
        }
    );
    assert!(matches!(
        client.pull_request_checks(&token(), &demo_repo(), 0).await,
        Err(GitHubError::InvalidInput { .. })
    ));
}

#[tokio::test]
async fn rerun_posts_to_the_job_and_maps_refusals() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path(format!("{REPO_PATH}/actions/jobs/71/rerun")))
        .and(header("authorization", "Bearer gho_synthetic_token"))
        .respond_with(ResponseTemplate::new(201))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("{REPO_PATH}/actions/jobs/72/rerun")))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_json(json!({ "message": "Must have admin rights to Repository." })),
        )
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    client
        .rerun_actions_job(&token(), &demo_repo(), 71)
        .await
        .unwrap();
    assert!(matches!(
        client.rerun_actions_job(&token(), &demo_repo(), 72).await,
        Err(GitHubError::Forbidden { .. })
    ));
}

#[tokio::test]
async fn path_segments_are_escaped() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header_exists("authorization"))
        .respond_with(|request: &Request| {
            ResponseTemplate::new(404)
                .set_body_json(json!({ "message": request.url.path().to_string() }))
        })
        .mount(&server)
        .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    let odd = RepoRef::new("github.com", "ex ample", "demo?repo");
    match client.pull_request_checks(&token(), &odd, 7).await {
        Err(GitHubError::NotFound { message }) => {
            assert_eq!(message, "/repos/ex%20ample/demo%3Frepo/pulls/7")
        }
        other => panic!("expected NotFound, got {other:?}"),
    }
}
