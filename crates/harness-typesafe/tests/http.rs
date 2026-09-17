use std::{collections::BTreeMap, time::Duration};

use serde_json::{Value, json};
use vertebrae_harness_typesafe::{
    Answer, ChoiceAnswer, DEFAULT_MODEL, Question, SystemOneRequest, TypeSafeClient,
    TypeSafeClientConfig, TypeSafeError, Usage,
};
use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

fn request() -> SystemOneRequest {
    SystemOneRequest::new(
        json!({"message": "The export button is broken."}),
        BTreeMap::from([(
            "team".to_string(),
            Question::choice(
                "Which team should handle this?",
                BTreeMap::from([
                    ("billing".to_string(), Value::from("Charges and invoices")),
                    ("technical".to_string(), Value::from("Product failures")),
                ]),
            ),
        )]),
    )
}

fn success_body() -> Value {
    json!({
        "model": DEFAULT_MODEL,
        "answers": {
            "team": {
                "type": "choice",
                "choice": "technical",
                "probabilities": {"billing": 0.08, "technical": 0.92},
                "confidence": 0.85
            }
        },
        "usage": {"input_tokens": 312, "output_tokens": 48}
    })
}

fn client(server: &MockServer) -> TypeSafeClient {
    TypeSafeClient::from_config(
        TypeSafeClientConfig::new("test-key")
            .with_base_url(server.uri())
            .with_timeout(Duration::from_secs(2)),
    )
    .unwrap()
}

#[tokio::test]
async fn sends_authenticated_post_and_captures_request_id_and_usage() {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .and(matchers::header("authorization", "Bearer test-key"))
        .and(matchers::header("content-type", "application/json"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-typesafe-request-id", "req-success")
                .set_body_json(success_body()),
        )
        .expect(1)
        .mount(&server)
        .await;

    let response = client(&server).system_one(request()).await.unwrap();
    assert_eq!(response.request_id.as_deref(), Some("req-success"));
    assert_eq!(response.usage.input_tokens, 312);
    assert!(matches!(
        response.answers["team"],
        Answer::Choice(ChoiceAnswer { .. })
    ));

    let requests = server.received_requests().await.unwrap();
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["model"], DEFAULT_MODEL);
    assert_eq!(body["questions"]["team"]["type"], "choice");
}

#[tokio::test]
async fn transient_service_errors_are_returned_without_retry() {
    for status in [429, 529] {
        let server = MockServer::start().await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path("/v1/systemone"))
            .respond_with(
                ResponseTemplate::new(status)
                    .insert_header("x-typesafe-request-id", format!("req-{status}"))
                    .set_body_string("provider details are intentionally not surfaced"),
            )
            .expect(1)
            .mount(&server)
            .await;

        let error = client(&server).system_one(request()).await.unwrap_err();
        assert_eq!(error.status(), Some(status));
        assert_eq!(error.request_id(), Some(format!("req-{status}").as_str()));
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn api_errors_preserve_status_and_request_id_without_body_secrets() {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("x-typesafe-request-id", "req-limited")
                .set_body_string("test-key must never appear in diagnostics"),
        )
        .mount(&server)
        .await;

    let error = client(&server).system_one(request()).await.unwrap_err();
    assert_eq!(error.status(), Some(429));
    assert_eq!(error.request_id(), Some("req-limited"));
    assert!(!error.to_string().contains("test-key"));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn authentication_failure_is_typed_and_does_not_retry() {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .respond_with(ResponseTemplate::new(401).set_body_string("invalid API key"))
        .expect(1)
        .mount(&server)
        .await;

    let error = client(&server).system_one(request()).await.unwrap_err();
    assert!(matches!(error, TypeSafeError::ApiError { status: 401, .. }));
    assert!(error.to_string().contains("authentication failed"));
}

#[tokio::test]
async fn malformed_answers_are_rejected_after_http_success() {
    let server = MockServer::start().await;
    let mut body = success_body();
    body["answers"]["team"]["choice"] = json!("unknown");
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;

    let error = client(&server).system_one(request()).await.unwrap_err();
    assert!(matches!(error, TypeSafeError::MalformedResponse(_)));
}

#[tokio::test]
async fn timeout_is_distinct_from_http_errors() {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(100))
                .set_body_json(success_body()),
        )
        .mount(&server)
        .await;

    let client = TypeSafeClient::from_config(
        TypeSafeClientConfig::new("test-key")
            .with_base_url(server.uri())
            .with_timeout(Duration::from_millis(20)),
    )
    .unwrap();
    let error = client.system_one(request()).await.unwrap_err();
    assert!(matches!(error, TypeSafeError::Timeout { .. }));
}

#[tokio::test]
async fn oversized_response_is_rejected_before_decoding() {
    let server = MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path("/v1/systemone"))
        .respond_with(ResponseTemplate::new(200).set_body_string("0123456789"))
        .mount(&server)
        .await;

    let client = TypeSafeClient::from_config(
        TypeSafeClientConfig::new("test-key")
            .with_base_url(server.uri())
            .with_max_response_bytes(5),
    )
    .unwrap();
    let error = client.system_one(request()).await.unwrap_err();
    assert!(matches!(error, TypeSafeError::ResponseTooLarge));
}

#[tokio::test]
async fn missing_api_key_fails_before_any_outbound_request() {
    let server = MockServer::start().await;
    let error =
        TypeSafeClient::from_config(TypeSafeClientConfig::new("   ").with_base_url(server.uri()))
            .unwrap_err();
    assert!(matches!(error, TypeSafeError::MissingApiKey));
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[test]
fn usage_fixture_has_only_documented_token_fields() {
    let usage: Usage = serde_json::from_value(json!({
        "input_tokens": 10,
        "output_tokens": 20
    }))
    .unwrap();
    assert_eq!(usage.input_tokens + usage.output_tokens, 30);
}
