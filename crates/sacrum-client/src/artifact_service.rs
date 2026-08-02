use crate::api_types::ArtifactResponse;
use crate::client::{GraphqlClient, with_fragments};
use crate::queries::artifacts;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::str::FromStr;
use vertebrae_core::artifact_service::ArtifactService;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::{
    Artifact, CreateArtifactInput, GetArtifactByLogicalNameInput, ListArtifactInput,
    UpdateArtifactInput,
};

pub struct SacrumArtifactService {
    client: GraphqlClient,
}

#[derive(Debug, Deserialize)]
struct ProjectArtifactsResponse {
    artifacts: Vec<ArtifactResponse>,
}

#[derive(Debug, Deserialize)]
struct TaskArtifactsResponse {
    artifacts: Vec<ArtifactResponse>,
}

impl SacrumArtifactService {
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }
    fn id(id: &str, field: &str) -> ServiceResult<String> {
        uuid::Uuid::from_str(id)
            .map(|_| id.to_owned())
            .map_err(|e| ServiceError::InvalidInput(format!("invalid {field}: {e}")))
    }
    fn active_project_id(&self) -> ServiceResult<String> {
        Self::id(self.client.project_id(), "active project id")
    }
    fn map(response: ArtifactResponse, known_project_id: Option<&str>) -> ServiceResult<Artifact> {
        let mut response = response;
        if response.project_id.is_none() {
            response.project_id = known_project_id.map(ToOwned::to_owned);
        }
        response.into_artifact()
    }

    fn artifact_mutation(
        operation_name: &str,
        field_name: &str,
        required: Vec<(&str, &str, Value)>,
        optional: Vec<(&str, &str, Option<Value>)>,
    ) -> (String, Value) {
        let mut declarations = Vec::new();
        let mut arguments = Vec::new();
        let mut variables = Map::new();

        for (name, ty, value) in required {
            declarations.push(format!("${name}: {ty}"));
            arguments.push(format!("{name}: ${name}"));
            variables.insert(name.to_string(), value);
        }
        for (name, ty, value) in optional {
            if let Some(value) = value {
                declarations.push(format!("${name}: {ty}"));
                arguments.push(format!("{name}: ${name}"));
                variables.insert(name.to_string(), value);
            }
        }

        (
            format!(
                "mutation {operation_name}({}) {{ {field_name}({}) {{ ...ArtifactFields }} }}",
                declarations.join(", "),
                arguments.join(", ")
            ),
            Value::Object(variables),
        )
    }

    /// Sacrum's `Json` GraphQL scalar accepts a JSON-encoded string as its
    /// input value, then decodes it server-side. Sending the object directly
    /// causes Absinthe to treat each metadata key as an unknown GraphQL input
    /// field.
    fn metadata_variable(metadata: vertebrae_core::ArtifactLinkMetadata) -> Value {
        Value::String(
            serde_json::to_string(&metadata)
                .expect("artifact link metadata contains only JSON-serializable values"),
        )
    }
}

#[async_trait]
impl ArtifactService for SacrumArtifactService {
    async fn create_artifact(&self, input: CreateArtifactInput) -> ServiceResult<Artifact> {
        input
            .validate()
            .map_err(|e| ServiceError::InvalidInput(e.into()))?;
        let project_id = self.active_project_id()?;
        let subject_id = input
            .subject_id
            .as_deref()
            .map(|id| Self::id(id, "artifact subject id"))
            .transpose()?;
        let (operation, variables) = Self::artifact_mutation(
            "CreateArtifact",
            "createArtifact",
            vec![
                ("project_id", "Uuid4!", json!(project_id)),
                ("filename", "String!", json!(input.filename)),
                ("body", "String!", json!(input.body)),
            ],
            vec![
                (
                    "subject_type",
                    "String",
                    input.subject_type.map(Value::String),
                ),
                ("subject_id", "Uuid4", subject_id.map(Value::String)),
                (
                    "logical_name",
                    "String",
                    input.logical_name.map(Value::String),
                ),
                (
                    "metadata",
                    "Json",
                    input.metadata.map(Self::metadata_variable),
                ),
            ],
        );
        let query = with_fragments(&operation, &[artifacts::ARTIFACT_FIELDS]);
        let response: ArtifactResponse = self
            .client
            .execute(&query, variables, "createArtifact")
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, Some(self.client.project_id()))
    }
    async fn list_artifacts(&self, input: ListArtifactInput) -> ServiceResult<Vec<Artifact>> {
        let query = with_fragments(artifacts::LIST_ARTIFACTS, &[artifacts::ARTIFACT_FIELDS]);
        let project_id = self.active_project_id()?;
        let variables = json!({
            "project_id": project_id,
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
            .map(|response| Self::map(response, Some(self.client.project_id())))
            .collect()
    }

    async fn list_task_artifacts(&self, task_id: &str) -> ServiceResult<Vec<Artifact>> {
        let task_id = Self::id(task_id, "task id")?;
        let query = with_fragments(
            artifacts::LIST_TASK_ARTIFACTS,
            &[artifacts::ARTIFACT_FIELDS],
        );
        let task: TaskArtifactsResponse = self
            .client
            .execute(&query, json!({ "task_id": task_id }), "task")
            .await
            .map_err(ServiceError::from)?;

        task.artifacts
            .into_iter()
            .map(|response| Self::map(response, Some(self.client.project_id())))
            .collect()
    }
    async fn get_artifact(&self, id: &str) -> ServiceResult<Artifact> {
        let response: ArtifactResponse = self
            .client
            .execute(
                &with_fragments(artifacts::GET_ARTIFACT, &[artifacts::ARTIFACT_FIELDS]),
                json!({"id": Self::id(id, "artifact id")?}),
                "artifact",
            )
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, None)
    }
    async fn get_artifact_by_logical_name(
        &self,
        input: GetArtifactByLogicalNameInput,
    ) -> ServiceResult<Artifact> {
        input
            .validate()
            .map_err(|e| ServiceError::InvalidInput(e.into()))?;
        let project_id = self.active_project_id()?;
        let subject_id = Self::id(&input.subject_id, "artifact subject id")?;
        let response: ArtifactResponse = self
            .client
            .execute(
                &with_fragments(
                    artifacts::GET_ARTIFACT_BY_LOGICAL_NAME,
                    &[artifacts::ARTIFACT_FIELDS],
                ),
                json!({
                    "project_id": project_id,
                    "subject_type": input.subject_type,
                    "subject_id": subject_id,
                    "logical_name": input.logical_name,
                }),
                "artifactByLogicalName",
            )
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, Some(self.client.project_id()))
    }
    async fn update_artifact(
        &self,
        id: &str,
        input: UpdateArtifactInput,
    ) -> ServiceResult<Artifact> {
        input
            .validate()
            .map_err(|e| ServiceError::InvalidInput(e.into()))?;
        if !input.has_updates() {
            return Err(ServiceError::InvalidInput(
                "at least one artifact field must be updated".into(),
            ));
        }
        let subject_id = input
            .subject_id
            .as_deref()
            .map(|subject_id| Self::id(subject_id, "artifact subject id"))
            .transpose()?;
        let (operation, variables) = Self::artifact_mutation(
            "UpdateArtifact",
            "updateArtifact",
            vec![("id", "Uuid4!", json!(Self::id(id, "artifact id")?))],
            vec![
                ("filename", "String", input.filename.map(Value::String)),
                ("body", "String", input.body.map(Value::String)),
                (
                    "subject_type",
                    "String",
                    input.subject_type.map(Value::String),
                ),
                ("subject_id", "Uuid4", subject_id.map(Value::String)),
                (
                    "logical_name",
                    "String",
                    input.logical_name.map(Value::String),
                ),
                (
                    "metadata",
                    "Json",
                    input.metadata.map(Self::metadata_variable),
                ),
            ],
        );
        let response: ArtifactResponse = self
            .client
            .execute(
                &with_fragments(&operation, &[artifacts::ARTIFACT_FIELDS]),
                variables,
                "updateArtifact",
            )
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, None)
    }
    async fn delete_artifact(&self, id: &str) -> ServiceResult<Artifact> {
        let response: ArtifactResponse = self
            .client
            .execute(
                &with_fragments(artifacts::DELETE_ARTIFACT, &[artifacts::ARTIFACT_FIELDS]),
                json!({"id": Self::id(id, "artifact id")?}),
                "deleteArtifact",
            )
            .await
            .map_err(ServiceError::from)?;
        Self::map(response, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SacrumConfig;
    use serde_json::json;
    use vertebrae_core::error::ServiceError;
    use vertebrae_core::models::ArtifactLinkMetadata;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

    const ARTIFACT_ID: &str = "11111111-1111-1111-1111-111111111111";
    const PROJECT_ID: &str = "22222222-2222-2222-2222-222222222222";

    #[derive(Debug)]
    struct VariablesExactly(serde_json::Value);

    impl Match for VariablesExactly {
        fn matches(&self, request: &Request) -> bool {
            request
                .body_json::<serde_json::Value>()
                .ok()
                .and_then(|body| body.get("variables").cloned())
                .as_ref()
                == Some(&self.0)
        }
    }

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
            "filename": "notes.md",
            "body": "hello",
            "logical_name": "conversation",
            "metadata": {
                "version": 1,
                "content_kind": "conversation",
                "format": "jsonl",
                "origin": "harness",
                "presentation": "raw",
                "extensions": { "provider": "codex" }
            },
            "inserted_at": "2026-07-29T10:00:00Z",
            "updated_at": "2026-07-29T11:00:00Z"
        })
    }

    fn root_artifact_json() -> serde_json::Value {
        json!({
            "id": ARTIFACT_ID,
            "filename": "notes.md",
            "body": "hello",
            "logical_name": null,
            "metadata": null,
            "inserted_at": "2026-07-29T10:00:00Z",
            "updated_at": "2026-07-29T11:00:00Z"
        })
    }

    #[tokio::test]
    async fn create_encodes_metadata_as_a_json_scalar_string() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateArtifact"))
            .and(body_string_contains(PROJECT_ID))
            .and(body_string_contains("subject_type"))
            .and(body_string_contains("logical_name"))
            .and(body_string_contains("metadata"))
            .and(VariablesExactly(json!({
                "project_id": PROJECT_ID,
                "filename": "notes.md",
                "body": "hello",
                "subject_type": "task",
                "subject_id": ARTIFACT_ID,
                "logical_name": "conversation",
                "metadata": "{\"version\":1,\"content_kind\":\"conversation\",\"format\":\"jsonl\",\"origin\":\"harness\",\"presentation\":\"raw\",\"extensions\":{\"provider\":\"codex\"}}"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "createArtifact": artifact_json() }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let artifact = service(&server)
            .create_artifact(
                CreateArtifactInput::new("notes.md", "hello")
                    .with_subject("task", ARTIFACT_ID)
                    .with_logical_name("conversation")
                    .with_metadata(
                        ArtifactLinkMetadata::new("conversation", "jsonl", "harness", "raw")
                            .with_extension("provider", json!("codex")),
                    ),
            )
            .await
            .unwrap();
        assert_eq!(artifact.id, ARTIFACT_ID);
        assert_eq!(artifact.logical_name.as_deref(), Some("conversation"));
        assert_eq!(artifact.project_id.as_deref(), Some(PROJECT_ID));
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
        assert_eq!(artifacts[0].project_id.as_deref(), Some(PROJECT_ID));
    }

    #[tokio::test]
    async fn list_task_artifacts_maps_the_task_projection() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("ListTaskArtifacts"))
            .and(body_string_contains("task(id: $task_id)"))
            .and(body_string_contains(ARTIFACT_ID))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": { "artifacts": [artifact_json()] } }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let artifacts = service(&server)
            .list_task_artifacts(ARTIFACT_ID)
            .await
            .unwrap();

        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].filename, "notes.md");
        assert_eq!(artifacts[0].logical_name.as_deref(), Some("conversation"));
        assert_eq!(artifacts[0].project_id.as_deref(), Some(PROJECT_ID));
        server.verify().await;
    }

    #[tokio::test]
    async fn root_get_keeps_project_scope_unknown() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetArtifact"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "artifact": root_artifact_json() }
            })))
            .mount(&server)
            .await;

        let artifact = service(&server).get_artifact(ARTIFACT_ID).await.unwrap();
        assert!(artifact.project_id.is_none());
        assert!(artifact.logical_name.is_none());
        assert!(artifact.metadata.is_none());
    }

    #[tokio::test]
    async fn subject_logical_name_lookup_sends_scope_and_preserves_link_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetArtifactByLogicalName"))
            .and(body_string_contains("artifactByLogicalName"))
            .and(body_string_contains(PROJECT_ID))
            .and(body_string_contains("conversation"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "artifactByLogicalName": artifact_json() }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let artifact = service(&server)
            .get_artifact_by_logical_name(GetArtifactByLogicalNameInput::new(
                "task",
                ARTIFACT_ID,
                "conversation",
            ))
            .await
            .unwrap();
        assert_eq!(artifact.project_id.as_deref(), Some(PROJECT_ID));
        assert_eq!(
            artifact.metadata.unwrap().extensions["provider"],
            serde_json::json!("codex")
        );
        server.verify().await;
    }

    #[tokio::test]
    async fn link_only_update_encodes_metadata_as_a_json_scalar_string() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpdateArtifact"))
            .and(body_string_contains("logical_name"))
            .and(body_string_contains("metadata"))
            .and(VariablesExactly(json!({
                "id": ARTIFACT_ID,
                "logical_name": "conversation",
                "metadata": "{\"version\":1,\"content_kind\":\"conversation\",\"format\":\"jsonl\",\"origin\":\"harness\",\"presentation\":\"raw\",\"extensions\":{\"trace\":{\"turn\":7}}}"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "updateArtifact": artifact_json() }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let artifact = service(&server)
            .update_artifact(
                ARTIFACT_ID,
                UpdateArtifactInput::new()
                    .with_logical_name("conversation")
                    .with_metadata(
                        ArtifactLinkMetadata::new("conversation", "jsonl", "harness", "raw")
                            .with_extension("trace", json!({ "turn": 7 })),
                    ),
            )
            .await
            .unwrap();
        assert!(artifact.project_id.is_none());
        server.verify().await;
    }

    #[tokio::test]
    async fn filename_only_update_omits_attachment_variables() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpdateArtifact"))
            .and(VariablesExactly(json!({
                "id": ARTIFACT_ID,
                "filename": "renamed.md"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "updateArtifact": artifact_json() }
            })))
            .expect(1)
            .mount(&server)
            .await;

        service(&server)
            .update_artifact(
                ARTIFACT_ID,
                UpdateArtifactInput::new().with_filename("renamed.md"),
            )
            .await
            .unwrap();
        server.verify().await;
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
