//! IPC types for daemon fleet management.
//! Timestamps stay RFC 3339 strings; `inserted_at` keeps the Sacrum field name.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Daemon {
    pub id: String,
    pub status: String,
    pub name: Option<String>,
    pub display_name: String,
    pub enrolled_at: Option<String>,
    pub removed_at: Option<String>,
    pub inserted_at: Option<String>,
    pub updated_at: Option<String>,
}

impl From<vertebrae_sacrum_client::daemon_service::DaemonSummary> for Daemon {
    fn from(summary: vertebrae_sacrum_client::daemon_service::DaemonSummary) -> Self {
        Self {
            id: summary.id,
            status: summary.status.to_string(),
            name: summary.name,
            display_name: summary.display_name,
            enrolled_at: summary.enrolled_at.map(|dt| dt.to_rfc3339()),
            removed_at: summary.removed_at.map(|dt| dt.to_rfc3339()),
            inserted_at: summary.inserted_at.map(|dt| dt.to_rfc3339()),
            updated_at: summary.updated_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonCredentialMetadata {
    pub id: String,
    pub credential_kind: String,
    pub status: String,
    pub expires_at: String,
    pub consumed_at: Option<String>,
    pub revoked_at: Option<String>,
    pub inserted_at: Option<String>,
    pub updated_at: Option<String>,
}

impl From<vertebrae_sacrum_client::daemon_service::DaemonCredentialMetadata>
    for DaemonCredentialMetadata
{
    fn from(metadata: vertebrae_sacrum_client::daemon_service::DaemonCredentialMetadata) -> Self {
        Self {
            id: metadata.id,
            credential_kind: metadata.credential_kind,
            status: metadata.status,
            expires_at: metadata.expires_at.to_rfc3339(),
            consumed_at: metadata.consumed_at.map(|dt| dt.to_rfc3339()),
            revoked_at: metadata.revoked_at.map(|dt| dt.to_rfc3339()),
            inserted_at: metadata.inserted_at.map(|dt| dt.to_rfc3339()),
            updated_at: metadata.updated_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonEnrollmentMetadata {
    pub daemon_id: String,
    pub status: String,
    pub enrolled_at: Option<String>,
    pub credentials: Vec<DaemonCredentialMetadata>,
}

impl From<vertebrae_sacrum_client::daemon_service::DaemonEnrollmentMetadata>
    for DaemonEnrollmentMetadata
{
    fn from(metadata: vertebrae_sacrum_client::daemon_service::DaemonEnrollmentMetadata) -> Self {
        Self {
            daemon_id: metadata.daemon_id,
            status: metadata.status.to_string(),
            enrolled_at: metadata.enrolled_at.map(|dt| dt.to_rfc3339()),
            credentials: metadata.credentials.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonBootstrap {
    pub daemon: Daemon,
    pub enrollment_token: String,
    pub expires_at: String,
}

impl From<vertebrae_sacrum_client::daemon_service::DaemonBootstrap> for DaemonBootstrap {
    fn from(bootstrap: vertebrae_sacrum_client::daemon_service::DaemonBootstrap) -> Self {
        Self {
            daemon: bootstrap.daemon.into(),
            enrollment_token: bootstrap.enrollment_token,
            expires_at: bootstrap.expires_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DaemonNameUpdate {
    Unchanged,
    Clear,
    Set { value: String },
}

impl From<DaemonNameUpdate> for vertebrae_sacrum_client::daemon_service::DaemonRename {
    fn from(update: DaemonNameUpdate) -> Self {
        match update {
            DaemonNameUpdate::Unchanged => Self::Unchanged,
            DaemonNameUpdate::Clear => Self::Clear,
            DaemonNameUpdate::Set { value } => Self::Set(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonFleetSnapshot {
    pub connection_id: String,
    pub daemons: Vec<Daemon>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonDetailSnapshot {
    pub connection_id: String,
    pub daemon: Option<Daemon>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonEnrollmentSnapshot {
    pub connection_id: String,
    pub metadata: Option<DaemonEnrollmentMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonMutationResult {
    pub connection_id: String,
    pub daemon: Daemon,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DaemonBootstrapResult {
    pub connection_id: String,
    pub bootstrap: DaemonBootstrap,
}
