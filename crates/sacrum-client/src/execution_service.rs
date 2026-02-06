//! ExecutionService implementation for Sacrum HTTP API
//!
//! Implements the ExecutionService trait by making HTTP calls to the Sacrum REST API.
//! Supports full CRUD: create, read, update executions, and create/list session logs.

use async_trait::async_trait;
use vertebrae_core::error::ServiceResult;
use vertebrae_core::execution_service::ExecutionService;
use vertebrae_core::models::{ExecutionStatus, SessionLog, StepExecution};

use crate::api_types::{
    CreateExecutionRequest, CreateLogRequest, SessionLogResponse, StepExecutionResponse,
    UpdateExecutionRequest,
};
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
    async fn create_execution(&self, execution: StepExecution) -> ServiceResult<String> {
        let path = format!("/api/tasks/{}/executions", execution.task_id);

        let (input_tokens, output_tokens) = execution
            .token_usage
            .as_ref()
            .map(|u| (Some(u.input_tokens as i64), Some(u.output_tokens as i64)))
            .unwrap_or((None, None));

        let request = CreateExecutionRequest {
            step_name: execution.step_name,
            status: Some(execution.status.as_str().to_string()),
            context: execution.context,
            prompt: execution.prompt,
            output: execution.output,
            transition_result: execution.transition_result,
            model: execution.model_used,
            model_provider: None,
            input_tokens,
            output_tokens,
            cost: execution.cost_usd,
            duration_ms: execution.duration_ms.map(|v| v as i64),
            workflow_id: Some(execution.workflow_id),
        };

        let response: StepExecutionResponse = self.client.post(&path, &request).await?;
        Ok(response.id)
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

    async fn add_log(&self, log: SessionLog) -> ServiceResult<String> {
        let path = format!("/api/executions/{}/logs", log.step_execution_id);
        let request = CreateLogRequest {
            content: log.content,
        };
        let response: SessionLogResponse = self.client.post(&path, &request).await?;
        Ok(response.id)
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
        execution_id: &str,
        output: Option<String>,
        transition_result: Option<String>,
    ) -> ServiceResult<()> {
        let path = format!("/api/executions/{}", execution_id);
        let request = UpdateExecutionRequest {
            status: None,
            output,
            transition_result,
        };
        self.client.patch(&path, &request).await?;
        Ok(())
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

    #[test]
    fn test_create_execution_request_serialization() {
        use crate::api_types::CreateExecutionRequest;

        let request = CreateExecutionRequest {
            step_name: "review".to_string(),
            status: Some("in_progress".to_string()),
            context: None,
            prompt: Some("Review the code".to_string()),
            output: None,
            transition_result: None,
            model: Some("claude-opus".to_string()),
            model_provider: None,
            input_tokens: Some(1000),
            output_tokens: Some(500),
            cost: Some(0.05),
            duration_ms: Some(1500),
            workflow_id: Some("wf-1".to_string()),
        };

        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["step_name"], "review");
        assert_eq!(json["status"], "in_progress");
        assert_eq!(json["model"], "claude-opus");
        assert_eq!(json["input_tokens"], 1000);
        assert_eq!(json["workflow_id"], "wf-1");
        // None fields should be omitted
        assert!(json.get("context").is_none());
        assert!(json.get("output").is_none());
        assert!(json.get("transition_result").is_none());
        assert!(json.get("model_provider").is_none());
    }

    #[test]
    fn test_create_execution_request_minimal() {
        use crate::api_types::CreateExecutionRequest;

        let request = CreateExecutionRequest {
            step_name: "backlog".to_string(),
            status: None,
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
            workflow_id: None,
        };

        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["step_name"], "backlog");
        // Only step_name should be present
        assert_eq!(json.as_object().unwrap().len(), 1);
    }

    #[test]
    fn test_update_execution_request_serialization() {
        use crate::api_types::UpdateExecutionRequest;

        let request = UpdateExecutionRequest {
            status: None,
            output: Some("Execution complete".to_string()),
            transition_result: Some("advance".to_string()),
        };

        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["output"], "Execution complete");
        assert_eq!(json["transition_result"], "advance");
        assert!(json.get("status").is_none());
    }

    #[test]
    fn test_create_log_request_serialization() {
        use crate::api_types::CreateLogRequest;

        let request = CreateLogRequest {
            content: "Step completed successfully".to_string(),
        };

        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["content"], "Step completed successfully");
    }

    #[test]
    fn test_execution_to_request_maps_token_usage() {
        use crate::api_types::CreateExecutionRequest;
        use vertebrae_core::models::TokenUsage;

        let execution = StepExecution::new("task-1", "wf-1", "review")
            .with_token_usage(TokenUsage::new(1000, 500))
            .with_model_used("claude-opus")
            .with_cost_usd(0.05)
            .with_duration_ms(1500);

        let (input_tokens, output_tokens) = execution
            .token_usage
            .as_ref()
            .map(|u| (Some(u.input_tokens as i64), Some(u.output_tokens as i64)))
            .unwrap_or((None, None));

        let request = CreateExecutionRequest {
            step_name: execution.step_name.clone(),
            status: Some(execution.status.as_str().to_string()),
            context: execution.context.clone(),
            prompt: execution.prompt.clone(),
            output: execution.output.clone(),
            transition_result: execution.transition_result.clone(),
            model: execution.model_used.clone(),
            model_provider: None,
            input_tokens,
            output_tokens,
            cost: execution.cost_usd,
            duration_ms: execution.duration_ms.map(|v| v as i64),
            workflow_id: Some(execution.workflow_id.clone()),
        };

        assert_eq!(request.step_name, "review");
        assert_eq!(request.input_tokens, Some(1000));
        assert_eq!(request.output_tokens, Some(500));
        assert_eq!(request.model, Some("claude-opus".to_string()));
        assert_eq!(request.cost, Some(0.05));
        assert_eq!(request.duration_ms, Some(1500));
    }

    #[test]
    fn test_execution_to_request_without_token_usage() {
        let execution = StepExecution::new("task-1", "wf-1", "review");

        let (input_tokens, output_tokens) = execution
            .token_usage
            .as_ref()
            .map(|u| (Some(u.input_tokens as i64), Some(u.output_tokens as i64)))
            .unwrap_or((None, None));

        assert!(input_tokens.is_none());
        assert!(output_tokens.is_none());
    }

    // =========================================================================
    // Wiremock integration tests for execution service HTTP methods
    // =========================================================================

    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn create_wiremock_service(server_url: &str) -> SacrumExecutionService {
        let client = SacrumClient::new(crate::config::SacrumConfig::new(
            server_url.to_string(),
            "test-token".to_string(),
            "test-proj".to_string(),
        ));
        SacrumExecutionService::new(client)
    }

    #[tokio::test]
    async fn test_create_execution_returns_id() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/tasks/task-1/executions"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "data": {
                    "id": "exec-new",
                    "task_id": "task-1",
                    "workflow_id": "wf-1",
                    "step_name": "review",
                    "status": "in_progress",
                    "inserted_at": "2024-01-01T00:00:00Z",
                    "updated_at": "2024-01-01T00:00:00Z"
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let execution = StepExecution::new("task-1", "wf-1", "review");
        let result = service.create_execution(execution).await.unwrap();

        assert_eq!(result, "exec-new");
    }

    #[tokio::test]
    async fn test_create_execution_with_all_fields() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/tasks/task-2/executions"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "data": {
                    "id": "exec-full",
                    "task_id": "task-2",
                    "workflow_id": "wf-1",
                    "step_name": "implement",
                    "status": "in_progress",
                    "context": "some context",
                    "prompt": "do the work",
                    "output": null,
                    "model": "claude-opus",
                    "input_tokens": 1000,
                    "output_tokens": 500,
                    "cost": 0.05,
                    "duration_ms": 1500,
                    "inserted_at": "2024-01-01T00:00:00Z",
                    "updated_at": "2024-01-01T00:00:00Z"
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let execution = StepExecution::new("task-2", "wf-1", "implement")
            .with_context("some context")
            .with_prompt("do the work")
            .with_model_used("claude-opus")
            .with_token_usage(vertebrae_core::models::TokenUsage::new(1000, 500))
            .with_cost_usd(0.05)
            .with_duration_ms(1500);

        let result = service.create_execution(execution).await.unwrap();
        assert_eq!(result, "exec-full");
    }

    #[tokio::test]
    async fn test_create_execution_api_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/tasks/bad-task/executions"))
            .respond_with(ResponseTemplate::new(422).set_body_json(json!({
                "errors": {"step_name": ["can't be blank"]}
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let execution = StepExecution::new("bad-task", "wf-1", "");
        let result = service.create_execution(execution).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_update_execution_success() {
        let server = MockServer::start().await;

        Mock::given(method("PATCH"))
            .and(path("/api/executions/exec-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "id": "exec-1",
                    "task_id": "task-1",
                    "workflow_id": "wf-1",
                    "step_name": "review",
                    "status": "in_progress",
                    "output": "updated output",
                    "transition_result": "advance"
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .update_execution(
                "exec-1",
                Some("updated output".to_string()),
                Some("advance".to_string()),
            )
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_update_execution_partial() {
        let server = MockServer::start().await;

        Mock::given(method("PATCH"))
            .and(path("/api/executions/exec-2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "id": "exec-2",
                    "task_id": "task-1",
                    "workflow_id": "wf-1",
                    "step_name": "review",
                    "status": "in_progress",
                    "output": "just output"
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .update_execution("exec-2", Some("just output".to_string()), None)
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_update_execution_api_error() {
        let server = MockServer::start().await;

        Mock::given(method("PATCH"))
            .and(path("/api/executions/nonexistent"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errors": {"detail": "Not Found"}
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.update_execution("nonexistent", None, None).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_add_log_returns_id() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/executions/exec-1/logs"))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({
                "data": {
                    "id": "log-new",
                    "step_execution_id": "exec-1",
                    "content": "Step completed successfully",
                    "inserted_at": "2024-01-01T00:00:00Z"
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let log = SessionLog::new("exec-1", "Step completed successfully");
        let result = service.add_log(log).await.unwrap();

        assert_eq!(result, "log-new");
    }

    #[tokio::test]
    async fn test_add_log_api_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/api/executions/bad-exec/logs"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errors": {"detail": "Not Found"}
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let log = SessionLog::new("bad-exec", "This should fail");
        let result = service.add_log(log).await;

        assert!(result.is_err());
    }
}
