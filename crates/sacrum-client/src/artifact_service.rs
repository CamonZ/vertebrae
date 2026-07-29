use crate::api_types::ArtifactResponse;
use crate::client::{GraphqlClient, with_fragments};
use crate::queries::artifacts;
use async_trait::async_trait;
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

impl SacrumArtifactService {
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }
    fn id(id: &str) -> ServiceResult<String> {
        uuid::Uuid::from_str(id)
            .map(|_| id.to_owned())
            .map_err(|e| ServiceError::InvalidInput(format!("invalid artifact id: {e}")))
    }
    fn map(response: ArtifactResponse) -> ServiceResult<Artifact> {
        response.into_artifact()
    }
}

#[async_trait]
impl ArtifactService for SacrumArtifactService {
    async fn create_artifact(&self, input: CreateArtifactInput) -> ServiceResult<Artifact> {
        input
            .validate()
            .map_err(|e| ServiceError::InvalidInput(e.into()))?;
        let response: ArtifactResponse = self.client.execute(&with_fragments(artifacts::CREATE_ARTIFACT, &[artifacts::ARTIFACT_FIELDS]), json!({"project_id": self.client.project_id(), "filename": input.filename, "body": input.body, "subject_type": input.subject_type, "subject_id": input.subject_id}), "createArtifact").await.map_err(ServiceError::from)?;
        Self::map(response)
    }
    async fn list_artifacts(&self, input: ListArtifactInput) -> ServiceResult<Vec<Artifact>> {
        let responses: Vec<ArtifactResponse> = self.client.execute(&with_fragments(artifacts::LIST_ARTIFACTS, &[artifacts::ARTIFACT_FIELDS]), json!({"project_id": self.client.project_id(), "limit": input.limit, "offset": input.offset}), "artifacts").await.map_err(ServiceError::from)?;
        responses.into_iter().map(Self::map).collect()
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
        Self::map(response)
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
        Self::map(response)
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
        Self::map(response)
    }
}
