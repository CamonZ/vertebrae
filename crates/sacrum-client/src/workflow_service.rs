//! WorkflowService implementation for Sacrum HTTP API - Stub
//!
//! Implements the WorkflowService trait by making HTTP calls to the Sacrum REST API.
//! Many methods are currently unimplemented as they require additional API endpoints
//! to be defined in the Sacrum backend.

use async_trait::async_trait;
use serde_json::json;
use vertebrae_core::WorkflowSummary;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::{Workflow, WorkflowTransition};
use vertebrae_core::workflow_service::{
    AssignResult, CreateWorkflowOptions, MigrationResult, RejectResult, StepTransitionResult,
    UpdateWorkflowOptions, WorkflowInfo, WorkflowService,
};

use crate::api_types::WorkflowResponse;
use crate::client::SacrumClient;

/// WorkflowService implementation for Sacrum HTTP client
pub struct SacrumWorkflowService {
    client: SacrumClient,
}

impl SacrumWorkflowService {
    /// Create a new SacrumWorkflowService
    pub fn new(client: SacrumClient) -> Self {
        Self { client }
    }

    fn response_to_workflow(&self, response: &WorkflowResponse) -> Workflow {
        Workflow {
            id: Some(response.id.clone()),
            name: response.name.clone(),
            description: response.description.clone(),
            initial_step: None,
            metadata: std::collections::HashMap::new(),
            auto_advance: false,
            order: 0,
            created_at: None,
            updated_at: None,
        }
    }

    fn response_to_summary(&self, response: &WorkflowResponse) -> WorkflowSummary {
        WorkflowSummary {
            id: response.id.clone(),
            name: response.name.clone(),
            description: response.description.clone(),
            step_count: response.steps.len(),
        }
    }
}

#[async_trait]
impl WorkflowService for SacrumWorkflowService {
    fn database(&self) -> &vertebrae_db::Database {
        unimplemented!("SacrumWorkflowService does not provide direct database access")
    }

    async fn create_workflow(&self, options: CreateWorkflowOptions) -> ServiceResult<String> {
        if options.name.trim().is_empty() {
            return Err(ServiceError::validation_failed("Name cannot be empty"));
        }

        let request = json!({
            "name": options.name,
            "description": options.description,
            "project_id": self.client.project_id(),
        });

        let path = format!("/projects/{}/workflows", self.client.project_id());
        let response: WorkflowResponse = self.client.post(&path, &request).await?;

        Ok(response.id)
    }

    async fn get_workflow(&self, id: &str) -> ServiceResult<Workflow> {
        let path = format!("/projects/{}/workflows/{}", self.client.project_id(), id);
        let response: WorkflowResponse = self.client.get(&path).await?;
        Ok(self.response_to_workflow(&response))
    }

    async fn list_workflows(&self) -> ServiceResult<Vec<WorkflowSummary>> {
        let path = format!("/projects/{}/workflows", self.client.project_id());
        let response: serde_json::Value = self.client.get(&path).await?;

        let summaries = response
            .get("workflows")
            .and_then(|v| v.as_array())
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|w| {
                let workflow_response: WorkflowResponse = serde_json::from_value(w.clone()).ok()?;
                Some(self.response_to_summary(&workflow_response))
            })
            .collect();

        Ok(summaries)
    }

    async fn update_workflow(&self, id: &str, options: UpdateWorkflowOptions) -> ServiceResult<()> {
        let mut request = json!({});

        if let Some(name) = &options.name {
            request["name"] = json!(name);
        }

        if let Some(desc) = &options.description {
            request["description"] = json!(desc);
        }

        let path = format!("/projects/{}/workflows/{}", self.client.project_id(), id);
        let _response: WorkflowResponse = self.client.put(&path, &request).await?;

        Ok(())
    }

    async fn delete_workflow(&self, id: &str) -> ServiceResult<()> {
        let path = format!("/projects/{}/workflows/{}", self.client.project_id(), id);
        self.client.delete(&path).await?;
        Ok(())
    }

    async fn workflow_exists(&self, id: &str) -> ServiceResult<bool> {
        match self.get_workflow(id).await {
            Ok(_) => Ok(true),
            Err(ServiceError::WorkflowNotFound { workflow_id: _ }) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn assign_workflow(
        &self,
        task_id: &str,
        workflow_id: &str,
    ) -> ServiceResult<AssignResult> {
        let request = json!({
            "workflow_id": workflow_id
        });
        let path = format!(
            "/projects/{}/tasks/{}/assign-workflow",
            self.client.project_id(),
            task_id
        );
        let _response: serde_json::Value = self.client.post(&path, &request).await?;

        Ok(AssignResult {
            task_id: task_id.to_string(),
            workflow_id: workflow_id.to_string(),
            first_step_name: String::new(),
        })
    }

    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()> {
        let path = format!(
            "/projects/{}/tasks/{}/assign-workflow",
            self.client.project_id(),
            task_id
        );
        self.client.delete(&path).await?;
        Ok(())
    }

    async fn advance_step(&self, task_id: &str) -> ServiceResult<StepTransitionResult> {
        let path = format!(
            "/projects/{}/tasks/{}/advance-step",
            self.client.project_id(),
            task_id
        );
        let _response: serde_json::Value = self.client.post(&path, &json!({})).await?;

        Ok(StepTransitionResult {
            task_id: task_id.to_string(),
            workflow_id: String::new(),
            from_step: 0,
            to_step: 1,
            step_name: String::new(),
            total_steps: 0,
            execution_id: None,
            chained_to_workflow: None,
        })
    }

    async fn retreat_step(&self, task_id: &str) -> ServiceResult<StepTransitionResult> {
        let path = format!(
            "/projects/{}/tasks/{}/retreat-step",
            self.client.project_id(),
            task_id
        );
        let _response: serde_json::Value = self.client.post(&path, &json!({})).await?;

        Ok(StepTransitionResult {
            task_id: task_id.to_string(),
            workflow_id: String::new(),
            from_step: 1,
            to_step: 0,
            step_name: String::new(),
            total_steps: 0,
            execution_id: None,
            chained_to_workflow: None,
        })
    }

    async fn reject_task(&self, task_id: &str) -> ServiceResult<RejectResult> {
        let path = format!(
            "/projects/{}/tasks/{}/reject",
            self.client.project_id(),
            task_id
        );
        let _response: serde_json::Value = self.client.post(&path, &json!({})).await?;

        Ok(RejectResult {
            task_id: task_id.to_string(),
            from_workflow_id: String::new(),
            chained_to_workflow: None,
            first_step_name: None,
            execution_id: None,
        })
    }

    async fn get_workflow_info(
        &self,
        workflow_id: &str,
        _current_step_id: Option<&str>,
    ) -> ServiceResult<WorkflowInfo> {
        let workflow = self.get_workflow(workflow_id).await?;

        Ok(WorkflowInfo {
            id: workflow.id.unwrap_or_default(),
            name: workflow.name,
            current_step_id: None,
            current_step_name: String::new(),
            current_step_index: 0,
            total_steps: 0,
            prev_step_name: None,
            next_step_name: None,
        })
    }

    async fn migrate_to_default_workflow(&self, _dry_run: bool) -> ServiceResult<MigrationResult> {
        Err(ServiceError::InvalidInput(
            "Migration not supported via HTTP client".to_string(),
        ))
    }

    async fn create_workflow_transition(
        &self,
        _from_workflow_id: &str,
        _to_workflow_id: &str,
        _label: &str,
        _target_step_id: Option<&str>,
    ) -> ServiceResult<WorkflowTransition> {
        Err(ServiceError::InvalidInput(
            "Transitions not supported via HTTP client".to_string(),
        ))
    }

    async fn list_workflow_transitions(
        &self,
        _from_workflow_id: Option<&str>,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        Ok(Vec::new())
    }

    async fn get_transitions_from_workflow(
        &self,
        _workflow_id: &str,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        Ok(Vec::new())
    }

    async fn get_transitions_to_workflow(
        &self,
        _workflow_id: &str,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        Ok(Vec::new())
    }

    async fn delete_workflow_transition(
        &self,
        _from_workflow_id: &str,
        _to_workflow_id: &str,
    ) -> ServiceResult<()> {
        Err(ServiceError::InvalidInput(
            "Transitions not supported via HTTP client".to_string(),
        ))
    }

    async fn workflow_transition_exists(
        &self,
        _from_workflow_id: &str,
        _to_workflow_id: &str,
    ) -> ServiceResult<bool> {
        Ok(false)
    }

    async fn create_workflow_raw(&self, _id: &str, workflow: &Workflow) -> ServiceResult<String> {
        let request = json!({
            "name": workflow.name,
            "description": workflow.description
        });
        let path = format!("/projects/{}/workflows", self.client.project_id());
        let response: WorkflowResponse = self.client.post(&path, &request).await?;
        Ok(response.id)
    }

    async fn update_workflow_initial_step(
        &self,
        _id: &str,
        _step_id: &vertebrae_db::Thing,
    ) -> ServiceResult<()> {
        Ok(())
    }

    async fn export_all_workflows(&self) -> ServiceResult<Vec<(String, Workflow)>> {
        let workflows = self.list_workflows().await?;
        let mut results = Vec::new();
        for summary in workflows {
            if let Ok(workflow) = self.get_workflow(&summary.id).await {
                results.push((summary.id.clone(), workflow));
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::StepResponse;

    fn create_test_client() -> SacrumClient {
        crate::client::SacrumClient::new(crate::config::SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-proj".to_string(),
        ))
    }

    #[test]
    fn test_new_creates_service() {
        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        assert!(!service.client.project_id().is_empty());
    }

    #[test]
    fn test_workflow_summary_conversion() {
        let response = WorkflowResponse {
            id: "wf-1".to_string(),
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![],
        };

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
        let response = WorkflowResponse {
            id: "wf-2".to_string(),
            name: "Complex Workflow".to_string(),
            description: Some("A workflow with multiple steps".to_string()),
            steps: vec![],
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let summary = service.response_to_summary(&response);

        assert_eq!(summary.id, "wf-2");
        assert_eq!(summary.name, "Complex Workflow");
        assert_eq!(
            summary.description,
            Some("A workflow with multiple steps".to_string())
        );
        assert_eq!(summary.step_count, 0);
    }

    #[test]
    fn test_workflow_summary_with_steps() {
        let steps = vec![
            StepResponse {
                id: "step-1".to_string(),
                name: "Review".to_string(),
                ordinal: 0,
                requires_human_review: true,
            },
            StepResponse {
                id: "step-2".to_string(),
                name: "Approve".to_string(),
                ordinal: 1,
                requires_human_review: false,
            },
        ];

        let response = WorkflowResponse {
            id: "wf-3".to_string(),
            name: "Multi-Step Workflow".to_string(),
            description: Some("Has steps".to_string()),
            steps,
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let summary = service.response_to_summary(&response);

        assert_eq!(summary.id, "wf-3");
        assert_eq!(summary.name, "Multi-Step Workflow");
        assert_eq!(summary.step_count, 2);
    }

    #[test]
    fn test_response_to_workflow_conversion() {
        let response = WorkflowResponse {
            id: "wf-4".to_string(),
            name: "Domain Workflow".to_string(),
            description: Some("For domain objects".to_string()),
            steps: vec![],
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(workflow.id, Some("wf-4".to_string()));
        assert_eq!(workflow.name, "Domain Workflow");
        assert_eq!(workflow.description, Some("For domain objects".to_string()));
        assert_eq!(workflow.auto_advance, false);
        assert_eq!(workflow.order, 0);
        assert!(workflow.metadata.is_empty());
    }

    #[test]
    fn test_response_to_workflow_minimal() {
        let response = WorkflowResponse {
            id: "wf-5".to_string(),
            name: "Minimal".to_string(),
            description: None,
            steps: vec![],
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(workflow.id, Some("wf-5".to_string()));
        assert_eq!(workflow.name, "Minimal");
        assert_eq!(workflow.description, None);
        assert!(workflow.initial_step.is_none());
    }

    #[test]
    fn test_multiple_service_instances() {
        let client1 = create_test_client();
        let client2 = create_test_client();

        let _service1 = SacrumWorkflowService::new(client1);
        let _service2 = SacrumWorkflowService::new(client2);
    }

    #[test]
    fn test_response_to_workflow_with_all_fields() {
        let response = WorkflowResponse {
            id: "full-wf".to_string(),
            name: "Full Workflow".to_string(),
            description: Some("Complete workflow with all details".to_string()),
            steps: vec![],
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(workflow.id, Some("full-wf".to_string()));
        assert_eq!(workflow.name, "Full Workflow");
        assert_eq!(
            workflow.description,
            Some("Complete workflow with all details".to_string())
        );
        assert_eq!(workflow.auto_advance, false);
        assert_eq!(workflow.order, 0);
        assert!(workflow.initial_step.is_none());
        assert!(workflow.metadata.is_empty());
        assert!(workflow.created_at.is_none());
        assert!(workflow.updated_at.is_none());
    }

    #[test]
    fn test_summary_and_workflow_consistency() {
        let response = WorkflowResponse {
            id: "consistency-test".to_string(),
            name: "Consistent Workflow".to_string(),
            description: Some("Test consistency".to_string()),
            steps: vec![
                StepResponse {
                    id: "s1".to_string(),
                    name: "Step 1".to_string(),
                    ordinal: 0,
                    requires_human_review: false,
                },
                StepResponse {
                    id: "s2".to_string(),
                    name: "Step 2".to_string(),
                    ordinal: 1,
                    requires_human_review: true,
                },
                StepResponse {
                    id: "s3".to_string(),
                    name: "Step 3".to_string(),
                    ordinal: 2,
                    requires_human_review: false,
                },
            ],
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);

        let summary = service.response_to_summary(&response);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(summary.id, workflow.id.as_ref().unwrap().as_str());
        assert_eq!(summary.name, workflow.name);
        assert_eq!(summary.description, workflow.description);
        assert_eq!(summary.step_count, 3);
    }

    #[test]
    fn test_empty_and_full_workflows() {
        let empty_response = WorkflowResponse {
            id: "empty".to_string(),
            name: "Empty".to_string(),
            description: None,
            steps: vec![],
        };

        let full_response = WorkflowResponse {
            id: "full".to_string(),
            name: "Full".to_string(),
            description: Some("Full workflow".to_string()),
            steps: vec![
                StepResponse {
                    id: "s1".to_string(),
                    name: "Step 1".to_string(),
                    ordinal: 0,
                    requires_human_review: true,
                },
                StepResponse {
                    id: "s2".to_string(),
                    name: "Step 2".to_string(),
                    ordinal: 1,
                    requires_human_review: false,
                },
            ],
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);

        let empty_summary = service.response_to_summary(&empty_response);
        let full_summary = service.response_to_summary(&full_response);

        assert_eq!(empty_summary.step_count, 0);
        assert_eq!(full_summary.step_count, 2);

        let empty_workflow = service.response_to_workflow(&empty_response);
        let full_workflow = service.response_to_workflow(&full_response);

        assert_eq!(empty_workflow.name, "Empty");
        assert_eq!(full_workflow.name, "Full");
    }

    #[test]
    fn test_special_characters_in_names() {
        let response = WorkflowResponse {
            id: "special-wf".to_string(),
            name: "Workflow with \"quotes\" and 'apostrophes' & symbols".to_string(),
            description: Some("Description with émojis: 🚀 and ünicode: café".to_string()),
            steps: vec![],
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);

        let summary = service.response_to_summary(&response);
        let workflow = service.response_to_workflow(&response);

        assert_eq!(
            summary.name,
            "Workflow with \"quotes\" and 'apostrophes' & symbols"
        );
        assert_eq!(
            workflow.description,
            Some("Description with émojis: 🚀 and ünicode: café".to_string())
        );
    }

    #[test]
    fn test_workflow_summary_step_counting() {
        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);

        for count in &[0, 1, 3, 5, 10, 100] {
            let mut steps = vec![];
            for i in 0..*count {
                steps.push(StepResponse {
                    id: format!("step-{}", i),
                    name: format!("Step {}", i),
                    ordinal: i as i32,
                    requires_human_review: i % 2 == 0,
                });
            }

            let response = WorkflowResponse {
                id: format!("wf-{}", count),
                name: format!("Workflow with {} steps", count),
                description: None,
                steps,
            };

            let summary = service.response_to_summary(&response);
            assert_eq!(summary.step_count, *count);
        }
    }

    #[test]
    fn test_workflow_field_preservation() {
        let response = WorkflowResponse {
            id: "preserve-test".to_string(),
            name: "Field Preservation".to_string(),
            description: Some("Preserving all fields".to_string()),
            steps: vec![],
        };

        let client = create_test_client();
        let service = SacrumWorkflowService::new(client);

        let workflow = service.response_to_workflow(&response);
        let summary = service.response_to_summary(&response);

        assert_eq!(workflow.id.unwrap(), summary.id);
        assert_eq!(workflow.name, summary.name);
        assert_eq!(workflow.description, summary.description);
        assert_eq!(workflow.auto_advance, false);
        assert_eq!(workflow.order, 0);
        assert!(workflow.metadata.is_empty());
    }
}
