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
                    vec![
                        actions_run(11, "test", "COMPLETED", Some("FAILURE")),
                        // Listed before `test`, so a step must find its job.
                        actions_run(10, "build", "COMPLETED", Some("FAILURE")),
                    ],
                ),
            )],
        ),
    )
    .await;
    mount_steps(
        &server,
        steps_response(vec![(11, "Run cargo test"), (10, "Compile")]),
        1,
    )
    .await;
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
        assert_eq!(
            by_name(&checks, "build").failed_step.as_deref(),
            Some("Compile")
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

#[tokio::test]
async fn a_run_github_answers_without_steps_is_not_asked_about_again() {
    let server = MockServer::start().await;
    mount_checks(
        &server,
        checks_response(
            "WRITE",
            vec![(
                7,
                open_pull(
                    7,
                    vec![actions_run(31, "test", "COMPLETED", Some("FAILURE"))],
                ),
            )],
        ),
    )
    .await;
    // GitHub returns no node for the run.
    mount_steps(&server, json!({ "data": { "nodes": [null] } }), 1).await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    for _ in 0..2 {
        let checks = client
            .pull_request_checks(&token(), &demo_repo(), 7)
            .await
            .unwrap();
        assert_eq!(by_name(&checks, "test").failed_step, None);
    }
}

#[tokio::test]
async fn a_run_missing_from_an_answer_with_errors_is_asked_about_again() {
    let server = MockServer::start().await;
    mount_checks(
        &server,
        checks_response(
            "WRITE",
            vec![(
                7,
                open_pull(
                    7,
                    vec![actions_run(31, "test", "COMPLETED", Some("FAILURE"))],
                ),
            )],
        ),
    )
    .await;
    mount_steps(
        &server,
        json!({
            "data": { "nodes": [null] },
            "errors": [{ "type": "SERVICE_UNAVAILABLE", "message": "Try again later." }]
        }),
        2,
    )
    .await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    for _ in 0..2 {
        let checks = client
            .pull_request_checks(&token(), &demo_repo(), 7)
            .await
            .unwrap();
        assert_eq!(by_name(&checks, "test").failed_step, None);
    }
}

mod properties;
