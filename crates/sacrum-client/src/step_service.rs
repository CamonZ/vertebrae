//! StepService implementation for Sacrum GraphQL API
//!
//! Implements the StepService trait by making GraphQL calls to the Sacrum API.
//! Full CRUD operations are available for workflow steps.

use async_trait::async_trait;
use serde_json::json;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::{Step, StepConfig, StepType, StepUpdate};
use vertebrae_core::step_service::StepService;
use vertebrae_core::validate_step_config;

use crate::api_types::{ShortIdResponse, WorkflowResponse, WorkflowStepResponse};
use crate::client::{GraphqlClient, with_fragments};
use crate::error::SacrumClientError;
use crate::queries::steps::{
    CREATE_STEP, DELETE_STEP, GET_STEP, LIST_STEPS, RESOLVE_STEP_SHORT_ID, STEP_FIELDS,
    SYNC_STEP_TRANSITIONS, update_step_query,
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

    fn response_to_step(response: &WorkflowStepResponse) -> ServiceResult<Step> {
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

        let step_type = response
            .step_type
            .as_deref()
            .map(StepType::from_wire_str)
            .unwrap_or_default();

        let config =
            StepConfig::from_value(&step_type, response.config.clone().unwrap_or_default())
                .map_err(|e| {
                    ServiceError::validation_failed(format!(
                        "Invalid {step_type} config for step {}: {e}",
                        response.id
                    ))
                })?;

        Ok(Step {
            id: Some(response.id.clone()),
            name: response.name.clone(),
            workflow_id: response.workflow_id.clone(),
            goal: response.goal.clone(),
            step_type,
            config,
            persistence_options: response.persistence_options.clone(),
            transitions_to,
            order: response.step_order,
            created_at,
            updated_at,
        })
    }

    fn validate_stop_transitions(
        step_type: &StepType,
        transitions_to: &[String],
    ) -> ServiceResult<()> {
        if matches!(step_type, StepType::Stop) && transitions_to.len() != 1 {
            return Err(ServiceError::validation_failed(
                "stop steps must have exactly one outgoing transition",
            ));
        }

        Ok(())
    }

    fn json_variable(value: &impl serde::Serialize, label: &str) -> ServiceResult<String> {
        serde_json::to_string(value)
            .map_err(|e| ServiceError::validation_failed(format!("Invalid {label}: {e}")))
    }
}

#[async_trait]
impl StepService for SacrumStepService {
    async fn create_step(&self, step: &Step) -> ServiceResult<Step> {
        Self::validate_stop_transitions(&step.step_type, &step.transitions_to)?;
        validate_step_config(step)?;

        let query = with_fragments(CREATE_STEP, &[STEP_FIELDS]);
        let mut variables = json!({
            "workflow_id": step.workflow_id,
            "name": step.name,
            "goal": step.goal,
            "step_type": step.step_type.as_str(),
            "step_order": step.order,
        });
        if let Some(config) = &step.config {
            variables["config"] = json!(Self::json_variable(config, "config")?);
        }
        if let Some(options) = &step.persistence_options {
            variables["persistence_options"] =
                json!(Self::json_variable(options, "persistence options")?);
        }

        let response: WorkflowStepResponse = self
            .client
            .execute(&query, variables, "create_workflow_step")
            .await?;

        let mut created = Self::response_to_step(&response)?;

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
            created = Self::response_to_step(&synced)?;
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
            Ok(response) => Self::response_to_step(&response).map(Some),
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

    async fn resolve_short_id(
        &self,
        prefix: &str,
        workflow_id: Option<&str>,
    ) -> ServiceResult<String> {
        // Backend's resolve_step_short_id is scoped to a workflow. If the caller
        // didn't supply one, iterate workflows and aggregate matches client-side.
        if let Some(wf_id) = workflow_id {
            let variables = json!({
                "project_id": self.client.project_id(),
                "workflow_id": wf_id,
                "prefix": prefix,
            });

            let response: ShortIdResponse = self
                .client
                .execute(RESOLVE_STEP_SHORT_ID, variables, "resolve_step_short_id")
                .await?;

            return Ok(response.id);
        }

        // No workflow context: scan all steps in the project. We tolerate the
        // GraphQL error we'd otherwise hit on a per-workflow miss because we
        // want to surface a single project-scoped result.
        let prefix_lower = prefix.to_lowercase();
        let steps = self.list_all_steps().await?;
        let matches: Vec<String> = steps
            .into_iter()
            .filter_map(|s| s.id)
            .filter(|id| id.to_lowercase().starts_with(&prefix_lower))
            .collect();

        match matches.len() {
            0 => Err(ServiceError::validation_failed(format!(
                "step with prefix '{}' not found",
                prefix
            ))),
            1 => Ok(matches.into_iter().next().unwrap()),
            _ => Err(ServiceError::validation_failed(format!(
                "ambiguous prefix '{}': multiple steps match: {}",
                prefix,
                matches.join(", ")
            ))),
        }
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

        responses.iter().map(Self::response_to_step).collect()
    }

    async fn update_step(&self, id: &str, updates: &StepUpdate) -> ServiceResult<String> {
        let query = with_fragments(&update_step_query(updates), &[STEP_FIELDS]);
        let mut variables = json!({ "id": id });

        if let Some(name) = &updates.name {
            variables["name"] = json!(name);
        }
        if let Some(goal) = &updates.goal {
            variables["goal"] = json!(goal);
        }
        if let Some(config) = &updates.config {
            variables["config"] = json!(Self::json_variable(config, "config")?);
        }
        if let Some(order) = updates.order {
            variables["step_order"] = json!(order);
        }
        match &updates.persistence_options {
            Some(Some(options)) => {
                variables["persistence_options"] =
                    json!(Self::json_variable(options, "persistence options")?);
            }
            Some(None) => {
                variables["persistence_options"] = serde_json::Value::Null;
            }
            None => {}
        }

        let response: WorkflowStepResponse = self
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

        Ok(response.workflow_id)
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

    async fn get_finish_steps(&self, workflow_id: &str) -> ServiceResult<Vec<Step>> {
        let steps = self.list_steps_for_workflow(workflow_id).await?;
        Ok(steps
            .into_iter()
            .filter(|s| s.step_type == StepType::Finish)
            .collect())
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

    fn step_response(step_type: Option<&str>, config: serde_json::Value) -> WorkflowStepResponse {
        WorkflowStepResponse {
            id: "step-1".to_string(),
            name: "Review".to_string(),
            goal: None,
            step_type: step_type.map(str::to_string),
            config: Some(config),
            persistence_options: None,
            step_order: 0,
            workflow_id: "wf-1".to_string(),
            transitions: None,
            inserted_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn test_response_to_step_conversion() {
        let response = WorkflowStepResponse {
            goal: Some("Review the code".to_string()),
            persistence_options: Some(json!({
                "artifact": {"logical_name": "step_result"}
            })),
            transitions: Some(vec![StepTransitionResponse {
                id: "t-1".to_string(),
                to_step_id: "step-2".to_string(),
                label: Some("next".to_string()),
            }]),
            inserted_at: Some("2024-01-01T00:00:00Z".to_string()),
            ..step_response(
                Some("llm_inference"),
                json!({
                    "version": 1,
                    "prompt": "Review the PR for issues",
                    "output_schema": {"type": "object"},
                    "agents": ["claude"],
                    "skills": ["code-review"],
                    "agent_config": {"model": "claude-opus"}
                }),
            )
        };

        let step = SacrumStepService::response_to_step(&response).unwrap();

        assert_eq!(step.id, Some("step-1".to_string()));
        assert_eq!(step.name, "Review");
        assert_eq!(step.goal.as_deref(), Some("Review the code"));
        assert_eq!(step.step_type, StepType::LlmInference);
        assert_eq!(step.prompt(), Some("Review the PR for issues"));
        assert_eq!(step.agents(), ["claude"]);
        assert_eq!(step.skills(), ["code-review"]);
        assert_eq!(step.output_schema(), Some(&json!({"type": "object"})));
        assert_eq!(
            step.agent_config().unwrap().model.as_deref(),
            Some("claude-opus")
        );
        assert_eq!(
            step.persistence_options,
            Some(json!({"artifact": {"logical_name": "step_result"}}))
        );
        assert_eq!(step.order, 0);
        assert_eq!(step.workflow_id, "wf-1");
        assert_eq!(step.transitions_to, vec!["step-2"]);
        assert!(step.created_at.is_some());
    }

    #[test]
    fn test_response_to_step_decodes_route_config_opaquely() {
        let route_config = json!({
            "version": 1,
            "future": {"unknown": ["nested", true, null]}
        });
        let step = SacrumStepService::response_to_step(&step_response(
            Some("route"),
            json!({"version": 1, "route_config": route_config}),
        ))
        .unwrap();

        assert_eq!(step.step_type, StepType::Route);
        assert_eq!(step.route_config(), Some(&route_config));
        assert_eq!(step.prompt(), None);
    }

    #[test]
    fn test_response_to_step_decodes_wait_children_config() {
        let step = SacrumStepService::response_to_step(&step_response(
            Some("wait_children"),
            json!({"version": 1, "output_schema": {"type": "object"}}),
        ))
        .unwrap();

        assert_eq!(
            step.config,
            Some(StepConfig::WaitChildren(
                vertebrae_core::WaitChildrenConfig {
                    version: 1,
                    output_schema: Some(json!({"type": "object"})),
                }
            ))
        );
    }

    #[test]
    fn test_response_to_step_null_config_for_config_less_types() {
        for step_type in ["human_input", "stop", "finish"] {
            let step = SacrumStepService::response_to_step(&step_response(
                Some(step_type),
                serde_json::Value::Null,
            ))
            .unwrap();
            assert_eq!(step.config, None, "{step_type}");
        }
    }

    #[test]
    fn test_response_to_step_rejects_malformed_config() {
        let error = SacrumStepService::response_to_step(&step_response(
            Some("llm_inference"),
            json!({"version": 1, "agents": "not-a-list"}),
        ))
        .unwrap_err();
        assert!(error.to_string().contains("Invalid llm_inference config"));
    }

    #[test]
    fn test_response_to_step_unknown_step_type_is_preserved() {
        let step = SacrumStepService::response_to_step(&step_response(
            Some("future_type"),
            json!({"version": 1}),
        ))
        .unwrap();
        assert_eq!(
            step.step_type,
            StepType::Unsupported("future_type".to_string())
        );
        assert_eq!(step.config, None);
    }

    #[test]
    fn test_response_to_step_maps_all_step_type_variants() {
        for (input, expected) in [
            ("llm_inference", StepType::LlmInference),
            ("route", StepType::Route),
            ("wait_children", StepType::WaitChildren),
            ("human_input", StepType::HumanInput),
            ("stop", StepType::Stop),
            ("finish", StepType::Finish),
            ("execute", StepType::Unsupported("execute".to_string())),
        ] {
            let step = SacrumStepService::response_to_step(&step_response(
                Some(input),
                serde_json::Value::Null,
            ))
            .unwrap();
            assert_eq!(
                step.step_type, expected,
                "step_type '{}' should map to {:?}",
                input, expected
            );
        }
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
            "step_type": "llm_inference",
            "config": {
                "version": 1,
                "prompt": null,
                "output_schema": null,
                "agents": [],
                "skills": [],
                "agent_config": null
            },
            "persistence_options": null,
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
    async fn test_create_step_rejects_config_fields_the_type_does_not_declare() {
        let service = create_wiremock_service("http://localhost:4000");
        let mut step = Step::new("Route", "wf-1").with_step_type(StepType::Route);
        step.config = Some(StepConfig::LlmInference(Box::default()));

        let error = service.create_step(&step).await.unwrap_err();

        assert!(
            error
                .to_string()
                .contains("is not supported for route steps"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn test_create_step_sends_type_and_config() {
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
        let step = Step::new("Review", "wf-1")
            .with_prompt("Review it")
            .with_skills(vec!["review".to_string()]);
        service.create_step(&step).await.unwrap();

        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["variables"]["step_type"], "llm_inference");
        let config: serde_json::Value =
            serde_json::from_str(body["variables"]["config"].as_str().unwrap()).unwrap();
        assert_eq!(
            config,
            json!({
                "version": 1,
                "prompt": "Review it",
                "output_schema": null,
                "agents": [],
                "skills": ["review"],
                "agent_config": {}
            })
        );
    }

    #[tokio::test]
    async fn test_create_config_less_step_omits_config() {
        let server = MockServer::start().await;
        let mut response = make_step_response("step-done", "Done", "wf-1", 0);
        response["step_type"] = json!("finish");
        response["config"] = serde_json::Value::Null;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(graphql_response("create_workflow_step", response)),
            )
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let step = Step::new("Done", "wf-1").with_step_type(StepType::Finish);
        let created = service.create_step(&step).await.unwrap();

        assert_eq!(created.config, None);
        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["variables"]["step_type"], "finish");
        assert!(body["variables"].get("config").is_none());
    }

    #[tokio::test]
    async fn test_create_step_serializes_persistence_options_and_maps_response() {
        let server = MockServer::start().await;

        let mut response = make_step_response("step-new", "Review", "wf-1", 0);
        response["persistence_options"] = json!({
            "artifact": {"logical_name": "step_result"}
        });
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(graphql_response("create_workflow_step", response)),
            )
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let options = json!({"artifact": {"logical_name": "step_result"}});
        let step = Step::new("Review", "wf-1").with_persistence_options(options.clone());
        let result = service.create_step(&step).await.unwrap();

        assert_eq!(result.persistence_options, Some(options));
        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            body["variables"]["persistence_options"],
            r#"{"artifact":{"logical_name":"step_result"}}"#
        );
    }

    #[tokio::test]
    async fn test_create_step_serializes_route_config_without_reinterpretation() {
        let server = MockServer::start().await;
        let route_config = json!({
            "version": 1,
            "rules": [{
                "id": "future-rule",
                "when": {"ref": "task.level", "op": "eq", "value": "task"},
                "future": ["keep", 3, false, null]
            }]
        });

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "create_workflow_step",
                make_step_response("step-route", "Route", "wf-1", 0),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let step = Step::new("Route", "wf-1")
            .with_step_type(StepType::Route)
            .with_route_config(route_config.clone());
        service.create_step(&step).await.unwrap();

        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        let config: serde_json::Value =
            serde_json::from_str(body["variables"]["config"].as_str().unwrap()).unwrap();
        assert_eq!(config, json!({"version": 1, "route_config": route_config}));
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
                    "step_type": "llm_inference",
                    "config": {"version": 1, "agents": ["claude"]},
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
        assert_eq!(step.agents(), ["claude"]);
        assert_eq!(step.transitions_to, vec!["step-2"]);
    }

    #[tokio::test]
    async fn test_get_step_maps_human_input_step_type() {
        let server = MockServer::start().await;

        let mut response = make_step_response("step-1", "Approval", "wf-1", 0);
        response["step_type"] = json!("human_input");

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(graphql_response("workflow_step", response)),
            )
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let step = service.get_step("step-1").await.unwrap().unwrap();

        assert_eq!(step.step_type, StepType::HumanInput);
    }

    #[tokio::test]
    async fn test_get_step_maps_finish_step_type() {
        let server = MockServer::start().await;

        let mut response = make_step_response("step-1", "Finish", "wf-1", 0);
        response["step_type"] = json!("finish");

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(graphql_response("workflow_step", response)),
            )
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let step = service.get_step("step-1").await.unwrap().unwrap();

        assert_eq!(step.step_type, StepType::Finish);
    }

    #[tokio::test]
    async fn test_get_step_maps_stop_step_type() {
        let server = MockServer::start().await;

        let mut response = make_step_response("step-1", "Stop", "wf-1", 0);
        response["step_type"] = json!("stop");
        response["transitions"] = json!([{
            "id": "t-1",
            "to_step_id": "step-next",
            "label": "continue"
        }]);

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(graphql_response("workflow_step", response)),
            )
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let step = service.get_step("step-1").await.unwrap().unwrap();

        assert_eq!(step.step_type, StepType::Stop);
        assert_eq!(step.transitions_to, vec!["step-next"]);
    }

    #[tokio::test]
    async fn test_create_stop_step_requires_exactly_one_transition() {
        let service = create_wiremock_service("http://localhost:4000");
        let step = Step::new("Stop", "wf-1").with_step_type(StepType::Stop);

        let error = service.create_step(&step).await.unwrap_err();

        assert!(
            error
                .to_string()
                .contains("exactly one outgoing transition")
        );
    }

    #[tokio::test]
    async fn test_get_step_preserves_unsupported_step_type() {
        let server = MockServer::start().await;

        let mut response = make_step_response("step-1", "Manual Gate", "wf-1", 0);
        response["step_type"] = json!("manual_gate");

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(graphql_response("workflow_step", response)),
            )
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let step = service.get_step("step-1").await.unwrap().unwrap();

        assert_eq!(
            step.step_type,
            StepType::Unsupported("manual_gate".to_string())
        );
        assert_eq!(step.config, None);
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
                "errors": [{
                    "message": "route_config validation failed",
                    "path": ["workflowStep", "routeConfig"],
                    "extensions": {
                        "rule": "unknown destination",
                        "field_path": "$.rules[0].transition.step_id"
                    }
                }]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.get_step("step-1").await;

        let error = result.unwrap_err();
        let message = error.to_string();
        assert!(message.contains("route_config validation failed"));
        assert!(message.contains("workflowStep.routeConfig"));
        assert!(message.contains("unknown destination"));
        assert!(message.contains("$.rules[0].transition.step_id"));
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

        assert_eq!(result.unwrap(), "wf-1");
    }

    #[tokio::test]
    async fn test_update_step_omits_unmodified_nullable_arguments() {
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
        service
            .update_step("step-1", &StepUpdate::new().with_name("Updated"))
            .await
            .unwrap();

        let requests = server.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        let query = body["query"].as_str().unwrap();
        let operation = query.split("fragment StepFields").next().unwrap();
        assert!(!operation.contains("config: $config"));
        assert!(!operation.contains("step_type"));
        assert_eq!(body["variables"]["name"], "Updated");
    }

    #[tokio::test]
    async fn test_update_step_surfaces_immutable_step_type_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {"update_workflow_step": null},
                "errors": [{
                    "message": "config: $.prompt: is not supported for route steps",
                    "path": ["update_workflow_step"]
                }]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let error = service
            .update_step("step-1", &StepUpdate::new().with_prompt("new prompt"))
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("config: $.prompt: is not supported for route steps"),
            "{error}"
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_update_step_serializes_and_clears_persistence_options() {
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
        let options = json!({"artifact": {"logical_name": "step_result"}});
        service
            .update_step(
                "step-1",
                &StepUpdate::new().with_persistence_options(Some(options)),
            )
            .await
            .unwrap();
        service
            .update_step("step-1", &StepUpdate::new().with_persistence_options(None))
            .await
            .unwrap();

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2);
        let set_body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            set_body["variables"]["persistence_options"],
            r#"{"artifact":{"logical_name":"step_result"}}"#
        );
        let clear_body: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert!(clear_body["variables"]["persistence_options"].is_null());
    }

    #[tokio::test]
    async fn test_update_step_sends_config_as_a_partial_patch() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "update_workflow_step",
                make_step_response("step-1", "Updated", "wf-1", 0),
            )))
            .mount(&server)
            .await;

        let route_config = json!({
            "version": 1,
            "unknown": {"nested": ["value", 7, true, null]}
        });
        let service = create_wiremock_service(&server.uri());
        service
            .update_step(
                "step-1",
                &StepUpdate::new().with_route_config(Some(route_config.clone())),
            )
            .await
            .unwrap();
        service
            .update_step(
                "step-1",
                &StepUpdate::new().clear_prompt().with_output_schema(None),
            )
            .await
            .unwrap();

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2);
        let config = |index: usize| -> serde_json::Value {
            let body: serde_json::Value = serde_json::from_slice(&requests[index].body).unwrap();
            assert!(body["variables"].get("step_type").is_none());
            serde_json::from_str(body["variables"]["config"].as_str().unwrap()).unwrap()
        };
        assert_eq!(config(0), json!({"route_config": route_config}));
        assert_eq!(config(1), json!({"prompt": null, "output_schema": null}));
    }

    #[tokio::test]
    async fn test_update_step_syncs_transitions() {
        let server = MockServer::start().await;

        let response = json!({
            "data": {
                "update_workflow_step": make_step_response("step-1", "Pause", "wf-1", 0),
                "sync_step_transitions": make_step_response("step-1", "Pause", "wf-1", 0)
            }
        });
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let updates = StepUpdate::new().with_transitions_to(vec!["step-next".to_string()]);
        service.update_step("step-1", &updates).await.unwrap();

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2, "update and transition sync requests");
        let sync_body: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(
            sync_body["variables"]["transitions"],
            json!([{ "to_step_id": "step-next" }])
        );
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
    async fn test_get_finish_steps() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(graphql_response(
                "workflow_steps",
                json!([
                    {
                        "id": "step-1", "name": "Backlog", "goal": null,
                        "step_type": "llm_inference", "config": {"version": 1},
                        "step_order": 0, "workflow_id": "wf-1",
                        "project_id": "test-project",
                        "inserted_at": null, "updated_at": null, "transitions": []
                    },
                    {
                        "id": "step-2", "name": "Done", "goal": null,
                        "step_type": "finish", "config": null, "step_order": 1, "workflow_id": "wf-1",
                        "project_id": "test-project",
                        "inserted_at": null, "updated_at": null, "transitions": []
                    }
                ]),
            )))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let final_steps = service.get_finish_steps("wf-1").await.unwrap();

        assert_eq!(final_steps.len(), 1);
        assert_eq!(final_steps[0].name, "Done");
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
                        "description": null,
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
