use crate::api_types::ArtifactResponse;
use crate::client::{GraphqlClient, with_fragments};
use crate::queries::artifacts;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use std::str::FromStr;
use vertebrae_core::artifact_service::ArtifactService;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::{
    Artifact, CreateArtifactInput, ListArtifactInput, UpdateArtifactInput,
};

pub struct SacrumArtifactService {
    client: GraphqlClient,
}

#[derive(Debug, Deserialize)]
struct ProjectArtifactsResponse {
    artifacts: Vec<ArtifactResponse>,
}

impl SacrumArtifactService {
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }
    fn id(id: &str) -> ServiceResult<String> {
        uuid::Uuid::from_str(id)
            .map(|_| id.to_owned())
            .map_err(|e| ServiceError::InvalidInput(format!("invalid artifact id: {e}")))
    }
    fn map(response: ArtifactResponse, project_id: &str) -> ServiceResult<Artifact> {
        // Sacrum scopes artifact queries by project but does not expose the
        // owning project as a field on the public Artifact GraphQL type.
        // Preserve that domain field from the client scope instead.
        let mut response = response;
        if response.project_id.is_empty() {
            response.project_id = project_id.to_owned();
        }
        response.into_artifact()
    }
}

#[async_trait]
impl ArtifactService for SacrumArtifactService {
    async fn create_artifact(&self, input: CreateArtifactInput) -> ServiceResult<Artifact> {
        input
            .validate()
            .map_err(|e| ServiceError::InvalidInput(e.into()))?;
        let query = with_fragments(artifacts::CREATE_ARTIFACT, &[artifacts::ARTIFACT_FIELDS]);
        let variables = json!({
            "project_id": self.client.project_id(),
            "filename": input.filename,
            "body": input.body,
            "subject_type": input.subject_type,
            "subject_id": input.subject_id,
        });
        let response: ArtifactResponse = self
            .client
            .execute(&query, variables, "createArtifact")
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, self.client.project_id())
    }
    async fn list_artifacts(&self, input: ListArtifactInput) -> ServiceResult<Vec<Artifact>> {
        let query = with_fragments(artifacts::LIST_ARTIFACTS, &[artifacts::ARTIFACT_FIELDS]);
        let variables = json!({
            "project_id": self.client.project_id(),
            "limit": input.limit,
            "offset": input.offset,
        });
        let project: ProjectArtifactsResponse = self
            .client
            .execute(&query, variables, "project")
            .await
            .map_err(ServiceError::from)?;
        project
            .artifacts
            .into_iter()
            .map(|response| Self::map(response, self.client.project_id()))
            .collect()
    }
    async fn get_artifact(&self, id: &str) -> ServiceResult<Artifact> {
        let response: ArtifactResponse = self
            .client
            .execute(
                &with_fragments(artifacts::GET_ARTIFACT, &[artifacts::ARTIFACT_FIELDS]),
                json!({"id": Self::id(id)?}),
                "artifact",
            )
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, self.client.project_id())
    }
    async fn update_artifact(
        &self,
        id: &str,
        input: UpdateArtifactInput,
    ) -> ServiceResult<Artifact> {
        if !input.has_updates() {
            return Err(ServiceError::InvalidInput(
                "at least one artifact field must be updated".into(),
            ));
        }
        let response: ArtifactResponse = self
            .client
            .execute(
                &with_fragments(artifacts::UPDATE_ARTIFACT, &[artifacts::ARTIFACT_FIELDS]),
                json!({"id": Self::id(id)?, "filename": input.filename, "body": input.body}),
                "updateArtifact",
            )
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, self.client.project_id())
    }
    async fn delete_artifact(&self, id: &str) -> ServiceResult<Artifact> {
        let response: ArtifactResponse = self
            .client
            .execute(
                &with_fragments(artifacts::DELETE_ARTIFACT, &[artifacts::ARTIFACT_FIELDS]),
                json!({"id": Self::id(id)?}),
                "deleteArtifact",
            )
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, self.client.project_id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SacrumConfig;
    use serde_json::json;
    use vertebrae_core::error::ServiceError;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const ARTIFACT_ID: &str = "11111111-1111-1111-1111-111111111111";
    const PROJECT_ID: &str = "22222222-2222-2222-2222-222222222222";

    fn service(server: &MockServer) -> SacrumArtifactService {
        SacrumArtifactService::new(GraphqlClient::new(SacrumConfig::new(
            server.uri(),
            "test-token".into(),
            PROJECT_ID.into(),
        )))
    }

    fn artifact_json() -> serde_json::Value {
        json!({
            "id": ARTIFACT_ID,
            "project_id": PROJECT_ID,
            "filename": "notes.md",
            "body": "hello",
            "inserted_at": "2026-07-29T10:00:00Z",
            "updated_at": "2026-07-29T11:00:00Z"
        })
    }

    #[tokio::test]
    async fn create_sends_project_and_attachment_variables() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateArtifact"))
            .and(body_string_contains(PROJECT_ID))
            .and(body_string_contains("subject_type"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "createArtifact": artifact_json() }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let artifact = service(&server)
            .create_artifact(
                CreateArtifactInput::new("notes.md", "hello").with_subject("task", ARTIFACT_ID),
            )
            .await
            .unwrap();
        assert_eq!(artifact.id, ARTIFACT_ID);
        server.verify().await;
    }

    #[tokio::test]
    async fn list_maps_pagination_and_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("ListArtifacts"))
            .and(body_string_contains(PROJECT_ID))
            .and(body_string_contains("\"limit\":2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "project": { "artifacts": [artifact_json()] } }
            })))
            .mount(&server)
            .await;

        let artifacts = service(&server)
            .list_artifacts(ListArtifactInput::new().with_limit(2).with_offset(4))
            .await
            .unwrap();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].filename, "notes.md");
    }

    #[tokio::test]
    async fn translates_graphql_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{ "message": "artifact validation failed" }]
            })))
            .mount(&server)
            .await;

        let result = service(&server).get_artifact(ARTIFACT_ID).await;
        assert!(
            matches!(result, Err(ServiceError::InvalidInput(message)) if message.contains("validation failed"))
        );
    }
}
