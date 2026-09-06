//! Local daemon service install/update is a separate responsibility owned by
//! [`crate::install`]. Every command captures the connection identity before
//! dispatch and re-checks it after the response, so stale payloads (possibly
//! carrying the previous account's one-time token) are discarded as
//! `stale_connection`; `ambiguous_transport` must not be auto-retried.

use super::*;
use crate::types::{
    DaemonBootstrapResult, DaemonDetailSnapshot, DaemonEnrollmentSnapshot, DaemonFleetSnapshot,
    DaemonMutationResult, DaemonNameUpdate,
};
use vertebrae_sacrum_client::daemon_service::{DaemonRefusal, DaemonRename, DaemonServiceError};
use vertebrae_sacrum_client::SacrumDaemonService;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DaemonErrorKind {
    NoBackend,
    StaleConnection,
    AmbiguousTransport,
    MalformedResponse,
    Unavailable,
    NotFound,
    TerminalState,
    ActiveSession,
    OwnershipUnknown,
    InvalidName,
    InvalidInput,
    UnknownRefusal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonCommandError {
    pub kind: DaemonErrorKind,
    pub message: String,
}

impl DaemonCommandError {
    fn new(kind: DaemonErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn no_backend() -> Self {
        Self::new(
            DaemonErrorKind::NoBackend,
            "No Sacrum backend connection is active.",
        )
    }

    fn stale_connection() -> Self {
        Self::new(
            DaemonErrorKind::StaleConnection,
            "The Sacrum connection changed while the request was in flight; the response was discarded.",
        )
    }
}

impl From<DaemonServiceError> for DaemonCommandError {
    fn from(error: DaemonServiceError) -> Self {
        match error {
            DaemonServiceError::AmbiguousTransport(source) => Self::new(
                DaemonErrorKind::AmbiguousTransport,
                format!(
                    "network ambiguity: the daemon operation may have been applied; refresh the fleet and recover explicitly ({source})"
                ),
            ),
            DaemonServiceError::Unavailable(source) => Self::new(
                DaemonErrorKind::Unavailable,
                format!("backend unavailable: {source}"),
            ),
            DaemonServiceError::Refused(refusal) => match refusal {
                DaemonRefusal::NotFound => Self::new(DaemonErrorKind::NotFound, refusal.to_string()),
                DaemonRefusal::TerminalState => {
                    Self::new(DaemonErrorKind::TerminalState, refusal.to_string())
                }
                DaemonRefusal::ActiveSession => {
                    Self::new(DaemonErrorKind::ActiveSession, refusal.to_string())
                }
                DaemonRefusal::OwnershipUnknown => {
                    Self::new(DaemonErrorKind::OwnershipUnknown, refusal.to_string())
                }
                DaemonRefusal::Other(message) => {
                    Self::new(DaemonErrorKind::UnknownRefusal, message)
                }
            },
            DaemonServiceError::InvalidName(message) => {
                Self::new(DaemonErrorKind::InvalidName, message)
            }
            DaemonServiceError::MalformedResponse(message) => {
                Self::new(DaemonErrorKind::MalformedResponse, message)
            }
            DaemonServiceError::InvalidInput { field, message } => Self::new(
                DaemonErrorKind::InvalidInput,
                format!("invalid {field}: {message}"),
            ),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_sacrum_connection_identity(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    let client = state.sacrum_client.read().await;
    Ok(client
        .as_ref()
        .map(|client| client.connection_identity().to_string()))
}

async fn connection_for_service(
    state: &State<'_, AppState>,
) -> Result<(SacrumDaemonService, String), DaemonCommandError> {
    let client = state.sacrum_client.read().await;
    let client = client.as_ref().ok_or_else(DaemonCommandError::no_backend)?;
    Ok((
        SacrumDaemonService::new((**client).clone()),
        client.connection_identity().to_string(),
    ))
}

async fn reject_stale_connection(
    state: &State<'_, AppState>,
    captured: &str,
) -> Result<(), DaemonCommandError> {
    let client = state.sacrum_client.read().await;
    let is_current = client
        .as_ref()
        .is_some_and(|client| client.connection_identity() == captured);
    if is_current {
        Ok(())
    } else {
        Err(DaemonCommandError::stale_connection())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn list_daemon_fleet(
    state: State<'_, AppState>,
) -> Result<DaemonFleetSnapshot, DaemonCommandError> {
    let (service, connection_id) = connection_for_service(&state).await?;
    let daemons = service.list_fleet().await?;
    reject_stale_connection(&state, &connection_id).await?;
    log::info!(
        "[daemon] fleet listed {} daemons on connection {connection_id}",
        daemons.len()
    );
    Ok(DaemonFleetSnapshot {
        connection_id,
        daemons: daemons.into_iter().map(Into::into).collect(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_daemon(
    state: State<'_, AppState>,
    daemon_id: String,
) -> Result<DaemonDetailSnapshot, DaemonCommandError> {
    let (service, connection_id) = connection_for_service(&state).await?;
    let daemon = service.get_daemon(&daemon_id).await?;
    reject_stale_connection(&state, &connection_id).await?;
    Ok(DaemonDetailSnapshot {
        connection_id,
        daemon: daemon.map(Into::into),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_daemon_enrollment_metadata(
    state: State<'_, AppState>,
    daemon_id: String,
) -> Result<DaemonEnrollmentSnapshot, DaemonCommandError> {
    let (service, connection_id) = connection_for_service(&state).await?;
    let metadata = service.get_enrollment_metadata(&daemon_id).await?;
    reject_stale_connection(&state, &connection_id).await?;
    log::info!(
        "[daemon] enrollment metadata read for daemon {daemon_id} on connection {connection_id}"
    );
    Ok(DaemonEnrollmentSnapshot {
        connection_id,
        metadata: metadata.map(Into::into),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn create_daemon(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<DaemonBootstrapResult, DaemonCommandError> {
    let (service, connection_id) = connection_for_service(&state).await?;
    let bootstrap = service.create_daemon(name.as_deref()).await?;
    reject_stale_connection(&state, &connection_id).await?;
    // Deliberately no token in diagnostics: identity and expiry only.
    log::info!(
        "[daemon] bootstrap issued for daemon {} (expires {})",
        bootstrap.daemon.id,
        bootstrap.expires_at.to_rfc3339()
    );
    Ok(DaemonBootstrapResult {
        connection_id,
        bootstrap: bootstrap.into(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn rename_daemon(
    state: State<'_, AppState>,
    daemon_id: String,
    name: DaemonNameUpdate,
) -> Result<DaemonMutationResult, DaemonCommandError> {
    let (service, connection_id) = connection_for_service(&state).await?;
    let rename: DaemonRename = name.into();
    let daemon = service.rename_daemon(&daemon_id, rename).await?;
    reject_stale_connection(&state, &connection_id).await?;
    Ok(DaemonMutationResult {
        connection_id,
        daemon: daemon.into(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn revoke_daemon(
    state: State<'_, AppState>,
    daemon_id: String,
) -> Result<DaemonMutationResult, DaemonCommandError> {
    let (service, connection_id) = connection_for_service(&state).await?;
    let daemon = service.revoke_daemon(&daemon_id).await?;
    reject_stale_connection(&state, &connection_id).await?;
    log::info!("[daemon] revoked daemon {}", daemon.id);
    Ok(DaemonMutationResult {
        connection_id,
        daemon: daemon.into(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn unregister_daemon(
    state: State<'_, AppState>,
    daemon_id: String,
) -> Result<DaemonMutationResult, DaemonCommandError> {
    let (service, connection_id) = connection_for_service(&state).await?;
    let daemon = service.unregister_daemon(&daemon_id).await?;
    reject_stale_connection(&state, &connection_id).await?;
    log::info!("[daemon] unregistered daemon {}", daemon.id);
    Ok(DaemonMutationResult {
        connection_id,
        daemon: daemon.into(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn rotate_daemon_credentials(
    state: State<'_, AppState>,
    daemon_id: String,
) -> Result<DaemonBootstrapResult, DaemonCommandError> {
    let (service, connection_id) = connection_for_service(&state).await?;
    let bootstrap = service.rotate_credentials(&daemon_id).await?;
    reject_stale_connection(&state, &connection_id).await?;
    log::info!(
        "[daemon] bootstrap rotated for daemon {} (expires {})",
        bootstrap.daemon.id,
        bootstrap.expires_at.to_rfc3339()
    );
    Ok(DaemonBootstrapResult {
        connection_id,
        bootstrap: bootstrap.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::build_app_without_services;
    use serde_json::json;
    use std::sync::Arc;
    use tauri::Manager;
    use vertebrae_sacrum_client::SacrumConfig;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const DAEMON_ID: &str = "33333333-3333-3333-3333-333333333333";
    const ONE_TIME_TOKEN: &str = "dtoken_dummy_one_time_value";

    fn daemon_json() -> serde_json::Value {
        json!({
            "id": DAEMON_ID,
            "status": "pending",
            "name": null,
            "display_name": "33333333",
            "enrolled_at": null,
            "removed_at": null,
            "inserted_at": "2026-09-05T10:00:00Z",
            "updated_at": "2026-09-05T10:00:00Z"
        })
    }

    fn build_app_with_client(
        server: &MockServer,
        token: &str,
    ) -> tauri::App<tauri::test::MockRuntime> {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let project_config = ProjectConfig::with_path(tmp.path().to_path_buf());
        let client = Arc::new(vertebrae_sacrum_client::GraphqlClient::new(
            SacrumConfig::new(server.uri(), token.to_string(), "project".to_string()),
        ));

        tauri::test::mock_builder()
            .manage(AppState {
                services: RwLock::new(None),
                sacrum_client: RwLock::new(Some(client)),
                project_config,
            })
            .manage(LocalChatSessionManager::with_harnesses_for_tests(Vec::new()))
            .manage(tokio::sync::Mutex::new(
                crate::websocket_client::SacrumSocket::disconnected(),
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    #[tokio::test]
    async fn daemon_commands_require_a_backend_connection() {
        let app = build_app_without_services();
        let error = list_daemon_fleet(app.state()).await.unwrap_err();
        assert_eq!(error.kind, DaemonErrorKind::NoBackend);

        let error = create_daemon(app.state(), None).await.unwrap_err();
        assert_eq!(error.kind, DaemonErrorKind::NoBackend);
    }

    #[tokio::test]
    async fn identity_command_reports_none_without_a_client() {
        let app = build_app_without_services();
        assert_eq!(
            get_sacrum_connection_identity(app.state()).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn fleet_listing_flows_service_to_snapshot() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("ListDaemonFleet"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "daemons": [daemon_json()] }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let app = build_app_with_client(&server, "account-token");

        let snapshot = list_daemon_fleet(app.state()).await.unwrap();
        assert_eq!(snapshot.daemons.len(), 1);
        assert_eq!(snapshot.daemons[0].id, DAEMON_ID);
        assert_eq!(snapshot.daemons[0].status, "pending");
        assert_eq!(
            snapshot.connection_id,
            app.state::<AppState>()
                .sacrum_client
                .read()
                .await
                .as_ref()
                .unwrap()
                .connection_identity()
        );
        server.verify().await;
    }

    #[tokio::test]
    async fn create_maps_bootstrap_and_rotates_issue_tokens() {
        for document in ["CreateDaemon", "RotateDaemonCredentials"] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/graphql"))
                .and(body_string_contains(document))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "data": {
                        "createDaemon": {
                            "daemon": daemon_json(),
                            "enrollment_token": ONE_TIME_TOKEN,
                            "expires_at": "2026-09-05T12:00:00Z"
                        },
                        "rotateDaemonCredentials": {
                            "daemon": daemon_json(),
                            "enrollment_token": ONE_TIME_TOKEN,
                            "expires_at": "2026-09-06T12:00:00Z"
                        }
                    }
                })))
                .expect(1)
                .mount(&server)
                .await;
            let app = build_app_with_client(&server, "account-token");

            let result = if document == "CreateDaemon" {
                create_daemon(app.state(), Some("Farm bot".into()))
                    .await
                    .unwrap()
            } else {
                rotate_daemon_credentials(app.state(), DAEMON_ID.into())
                    .await
                    .unwrap()
            };
            assert_eq!(result.bootstrap.enrollment_token, ONE_TIME_TOKEN);
            assert_eq!(result.bootstrap.daemon.id, DAEMON_ID);
            assert!(!result.connection_id.is_empty());
            server.verify().await;
        }
    }

    #[tokio::test]
    async fn terminal_errors_adapt_to_structured_kinds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{ "message": "daemon is in a terminal state (revoked or removed)" }]
            })))
            .mount(&server)
            .await;
        let app = build_app_with_client(&server, "account-token");

        let error = rotate_daemon_credentials(app.state(), DAEMON_ID.into())
            .await
            .unwrap_err();
        assert_eq!(error.kind, DaemonErrorKind::TerminalState);
        assert!(error.message.contains("terminal state"));
        assert!(!error.message.contains("account-token"));
    }

    #[tokio::test]
    async fn not_found_errors_adapt_to_the_documented_refusal() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{ "message": "daemon not found" }]
            })))
            .mount(&server)
            .await;
        let app = build_app_with_client(&server, "account-token");

        let error = revoke_daemon(app.state(), DAEMON_ID.into())
            .await
            .unwrap_err();
        assert_eq!(error.kind, DaemonErrorKind::NotFound);
    }

    #[tokio::test]
    async fn ambiguous_transport_surfaces_the_recovery_kind() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
            .mount(&server)
            .await;
        let app = build_app_with_client(&server, "account-token");

        let error = create_daemon(app.state(), None).await.unwrap_err();
        assert_eq!(error.kind, DaemonErrorKind::AmbiguousTransport);
        assert!(error.message.contains("may have been applied"));
    }

    #[tokio::test]
    async fn late_responses_from_a_retired_connection_are_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateDaemon"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({
                        "data": { "createDaemon": {
                            "daemon": daemon_json(),
                            "enrollment_token": ONE_TIME_TOKEN,
                            "expires_at": "2026-09-05T12:00:00Z"
                        }}
                    }))
                    // Hold the response long enough to swap the connection.
                    .set_delay(std::time::Duration::from_millis(250)),
            )
            .expect(1)
            .mount(&server)
            .await;
        let app = build_app_with_client(&server, "account-one");

        let state = app.state::<AppState>();
        let mut command = Box::pin(create_daemon(app.state(), None));
        tokio::select! {
            result = &mut command => {
                panic!("command completed before the connection swap: {result:?}");
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
        }
        let replacement = Arc::new(vertebrae_sacrum_client::GraphqlClient::new(
            SacrumConfig::new(server.uri(), "account-two".to_string(), "project".into()),
        ));
        *state.sacrum_client.write().await = Some(replacement);

        let error = command.await.unwrap_err();
        assert_eq!(error.kind, DaemonErrorKind::StaleConnection);
        assert!(!error.message.contains(ONE_TIME_TOKEN));
        server.verify().await;
    }

    #[tokio::test]
    async fn rename_preserves_the_omitted_null_set_distinction() {
        for (update, expected) in [
            (DaemonNameUpdate::Unchanged, json!({ "id": DAEMON_ID })),
            (
                DaemonNameUpdate::Clear,
                json!({ "id": DAEMON_ID, "name": null }),
            ),
            (
                DaemonNameUpdate::Set {
                    value: "Renamed".into(),
                },
                json!({ "id": DAEMON_ID, "name": "Renamed" }),
            ),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/graphql"))
                .and(body_string_contains("RenameDaemon"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "data": { "renameDaemon": daemon_json() }
                })))
                .mount(&server)
                .await;
            let app = build_app_with_client(&server, "account-token");

            rename_daemon(app.state(), DAEMON_ID.into(), update)
                .await
                .unwrap();

            let request = &server.received_requests().await.unwrap()[0];
            let variables = serde_json::from_slice::<serde_json::Value>(&request.body)
                .unwrap()
                .get("variables")
                .cloned()
                .unwrap();
            assert_eq!(variables, expected);
        }
    }
}
