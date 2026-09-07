//! Domain types, refusal mapping, and wire conversions for daemon fleet
//! management. Safe metadata is kept separate from one-time
//! [`DaemonBootstrap`] payloads.

use crate::api_types::{
    DaemonBootstrapResponse, DaemonCredentialMetadataResponse, DaemonEnrollmentMetadataResponse,
    DaemonResponse,
};
use crate::error::{GraphqlErrorItem, SacrumClientError};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

pub(crate) const REFUSAL_NOT_FOUND: &str = "daemon not found";
pub(crate) const REFUSAL_TERMINAL_STATE: &str =
    "daemon is in a terminal state (revoked or removed)";
pub(crate) const REFUSAL_ACTIVE_SESSION: &str =
    "daemon has an active session; disconnect it before unregistering";
pub(crate) const REFUSAL_OWNERSHIP_UNKNOWN: &str =
    "daemon has enrollment history and cannot be unregistered until work ownership is established";

#[derive(Debug, Clone, Copy)]
pub(crate) enum DaemonTransport {
    Read,
    Write,
}

pub(crate) fn map_client_error(
    error: SacrumClientError,
    transport: DaemonTransport,
) -> DaemonServiceError {
    match &error {
        SacrumClientError::GraphqlError { items, .. } => {
            if let Some(classified) = classify_graphql_items(items) {
                return classified;
            }
            match transport {
                DaemonTransport::Write => DaemonServiceError::AmbiguousTransport(error),
                DaemonTransport::Read => DaemonServiceError::MalformedResponse(error.to_string()),
            }
        }
        SacrumClientError::HttpError(reqwest_error) if http_never_dispatched(reqwest_error) => {
            DaemonServiceError::Unavailable(error)
        }
        SacrumClientError::HttpError(_) => match transport {
            DaemonTransport::Write => DaemonServiceError::AmbiguousTransport(error),
            DaemonTransport::Read => DaemonServiceError::Unavailable(error),
        },
        SacrumClientError::ApiError {
            status: 500..=599, ..
        } => match transport {
            DaemonTransport::Write => DaemonServiceError::AmbiguousTransport(error),
            DaemonTransport::Read => DaemonServiceError::Unavailable(error),
        },
        SacrumClientError::SerializationError(_) => match transport {
            DaemonTransport::Write => DaemonServiceError::AmbiguousTransport(error),
            DaemonTransport::Read => DaemonServiceError::MalformedResponse(error.to_string()),
        },
        SacrumClientError::ConfigError(_) | SacrumClientError::ApiError { .. } => {
            DaemonServiceError::Unavailable(error)
        }
    }
}

fn http_never_dispatched(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_request()
}

/// Classify from structured GraphQL items only. Formatted Display strings
/// append path/extensions and must not be used to recover categories.
fn classify_graphql_items(items: &[GraphqlErrorItem]) -> Option<DaemonServiceError> {
    if items.is_empty() {
        return None;
    }
    if let Some(item) = items.iter().find(|item| is_name_field_error(item)) {
        return Some(DaemonServiceError::InvalidName(item.message.clone()));
    }
    for item in items {
        if let Some(code) = extension_str(item, "code").or_else(|| extension_str(item, "kind"))
            && let Some(refusal) = refusal_from_code(code)
        {
            return Some(DaemonServiceError::Refused(refusal));
        }
        if let Some(refusal) = refusal_from_message(item.message.trim()) {
            return Some(DaemonServiceError::Refused(refusal));
        }
    }
    let joined = items
        .iter()
        .map(|item| item.message.as_str())
        .collect::<Vec<_>>()
        .join("; ");
    Some(DaemonServiceError::Refused(DaemonRefusal::Other(joined)))
}

fn refusal_from_code(code: &str) -> Option<DaemonRefusal> {
    match code {
        "not_found" | "daemon_not_found" => Some(DaemonRefusal::NotFound),
        "terminal_state" => Some(DaemonRefusal::TerminalState),
        "active_session" => Some(DaemonRefusal::ActiveSession),
        "ownership_unknown" => Some(DaemonRefusal::OwnershipUnknown),
        _ => None,
    }
}

fn refusal_from_message(message: &str) -> Option<DaemonRefusal> {
    match message {
        REFUSAL_NOT_FOUND => Some(DaemonRefusal::NotFound),
        REFUSAL_TERMINAL_STATE => Some(DaemonRefusal::TerminalState),
        REFUSAL_ACTIVE_SESSION => Some(DaemonRefusal::ActiveSession),
        REFUSAL_OWNERSHIP_UNKNOWN => Some(DaemonRefusal::OwnershipUnknown),
        _ => None,
    }
}

fn extension_str<'a>(item: &'a GraphqlErrorItem, key: &str) -> Option<&'a str> {
    item.extensions
        .as_ref()
        .and_then(|extensions| extensions.get(key))
        .and_then(Value::as_str)
}

fn is_name_field_error(item: &GraphqlErrorItem) -> bool {
    extension_str(item, "field").is_some_and(|field| field == "name")
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
    pub(crate) fn into_summary(self) -> Result<DaemonSummary, DaemonServiceError> {
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
    pub(crate) fn into_metadata(self) -> Result<DaemonCredentialMetadata, DaemonServiceError> {
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
    pub(crate) fn into_metadata(self) -> Result<DaemonEnrollmentMetadata, DaemonServiceError> {
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
    pub(crate) fn into_bootstrap(self) -> Result<DaemonBootstrap, DaemonServiceError> {
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
