//! ExecutionService implementation for Sacrum HTTP API
//!
//! Implements the ExecutionService trait by making HTTP calls to the Sacrum REST API.
//! The Sacrum API only exposes read-only endpoints (index/show) for executions.
//! Create/update/add_log remain unimplemented as there are no API endpoints for them.

use async_trait::async_trait;
use vertebrae_core::error::ServiceResult;
use vertebrae_core::execution_service::ExecutionService;
use vertebrae_core::models::{ExecutionStatus, SessionLog, StepExecution};

use crate::api_types::{SessionLogResponse, StepExecutionResponse};
use crate::client::SacrumClient;

/// ExecutionService implementation for Sacrum HTTP client
pub struct SacrumExecutionService {
    client: SacrumClient,
}

impl SacrumExecutionService {
    /// Create a new SacrumExecutionService with a client
    pub fn new(client: SacrumClient) -> Self {
        Self { client }
    }

    fn response_to_execution(response: &StepExecutionResponse) -> StepExecution {
        let status =
            ExecutionStatus::parse(&response.status).unwrap_or(ExecutionStatus::InProgress);

        let started_at = response
            .inserted_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(chrono::Utc::now);

        let completed_at = if status.is_terminal() {
            response
                .updated_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc))
        } else {
            None
        };

        StepExecution {
            id: Some(response.id.clone()),
            task_id: response.task_id.clone(),
            workflow_id: response.workflow_id.clone(),
            step_name: response.step_name.clone(),
            started_at,
            completed_at,
            status,
            context: response.context.clone(),
            prompt: response.prompt.clone(),
            output: response.output.clone(),
            transition_result: response.transition_result.clone(),
            model_used: response.model.clone(),
            session_id: None,
            token_usage: None,
            cost_usd: response.cost,
            duration_ms: response.duration_ms.map(|v| v as u64),
        }
    }

    fn response_to_log(response: &SessionLogResponse) -> SessionLog {
        let created_at = response
            .inserted_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(chrono::Utc::now);

        SessionLog {
            id: Some(response.id.clone()),
            step_execution_id: response.step_execution_id.clone(),
            content: response.content.clone(),
            created_at,
        }
    }
}

#[async_trait]
impl ExecutionService for SacrumExecutionService {
    async fn create_execution(&self, _execution: StepExecution) -> ServiceResult<String> {
        unimplemented!("Execution creation not available via Sacrum API")
    }

    async fn get_execution(&self, id: &str) -> ServiceResult<Option<StepExecution>> {
        let path = format!("/api/executions/{}", id);
        let response: StepExecutionResponse = self.client.get(&path, &()).await?;
        Ok(Some(Self::response_to_execution(&response)))
    }

    async fn list_executions_for_task(&self, task_id: &str) -> ServiceResult<Vec<StepExecution>> {
        let path = format!("/api/tasks/{}/executions", task_id);
        let responses: Vec<StepExecutionResponse> = self.client.get(&path, &()).await?;
        Ok(responses.iter().map(Self::response_to_execution).collect())
    }

    async fn add_log(&self, _log: SessionLog) -> ServiceResult<String> {
        unimplemented!("Log creation not available via Sacrum API")
    }

    async fn list_logs_for_execution(&self, execution_id: &str) -> ServiceResult<Vec<SessionLog>> {
        let path = format!("/api/executions/{}/logs", execution_id);
        let responses: Vec<SessionLogResponse> = self.client.get(&path, &()).await?;
        Ok(responses.iter().map(Self::response_to_log).collect())
    }

    async fn get_latest_execution_for_task(
        &self,
        task_id: &str,
    ) -> ServiceResult<Option<StepExecution>> {
        let executions = self.list_executions_for_task(task_id).await?;
        Ok(executions.into_iter().last())
    }

    async fn update_execution(
        &self,
        _execution_id: &str,
        _output: Option<String>,
        _transition_result: Option<String>,
    ) -> ServiceResult<()> {
        unimplemented!("Execution update not available via Sacrum API")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::StepExecutionResponse;

    fn create_test_client() -> SacrumClient {
        crate::client::SacrumClient::new(crate::config::SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "test-project".to_string(),
        ))
    }

    #[test]
    fn test_service_new_creates_service() {
        let client = create_test_client();
        let _service = SacrumExecutionService::new(client);
    }

    #[test]
    fn test_response_to_execution_conversion() {
        let response = StepExecutionResponse {
            id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            workflow_id: "wf-1".to_string(),
            step_name: "review".to_string(),
            status: "completed".to_string(),
            context: Some("ctx".to_string()),
            prompt: Some("prompt".to_string()),
            output: Some("output".to_string()),
            transition_result: Some("next".to_string()),
            model: Some("claude-opus".to_string()),
            model_provider: None,
            input_tokens: Some(1000),
            output_tokens: Some(500),
            cost: Some(0.05),
            duration_ms: Some(1500),
            inserted_at: Some("2024-01-01T00:00:00Z".to_string()),
            updated_at: Some("2024-01-01T00:01:00Z".to_string()),
        };

        let execution = SacrumExecutionService::response_to_execution(&response);

        assert_eq!(execution.id, Some("exec-1".to_string()));
        assert_eq!(execution.task_id, "task-1");
        assert_eq!(execution.workflow_id, "wf-1");
        assert_eq!(execution.step_name, "review");
        assert_eq!(execution.status, ExecutionStatus::Completed);
        assert_eq!(execution.context.as_deref(), Some("ctx"));
        assert_eq!(execution.output.as_deref(), Some("output"));
        assert_eq!(execution.model_used.as_deref(), Some("claude-opus"));
        assert_eq!(execution.cost_usd, Some(0.05));
        assert_eq!(execution.duration_ms, Some(1500));
        assert!(execution.completed_at.is_some());
    }

    #[test]
    fn test_response_to_execution_in_progress() {
        let response = StepExecutionResponse {
            id: "exec-2".to_string(),
            task_id: "task-1".to_string(),
            workflow_id: "wf-1".to_string(),
            step_name: "review".to_string(),
            status: "in_progress".to_string(),
            context: None,
            prompt: None,
            output: None,
            transition_result: None,
            model: None,
            model_provider: None,
            input_tokens: None,
            output_tokens: None,
            cost: None,
            duration_ms: None,
            inserted_at: None,
            updated_at: None,
        };

        let execution = SacrumExecutionService::response_to_execution(&response);

        assert_eq!(execution.status, ExecutionStatus::InProgress);
        assert!(execution.completed_at.is_none());
    }

    #[test]
    fn test_response_to_log_conversion() {
        let response = SessionLogResponse {
            id: "log-1".to_string(),
            step_execution_id: "exec-1".to_string(),
            content: "Log content".to_string(),
            inserted_at: Some("2024-01-01T00:00:00Z".to_string()),
            updated_at: None,
        };

        let log = SacrumExecutionService::response_to_log(&response);

        assert_eq!(log.id, Some("log-1".to_string()));
        assert_eq!(log.step_execution_id, "exec-1");
        assert_eq!(log.content, "Log content");
    }

    #[test]
    fn test_multiple_service_instances() {
        let client1 = create_test_client();
        let client2 = create_test_client();

        let _s1 = SacrumExecutionService::new(client1);
        let _s2 = SacrumExecutionService::new(client2);
    }
}
