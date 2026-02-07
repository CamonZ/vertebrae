//! WorkflowService implementation for Sacrum GraphQL API
//!
//! Implements the WorkflowService trait by making GraphQL calls to the Sacrum API.
//! Uses the GraphqlClient with query strings from crate::queries::workflows.

use async_trait::async_trait;
use serde_json::json;
use vertebrae_core::WorkflowSummary;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::{Workflow, WorkflowTransition};
use vertebrae_core::workflow_service::{
    AssignResult, CreateWorkflowOptions, UpdateWorkflowOptions, WorkflowInfo, WorkflowService,
};

use crate::api_types::{WorkflowResponse, WorkflowStepResponse, WorkflowTransitionResponse};
use crate::client::{GraphqlClient, with_fragments};
use crate::queries::tasks::{ASSIGN_WORKFLOW, UNASSIGN_WORKFLOW};
use crate::queries::workflows::{
    CREATE_WORKFLOW, CREATE_WORKFLOW_TRANSITION, DELETE_WORKFLOW, DELETE_WORKFLOW_TRANSITION,
    GET_WORKFLOW, LIST_WORKFLOWS, UPDATE_WORKFLOW, WORKFLOW_FIELDS,
};

/// Intermediate type for deserializing GET_WORKFLOW responses that include workflow_steps.
#[derive(Debug, Clone, serde::Deserialize)]
struct WorkflowWithSteps {
    #[serde(flatten)]
    workflow: WorkflowResponse,
    #[serde(default)]
    workflow_steps: Vec<WorkflowStepResponse>,
}

/// Intermediate type for deserializing ASSIGN_WORKFLOW responses.
#[derive(Debug, Clone, serde::Deserialize)]
struct AssignWorkflowResponse {
    id: String,
    workflow_id: Option<String>,
    #[allow(dead_code)]
    current_step_id: Option<String>,
}

/// WorkflowService implementation for Sacrum GraphQL client
pub struct SacrumWorkflowService {
    client: GraphqlClient,
}

impl SacrumWorkflowService {
    /// Create a new SacrumWorkflowService
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }

    fn response_to_workflow(&self, response: &WorkflowResponse) -> Workflow {
        let metadata = response
            .metadata
            .as_ref()
            .and_then(|v| {
                v.as_object().map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
            })
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

        // Convert transitions from response
        let transitions = response
            .transitions
            .as_ref()
            .map(|ts| {
                ts.iter()
                    .map(|t| WorkflowTransition {
                        id: Some(t.id.clone()),
                        from_workflow: response.id.clone(),
                        to_workflow: t.to_workflow_id.clone(),
                        label: t.label.clone().unwrap_or_default(),
                        target_step: t.target_step_id.clone(),
                        created_at: None,
                    })
                    .collect()
            })
            .unwrap_or_default();

        Workflow {
            id: Some(response.id.clone()),
            name: response.name.clone(),
            description: response.description.clone(),
            initial_step: response.initial_step_id.clone(),
            metadata,
            auto_advance: response.auto_advance.unwrap_or(false),
            order: response.display_order.unwrap_or(0),
            transitions,
            created_at,
            updated_at,
        }
    }

    fn response_to_summary(&self, response: &WorkflowResponse) -> WorkflowSummary {
        WorkflowSummary {
            id: response.id.clone(),
            name: response.name.clone(),
            description: response.description.clone(),
            step_count: 0, // Step count not included in list response; fetched separately
        }
    }

    fn extract_transitions(
        workflows: &[WorkflowResponse],
        from_workflow_id: Option<&str>,
    ) -> Vec<WorkflowTransition> {
        let mut transitions = Vec::new();
        for workflow in workflows {
            if let Some(from_id) = from_workflow_id
                && workflow.id != from_id
            {
                continue;
            }
            if let Some(wf_transitions) = &workflow.transitions {
                for t in wf_transitions {
                    transitions.push(WorkflowTransition {
                        id: Some(t.id.clone()),
                        from_workflow: workflow.id.clone(),
                        to_workflow: t.to_workflow_id.clone(),
                        label: t.label.clone().unwrap_or_default(),
                        target_step: t.target_step_id.clone(),
                        created_at: None,
                    });
                }
            }
        }
        transitions
    }
}

#[async_trait]
impl WorkflowService for SacrumWorkflowService {
    async fn create_workflow(&self, options: CreateWorkflowOptions) -> ServiceResult<String> {
        if options.name.trim().is_empty() {
            return Err(ServiceError::validation_failed("Name cannot be empty"));
        }

        let query = with_fragments(CREATE_WORKFLOW, &[WORKFLOW_FIELDS]);
        let variables = json!({
            "project_id": self.client.project_id(),
            "name": options.name,
            "description": options.description,
            "auto_advance": options.auto_advance,
            "display_order": options.order,
        });

        #[derive(serde::Deserialize)]
        struct IdResponse {
            id: String,
        }

        let response: IdResponse = self
            .client
            .execute(&query, variables, "create_workflow")
            .await?;
        Ok(response.id)
    }

    async fn get_workflow(&self, id: &str) -> ServiceResult<Workflow> {
        let query = with_fragments(GET_WORKFLOW, &[WORKFLOW_FIELDS]);
        let variables = json!({ "id": id });

        let response: WorkflowWithSteps =
            self.client.execute(&query, variables, "workflow").await?;
        Ok(self.response_to_workflow(&response.workflow))
    }

    async fn list_workflows(&self) -> ServiceResult<Vec<WorkflowSummary>> {
        let query = with_fragments(LIST_WORKFLOWS, &[WORKFLOW_FIELDS]);
        let variables = json!({ "project_id": self.client.project_id() });

        let workflows: Vec<WorkflowResponse> =
            self.client.execute(&query, variables, "workflows").await?;

        Ok(workflows
            .iter()
            .map(|w| self.response_to_summary(w))
            .collect())
    }

    async fn list_workflows_full(&self) -> ServiceResult<Vec<Workflow>> {
        let query = with_fragments(LIST_WORKFLOWS, &[WORKFLOW_FIELDS]);
        let variables = json!({ "project_id": self.client.project_id() });

        let workflows: Vec<WorkflowResponse> =
            self.client.execute(&query, variables, "workflows").await?;

        Ok(workflows
            .iter()
            .map(|w| self.response_to_workflow(w))
            .collect())
    }

    async fn update_workflow(&self, id: &str, options: UpdateWorkflowOptions) -> ServiceResult<()> {
        let query = with_fragments(UPDATE_WORKFLOW, &[WORKFLOW_FIELDS]);
        let mut variables = json!({ "id": id });

        if let Some(name) = &options.name {
            variables["name"] = json!(name);
        }
        if let Some(desc) = &options.description {
            variables["description"] = json!(desc);
        }
        if let Some(auto_advance) = options.auto_advance {
            variables["auto_advance"] = json!(auto_advance);
        }
        if let Some(order) = options.order {
            variables["display_order"] = json!(order);
        }

        self.client.execute_void(&query, variables).await?;
        Ok(())
    }

    async fn delete_workflow(&self, id: &str) -> ServiceResult<()> {
        let query = with_fragments(DELETE_WORKFLOW, &[WORKFLOW_FIELDS]);
        let variables = json!({ "id": id });

        self.client.execute_void(&query, variables).await?;
        Ok(())
    }

    async fn workflow_exists(&self, id: &str) -> ServiceResult<bool> {
        match self.get_workflow(id).await {
            Ok(_) => Ok(true),
            Err(ServiceError::WorkflowNotFound { workflow_id: _ }) => Ok(false),
            Err(ServiceError::TaskNotFound { task_id: _ }) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn assign_workflow(
        &self,
        task_id: &str,
        workflow_id: &str,
    ) -> ServiceResult<AssignResult> {
        let variables = json!({
            "task_id": task_id,
            "workflow_id": workflow_id,
        });

        let response: AssignWorkflowResponse = self
            .client
            .execute(ASSIGN_WORKFLOW, variables, "assign_workflow")
            .await?;

        Ok(AssignResult {
            task_id: response.id,
            workflow_id: response
                .workflow_id
                .unwrap_or_else(|| workflow_id.to_string()),
            first_step_name: String::new(),
        })
    }

    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()> {
        let variables = json!({ "task_id": task_id });

        self.client
            .execute_void(UNASSIGN_WORKFLOW, variables)
            .await?;
        Ok(())
    }

    async fn get_workflow_info(
        &self,
        workflow_id: &str,
        current_step_id: Option<&str>,
    ) -> ServiceResult<WorkflowInfo> {
        let query = with_fragments(GET_WORKFLOW, &[WORKFLOW_FIELDS]);
        let variables = json!({ "id": workflow_id });

        let response: WorkflowWithSteps =
            self.client.execute(&query, variables, "workflow").await?;

        let workflow = self.response_to_workflow(&response.workflow);
        let steps = &response.workflow_steps;
        let total_steps = steps.len();

        // Find current step index and names
        let mut current_step_index = 0;
        let mut current_step_name = String::new();
        let mut current_step_id_resolved = None;
        let mut prev_step_name = None;
        let mut next_step_name = None;

        // Sort steps by step_order for proper navigation
        let mut sorted_steps: Vec<&WorkflowStepResponse> = steps.iter().collect();
        sorted_steps.sort_by_key(|s| s.step_order);

        if let Some(step_id) = current_step_id {
            for (i, step) in sorted_steps.iter().enumerate() {
                if step.id == step_id {
                    current_step_index = i;
                    current_step_name = step.name.clone();
                    current_step_id_resolved = Some(step.id.clone());
                    if i > 0 {
                        prev_step_name = Some(sorted_steps[i - 1].name.clone());
                    }
                    if i + 1 < sorted_steps.len() {
                        next_step_name = Some(sorted_steps[i + 1].name.clone());
                    }
                    break;
                }
            }
        } else if let Some(first_step) = sorted_steps.first() {
            current_step_name = first_step.name.clone();
            current_step_id_resolved = Some(first_step.id.clone());
            if sorted_steps.len() > 1 {
                next_step_name = Some(sorted_steps[1].name.clone());
            }
        }

        Ok(WorkflowInfo {
            id: workflow.id.unwrap_or_default(),
            name: workflow.name,
            current_step_id: current_step_id_resolved,
            current_step_name,
            current_step_index,
            total_steps,
            prev_step_name,
            next_step_name,
        })
    }

    async fn create_workflow_transition(
        &self,
        from_workflow_id: &str,
        to_workflow_id: &str,
        label: &str,
        target_step_id: Option<&str>,
    ) -> ServiceResult<WorkflowTransition> {
        let mut variables = json!({
            "from_workflow_id": from_workflow_id,
            "to_workflow_id": to_workflow_id,
        });

        if !label.is_empty() {
            variables["label"] = json!(label);
        }

        if let Some(step_id) = target_step_id {
            variables["target_step_id"] = json!(step_id);
        }

        let response: WorkflowTransitionResponse = self
            .client
            .execute(
                CREATE_WORKFLOW_TRANSITION,
                variables,
                "create_workflow_transition",
            )
            .await?;

        Ok(WorkflowTransition {
            id: Some(response.id),
            from_workflow: from_workflow_id.to_string(),
            to_workflow: response.to_workflow_id,
            label: response.label.unwrap_or_default(),
            target_step: response.target_step_id,
            created_at: None,
        })
    }

    async fn list_workflow_transitions(
        &self,
        from_workflow_id: Option<&str>,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        let query = with_fragments(LIST_WORKFLOWS, &[WORKFLOW_FIELDS]);
        let variables = json!({ "project_id": self.client.project_id() });

        let workflows: Vec<WorkflowResponse> =
            self.client.execute(&query, variables, "workflows").await?;

        Ok(Self::extract_transitions(&workflows, from_workflow_id))
    }

    async fn get_transitions_from_workflow(
        &self,
        workflow_id: &str,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        self.list_workflow_transitions(Some(workflow_id)).await
    }

    async fn get_transitions_to_workflow(
        &self,
        workflow_id: &str,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        let all = self.list_workflow_transitions(None).await?;
        Ok(all
            .into_iter()
            .filter(|t| t.to_workflow == workflow_id)
            .collect())
    }

    async fn delete_workflow_transition(
        &self,
        from_workflow_id: &str,
        to_workflow_id: &str,
    ) -> ServiceResult<()> {
        // Find the transition ID by looking at transitions on the source workflow
        let workflow = self.get_workflow(from_workflow_id).await?;
        let transition = workflow
            .transitions
            .iter()
            .find(|t| t.to_workflow == to_workflow_id)
            .ok_or_else(|| {
                ServiceError::InvalidInput(format!(
                    "No transition found from workflow {} to {}",
                    from_workflow_id, to_workflow_id
                ))
            })?;

        let transition_id = transition
            .id
            .as_ref()
            .ok_or_else(|| ServiceError::InvalidInput("Transition has no ID".to_string()))?;

        let variables = json!({ "id": transition_id });
        self.client
            .execute_void(DELETE_WORKFLOW_TRANSITION, variables)
            .await?;
        Ok(())
    }

    async fn workflow_transition_exists(
        &self,
        from_workflow_id: &str,
        to_workflow_id: &str,
    ) -> ServiceResult<bool> {
        let workflow = self.get_workflow(from_workflow_id).await?;
        Ok(workflow
            .transitions
            .iter()
            .any(|t| t.to_workflow == to_workflow_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::WorkflowTransitionResponse;
    use crate::config::SacrumConfig;

    fn create_test_client() -> GraphqlClient {
        GraphqlClient::new(SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-proj".to_string(),
        ))
    }

    fn make_workflow_response(id: &str, name: &str) -> WorkflowResponse {
        WorkflowResponse {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            auto_advance: None,
            is_default: None,
            display_order: None,
            metadata: None,
            initial_step_id: None,
            project_id: Some("test-proj".to_string()),
            workflow_steps: vec![],
            transitions: None,
            inserted_at: None,
            updated_at: None,
        }
    }

    fn make_transition(id: &str, to_workflow_id: &str) -> WorkflowTransitionResponse {
        WorkflowTransitionResponse {
            id: id.to_string(),
            to_workflow_id: to_workflow_id.to_string(),
            target_step_id: None,
            label: None,
        }
    }

    #[test]
    fn test_new_creates_service() {
        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        assert!(!service.client.project_id().is_empty());
    }

    #[test]
    fn test_workflow_summary_conversion() {
        let response = make_workflow_response("wf-1", "Test Workflow");

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let summary = service.response_to_summary(&response);

        assert_eq!(summary.id, "wf-1");
        assert_eq!(summary.name, "Test Workflow");
        assert_eq!(summary.description, None);
        assert_eq!(summary.step_count, 0);
    }

    #[test]
    fn test_workflow_summary_with_description() {
        let mut response = make_workflow_response("wf-2", "Complex Workflow");
        response.description = Some("A workflow with multiple steps".to_string());

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let summary = service.response_to_summary(&response);

        assert_eq!(summary.id, "wf-2");
        assert_eq!(summary.name, "Complex Workflow");
        assert_eq!(
            summary.description,
            Some("A workflow with multiple steps".to_string())
        );
    }

    #[test]
    fn test_response_to_workflow_conversion() {
        let mut response = make_workflow_response("wf-4", "Domain Workflow");
        response.description = Some("For domain objects".to_string());
        response.auto_advance = Some(true);
        response.display_order = Some(3);
        response.initial_step_id = Some("step-1".to_string());

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(workflow.id, Some("wf-4".to_string()));
        assert_eq!(workflow.name, "Domain Workflow");
        assert_eq!(workflow.description, Some("For domain objects".to_string()));
        assert!(workflow.auto_advance);
        assert_eq!(workflow.order, 3);
        assert_eq!(workflow.initial_step.as_deref(), Some("step-1"));
    }

    #[test]
    fn test_response_to_workflow_minimal() {
        let response = make_workflow_response("wf-5", "Minimal");

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(workflow.id, Some("wf-5".to_string()));
        assert_eq!(workflow.name, "Minimal");
        assert_eq!(workflow.description, None);
        assert!(!workflow.auto_advance);
        assert_eq!(workflow.order, 0);
        assert!(workflow.initial_step.is_none());
    }

    #[test]
    fn test_response_to_workflow_with_metadata() {
        let mut response = make_workflow_response("wf-meta", "Metadata Workflow");
        response.metadata = Some(json!({"key1": "value1", "key2": "value2"}));

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(workflow.metadata.get("key1").unwrap(), "value1");
        assert_eq!(workflow.metadata.get("key2").unwrap(), "value2");
    }

    #[test]
    fn test_response_to_workflow_with_timestamps() {
        let mut response = make_workflow_response("wf-ts", "Timestamped");
        response.inserted_at = Some("2024-01-01T00:00:00Z".to_string());
        response.updated_at = Some("2024-01-02T00:00:00Z".to_string());

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let workflow = service.response_to_workflow(&response);

        assert!(workflow.created_at.is_some());
        assert!(workflow.updated_at.is_some());
    }

    #[test]
    fn test_multiple_service_instances() {
        let client1 = create_test_client();
        let client2 = create_test_client();

        let _service1 = SacrumWorkflowService::new(client1);
        let _service2 = SacrumWorkflowService::new(client2);
    }

    #[test]
    fn test_summary_and_workflow_consistency() {
        let mut response = make_workflow_response("consistency-test", "Consistent Workflow");
        response.description = Some("Test consistency".to_string());

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);

        let summary = service.response_to_summary(&response);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(summary.id, workflow.id.as_ref().unwrap().as_str());
        assert_eq!(summary.name, workflow.name);
        assert_eq!(summary.description, workflow.description);
    }

    #[test]
    fn test_extract_transitions_from_workflows_with_transitions() {
        let mut wf = make_workflow_response("wf-1", "Source");
        wf.transitions = Some(vec![
            WorkflowTransitionResponse {
                id: "t-1".to_string(),
                to_workflow_id: "wf-2".to_string(),
                target_step_id: Some("step-5".to_string()),
                label: Some("on_done".to_string()),
            },
            make_transition("t-2", "wf-3"),
        ]);

        let result = SacrumWorkflowService::extract_transitions(&[wf], None);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, Some("t-1".to_string()));
        assert_eq!(result[0].from_workflow, "wf-1");
        assert_eq!(result[0].to_workflow, "wf-2");
        assert_eq!(result[0].label, "on_done");
        assert_eq!(result[0].target_step, Some("step-5".to_string()));

        assert_eq!(result[1].id, Some("t-2".to_string()));
        assert_eq!(result[1].from_workflow, "wf-1");
        assert_eq!(result[1].to_workflow, "wf-3");
        assert_eq!(result[1].label, "");
        assert_eq!(result[1].target_step, None);
    }

    #[test]
    fn test_extract_transitions_no_transitions() {
        let wf = make_workflow_response("wf-1", "No Transitions");

        let result = SacrumWorkflowService::extract_transitions(&[wf], None);

        assert!(result.is_empty());
    }

    #[test]
    fn test_extract_transitions_empty_transitions_list() {
        let mut wf = make_workflow_response("wf-1", "Empty List");
        wf.transitions = Some(vec![]);

        let result = SacrumWorkflowService::extract_transitions(&[wf], None);

        assert!(result.is_empty());
    }

    #[test]
    fn test_extract_transitions_filters_by_from_workflow_id() {
        let mut wf1 = make_workflow_response("wf-1", "Source A");
        wf1.transitions = Some(vec![make_transition("t-1", "wf-3")]);

        let mut wf2 = make_workflow_response("wf-2", "Source B");
        wf2.transitions = Some(vec![make_transition("t-2", "wf-3")]);

        let result = SacrumWorkflowService::extract_transitions(&[wf1, wf2], Some("wf-2"));

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].from_workflow, "wf-2");
        assert_eq!(result[0].id, Some("t-2".to_string()));
    }

    #[test]
    fn test_extract_transitions_filter_no_match() {
        let mut wf = make_workflow_response("wf-1", "Source");
        wf.transitions = Some(vec![make_transition("t-1", "wf-2")]);

        let result = SacrumWorkflowService::extract_transitions(&[wf], Some("wf-nonexistent"));

        assert!(result.is_empty());
    }

    #[test]
    fn test_extract_transitions_multiple_workflows() {
        let mut wf1 = make_workflow_response("wf-1", "First");
        wf1.transitions = Some(vec![make_transition("t-1", "wf-2")]);

        let mut wf2 = make_workflow_response("wf-2", "Second");
        wf2.transitions = Some(vec![
            make_transition("t-2", "wf-3"),
            make_transition("t-3", "wf-1"),
        ]);

        let wf3 = make_workflow_response("wf-3", "Third");

        let result = SacrumWorkflowService::extract_transitions(&[wf1, wf2, wf3], None);

        assert_eq!(result.len(), 3);
        assert_eq!(result[0].from_workflow, "wf-1");
        assert_eq!(result[0].to_workflow, "wf-2");
        assert_eq!(result[1].from_workflow, "wf-2");
        assert_eq!(result[1].to_workflow, "wf-3");
        assert_eq!(result[2].from_workflow, "wf-2");
        assert_eq!(result[2].to_workflow, "wf-1");
    }

    // =========================================================================
    // Wiremock integration tests for workflow GraphQL methods
    // =========================================================================

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn create_wiremock_service(server_url: &str) -> SacrumWorkflowService {
        let client = GraphqlClient::new(SacrumConfig::new(
            server_url.to_string(),
            "test-token".to_string(),
            "test-proj".to_string(),
        ));
        SacrumWorkflowService::new(client)
    }

    #[tokio::test]
    async fn test_create_workflow_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "create_workflow": {
                        "id": "wf-new"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let opts = CreateWorkflowOptions::new("Test Workflow", vec![]);
        let id = service.create_workflow(opts).await.unwrap();

        assert_eq!(id, "wf-new");
    }

    #[tokio::test]
    async fn test_create_workflow_empty_name_rejected() {
        let server = MockServer::start().await;
        let service = create_wiremock_service(&server.uri());

        let opts = CreateWorkflowOptions::new("  ", vec![]);
        let result = service.create_workflow(opts).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_workflow_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflow": {
                        "id": "wf-1",
                        "name": "Dev Workflow",
                        "description": "Development process",
                        "auto_advance": true,
                        "display_order": 1,
                        "initial_step_id": "step-1",
                        "workflow_steps": [
                            {
                                "id": "step-1",
                                "name": "backlog",
                                "step_order": 0,
                                "is_final": false,
                                "workflow_id": "wf-1",
                                "agents": [],
                                "skills": []
                            }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let workflow = service.get_workflow("wf-1").await.unwrap();

        assert_eq!(workflow.id, Some("wf-1".to_string()));
        assert_eq!(workflow.name, "Dev Workflow");
        assert_eq!(
            workflow.description,
            Some("Development process".to_string())
        );
        assert!(workflow.auto_advance);
        assert_eq!(workflow.order, 1);
    }

    #[tokio::test]
    async fn test_list_workflows_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflows": [
                        { "id": "wf-1", "name": "First" },
                        { "id": "wf-2", "name": "Second", "description": "The second one" }
                    ]
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let summaries = service.list_workflows().await.unwrap();

        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].id, "wf-1");
        assert_eq!(summaries[0].name, "First");
        assert_eq!(summaries[1].id, "wf-2");
        assert_eq!(summaries[1].name, "Second");
        assert_eq!(summaries[1].description, Some("The second one".to_string()));
    }

    #[tokio::test]
    async fn test_list_workflows_full_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflows": [
                        {
                            "id": "wf-1",
                            "name": "Full Workflow",
                            "auto_advance": true,
                            "display_order": 2,
                            "transitions": [
                                { "id": "t-1", "to_workflow_id": "wf-2", "label": "on_done" }
                            ]
                        }
                    ]
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let workflows = service.list_workflows_full().await.unwrap();

        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0].name, "Full Workflow");
        assert!(workflows[0].auto_advance);
        assert_eq!(workflows[0].order, 2);
        assert_eq!(workflows[0].transitions.len(), 1);
    }

    #[tokio::test]
    async fn test_update_workflow_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "update_workflow": { "id": "wf-1" }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let opts = UpdateWorkflowOptions::new().with_name("Updated Name");
        let result = service.update_workflow("wf-1", opts).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_delete_workflow_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "delete_workflow": { "id": "wf-1" }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.delete_workflow("wf-1").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_assign_workflow_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "assign_workflow": {
                        "id": "task-1",
                        "workflow_id": "wf-1",
                        "current_step_id": "step-1"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.assign_workflow("task-1", "wf-1").await.unwrap();

        assert_eq!(result.task_id, "task-1");
        assert_eq!(result.workflow_id, "wf-1");
    }

    #[tokio::test]
    async fn test_unassign_workflow_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "unassign_workflow": { "id": "task-1" }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.unassign_workflow("task-1").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_create_workflow_transition_with_all_fields() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "create_workflow_transition": {
                        "id": "t-new",
                        "to_workflow_id": "wf-target",
                        "label": "promote",
                        "target_step_id": "step-5"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .create_workflow_transition("wf-source", "wf-target", "promote", Some("step-5"))
            .await
            .unwrap();

        assert_eq!(result.id, Some("t-new".to_string()));
        assert_eq!(result.from_workflow, "wf-source");
        assert_eq!(result.to_workflow, "wf-target");
        assert_eq!(result.label, "promote");
        assert_eq!(result.target_step, Some("step-5".to_string()));
    }

    #[tokio::test]
    async fn test_create_workflow_transition_minimal() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "create_workflow_transition": {
                        "id": "t-1",
                        "to_workflow_id": "wf-b",
                        "label": null,
                        "target_step_id": null
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .create_workflow_transition("wf-a", "wf-b", "", None)
            .await
            .unwrap();

        assert_eq!(result.id, Some("t-1".to_string()));
        assert_eq!(result.from_workflow, "wf-a");
        assert_eq!(result.to_workflow, "wf-b");
        assert_eq!(result.label, "");
        assert_eq!(result.target_step, None);
    }

    #[tokio::test]
    async fn test_delete_workflow_transition_success() {
        let server = MockServer::start().await;

        // First call: GET workflow to find the transition ID
        // Second call: DELETE the transition
        // Both go to /graphql as POST, so we use respond sequentially
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflow": {
                        "id": "wf-source",
                        "name": "Source",
                        "transitions": [
                            { "id": "t-99", "to_workflow_id": "wf-target", "label": "go", "target_step_id": null }
                        ],
                        "workflow_steps": []
                    }
                }
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "delete_workflow_transition": { "id": "t-99" }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .delete_workflow_transition("wf-source", "wf-target")
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_delete_workflow_transition_not_found() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflow": {
                        "id": "wf-source",
                        "name": "Source",
                        "transitions": [],
                        "workflow_steps": []
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .delete_workflow_transition("wf-source", "wf-nonexistent")
            .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_workflow_transition_exists_true() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflow": {
                        "id": "wf-1",
                        "name": "Source",
                        "transitions": [
                            { "id": "t-1", "to_workflow_id": "wf-2", "label": null, "target_step_id": null }
                        ],
                        "workflow_steps": []
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let exists = service
            .workflow_transition_exists("wf-1", "wf-2")
            .await
            .unwrap();

        assert!(exists);
    }

    #[tokio::test]
    async fn test_workflow_transition_exists_false() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflow": {
                        "id": "wf-1",
                        "name": "Source",
                        "transitions": [],
                        "workflow_steps": []
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let exists = service
            .workflow_transition_exists("wf-1", "wf-999")
            .await
            .unwrap();

        assert!(!exists);
    }

    #[tokio::test]
    async fn test_get_workflow_info_with_steps() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflow": {
                        "id": "wf-1",
                        "name": "Dev Flow",
                        "workflow_steps": [
                            { "id": "s-1", "name": "backlog", "step_order": 0, "is_final": false, "workflow_id": "wf-1", "agents": [], "skills": [] },
                            { "id": "s-2", "name": "in_progress", "step_order": 1, "is_final": false, "workflow_id": "wf-1", "agents": [], "skills": [] },
                            { "id": "s-3", "name": "done", "step_order": 2, "is_final": true, "workflow_id": "wf-1", "agents": [], "skills": [] }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let info = service
            .get_workflow_info("wf-1", Some("s-2"))
            .await
            .unwrap();

        assert_eq!(info.id, "wf-1");
        assert_eq!(info.name, "Dev Flow");
        assert_eq!(info.current_step_name, "in_progress");
        assert_eq!(info.current_step_index, 1);
        assert_eq!(info.total_steps, 3);
        assert_eq!(info.prev_step_name, Some("backlog".to_string()));
        assert_eq!(info.next_step_name, Some("done".to_string()));
    }

    #[tokio::test]
    async fn test_get_workflow_info_no_current_step() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflow": {
                        "id": "wf-1",
                        "name": "Dev Flow",
                        "workflow_steps": [
                            { "id": "s-1", "name": "backlog", "step_order": 0, "is_final": false, "workflow_id": "wf-1", "agents": [], "skills": [] },
                            { "id": "s-2", "name": "done", "step_order": 1, "is_final": true, "workflow_id": "wf-1", "agents": [], "skills": [] }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let info = service.get_workflow_info("wf-1", None).await.unwrap();

        assert_eq!(info.id, "wf-1");
        assert_eq!(info.current_step_name, "backlog");
        assert_eq!(info.current_step_index, 0);
        assert_eq!(info.total_steps, 2);
        assert!(info.prev_step_name.is_none());
        assert_eq!(info.next_step_name, Some("done".to_string()));
    }

    #[tokio::test]
    async fn test_list_workflow_transitions_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "workflows": [
                        {
                            "id": "wf-1",
                            "name": "First",
                            "transitions": [
                                { "id": "t-1", "to_workflow_id": "wf-2", "label": "on_done" }
                            ]
                        },
                        {
                            "id": "wf-2",
                            "name": "Second",
                            "transitions": []
                        }
                    ]
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let transitions = service.list_workflow_transitions(None).await.unwrap();

        assert_eq!(transitions.len(), 1);
        assert_eq!(transitions[0].from_workflow, "wf-1");
        assert_eq!(transitions[0].to_workflow, "wf-2");
        assert_eq!(transitions[0].label, "on_done");
    }
}
