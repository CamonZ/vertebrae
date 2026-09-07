use super::types::{
    REFUSAL_ACTIVE_SESSION, REFUSAL_NOT_FOUND, REFUSAL_OWNERSHIP_UNKNOWN, REFUSAL_TERMINAL_STATE,
};
use super::*;
use crate::client::GraphqlClient;
use crate::config::SacrumConfig;
use crate::error::SacrumClientError;
use serde_json::{Value, json};
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Match, Mock, MockServer, ResponseTemplate};

const DAEMON_ID: &str = "33333333-3333-3333-3333-333333333333";
const ONE_TIME_TOKEN: &str = "dtoken_dummy_one_time_value";

#[derive(Debug)]
struct VariablesExactly(Value);

impl Match for VariablesExactly {
    fn matches(&self, request: &wiremock::Request) -> bool {
        request
            .body_json::<Value>()
            .ok()
            .and_then(|body| body.get("variables").cloned())
            .as_ref()
            == Some(&self.0)
    }
}

fn service(server: &MockServer) -> SacrumDaemonService {
    SacrumDaemonService::new(GraphqlClient::new(SacrumConfig::new(
        server.uri(),
        "test-account-token".into(),
        "irrelevant-project-id".into(),
    )))
}

fn daemon_json(status: &str, name: Option<&str>) -> Value {
    json!({
        "id": DAEMON_ID,
        "status": status,
        "name": name,
        "display_name": name.unwrap_or("33333333"),
        "enrolled_at": if status == "pending" { Value::Null } else { json!("2026-09-05T11:00:00Z") },
        "removed_at": Value::Null,
        "inserted_at": "2026-09-05T10:00:00Z",
        "updated_at": "2026-09-05T10:00:00Z"
    })
}

#[test]
fn daemon_status_serde_round_trips_the_documented_snake_case_names() {
    for (variant, wire) in [
        (DaemonStatus::Pending, "pending"),
        (DaemonStatus::Active, "active"),
        (DaemonStatus::Revoked, "revoked"),
        (DaemonStatus::Removed, "removed"),
    ] {
        assert_eq!(serde_json::to_value(variant.clone()).unwrap(), json!(wire));
        assert_eq!(
            serde_json::from_value::<DaemonStatus>(json!(wire)).unwrap(),
            variant
        );
    }
}

#[test]
fn daemon_status_preserves_unknown_future_values() {
    assert_eq!(
        "pending".parse::<DaemonStatus>().unwrap(),
        DaemonStatus::Pending
    );
    let unknown: DaemonStatus = "quarantined_by_future_policy".parse().unwrap();
    assert_eq!(
        unknown,
        DaemonStatus::Unknown("quarantined_by_future_policy".into())
    );
    assert!(!unknown.is_known());
    assert!(!unknown.is_terminal());
    assert!(DaemonStatus::Revoked.is_terminal());
    assert!(DaemonStatus::Removed.is_terminal());
    assert!(!DaemonStatus::Active.is_terminal());
    assert_eq!(unknown.to_string(), "quarantined_by_future_policy");
    assert_eq!(
        serde_json::to_value(&unknown).unwrap(),
        json!("quarantined_by_future_policy")
    );
    let parsed: DaemonStatus =
        serde_json::from_value(json!("quarantined_by_future_policy")).unwrap();
    assert_eq!(parsed, unknown);
}

#[test]
fn daemon_summary_serializes_without_secret_fields() {
    let summary = DaemonSummary {
        id: DAEMON_ID.into(),
        status: DaemonStatus::Active,
        name: Some("Farm bot".into()),
        display_name: "Farm bot".into(),
        enrolled_at: None,
        removed_at: None,
        inserted_at: None,
        updated_at: None,
    };
    let body = serde_json::to_value(&summary).unwrap().to_string();
    assert!(!body.contains("token"));
    assert!(!body.contains("secret"));
    assert!(!body.contains("hash"));
}

#[tokio::test]
async fn list_fleet_maps_the_active_fleet_and_preserves_unknown_statuses() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("ListDaemonFleet"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "daemons": [
                daemon_json("pending", None),
                daemon_json("active", Some("Farm bot")),
                daemon_json("paused_by_future_policy", None)
            ]}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let fleet = service(&server).list_fleet().await.unwrap();
    assert_eq!(fleet.len(), 3);
    assert_eq!(fleet[0].status, DaemonStatus::Pending);
    assert_eq!(fleet[0].display_name, "33333333");
    assert_eq!(fleet[1].status, DaemonStatus::Active);
    assert_eq!(
        fleet[1].enrolled_at.map(|dt| dt.to_rfc3339()),
        Some("2026-09-05T11:00:00+00:00".into())
    );
    assert_eq!(
        fleet[2].status,
        DaemonStatus::Unknown("paused_by_future_policy".into())
    );
    server.verify().await;
}

#[tokio::test]
async fn get_daemon_maps_null_to_none() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("GetDaemon"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "daemon": null }
        })))
        .mount(&server)
        .await;

    assert!(
        service(&server)
            .get_daemon(DAEMON_ID)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn get_daemon_rejects_malformed_ids_before_sending() {
    let server = MockServer::start().await;
    let result = service(&server).get_daemon("not-a-uuid").await;
    assert!(matches!(
        result,
        Err(DaemonServiceError::InvalidInput {
            field: "daemon id",
            ..
        })
    ));
    let hits = server.received_requests().await.unwrap();
    assert!(hits.is_empty());
}

#[tokio::test]
async fn enrollment_metadata_carries_the_credential_audit_without_tokens() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("GetDaemonEnrollmentMetadata"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "daemonEnrollmentMetadata": {
                "daemon_id": DAEMON_ID,
                "status": "active",
                "enrolled_at": "2026-09-05T11:00:00Z",
                "credentials": [
                    {
                        "id": "44444444-4444-4444-4444-444444444444",
                        "credential_kind": "bootstrap",
                        "status": "consumed",
                        "expires_at": "2026-09-12T11:00:00Z",
                        "consumed_at": "2026-09-05T11:30:00Z",
                        "revoked_at": null,
                        "inserted_at": null,
                        "updated_at": null
                    },
                    {
                        "id": "55555555-5555-5555-5555-555555555555",
                        "credential_kind": "reconnect",
                        "status": "active",
                        "expires_at": "2026-10-05T11:00:00Z",
                        "consumed_at": null,
                        "revoked_at": null,
                        "inserted_at": null,
                        "updated_at": null
                    }
                ]
            }}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let metadata = service(&server)
        .get_enrollment_metadata(DAEMON_ID)
        .await
        .unwrap()
        .expect("metadata present");
    assert_eq!(metadata.status, DaemonStatus::Active);
    assert_eq!(metadata.credentials.len(), 2);
    assert_eq!(metadata.credentials[0].credential_kind, "bootstrap");
    assert!(metadata.credentials[0].consumed_at.is_some());
    assert_eq!(metadata.credentials[1].credential_kind, "reconnect");
    let body = serde_json::to_value(&metadata).unwrap().to_string();
    assert!(!body.contains(ONE_TIME_TOKEN));
    assert!(!body.contains("token"));
    server.verify().await;
}

#[tokio::test]
async fn create_daemon_omits_the_name_argument_when_none() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("CreateDaemon"))
        .and(VariablesExactly(json!({})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "createDaemon": {
                "daemon": daemon_json("pending", None),
                "enrollment_token": ONE_TIME_TOKEN,
                "expires_at": "2026-09-05T12:00:00Z"
            }}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let bootstrap = service(&server).create_daemon(None).await.unwrap();
    assert_eq!(bootstrap.enrollment_token, ONE_TIME_TOKEN);
    assert_eq!(bootstrap.daemon.status, DaemonStatus::Pending);
    assert_eq!(
        bootstrap.expires_at.to_rfc3339(),
        "2026-09-05T12:00:00+00:00"
    );
    server.verify().await;
}

#[tokio::test]
async fn create_daemon_sends_the_name_when_provided() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("CreateDaemon"))
        .and(VariablesExactly(json!({ "name": "Farm bot" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "createDaemon": {
                "daemon": daemon_json("pending", Some("Farm bot")),
                "enrollment_token": ONE_TIME_TOKEN,
                "expires_at": "2026-09-05T12:00:00Z"
            }}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let bootstrap = service(&server)
        .create_daemon(Some("Farm bot"))
        .await
        .unwrap();
    assert_eq!(bootstrap.daemon.name.as_deref(), Some("Farm bot"));
    server.verify().await;
}

#[tokio::test]
async fn rename_daemon_distinguishes_omitted_null_and_set() {
    for (rename, expected_variables) in [
        (DaemonRename::Unchanged, json!({ "id": DAEMON_ID })),
        (
            DaemonRename::Clear,
            json!({ "id": DAEMON_ID, "name": null }),
        ),
        (
            DaemonRename::Set("Renamed".into()),
            json!({ "id": DAEMON_ID, "name": "Renamed" }),
        ),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("RenameDaemon"))
            .and(VariablesExactly(expected_variables))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "renameDaemon": daemon_json("active", Some("Renamed")) }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let renamed = service(&server)
            .rename_daemon(DAEMON_ID, rename)
            .await
            .unwrap();
        assert_eq!(renamed.id, DAEMON_ID);
        server.verify().await;
    }
}

#[tokio::test]
async fn revoke_and_unregister_return_the_terminal_projection() {
    for (document, field, status) in [
        ("RevokeDaemon", "revokeDaemon", "revoked"),
        ("UnregisterDaemon", "unregisterDaemon", "removed"),
    ] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains(document))
            .and(VariablesExactly(json!({ "id": DAEMON_ID })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { field: daemon_json(status, Some("Retired")) }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let service = service(&server);
        let summary = if status == "revoked" {
            service.revoke_daemon(DAEMON_ID).await.unwrap()
        } else {
            service.unregister_daemon(DAEMON_ID).await.unwrap()
        };
        assert_eq!(summary.status.as_str(), status);
        server.verify().await;
    }
}

#[tokio::test]
async fn rotate_credentials_returns_a_fresh_bootstrap() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("RotateDaemonCredentials"))
        .and(VariablesExactly(json!({ "id": DAEMON_ID })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "rotateDaemonCredentials": {
                "daemon": daemon_json("active", Some("Farm bot")),
                "enrollment_token": ONE_TIME_TOKEN,
                "expires_at": "2026-09-06T12:00:00Z"
            }}
        })))
        .expect(1)
        .mount(&server)
        .await;

    let bootstrap = service(&server)
        .rotate_credentials(DAEMON_ID)
        .await
        .unwrap();
    assert_eq!(bootstrap.enrollment_token, ONE_TIME_TOKEN);
    assert_eq!(bootstrap.daemon.status, DaemonStatus::Active);
    server.verify().await;
}

fn graphql_item(
    message: &str,
    path: Option<Vec<&str>>,
    extensions: Option<Value>,
) -> crate::error::GraphqlErrorItem {
    crate::error::GraphqlErrorItem {
        message: message.to_string(),
        path: path.map(|path| path.into_iter().map(str::to_string).collect()),
        extensions,
    }
}

#[tokio::test]
async fn stable_refusals_map_from_raw_item_messages_even_when_path_and_extensions_are_present() {
    for (message, expected) in [
        (REFUSAL_NOT_FOUND, DaemonRefusal::NotFound),
        (REFUSAL_TERMINAL_STATE, DaemonRefusal::TerminalState),
        (REFUSAL_ACTIVE_SESSION, DaemonRefusal::ActiveSession),
        (REFUSAL_OWNERSHIP_UNKNOWN, DaemonRefusal::OwnershipUnknown),
    ] {
        let error = SacrumClientError::GraphqlError {
            items: vec![graphql_item(
                message,
                Some(vec!["revokeDaemon"]),
                Some(json!({ "trace_id": "abc" })),
            )],
            messages: vec![format!(
                "{message} (path: revokeDaemon) (extensions: {{\"trace_id\":\"abc\"}})"
            )],
            message: format!("{message} (path: revokeDaemon)"),
        };
        let adapted = map_client_error(error, DaemonTransport::Write);
        assert!(
            matches!(adapted, DaemonServiceError::Refused(ref refusal) if *refusal == expected),
            "stable refusal must map from the raw item message: {message}"
        );
        let display = adapted.to_string();
        assert!(!display.contains("test-account-token"));
        assert!(
            !display.contains("path:"),
            "classified errors must not leak formatted GraphQL display: {display}"
        );
    }
}

#[tokio::test]
async fn refusal_codes_in_extensions_classify_without_matching_english_copy() {
    let error = SacrumClientError::GraphqlError {
        items: vec![graphql_item(
            "localized: daemon missing",
            Some(vec!["revokeDaemon"]),
            Some(json!({ "code": "not_found" })),
        )],
        messages: vec!["localized: daemon missing (path: revokeDaemon)".into()],
        message: "localized: daemon missing".into(),
    };
    let adapted = map_client_error(error, DaemonTransport::Write);
    assert!(matches!(
        adapted,
        DaemonServiceError::Refused(DaemonRefusal::NotFound)
    ));
}

#[tokio::test]
async fn name_field_errors_map_to_invalid_name() {
    let error = SacrumClientError::GraphqlError {
        items: vec![graphql_item(
            "has already been taken",
            Some(vec!["renameDaemon"]),
            Some(json!({ "field": "name" })),
        )],
        messages: vec![
            "has already been taken (path: renameDaemon) (extensions: {\"field\":\"name\"})".into(),
        ],
        message: "has already been taken (path: renameDaemon)".into(),
    };
    let adapted = map_client_error(error, DaemonTransport::Write);
    assert!(
        matches!(adapted, DaemonServiceError::InvalidName(message) if message == "has already been taken")
    );
}

#[tokio::test]
async fn backend_name_field_extensions_classify_as_invalid_name() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .and(body_string_contains("RenameDaemon"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "errors": [{
                "message": "has already been taken",
                "path": ["renameDaemon"],
                "extensions": { "field": "name" }
            }]
        })))
        .expect(1)
        .mount(&server)
        .await;

    let result = service(&server)
        .rename_daemon(DAEMON_ID, DaemonRename::Set("Farm bot".into()))
        .await;
    assert!(
        matches!(result, Err(DaemonServiceError::InvalidName(message)) if message == "has already been taken")
    );
    server.verify().await;
}

#[tokio::test]
async fn path_bearing_backend_refusals_classify_through_the_live_client() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "errors": [{
                "message": "daemon not found",
                "path": ["revokeDaemon"],
                "extensions": { "code": "not_found" }
            }]
        })))
        .mount(&server)
        .await;

    let result = service(&server).revoke_daemon(DAEMON_ID).await;
    assert!(matches!(
        result,
        Err(DaemonServiceError::Refused(DaemonRefusal::NotFound))
    ));
}

#[tokio::test]
async fn connect_failures_are_unavailable_not_ambiguous() {
    let unreachable = GraphqlClient::new(SacrumConfig::new(
        "http://127.0.0.1:1".into(),
        "test-account-token".into(),
        "irrelevant".into(),
    ));
    let result = SacrumDaemonService::new(unreachable)
        .create_daemon(None)
        .await;
    assert!(
        matches!(result, Err(DaemonServiceError::Unavailable(_))),
        "a request that never connected must be retryable, got: {result:?}"
    );
}

#[tokio::test]
async fn server_errors_on_mutations_classify_as_ambiguous() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
        .mount(&server)
        .await;

    let result = service(&server).create_daemon(None).await;
    assert!(matches!(
        result,
        Err(DaemonServiceError::AmbiguousTransport(_))
    ));
}

#[tokio::test]
async fn server_errors_on_reads_classify_as_unavailable() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
        .mount(&server)
        .await;

    let result = service(&server).list_fleet().await;
    assert!(matches!(result, Err(DaemonServiceError::Unavailable(_))));
}

#[tokio::test]
async fn missing_write_payload_after_http_success_is_ambiguous() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": null })))
        .mount(&server)
        .await;

    let result = service(&server).create_daemon(None).await;
    assert!(matches!(
        result,
        Err(DaemonServiceError::AmbiguousTransport(_))
    ));
}

#[tokio::test]
async fn missing_read_payload_after_http_success_is_malformed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": null })))
        .mount(&server)
        .await;

    let result = service(&server).list_fleet().await;
    assert!(matches!(
        result,
        Err(DaemonServiceError::MalformedResponse(_))
    ));
}

#[tokio::test]
async fn client_side_rejections_classify_as_unavailable() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
        .mount(&server)
        .await;

    let result = service(&server).list_fleet().await;
    assert!(matches!(result, Err(DaemonServiceError::Unavailable(_))));
}

#[tokio::test]
async fn malformed_timestamps_are_rejected_as_malformed_responses() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/graphql"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": { "daemons": [{
                "id": DAEMON_ID,
                "status": "active",
                "display_name": "33333333",
                "enrolled_at": "not-a-timestamp"
            }]}
        })))
        .mount(&server)
        .await;

    let result = service(&server).list_fleet().await;
    assert!(matches!(
        result,
        Err(DaemonServiceError::MalformedResponse(message)) if message.contains("enrolled_at")
    ));
}
