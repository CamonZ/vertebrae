//! Account-authenticated, project-independent daemon fleet management.
//! Safe fleet metadata is kept separate from the one-time-token
//! [`DaemonBootstrap`] payloads; ambiguous transport must never be
//! auto-retried (refresh safe metadata, offer explicit recovery), and
//! refusal mapping never embeds credential material.

use crate::api_types::{
    DaemonBootstrapResponse, DaemonCredentialMetadataResponse, DaemonEnrollmentMetadataResponse,
    DaemonResponse,
};
use crate::client::GraphqlClient;
use crate::error::SacrumClientError;
use crate::queries::daemons;
use crate::queries::daemons::DAEMON_CREDENTIAL_METADATA_FIELDS;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonStatus {
    Pending,
    Active,
    Revoked,
    Removed,
    /// Open string set: unknown statuses are preserved verbatim.
    #[serde(untagged)]
    Unknown(String),
}

impl DaemonStatus {
    pub fn as_str(&self) -> &str {
        match self {
            DaemonStatus::Pending => "pending",
            DaemonStatus::Active => "active",
            DaemonStatus::Revoked => "revoked",
            DaemonStatus::Removed => "removed",
            DaemonStatus::Unknown(status) => status,
        }
    }

    pub fn is_known(&self) -> bool {
        !matches!(self, DaemonStatus::Unknown(_))
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, DaemonStatus::Revoked | DaemonStatus::Removed)
    }
}

impl std::fmt::Display for DaemonStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for DaemonStatus {
    type Err = std::convert::Infallible;

    fn from_str(status: &str) -> Result<Self, Self::Err> {
        Ok(match status {
            "pending" => DaemonStatus::Pending,
            "active" => DaemonStatus::Active,
            "revoked" => DaemonStatus::Revoked,
            "removed" => DaemonStatus::Removed,
            other => DaemonStatus::Unknown(other.to_string()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonSummary {
    pub id: String,
    pub status: DaemonStatus,
    pub name: Option<String>,
    pub display_name: String,
    pub enrolled_at: Option<DateTime<Utc>>,
    pub removed_at: Option<DateTime<Utc>>,
    pub inserted_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonCredentialMetadata {
    pub id: String,
    pub credential_kind: String,
    pub status: String,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub inserted_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonEnrollmentMetadata {
    pub daemon_id: String,
    pub status: DaemonStatus,
    pub enrolled_at: Option<DateTime<Utc>>,
    pub credentials: Vec<DaemonCredentialMetadata>,
}

/// One-time enrollment token: shown once, never logged or persisted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaemonBootstrap {
    pub daemon: DaemonSummary,
    pub enrollment_token: String,
    pub expires_at: DateTime<Utc>,
}

/// Omitted `name` = unchanged, `name: null` = clear; collapsing destroys data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonRename {
    Unchanged,
    Clear,
    Set(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DaemonRefusal {
    #[error("daemon not found")]
    NotFound,
    #[error("daemon is in a terminal state (revoked or removed)")]
    TerminalState,
    #[error("daemon has an active session; disconnect it before unregistering")]
    ActiveSession,
    #[error(
        "daemon has enrollment history and cannot be unregistered until work ownership is established"
    )]
    OwnershipUnknown,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Error)]
pub enum DaemonServiceError {
    /// The request may have been applied; never auto-retry.
    #[error(
        "network ambiguity: the daemon operation may have been applied; refresh the fleet before retrying ({0})"
    )]
    AmbiguousTransport(#[source] SacrumClientError),

    #[error("backend unavailable: {0}")]
    Unavailable(#[source] SacrumClientError),

    #[error("{0}")]
    Refused(DaemonRefusal),

    #[error("invalid daemon name: {0}")]
    InvalidName(String),

    #[error("malformed daemon response: {0}")]
    MalformedResponse(String),

    #[error("invalid {field}: {message}")]
    InvalidInput {
        field: &'static str,
        message: String,
    },
}

const REFUSAL_NOT_FOUND: &str = "daemon not found";
const REFUSAL_TERMINAL_STATE: &str = "daemon is in a terminal state (revoked or removed)";
const REFUSAL_ACTIVE_SESSION: &str =
    "daemon has an active session; disconnect it before unregistering";
const REFUSAL_OWNERSHIP_UNKNOWN: &str =
    "daemon has enrollment history and cannot be unregistered until work ownership is established";

impl From<SacrumClientError> for DaemonServiceError {
    fn from(error: SacrumClientError) -> Self {
        if let SacrumClientError::GraphqlError {
            items, messages, ..
        } = &error
            && let Some(refusal) = classify_graphql_error(items, messages, &error.to_string())
        {
            return refusal;
        }
        match &error {
            SacrumClientError::HttpError(_)
            | SacrumClientError::SerializationError(_)
            | SacrumClientError::ApiError {
                status: 500..=599, ..
            } => DaemonServiceError::AmbiguousTransport(error),
            SacrumClientError::ConfigError(_)
            | SacrumClientError::ApiError { .. }
            | SacrumClientError::GraphqlError { .. } => DaemonServiceError::Unavailable(error),
        }
    }
}

fn classify_graphql_error(
    items: &[crate::error::GraphqlErrorItem],
    messages: &[String],
    display: &str,
) -> Option<DaemonServiceError> {
    if items.iter().any(is_name_field_error) {
        return Some(DaemonServiceError::InvalidName(display.to_string()));
    }
    for message in messages {
        let refusal = match message.trim() {
            REFUSAL_NOT_FOUND => DaemonRefusal::NotFound,
            REFUSAL_TERMINAL_STATE => DaemonRefusal::TerminalState,
            REFUSAL_ACTIVE_SESSION => DaemonRefusal::ActiveSession,
            REFUSAL_OWNERSHIP_UNKNOWN => DaemonRefusal::OwnershipUnknown,
            _ => continue,
        };
        return Some(DaemonServiceError::Refused(refusal));
    }
    if display.contains("No data in response") || display.contains("not found in response") {
        return None;
    }
    Some(DaemonServiceError::Refused(DaemonRefusal::Other(
        display.to_string(),
    )))
}

/// Structural detection: the backend tags validation targets via
/// `extensions.field`, never by formatting the message text.
fn is_name_field_error(item: &crate::error::GraphqlErrorItem) -> bool {
    item.extensions
        .as_ref()
        .and_then(|extensions| extensions.get("field"))
        .and_then(|field| field.as_str())
        .is_some_and(|field| field == "name")
}

fn parse_timestamp(
    value: Option<String>,
    field: &'static str,
) -> Result<Option<DateTime<Utc>>, DaemonServiceError> {
    value
        .map(|value| {
            DateTime::parse_from_rfc3339(&value)
                .map(|dt| dt.with_timezone(&Utc))
                .map_err(|error| {
                    DaemonServiceError::MalformedResponse(format!(
                        "daemon {field} '{value}' is not an RFC 3339 timestamp: {error}"
                    ))
                })
        })
        .transpose()
}

impl DaemonResponse {
    fn into_summary(self) -> Result<DaemonSummary, DaemonServiceError> {
        let status = match self.status.parse::<DaemonStatus>() {
            Ok(status) => status,
            Err(_) => DaemonStatus::Unknown(self.status.clone()),
        };
        Ok(DaemonSummary {
            id: self.id,
            status,
            name: self.name,
            display_name: self.display_name,
            enrolled_at: parse_timestamp(self.enrolled_at, "enrolled_at")?,
            removed_at: parse_timestamp(self.removed_at, "removed_at")?,
            inserted_at: parse_timestamp(self.inserted_at, "inserted_at")?,
            updated_at: parse_timestamp(self.updated_at, "updated_at")?,
        })
    }
}

impl DaemonCredentialMetadataResponse {
    fn into_metadata(self) -> Result<DaemonCredentialMetadata, DaemonServiceError> {
        Ok(DaemonCredentialMetadata {
            id: self.id,
            credential_kind: self.credential_kind,
            status: self.status,
            expires_at: parse_timestamp(Some(self.expires_at), "credential expires_at")?
                .ok_or_else(|| {
                    DaemonServiceError::MalformedResponse(
                        "credential expires_at must be present".to_string(),
                    )
                })?,
            consumed_at: parse_timestamp(self.consumed_at, "credential consumed_at")?,
            revoked_at: parse_timestamp(self.revoked_at, "credential revoked_at")?,
            inserted_at: parse_timestamp(self.inserted_at, "credential inserted_at")?,
            updated_at: parse_timestamp(self.updated_at, "credential updated_at")?,
        })
    }
}

impl DaemonEnrollmentMetadataResponse {
    fn into_metadata(self) -> Result<DaemonEnrollmentMetadata, DaemonServiceError> {
        let status = match self.status.parse::<DaemonStatus>() {
            Ok(status) => status,
            Err(_) => DaemonStatus::Unknown(self.status.clone()),
        };
        Ok(DaemonEnrollmentMetadata {
            daemon_id: self.daemon_id,
            status,
            enrolled_at: parse_timestamp(self.enrolled_at, "enrolled_at")?,
            credentials: self
                .credentials
                .into_iter()
                .map(DaemonCredentialMetadataResponse::into_metadata)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
}

impl DaemonBootstrapResponse {
    fn into_bootstrap(self) -> Result<DaemonBootstrap, DaemonServiceError> {
        Ok(DaemonBootstrap {
            daemon: self.daemon.into_summary()?,
            enrollment_token: self.enrollment_token,
            expires_at: parse_timestamp(Some(self.expires_at), "bootstrap expires_at")?
                .ok_or_else(|| {
                    DaemonServiceError::MalformedResponse(
                        "bootstrap expires_at must be present".to_string(),
                    )
                })?,
        })
    }
}

pub struct SacrumDaemonService {
    client: GraphqlClient,
}

impl SacrumDaemonService {
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }

    fn daemon_id(id: &str) -> Result<String, DaemonServiceError> {
        uuid::Uuid::parse_str(id)
            .map(|_| id.to_owned())
            .map_err(|error| DaemonServiceError::InvalidInput {
                field: "daemon id",
                message: error.to_string(),
            })
    }

    pub async fn list_fleet(&self) -> Result<Vec<DaemonSummary>, DaemonServiceError> {
        let query = with_daemon_fields(daemons::LIST_FLEET);
        let response: Vec<DaemonResponse> = self
            .client
            .execute(&query, serde_json::json!({}), "daemons")
            .await?;
        response
            .into_iter()
            .map(DaemonResponse::into_summary)
            .collect()
    }

    pub async fn get_daemon(&self, id: &str) -> Result<Option<DaemonSummary>, DaemonServiceError> {
        let id = Self::daemon_id(id)?;
        let query = with_daemon_fields(daemons::GET_DAEMON);
        let response: Option<DaemonResponse> = self
            .client
            .execute(&query, serde_json::json!({ "id": id }), "daemon")
            .await?;
        response.map(DaemonResponse::into_summary).transpose()
    }

    pub async fn get_enrollment_metadata(
        &self,
        id: &str,
    ) -> Result<Option<DaemonEnrollmentMetadata>, DaemonServiceError> {
        let id = Self::daemon_id(id)?;
        let query = crate::client::with_fragments(
            daemons::GET_DAEMON_ENROLLMENT_METADATA,
            &[DAEMON_CREDENTIAL_METADATA_FIELDS],
        );
        let response: Option<DaemonEnrollmentMetadataResponse> = self
            .client
            .execute(
                &query,
                serde_json::json!({ "id": id }),
                "daemonEnrollmentMetadata",
            )
            .await?;
        response
            .map(DaemonEnrollmentMetadataResponse::into_metadata)
            .transpose()
    }

    pub async fn create_daemon(
        &self,
        name: Option<&str>,
    ) -> Result<DaemonBootstrap, DaemonServiceError> {
        let query = with_daemon_fields(daemons::CREATE_DAEMON);
        let mut variables = serde_json::Map::new();
        if let Some(name) = name {
            variables.insert("name".to_string(), serde_json::json!(name));
        }
        let response: DaemonBootstrapResponse = self
            .client
            .execute(&query, serde_json::Value::Object(variables), "createDaemon")
            .await?;
        response.into_bootstrap()
    }

    pub async fn rename_daemon(
        &self,
        id: &str,
        name: DaemonRename,
    ) -> Result<DaemonSummary, DaemonServiceError> {
        let id = Self::daemon_id(id)?;
        let query = with_daemon_fields(daemons::RENAME_DAEMON);
        let mut variables = serde_json::Map::new();
        variables.insert("id".to_string(), serde_json::json!(id));
        match name {
            DaemonRename::Unchanged => {}
            DaemonRename::Clear => {
                variables.insert("name".to_string(), serde_json::Value::Null);
            }
            DaemonRename::Set(value) => {
                variables.insert("name".to_string(), serde_json::json!(value));
            }
        }
        let response: Option<DaemonResponse> = self
            .client
            .execute(&query, serde_json::Value::Object(variables), "renameDaemon")
            .await?;
        response
            .map(DaemonResponse::into_summary)
            .transpose()?
            .ok_or(DaemonServiceError::Refused(DaemonRefusal::NotFound))
    }

    pub async fn revoke_daemon(&self, id: &str) -> Result<DaemonSummary, DaemonServiceError> {
        Self::daemon_mutation(self, id, daemons::REVOKE_DAEMON, "revokeDaemon").await
    }

    pub async fn unregister_daemon(&self, id: &str) -> Result<DaemonSummary, DaemonServiceError> {
        Self::daemon_mutation(self, id, daemons::UNREGISTER_DAEMON, "unregisterDaemon").await
    }

    pub async fn rotate_credentials(
        &self,
        id: &str,
    ) -> Result<DaemonBootstrap, DaemonServiceError> {
        let id = Self::daemon_id(id)?;
        let query = with_daemon_fields(daemons::ROTATE_DAEMON_CREDENTIALS);
        let response: DaemonBootstrapResponse = self
            .client
            .execute(
                &query,
                serde_json::json!({ "id": id }),
                "rotateDaemonCredentials",
            )
            .await?;
        response.into_bootstrap()
    }

    async fn daemon_mutation(
        &self,
        id: &str,
        document: &str,
        field: &'static str,
    ) -> Result<DaemonSummary, DaemonServiceError> {
        let id = Self::daemon_id(id)?;
        let query = with_daemon_fields(document);
        let response: Option<DaemonResponse> = self
            .client
            .execute(&query, serde_json::json!({ "id": id }), field)
            .await?;
        response
            .map(DaemonResponse::into_summary)
            .transpose()?
            .ok_or(DaemonServiceError::Refused(DaemonRefusal::NotFound))
    }
}

fn with_daemon_fields(document: &str) -> String {
    crate::client::with_fragments(document, &[daemons::DAEMON_FIELDS])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SacrumConfig;
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

    #[tokio::test]
    async fn stable_refusals_map_to_typed_errors_without_secrets() {
        for (message, expected) in [
            (REFUSAL_NOT_FOUND, DaemonRefusal::NotFound),
            (REFUSAL_TERMINAL_STATE, DaemonRefusal::TerminalState),
            (REFUSAL_ACTIVE_SESSION, DaemonRefusal::ActiveSession),
            (REFUSAL_OWNERSHIP_UNKNOWN, DaemonRefusal::OwnershipUnknown),
        ] {
            let error = SacrumClientError::GraphqlError {
                items: Vec::new(),
                messages: vec![message.to_string()],
                message: message.to_string(),
            };
            let adapted: DaemonServiceError = error.into();
            assert!(
                matches!(adapted, DaemonServiceError::Refused(ref refusal) if *refusal == expected),
                "stable refusal must map exactly: {message}"
            );
            let display = adapted.to_string();
            assert!(!display.contains("test-account-token"));
        }
    }

    #[tokio::test]
    async fn name_field_errors_map_to_invalid_name() {
        let error = SacrumClientError::GraphqlError {
            items: vec![crate::error::GraphqlErrorItem {
                message: "name: has already been taken".to_string(),
                path: None,
                extensions: Some(json!({ "field": "name" })),
            }],
            messages: vec!["name: has already been taken".to_string()],
            message: "name: has already been taken".to_string(),
        };
        let adapted: DaemonServiceError = error.into();
        assert!(
            matches!(adapted, DaemonServiceError::InvalidName(message) if message.contains("name"))
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
                    "message": "name: has already been taken",
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
            matches!(result, Err(DaemonServiceError::InvalidName(message)) if message.contains("name"))
        );
        server.verify().await;
    }

    #[tokio::test]
    async fn transport_failures_classify_conservatively_for_mutations() {
        let unreachable = GraphqlClient::new(SacrumConfig::new(
            "http://127.0.0.1:1".into(),
            "test-account-token".into(),
            "irrelevant".into(),
        ));
        let result = SacrumDaemonService::new(unreachable)
            .create_daemon(None)
            .await;
        assert!(
            matches!(result, Err(DaemonServiceError::AmbiguousTransport(_))),
            "transport failures after dispatch must classify as ambiguous, got: {result:?}"
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
}
