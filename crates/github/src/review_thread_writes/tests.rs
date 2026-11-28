use super::*;
use crate::client::MAX_RESPONSE_BODY_BYTES;
use std::time::Duration;
use wiremock::{
    matchers::{body_partial_json, body_string_contains, method, path},
    Mock, MockServer, ResponseTemplate,
};

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
    ReviewThreadWrite::Start {
        pull_request_id: "PR_synthetic7".into(),
        thread: NewReviewThread {
            path: "src/retry.rs".into(),
            side: DiffSide::Right,
            start_line,
            line,
            body: "Should this reset the budget?".into(),
        },
    }
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
        let (_, variables, _) = mutation(&write);
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
    let write = ReviewThreadWrite::Start {
        pull_request_id: "PR_node".into(),
        thread: NewReviewThread {
            path: "src/retry.rs".into(),
            side,
            start_line,
            line,
            body: "Why?".into(),
        },
    };
    let valid = line > 0 && start_line.is_none_or(|start| (1..=line).contains(&start));
    assert_eq!(validate(&write).is_ok(), valid);
    if !valid {
        return;
    }
    let (_, variables, field) = mutation(&write);
    assert_eq!(field, "addPullRequestReview");
    assert_eq!(variables["pullRequest"], json!("PR_node"));
    assert_eq!(variables["line"], json!(line));
    let ranged = start_line.is_some_and(|start| start < line);
    assert_eq!(variables["startLine"].is_null(), !ranged);
    assert_eq!(variables["startSide"].is_null(), !ranged);
    // GitHub's DiffSide enum values, spelled out independently.
    let wire_side = match side {
        DiffSide::Left => "LEFT",
        DiffSide::Right => "RIGHT",
    };
    assert_eq!(variables["side"], json!(wire_side));
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
        async move { client.write_review_thread(&token(), &write).await }
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
        .write_review_thread(&token(), &start(Some(12), 14))
        .await
        .unwrap();
    assert_eq!(id, "PRRT_started");
    // The pull request's node ID comes with the write: one request only.
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
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
        async move { client.write_review_thread(&token(), &write).await }
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
    let mut elsewhere = start(None, 3);
    if let ReviewThreadWrite::Start {
        pull_request_id, ..
    } = &mut elsewhere
    {
        *pull_request_id = "PR 7".into();
    }
    let bad_thread = ReviewThreadWrite::Resolve {
        thread_id: "github-thread:PRRT_1".into(),
    };
    for invalid in [
        reply("  \n"),
        start(Some(9), 3),
        start(None, 0),
        elsewhere,
        bad_thread,
    ] {
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
            client.write_review_thread(&token(), &write).await,
            Err(GitHubError::Unconfirmed { .. })
        ));
    }
}

/// Every answer GitHub can give a write after receiving it, by whether it
/// can have been applied: a server error, an unreadable answer or an
/// untyped GraphQL error is unconfirmed; a refusal or a client error is not.
#[tokio::test]
async fn answers_after_github_received_a_write_are_unconfirmed_unless_refused() {
    type Expected = fn(&GitHubError) -> bool;
    let cases: [(ResponseTemplate, Expected); 7] = [
        (ResponseTemplate::new(502).set_body_string("<html>bad gateway</html>"), |e| {
            matches!(e, GitHubError::Unconfirmed { message } if message.contains("502"))
        }),
        (ResponseTemplate::new(504), |e| matches!(e, GitHubError::Unconfirmed { .. })),
        (ResponseTemplate::new(200).set_body_string("{\"data\": {\"addPull"), |e| {
            matches!(e, GitHubError::Unconfirmed { .. })
        }),
        (
            ResponseTemplate::new(200).set_body_string("x".repeat(MAX_RESPONSE_BODY_BYTES + 1)),
            |e| matches!(e, GitHubError::Unconfirmed { message } if message.contains("byte limit")),
        ),
        (
            ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{ "message": "Something went wrong while executing your query. This may be the result of a timeout" }]
            })),
            |e| matches!(e, GitHubError::Unconfirmed { .. }),
        ),
        (
            ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{ "type": "NOT_FOUND", "message": "Could not resolve to a node" }]
            })),
            |e| matches!(e, GitHubError::NotFound { .. }),
        ),
        (ResponseTemplate::new(422).set_body_json(json!({ "message": "Unprocessable" })), |e| {
            matches!(e, GitHubError::Http { status: 422, .. })
        }),
    ];
    for (answer, expected) in cases {
        for write in [reply("Thanks"), start(None, 3)] {
            let (server, client) = server().await;
            Mock::given(method("POST"))
                .and(path("/graphql"))
                .respond_with(answer.clone())
                .expect(1)
                .mount(&server)
                .await;
            let err = client
                .write_review_thread(&token(), &write)
                .await
                .unwrap_err();
            assert!(expected(&err), "{write:?} -> {err:?}");
        }
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
        client.write_review_thread(&token(), &reply("Thanks")).await,
        Err(GitHubError::Timeout { .. })
    ));
}

/// A connection that drops once the request is out leaves the write's
/// outcome unknown, unlike one that never connected: the first must be
/// checked before it is sent again, the second is safe to resend.
#[tokio::test]
async fn a_dropped_answer_is_interrupted_and_no_connection_is_network() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0; 4096];
        // Read the request, then hang up without answering.
        let _ = socket.read(&mut request).await.unwrap();
    });
    let client = GitHubClient::with_base_url(&format!("http://{address}")).unwrap();
    let dropped = client.write_review_thread(&token(), &reply("Thanks")).await;
    server.await.unwrap();
    assert!(
        matches!(dropped, Err(GitHubError::Interrupted { .. })),
        "{dropped:?}"
    );

    // Nothing listens on a port just released.
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = closed.local_addr().unwrap();
    drop(closed);
    let client = GitHubClient::with_base_url(&format!("http://{address}")).unwrap();
    let refused = client.write_review_thread(&token(), &reply("Thanks")).await;
    assert!(
        matches!(refused, Err(GitHubError::Network { .. })),
        "{refused:?}"
    );
}
