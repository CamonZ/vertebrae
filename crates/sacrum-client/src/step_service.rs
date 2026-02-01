//! StepService implementation for Sacrum HTTP API
//!
//! Implements the StepService trait by making HTTP calls to the Sacrum REST API.
//! Full CRUD operations are available for workflow steps.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::json;
use vertebrae_core::error::ServiceResult;
use vertebrae_core::models::{AgentConfig, Step, StepUpdate};
use vertebrae_core::step_service::StepService;

use crate::api_types::WorkflowStepResponse;
use crate::client::SacrumClient;

/// Query param helper for workflow_id
#[derive(Serialize)]
struct WorkflowQuery<'a> {
    workflow_id: &'a str,
}

/// StepService implementation for Sacrum HTTP client
pub struct SacrumStepService {
    client: SacrumClient,
}

impl SacrumStepService {
    /// Create a new SacrumStepService with a client
    pub fn new(client: SacrumClient) -> Self {
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
            agents: response.agents.clone(),
            skills: response.skills.clone(),
            agent_config,
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
        let request = json!({
            "name": step.name,
            "workflow_id": step.workflow_id,
            "goal": step.goal,
            "agents": step.agents,
            "skills": step.skills,
            "is_final": step.is_final,
            "step_order": step.order,
        });

        let response: WorkflowStepResponse =
            self.client.post("/api/workflow-steps", &request).await?;
        Ok(Self::response_to_step(&response))
    }

    async fn create_step_with_id(&self, id: &str, step: &Step) -> ServiceResult<Step> {
        let request = json!({
            "id": id,
            "name": step.name,
            "workflow_id": step.workflow_id,
            "goal": step.goal,
            "agents": step.agents,
            "skills": step.skills,
            "is_final": step.is_final,
            "step_order": step.order,
        });

        let response: WorkflowStepResponse =
            self.client.post("/api/workflow-steps", &request).await?;
        Ok(Self::response_to_step(&response))
    }

    async fn get_step(&self, id: &str) -> ServiceResult<Option<Step>> {
        let path = format!("/api/workflow-steps/{}", id);
        match self.client.get::<WorkflowStepResponse, _>(&path, &()).await {
            Ok(response) => Ok(Some(Self::response_to_step(&response))),
            Err(crate::error::SacrumClientError::ApiError { status: 404, .. }) => Ok(None),
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
        let query = WorkflowQuery { workflow_id };
        let responses: Vec<WorkflowStepResponse> =
            self.client.get("/api/workflow-steps", &query).await?;
        Ok(responses.iter().map(Self::response_to_step).collect())
    }

    async fn update_step(&self, id: &str, updates: &StepUpdate) -> ServiceResult<()> {
        let mut request = json!({});

        if let Some(name) = &updates.name {
            request["name"] = json!(name);
        }
        if let Some(goal) = &updates.goal {
            request["goal"] = json!(goal);
        }
        if let Some(agents) = &updates.agents {
            request["agents"] = json!(agents);
        }
        if let Some(skills) = &updates.skills {
            request["skills"] = json!(skills);
        }
        if let Some(agent_config) = &updates.agent_config {
            request["agent_config"] = agent_config.clone();
        }
        if let Some(is_final) = updates.is_final {
            request["is_final"] = json!(is_final);
        }
        if let Some(transitions_to) = &updates.transitions_to {
            request["transitions_to"] = json!(transitions_to);
        }
        if let Some(order) = updates.order {
            request["step_order"] = json!(order);
        }

        let path = format!("/api/workflow-steps/{}", id);
        let _response: WorkflowStepResponse = self.client.put(&path, &request).await?;
        Ok(())
    }

    async fn delete_step(&self, id: &str) -> ServiceResult<()> {
        let path = format!("/api/workflow-steps/{}", id);
        self.client.delete(&path).await?;
        Ok(())
    }

    async fn get_initial_step(&self, workflow_id: &str) -> ServiceResult<Option<Step>> {
        let steps = self.list_steps_for_workflow(workflow_id).await?;
        // The initial step is the one with the lowest order
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
        let responses: Vec<WorkflowStepResponse> =
            self.client.get("/api/workflow-steps", &()).await?;
        Ok(responses.iter().map(Self::response_to_step).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::{StepTransitionResponse, WorkflowStepResponse};

    fn create_test_client() -> SacrumClient {
        crate::client::SacrumClient::new(crate::config::SacrumConfig::new(
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
}
