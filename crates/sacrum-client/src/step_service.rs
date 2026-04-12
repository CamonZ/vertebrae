//! StepService implementation for Sacrum GraphQL API
//!
//! Implements the StepService trait by making GraphQL calls to the Sacrum API.
//! Full CRUD operations are available for workflow steps.

use async_trait::async_trait;
use serde_json::json;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::{AgentConfig, Step, StepType, StepUpdate};
use vertebrae_core::step_service::StepService;

use crate::api_types::{WorkflowResponse, WorkflowStepResponse};
use crate::client::{GraphqlClient, with_fragments};
use crate::error::SacrumClientError;
use crate::queries::steps::{
    CREATE_STEP, DELETE_STEP, GET_STEP, LIST_STEPS, STEP_FIELDS, SYNC_STEP_TRANSITIONS, UPDATE_STEP,
};
use crate::queries::workflows::{LIST_WORKFLOWS, WORKFLOW_FIELDS};

/// StepService implementation for Sacrum GraphQL client
pub struct SacrumStepService {
    client: GraphqlClient,
}

impl SacrumStepService {
    /// Create a new SacrumStepService with a GraphQL client
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }

    fn response_to_step(response: &WorkflowStepResponse) -> Step {
        let agent_config = response
            .agent_config
            .as_ref()
            .and_then(|v| serde_json::from_value::<AgentConfig>(v.clone()).ok())
            .unwrap_or_default();

        let transitions_to = response
            .transitions
            .as_ref()
            .map(|ts| ts.iter().map(|t| t.to_step_id.clone()).collect())
            .unwrap_or_default();

        let created_at = response
            .inserted_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));

        let updated_at = response
            .updated_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));

        Step {
            id: Some(response.id.clone()),
            name: response.name.clone(),
            workflow_id: response.workflow_id.clone(),
            goal: response.goal.clone(),
            prompt: response.prompt.clone(),
            agents: response.agents.clone(),
            skills: response.skills.clone(),
            agent_config,
            step_type: StepType::default(),
            output_schema: None,
            is_final: response.is_final,
            transitions_to,
            order: response.step_order,
            created_at,
            updated_at,
        }
    }
}

#[async_trait]
impl StepService for SacrumStepService {
    async fn create_step(&self, step: &Step) -> ServiceResult<Step> {
        let query = with_fragments(CREATE_STEP, &[STEP_FIELDS]);
        let agent_config_str = serde_json::to_string(&step.agent_config)
            .map_err(|e| ServiceError::validation_failed(format!("Invalid agent config: {}", e)))?;
        let variables = json!({
            "workflow_id": step.workflow_id,
            "name": step.name,
            "goal": step.goal,
            "prompt": step.prompt,
            "agents": step.agents,
            "skills": step.skills,
            "agent_config": agent_config_str,
            "is_final": step.is_final,
            "step_order": step.order,
        });

        let response: WorkflowStepResponse = self
            .client
            .execute(&query, variables, "create_workflow_step")
            .await?;

        let mut created = Self::response_to_step(&response);

        // If the step has transitions, sync them after creation
        if !step.transitions_to.is_empty()
            && let Some(step_id) = &created.id
        {
            let sync_query = with_fragments(SYNC_STEP_TRANSITIONS, &[STEP_FIELDS]);
            let transitions: Vec<serde_json::Value> = step
                .transitions_to
                .iter()
                .map(|to_id| json!({"to_step_id": to_id}))
                .collect();
            let sync_vars = json!({
                "id": step_id,
                "transitions": transitions,
            });
            let synced: WorkflowStepResponse = self
                .client
                .execute(&sync_query, sync_vars, "sync_step_transitions")
                .await?;
            created = Self::response_to_step(&synced);
        }

        Ok(created)
    }

    async fn create_step_with_id(&self, _id: &str, step: &Step) -> ServiceResult<Step> {
        // Backend generates IDs; ignore caller-provided ID
        self.create_step(step).await
    }

    async fn get_step(&self, id: &str) -> ServiceResult<Option<Step>> {
        let query = with_fragments(GET_STEP, &[STEP_FIELDS]);
        let variables = json!({ "id": id });

        match self
            .client
            .execute::<WorkflowStepResponse>(&query, variables, "workflow_step")
            .await
        {
            Ok(response) => Ok(Some(Self::response_to_step(&response))),
            Err(SacrumClientError::GraphqlError { ref messages, .. })
                if messages
                    .iter()
                    .any(|m| m.contains("not_found") || m.contains("Not Found")) =>
            {
                Ok(None)
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn step_exists(&self, id: &str) -> ServiceResult<bool> {
        Ok(self.get_step(id).await?.is_some())
    }

    async fn get_step_by_id(&self, id: &str) -> ServiceResult<Option<Step>> {
        self.get_step(id).await
    }

    async fn list_steps_for_workflow(&self, workflow_id: &str) -> ServiceResult<Vec<Step>> {
        let query = with_fragments(LIST_STEPS, &[STEP_FIELDS]);
        let variables = json!({ "workflow_id": workflow_id });

        let responses: Vec<WorkflowStepResponse> = self
            .client
            .execute(&query, variables, "workflow_steps")
            .await?;

        Ok(responses.iter().map(Self::response_to_step).collect())
    }

    async fn update_step(&self, id: &str, updates: &StepUpdate) -> ServiceResult<()> {
        let query = with_fragments(UPDATE_STEP, &[STEP_FIELDS]);
        let mut variables = json!({ "id": id });

        if let Some(name) = &updates.name {
            variables["name"] = json!(name);
        }
        if let Some(goal) = &updates.goal {
            variables["goal"] = json!(goal);
        }
        if let Some(prompt) = &updates.prompt {
            variables["prompt"] = json!(prompt);
        }
        if let Some(agents) = &updates.agents {
            variables["agents"] = json!(agents);
        }
        if let Some(skills) = &updates.skills {
            variables["skills"] = json!(skills);
        }
        if let Some(agent_config) = &updates.agent_config {
            variables["agent_config"] =
                json!(serde_json::to_string(agent_config).map_err(|e| {
                    ServiceError::validation_failed(format!("Invalid agent config: {}", e))
                })?);
        }
        if let Some(is_final) = updates.is_final {
            variables["is_final"] = json!(is_final);
        }
        if let Some(order) = updates.order {
            variables["step_order"] = json!(order);
        }

        let _response: WorkflowStepResponse = self
            .client
            .execute(&query, variables, "update_workflow_step")
            .await?;

        // If transitions_to is being updated, sync them separately
        if let Some(transitions_to) = &updates.transitions_to {
            let sync_query = with_fragments(SYNC_STEP_TRANSITIONS, &[STEP_FIELDS]);
            let transitions: Vec<serde_json::Value> = transitions_to
                .iter()
                .map(|to_id| json!({"to_step_id": to_id}))
                .collect();
            let sync_vars = json!({
                "id": id,
                "transitions": transitions,
            });
            let _synced: WorkflowStepResponse = self
                .client
                .execute(&sync_query, sync_vars, "sync_step_transitions")
                .await?;
        }

        Ok(())
    }

    async fn delete_step(&self, id: &str) -> ServiceResult<()> {
        let variables = json!({ "id": id });
        self.client.execute_void(DELETE_STEP, variables).await?;
        Ok(())
    }

    async fn get_initial_step(&self, workflow_id: &str) -> ServiceResult<Option<Step>> {
        let steps = self.list_steps_for_workflow(workflow_id).await?;
        Ok(steps.into_iter().min_by_key(|s| s.order))
    }

    async fn get_transitions(&self, step_id: &str) -> ServiceResult<Vec<Step>> {
        let step = self.get_step(step_id).await?;
        match step {
            Some(step) => {
                let mut result = Vec::new();
                for target_id in &step.transitions_to {
                    if let Some(target_step) = self.get_step(target_id).await? {
                        result.push(target_step);
                    }
                }
                Ok(result)
            }
            None => Ok(Vec::new()),
        }
    }

    async fn get_final_steps(&self, workflow_id: &str) -> ServiceResult<Vec<Step>> {
        let steps = self.list_steps_for_workflow(workflow_id).await?;
        Ok(steps.into_iter().filter(|s| s.is_final).collect())
    }

    async fn list_all_steps(&self) -> ServiceResult<Vec<Step>> {
        // List all workflows for this project, then list steps for each
        let wf_query = with_fragments(LIST_WORKFLOWS, &[WORKFLOW_FIELDS]);
        let wf_variables = json!({ "project_id": self.client.project_id });
        let workflows: Vec<WorkflowResponse> = self
            .client
            .execute(&wf_query, wf_variables, "workflows")
            .await?;

        let mut all_steps = Vec::new();
        for workflow in &workflows {
            let steps = self.list_steps_for_workflow(&workflow.id).await?;
            all_steps.extend(steps);
        }

        Ok(all_steps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::{StepTransitionResponse, WorkflowStepResponse};
    use crate::config::SacrumConfig;

    fn create_test_client() -> GraphqlClient {
        GraphqlClient::new(SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "test-project".to_string(),
        ))
    }

    #[test]
    fn test_new_creates_service() {
        let client = create_test_client();
        let _service = SacrumStepService::new(client);
    }

    #[test]
    fn test_response_to_step_conversion() {
        let response = WorkflowStepResponse {
            id: "step-1".to_string(),
            name: "Review".to_string(),
            goal: Some("Review the code".to_string()),
            prompt: Some("Review the PR for issues".to_string()),
            agents: vec!["claude".to_string()],
            skills: vec!["code-review".to_string()],
            agent_config: None,
            is_final: false,
            step_order: 0,
            workflow_id: "wf-1".to_string(),
            transitions: Some(vec![StepTransitionResponse {
                id: "t-1".to_string(),
                to_step_id: "step-2".to_string(),
                label: Some("next".to_string()),
            }]),
            inserted_at: Some("2024-01-01T00:00:00Z".to_string()),
            updated_at: None,
        };

        let step = SacrumStepService::response_to_step(&response);

        assert_eq!(step.id, Some("step-1".to_string()));
        assert_eq!(step.name, "Review");
        assert_eq!(step.goal.as_deref(), Some("Review the code"));
        assert_eq!(step.prompt.as_deref(), Some("Review the PR for issues"));
        assert_eq!(step.agents, vec!["claude"]);
        assert_eq!(step.skills, vec!["code-review"]);
        assert!(!step.is_final);
        assert_eq!(step.order, 0);
        assert_eq!(step.workflow_id, "wf-1");
        assert_eq!(step.transitions_to, vec!["step-2"]);
        assert!(step.created_at.is_some());
    }

    #[test]
    fn test_response_to_step_minimal() {
        let response = WorkflowStepResponse {
            id: "step-min".to_string(),
            name: "Minimal".to_string(),
            goal: None,
            prompt: None,
            agents: vec![],
            skills: vec![],
            agent_config: None,
            is_final: true,
            step_order: 5,
            workflow_id: "wf-1".to_string(),
            transitions: None,
            inserted_at: None,
            updated_at: None,
        };

        let step = SacrumStepService::response_to_step(&response);

        assert_eq!(step.id, Some("step-min".to_string()));
        assert_eq!(step.name, "Minimal");
        assert!(step.goal.is_none());
        assert!(step.prompt.is_none());
        assert!(step.agents.is_empty());
        assert!(step.skills.is_empty());
        assert!(step.is_final);
        assert_eq!(step.order, 5);
        assert!(step.transitions_to.is_empty());
    }

    #[test]
    fn test_response_to_step_with_agent_config() {
        let response = WorkflowStepResponse {
            id: "step-cfg".to_string(),
            name: "Configured".to_string(),
            goal: None,
            prompt: None,
            agents: vec![],
            skills: vec![],
            agent_config: Some(json!({"model": "claude-opus"})),
            is_final: false,
            step_order: 0,
            workflow_id: "wf-1".to_string(),
            transitions: None,
            inserted_at: None,
            updated_at: None,
        };

        let step = SacrumStepService::response_to_step(&response);

        assert_eq!(step.agent_config.model.as_deref(), Some("claude-opus"));
    }

    #[test]
    fn test_multiple_service_instances() {
        let client1 = create_test_client();
        let client2 = create_test_client();

        let _s1 = SacrumStepService::new(client1);
        let _s2 = SacrumStepService::new(client2);
    }

    // =========================================================================
    // Wiremock integration tests for GraphQL step operations
    // =========================================================================

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn create_wiremock_service(server_url: &str) -> SacrumStepService {
        let client = GraphqlClient::new(SacrumConfig::new(
            server_url.to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        ));
        SacrumStepService::new(client)
    }

    fn graphql_response(field: &str, data: serde_json::Value) -> serde_json::Value {
        json!({
            "data": {
                field: data
            }
        })
    }

    fn make_step_response(
        id: &str,
        name: &str,
        workflow_id: &str,
        step_order: i32,
    ) -> serde_json::Value {
        json!({
            "id": id,
            "name": name,
            "goal": null,
            "agents": [],
            "skills": [],
            "agent_config": null,
            "is_final": false,
            "step_order": step_order,
            "workflow_id": workflow_id,
            "project_id": "test-project",
            "inserted_at": null,
            "updated_at": null,
            "transitions": []
        })
    }

    #[tokio::test]
    async fn test_create_step_via_graphql() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "create_workflow_step",
                make_step_response("step-new", "Review", "wf-1", 0),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let step = Step::new("Review", "wf-1");
        let result = service.create_step(&step).await.unwrap();

        assert_eq!(result.id, Some("step-new".to_string()));
        assert_eq!(result.name, "Review");
        assert_eq!(result.workflow_id, "wf-1");
    }

    #[tokio::test]
    async fn test_get_step_found() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "workflow_step",
                json!({
                    "id": "step-1",
                    "name": "Implement",
                    "goal": "Write the code",
                    "agents": ["claude"],
                    "skills": [],
                    "agent_config": null,
                    "is_final": false,
                    "step_order": 1,
                    "workflow_id": "wf-1",
                    "project_id": "test-project",
                    "inserted_at": "2024-01-01T00:00:00Z",
                    "updated_at": null,
                    "transitions": [{"id": "t-1", "to_step_id": "step-2", "label": "next"}]
                }),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.get_step("step-1").await.unwrap();

        assert!(result.is_some());
        let step = result.unwrap();
        assert_eq!(step.id, Some("step-1".to_string()));
        assert_eq!(step.name, "Implement");
        assert_eq!(step.goal.as_deref(), Some("Write the code"));
        assert_eq!(step.agents, vec!["claude"]);
        assert_eq!(step.transitions_to, vec!["step-2"]);
    }

    #[tokio::test]
    async fn test_get_step_not_found() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "not_found", "path": ["workflow_step"]}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.get_step("nonexistent").await.unwrap();

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_get_step_graphql_error_propagates() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "validation failed", "path": ["workflow_step"]}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.get_step("step-1").await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_steps_for_workflow() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "workflow_steps",
                json!([
                    make_step_response("step-1", "Backlog", "wf-1", 0),
                    make_step_response("step-2", "In Progress", "wf-1", 1),
                    make_step_response("step-3", "Done", "wf-1", 2)
                ]),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let steps = service.list_steps_for_workflow("wf-1").await.unwrap();

        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].name, "Backlog");
        assert_eq!(steps[1].name, "In Progress");
        assert_eq!(steps[2].name, "Done");
    }

    #[tokio::test]
    async fn test_update_step_via_graphql() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "update_workflow_step",
                make_step_response("step-1", "Updated", "wf-1", 0),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let updates = StepUpdate::new().with_name("Updated");
        let result = service.update_step("step-1", &updates).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_delete_step_via_graphql() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "delete_workflow_step": {"id": "step-1"}
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.delete_step("step-1").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_initial_step() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "workflow_steps",
                json!([
                    make_step_response("step-2", "In Progress", "wf-1", 1),
                    make_step_response("step-1", "Backlog", "wf-1", 0),
                    make_step_response("step-3", "Done", "wf-1", 2)
                ]),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.get_initial_step("wf-1").await.unwrap();

        assert!(result.is_some());
        let step = result.unwrap();
        assert_eq!(step.name, "Backlog");
        assert_eq!(step.order, 0);
    }

    #[tokio::test]
    async fn test_get_final_steps() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "workflow_steps",
                json!([
                    {
                        "id": "step-1", "name": "Backlog", "goal": null,
                        "agents": [], "skills": [], "agent_config": null,
                        "is_final": false, "step_order": 0, "workflow_id": "wf-1",
                        "project_id": "test-project",
                        "inserted_at": null, "updated_at": null, "transitions": []
                    },
                    {
                        "id": "step-2", "name": "Done", "goal": null,
                        "agents": [], "skills": [], "agent_config": null,
                        "is_final": true, "step_order": 1, "workflow_id": "wf-1",
                        "project_id": "test-project",
                        "inserted_at": null, "updated_at": null, "transitions": []
                    }
                ]),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let final_steps = service.get_final_steps("wf-1").await.unwrap();

        assert_eq!(final_steps.len(), 1);
        assert_eq!(final_steps[0].name, "Done");
        assert!(final_steps[0].is_final);
    }

    #[tokio::test]
    async fn test_step_exists_true() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "workflow_step",
                make_step_response("step-1", "Exists", "wf-1", 0),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let exists = service.step_exists("step-1").await.unwrap();

        assert!(exists);
    }

    #[tokio::test]
    async fn test_step_exists_false() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "not_found", "path": ["workflow_step"]}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let exists = service.step_exists("nonexistent").await.unwrap();

        assert!(!exists);
    }

    #[tokio::test]
    async fn test_list_all_steps() {
        let server = MockServer::start().await;

        // First call: list workflows
        // Second call: list steps for workflow wf-1
        // We use a sequence of responses - wiremock matches all POST /graphql
        // so we need to handle both calls returning appropriate data.
        // Since wiremock matches in order of mounting, we'll use a counter approach.
        // For simplicity, we mount two mocks that both match POST /graphql.
        // The first mock will be consumed first (list_workflows), then the second (list_steps).

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "workflows",
                json!([
                    {
                        "id": "wf-1", "name": "Dev",
                        "description": null, "auto_advance": false,
                        "is_default": false, "display_order": 0,
                        "metadata": null, "initial_step_id": null,
                        "project_id": "test-project",
                        "inserted_at": null, "updated_at": null,
                        "transitions": []
                    }
                ]),
            )))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "workflow_steps",
                json!([
                    make_step_response("step-1", "Backlog", "wf-1", 0),
                    make_step_response("step-2", "Done", "wf-1", 1)
                ]),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let all_steps = service.list_all_steps().await.unwrap();

        assert_eq!(all_steps.len(), 2);
        assert_eq!(all_steps[0].name, "Backlog");
        assert_eq!(all_steps[1].name, "Done");
    }

    #[tokio::test]
    async fn test_create_step_with_id_delegates() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "create_workflow_step",
                make_step_response("step-backend-id", "Review", "wf-1", 0),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let step = Step::new("Review", "wf-1");
        // The caller-provided ID "my-custom-id" is ignored; backend generates its own
        let result = service
            .create_step_with_id("my-custom-id", &step)
            .await
            .unwrap();

        assert_eq!(result.id, Some("step-backend-id".to_string()));
    }
}
