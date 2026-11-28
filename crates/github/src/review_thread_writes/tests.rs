use super::*;
use std::time::Duration;
use wiremock::{
    matchers::{body_partial_json, body_string_contains, method, path},
    Mock, MockServer, ResponseTemplate,
};

fn demo_repo() -> RepoRef {
    RepoRef::new("github.com", "example", "demo-repo")
}

fn token() -> GitHubToken {
    GitHubToken::new("gho_synthetic_token").unwrap()
}

fn reply(body: &str) -> ReviewThreadWrite {
    ReviewThreadWrite::Reply {
        thread_id: "PRRT_synthetic1".into(),
        body: body.into(),
    }
}

fn start(start_line: Option<u32>, line: u32) -> ReviewThreadWrite {
    ReviewThreadWrite::Start(NewReviewThread {
        path: "src/retry.rs".into(),
        side: DiffSide::Right,
        start_line,
        line,
        body: "Should this reset the budget?".into(),
    })
}

fn ok(data: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "data": data }))
}

async fn server() -> (MockServer, GitHubClient) {
    let server = MockServer::start().await;
    let client = GitHubClient::with_base_url(&server.uri()).unwrap();
    (server, client)
}

/// A body is accepted exactly when it has visible text and fits GitHub's
/// limit; whatever is accepted is sent as written.
#[hegel::test(test_cases = 200)]
fn bodies_are_accepted_exactly_when_github_would_take_them(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let filler = tc.draw(gs::sampled_from(&[" ", "\n", "x", "é", "\t"][..]));
    let len = if tc.draw(gs::booleans()) {
        tc.draw(gs::integers::<usize>().max_value(8))
    } else {
        MAX_COMMENT_CHARS - 2 + tc.draw(gs::integers::<usize>().max_value(4))
    };
    let mut body = filler.repeat(len);
    if tc.draw(gs::booleans()) {
        body.push_str(&tc.draw(gs::text().max_size(4)));
    }
    let expected = !body.trim().is_empty() && body.chars().count() <= MAX_COMMENT_CHARS;
    let write = reply(&body);
    assert_eq!(validate(&write).is_ok(), expected, "{len} × {filler:?}");
    if expected {
        let (_, variables, _) = mutation(&write, None);
        assert_eq!(variables["body"], json!(body));
    }
}

/// Every valid new thread is sent as GitHub's input requires: the range's
/// start only when it precedes the end, with a start side exactly then, and
/// the path, body and side unchanged. An inverted or zero range is refused.
#[hegel::test(test_cases = 300)]
fn new_threads_send_github_ranges(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let line = tc.draw(gs::integers::<u32>().max_value(6));
    let start_line = tc.draw(gs::optional(gs::integers::<u32>().max_value(7)));
    let side = tc.draw(gs::sampled_from(&[DiffSide::Left, DiffSide::Right][..]));
    let write = ReviewThreadWrite::Start(NewReviewThread {
        path: "src/retry.rs".into(),
        side,
        start_line,
        line,
        body: "Why?".into(),
    });
    let valid = line > 0 && start_line.is_none_or(|start| (1..=line).contains(&start));
    assert_eq!(validate(&write).is_ok(), valid);
    if !valid {
        return;
    }
    let (_, variables, field) = mutation(&write, Some("PR_node"));
    assert_eq!(field, "addPullRequestReview");
    assert_eq!(variables["pullRequest"], json!("PR_node"));
    assert_eq!(variables["line"], json!(line));
    let ranged = start_line.is_some_and(|start| start < line);
    assert_eq!(variables["startLine"].is_null(), !ranged);
    assert_eq!(variables["startSide"].is_null(), !ranged);
    assert_eq!(variables["side"], json!(side_name(side)));
    if ranged {
        assert_eq!(variables["startSide"], variables["side"]);
    }
}

#[tokio::test]
async fn reply_resolve_and_reopen_send_one_mutation_each() {
    let (server, client) = server().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("addPullRequestReviewThreadReply"))
        .and(body_partial_json(json!({
            "variables": { "thread": "PRRT_synthetic1", "body": "Fixed in abc123." }
        })))
        .respond_with(ok(json!({
            "addPullRequestReviewThreadReply": { "comment": { "id": "PRRC_new" } }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("mutation ResolveReviewThread"))
        .respond_with(ok(json!({
            "resolveReviewThread": { "thread": { "id": "PRRT_synthetic1" } }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("unresolveReviewThread"))
        .respond_with(ok(json!({
            "unresolveReviewThread": { "thread": { "id": "PRRT_synthetic1" } }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let write = |write: ReviewThreadWrite| {
        let client = client.clone();
        async move {
            client
                .write_review_thread(&token(), &demo_repo(), 7, &write)
                .await
        }
    };
    assert_eq!(
        write(reply("Fixed in abc123.")).await.unwrap(),
        "PRRT_synthetic1"
    );
    let thread_id = "PRRT_synthetic1".to_string();
    assert_eq!(
        write(ReviewThreadWrite::Resolve {
            thread_id: thread_id.clone()
        })
        .await
        .unwrap(),
        thread_id
    );
    assert_eq!(
        write(ReviewThreadWrite::Reopen {
            thread_id: thread_id.clone()
        })
        .await
        .unwrap(),
        thread_id
    );
}

/// The thread answered is the one the published review's comment starts,
/// wherever it sits among the PR's newest threads.
#[tokio::test]
async fn a_new_thread_is_published_on_the_pull_request_github_names() {
    let (server, client) = server().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("PullRequestId"))
        .and(body_partial_json(json!({ "variables": { "number": 7 } })))
        .respond_with(ok(json!({
            "repository": { "pullRequest": { "id": "PR_synthetic7" } }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("event: COMMENT"))
        .and(body_partial_json(json!({
            "variables": {
                "pullRequest": "PR_synthetic7",
                "path": "src/retry.rs",
                "line": 14,
                "startLine": 12,
                "side": "RIGHT"
            }
        })))
        .respond_with(ok(json!({
            "addPullRequestReview": { "pullRequestReview": {
                "comments": { "nodes": [{ "id": "PRRC_started" }] },
                "pullRequest": { "reviewThreads": { "nodes": [
                    { "id": "PRRT_older", "comments": { "nodes": [{ "id": "PRRC_older" }] } },
                    { "id": "PRRT_started", "comments": { "nodes": [{ "id": "PRRC_started" }] } },
                    null,
                    { "id": "PRRT_other", "comments": { "nodes": [{ "id": "PRRC_other" }] } }
                ] } }
            } }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let id = client
        .write_review_thread(&token(), &demo_repo(), 7, &start(Some(12), 14))
        .await
        .unwrap();
    assert_eq!(id, "PRRT_started");
}

#[tokio::test]
async fn refused_writes_map_to_forbidden_and_invalid_ones_are_never_sent() {
    let (server, client) = server().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("mutation ResolveReviewThread"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "resolveReviewThread": null },
            "errors": [{ "type": "FORBIDDEN", "message": "Resource not accessible" }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("unresolveReviewThread"))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(json!({ "message": "Must have push access" })),
        )
        .mount(&server)
        .await;
    let write = |write: ReviewThreadWrite| {
        let client = client.clone();
        async move {
            client
                .write_review_thread(&token(), &demo_repo(), 7, &write)
                .await
        }
    };

    for refused in [
        ReviewThreadWrite::Resolve {
            thread_id: "PRRT_synthetic1".into(),
        },
        ReviewThreadWrite::Reopen {
            thread_id: "PRRT_synthetic1".into(),
        },
    ] {
        assert!(matches!(
            write(refused).await,
            Err(GitHubError::Forbidden { .. })
        ));
    }
    let requests = server.received_requests().await.unwrap().len();
    for invalid in [reply("  \n"), start(Some(9), 3), start(None, 0)] {
        assert!(matches!(
            write(invalid).await,
            Err(GitHubError::InvalidInput { .. })
        ));
    }
    assert_eq!(server.received_requests().await.unwrap().len(), requests);
}

#[tokio::test]
async fn an_answer_without_the_written_node_is_unconfirmed() {
    let (server, client) = server().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("PullRequestId"))
        .respond_with(ok(json!({
            "repository": { "pullRequest": { "id": "PR_synthetic7" } }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("addPullRequestReviewThreadReply"))
        .respond_with(ok(json!({ "addPullRequestReviewThreadReply": null })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("StartReviewThread"))
        .respond_with(ok(json!({
            "addPullRequestReview": { "pullRequestReview": {
                "comments": { "nodes": [{ "id": "PRRC_started" }] },
                "pullRequest": { "reviewThreads": { "nodes": [
                    { "id": "PRRT_other", "comments": { "nodes": [{ "id": "PRRC_other" }] } }
                ] } }
            } }
        })))
        .mount(&server)
        .await;
    // Either may be on the PR already: unconfirmed, so it is checked
    // before it is sent again rather than retried blindly.
    for write in [reply("Thanks"), start(None, 3)] {
        assert!(matches!(
            client
                .write_review_thread(&token(), &demo_repo(), 7, &write)
                .await,
            Err(GitHubError::Unconfirmed { .. })
        ));
    }
}

#[tokio::test]
async fn an_unanswered_write_is_a_timeout_not_a_failure() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(
            ok(json!({ "addPullRequestReviewThreadReply": { "comment": { "id": "late" } } }))
                .set_delay(Duration::from_secs(5)),
        )
        .mount(&server)
        .await;
    let client =
        GitHubClient::with_base_url_and_timeout(&server.uri(), Duration::from_millis(200)).unwrap();
    assert!(matches!(
        client
            .write_review_thread(&token(), &demo_repo(), 7, &reply("Thanks"))
            .await,
        Err(GitHubError::Timeout { .. })
    ));
}
