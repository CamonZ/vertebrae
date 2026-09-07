//! Account-authenticated, project-independent daemon fleet management.
//! Safe fleet metadata is kept separate from the one-time-token
//! [`DaemonBootstrap`] payloads; ambiguous transport must never be
//! auto-retried (refresh safe metadata, offer explicit recovery), and
//! refusal mapping never embeds credential material.

mod types;

pub use types::{
    DaemonBootstrap, DaemonCredentialMetadata, DaemonEnrollmentMetadata, DaemonRefusal,
    DaemonRename, DaemonServiceError, DaemonStatus, DaemonSummary,
};
pub(crate) use types::{DaemonTransport, map_client_error};

use crate::api_types::{DaemonBootstrapResponse, DaemonEnrollmentMetadataResponse, DaemonResponse};
use crate::client::GraphqlClient;
use crate::queries::daemons;
use crate::queries::daemons::DAEMON_CREDENTIAL_METADATA_FIELDS;
use serde::de::DeserializeOwned;
use serde_json::Value;

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

    async fn execute_read<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
        field: &str,
    ) -> Result<T, DaemonServiceError> {
        self.client
            .execute(query, variables, field)
            .await
            .map_err(|error| map_client_error(error, DaemonTransport::Read))
    }

    async fn execute_write<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
        field: &str,
    ) -> Result<T, DaemonServiceError> {
        self.client
            .execute(query, variables, field)
            .await
            .map_err(|error| map_client_error(error, DaemonTransport::Write))
    }

    pub async fn list_fleet(&self) -> Result<Vec<DaemonSummary>, DaemonServiceError> {
        let query = with_daemon_fields(daemons::LIST_FLEET);
        let response: Vec<DaemonResponse> = self
            .execute_read(&query, serde_json::json!({}), "daemons")
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
            .execute_read(&query, serde_json::json!({ "id": id }), "daemon")
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
            .execute_read(
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
            .execute_write(&query, serde_json::Value::Object(variables), "createDaemon")
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
            .execute_write(&query, serde_json::Value::Object(variables), "renameDaemon")
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
            .execute_write(
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
            .execute_write(&query, serde_json::json!({ "id": id }), field)
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
mod tests;
