//! ExecutionService implementation for Sacrum GraphQL API
//!
//! Implements the ExecutionService trait by making GraphQL calls to the Sacrum API.
//! Supports full CRUD: create, read, update executions, and create/list session logs.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use vertebrae_core::error::ServiceResult;
use vertebrae_core::execution_service::{ExecutionService, StopRunTarget};
use vertebrae_core::models::{
    ExecutionStatus, SessionLog, StepExecution, TaskRun, TaskRunStatus, TaskRunTrace,
};

use crate::api_types::{
    SessionLogResponse, StepExecutionResponse, TaskRunResponse, TaskRunTraceResponse,
};
use crate::client::{GraphqlClient, with_fragments};
use crate::queries::executions::{
    ACTIVE_RUN, CREATE_EXECUTION, CREATE_LOG, EXECUTION_FIELDS, GET_EXECUTION, LIST_EXECUTIONS,
    LIST_LOGS, ORCHESTRATE_TASK, RUN_STEP, RUN_WORKFLOW, SESSION_LOG_FIELDS, STOP_ORCHESTRATOR,
    STOP_RUN, TASK_RUN, TASK_RUN_FIELDS, TASK_RUN_TRACE, TASK_RUN_TRACE_FIELDS, TASK_RUNS,
    UPDATE_EXECUTION,
};

/// Response shape for mutations that return only an id
#[derive(Debug, Deserialize)]
struct IdOnly {
    id: String,
}

fn json_value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn parse_datetime(value: Option<&str>) -> Option<chrono::DateTime<chrono::Utc>> {
    value
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

/// ExecutionService implementation for Sacrum GraphQL client
pub struct SacrumExecutionService {
    client: GraphqlClient,
}

impl SacrumExecutionService {
    /// Create a new SacrumExecutionService with a GraphQL client
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }

    fn response_to_execution(response: &StepExecutionResponse) -> StepExecution {
        let status =
            ExecutionStatus::parse(&response.status).unwrap_or(ExecutionStatus::InProgress);

        let started_at =
            parse_datetime(response.inserted_at.as_deref()).unwrap_or_else(chrono::Utc::now);

        let completed_at = if status.is_terminal() {
            parse_datetime(response.updated_at.as_deref())
        } else {
            None
        };

        StepExecution {
            id: Some(response.id.clone()),
            task_id: response.task_id.clone(),
            task_run_id: response.task_run_id.clone(),
            workflow_id: response.workflow_id.clone(),
            step_name: response.step_name.clone(),
            started_at,
            completed_at,
            status,
            context: response.context.as_ref().map(json_value_to_string),
            prompt: response.prompt.clone(),
            output: response.output.clone(),
            transition_result: response.transition_result.clone(),
            model_used: response.model.clone(),
            session_id: None,
            token_usage: (response.input_tokens.is_some() || response.output_tokens.is_some())
                .then(|| {
                    vertebrae_core::TokenUsage::new(
                        response.input_tokens.unwrap_or(0).max(0) as u64,
                        response.output_tokens.unwrap_or(0).max(0) as u64,
                    )
                }),
            cost_usd: response.cost,
            duration_ms: response.duration_ms.map(|v| v as u64),
            model_provider: response.model_provider.clone(),
            handoff: response.handoff.as_ref().map(json_value_to_string),
        }
    }

    pub(crate) fn response_to_task_run(response: &TaskRunResponse) -> TaskRun {
        TaskRun {
            id: response.id.clone(),
            task_id: response.task_id.clone(),
            project_id: response.project_id.clone().unwrap_or_default(),
            user_id: response.user_id.clone(),
            status: TaskRunStatus::parse(&response.status).unwrap_or(TaskRunStatus::Queued),
            started_at: parse_datetime(response.started_at.as_deref()),
            ended_at: parse_datetime(response.ended_at.as_deref()),
            stop_requested_at: parse_datetime(response.stop_requested_at.as_deref()),
            latest_step_execution_id: response.latest_step_execution_id.clone(),
            outcome_kind: response.outcome_kind.clone(),
            outcome_context: response.outcome_context.clone(),
            parent_task_run_id: response.parent_task_run_id.clone(),
            root_task_run_id: response.root_task_run_id.clone(),
            triggered_by_step_execution_id: response.triggered_by_step_execution_id.clone(),
            inserted_at: parse_datetime(response.inserted_at.as_deref()),
            updated_at: parse_datetime(response.updated_at.as_deref()),
        }
    }

    fn response_to_log(response: &SessionLogResponse) -> SessionLog {
        let created_at =
            parse_datetime(response.inserted_at.as_deref()).unwrap_or_else(chrono::Utc::now);

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
        let variables = json!({
            "task_id": execution.task_id,
            "workflow_id": execution.workflow_id,
            "step_name": execution.step_name,
            "status": execution.status.as_str(),
            "context": execution.context,
            "prompt": execution.prompt,
            "model": execution.model_used,
            "model_provider": serde_json::Value::Null,
        });

        let result: IdOnly = self
            .client
            .execute(CREATE_EXECUTION, variables, "create_step_execution")
            .await?;

        Ok(result.id)
    }

    async fn get_execution(&self, id: &str) -> ServiceResult<Option<StepExecution>> {
        let query = with_fragments(GET_EXECUTION, &[EXECUTION_FIELDS]);
        let variables = json!({ "id": id });

        let response: StepExecutionResponse = self
            .client
            .execute(&query, variables, "step_execution")
            .await?;

        Ok(Some(Self::response_to_execution(&response)))
    }

    async fn list_executions_for_task(&self, task_id: &str) -> ServiceResult<Vec<StepExecution>> {
        let query = with_fragments(LIST_EXECUTIONS, &[EXECUTION_FIELDS]);
        let variables = json!({ "task_id": task_id });

        let responses: Vec<StepExecutionResponse> = self
            .client
            .execute(&query, variables, "step_executions")
            .await?;

        Ok(responses.iter().map(Self::response_to_execution).collect())
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
        let variables = json!({
            "id": execution_id,
            "output": output,
            "transition_result": transition_result,
        });

        self.client
            .execute_void(UPDATE_EXECUTION, variables)
            .await?;

        Ok(())
    }

    async fn update_execution_status(
        &self,
        execution_id: &str,
        params: vertebrae_core::execution_service::UpdateExecutionStatusParams,
    ) -> ServiceResult<()> {
        let mut variables = json!({
            "id": execution_id,
            "status": params.status.as_str(),
        });
        if let Some(output) = &params.output {
            variables["output"] = json!(output);
        }
        if let Some(input_tokens) = params.input_tokens {
            variables["input_tokens"] = json!(input_tokens);
        }
        if let Some(output_tokens) = params.output_tokens {
            variables["output_tokens"] = json!(output_tokens);
        }
        if let Some(cost) = params.cost {
            variables["cost"] = json!(cost);
        }
        if let Some(duration_ms) = params.duration_ms {
            variables["duration_ms"] = json!(duration_ms);
        }

        self.client
            .execute_void(UPDATE_EXECUTION, variables)
            .await?;

        Ok(())
    }

    async fn add_log(&self, log: SessionLog) -> ServiceResult<String> {
        let variables = json!({
            "step_execution_id": log.step_execution_id,
            "content": log.content,
        });

        let result: IdOnly = self
            .client
            .execute(CREATE_LOG, variables, "create_session_log")
            .await?;

        Ok(result.id)
    }

    async fn list_logs_for_execution(&self, execution_id: &str) -> ServiceResult<Vec<SessionLog>> {
        let variables = json!({ "step_execution_id": execution_id });

        let responses: Vec<SessionLogResponse> = self
            .client
            .execute(LIST_LOGS, variables, "session_logs")
            .await?;

        Ok(responses.iter().map(Self::response_to_log).collect())
    }

    async fn run_step(&self, task_id: &str, step_id: &str) -> ServiceResult<StepExecution> {
        let query = with_fragments(RUN_STEP, &[EXECUTION_FIELDS]);
        let variables = json!({
            "task_id": task_id,
            "step_id": step_id,
        });

        let response: StepExecutionResponse =
            self.client.execute(&query, variables, "run_step").await?;

        Ok(Self::response_to_execution(&response))
    }

    async fn orchestrate_task(&self, task_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
        });

        let _: IdOnly = self
            .client
            .execute(ORCHESTRATE_TASK, variables, "orchestrate_task")
            .await?;

        Ok(())
    }

    async fn stop_orchestrator(&self, task_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
        });

        let _: IdOnly = self
            .client
            .execute(STOP_ORCHESTRATOR, variables, "stop_orchestrator")
            .await?;

        Ok(())
    }

    async fn active_run(&self, task_id: &str) -> ServiceResult<Option<TaskRun>> {
        let query = with_fragments(ACTIVE_RUN, &[TASK_RUN_FIELDS]);
        let variables = json!({ "task_id": task_id });

        let response: Option<TaskRunResponse> =
            self.client.execute(&query, variables, "active_run").await?;

        Ok(response.as_ref().map(Self::response_to_task_run))
    }

    async fn task_runs(&self, task_id: &str) -> ServiceResult<Vec<TaskRun>> {
        let query = with_fragments(TASK_RUNS, &[TASK_RUN_FIELDS]);
        let variables = json!({ "task_id": task_id });

        let responses: Vec<TaskRunResponse> =
            self.client.execute(&query, variables, "task_runs").await?;

        Ok(responses.iter().map(Self::response_to_task_run).collect())
    }

    async fn task_run(&self, task_run_id: &str) -> ServiceResult<Option<TaskRun>> {
        let query = with_fragments(TASK_RUN, &[TASK_RUN_FIELDS]);
        let variables = json!({ "id": task_run_id });

        let response: Option<TaskRunResponse> =
            self.client.execute(&query, variables, "task_run").await?;

        Ok(response.as_ref().map(Self::response_to_task_run))
    }

    async fn task_run_trace(&self, root_task_run_id: &str) -> ServiceResult<TaskRunTrace> {
        let query = with_fragments(
            TASK_RUN_TRACE,
            &[
                TASK_RUN_FIELDS,
                EXECUTION_FIELDS,
                SESSION_LOG_FIELDS,
                TASK_RUN_TRACE_FIELDS,
            ],
        );
        let variables = json!({ "root_task_run_id": root_task_run_id });

        let response: TaskRunTraceResponse = self
            .client
            .execute(&query, variables, "task_run_trace")
            .await?;

        Ok(TaskRunTrace {
            root_task_run_id: response.root_task_run_id,
            task_runs: response
                .task_runs
                .iter()
                .map(Self::response_to_task_run)
                .collect(),
            step_executions: response
                .step_executions
                .iter()
                .map(Self::response_to_execution)
                .collect(),
            session_logs: response
                .session_logs
                .iter()
                .map(Self::response_to_log)
                .collect(),
        })
    }

    async fn run_workflow(&self, task_id: &str) -> ServiceResult<TaskRun> {
        let query = with_fragments(RUN_WORKFLOW, &[TASK_RUN_FIELDS]);
        let variables = json!({ "task_id": task_id });

        let response: TaskRunResponse = self
            .client
            .execute(&query, variables, "run_workflow")
            .await?;

        Ok(Self::response_to_task_run(&response))
    }

    async fn stop_run(&self, target: StopRunTarget) -> ServiceResult<Option<TaskRun>> {
        let query = with_fragments(STOP_RUN, &[TASK_RUN_FIELDS]);
        let mut variables = serde_json::Map::new();
        match target {
            StopRunTarget::TaskId(task_id) => {
                variables.insert("task_id".to_string(), json!(task_id));
            }
            StopRunTarget::TaskRunId(task_run_id) => {
                variables.insert("task_run_id".to_string(), json!(task_run_id));
            }
        }

        let response: Option<TaskRunResponse> = self
            .client
            .execute(&query, serde_json::Value::Object(variables), "stop_run")
            .await?;

        Ok(response.as_ref().map(Self::response_to_task_run))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::StepExecutionResponse;

    fn create_test_client() -> GraphqlClient {
        GraphqlClient::new(crate::config::SacrumConfig::new(
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
            task_run_id: Some("run-1".to_string()),
            workflow_id: "wf-1".to_string(),
            step_name: "review".to_string(),
            status: "completed".to_string(),
            context: Some(serde_json::Value::String("ctx".to_string())),
            prompt: Some("prompt".to_string()),
            output: Some("output".to_string()),
            transition_result: Some("next".to_string()),
            model: Some("claude-opus".to_string()),
            model_provider: None,
            input_tokens: Some(1000),
            output_tokens: Some(500),
            cost: Some(0.05),
            duration_ms: Some(1500),
            handoff: Some(serde_json::json!({"to": "next-task"})),
            inserted_at: Some("2024-01-01T00:00:00Z".to_string()),
            updated_at: Some("2024-01-01T00:01:00Z".to_string()),
        };

        let execution = SacrumExecutionService::response_to_execution(&response);

        assert_eq!(execution.id, Some("exec-1".to_string()));
        assert_eq!(execution.task_id, "task-1");
        assert_eq!(execution.task_run_id.as_deref(), Some("run-1"));
        assert_eq!(execution.workflow_id, "wf-1");
        assert_eq!(execution.step_name, "review");
        assert_eq!(execution.status, ExecutionStatus::Completed);
        assert_eq!(execution.context.as_deref(), Some("ctx"));
        assert_eq!(execution.output.as_deref(), Some("output"));
        assert_eq!(execution.model_used.as_deref(), Some("claude-opus"));
        assert_eq!(execution.cost_usd, Some(0.05));
        assert_eq!(execution.duration_ms, Some(1500));
        assert!(execution.completed_at.is_some());
        let token_usage = execution.token_usage.expect("token_usage populated");
        assert_eq!(token_usage.input_tokens, 1000);
        assert_eq!(token_usage.output_tokens, 500);
        assert_eq!(execution.handoff.as_deref(), Some(r#"{"to":"next-task"}"#));
    }

    #[test]
    fn test_response_to_execution_in_progress() {
        let response = StepExecutionResponse {
            id: "exec-2".to_string(),
            task_id: "task-1".to_string(),
            task_run_id: None,
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
            handoff: None,
            inserted_at: None,
            updated_at: None,
        };

        let execution = SacrumExecutionService::response_to_execution(&response);

        assert_eq!(execution.status, ExecutionStatus::InProgress);
        assert!(execution.completed_at.is_none());
        assert!(execution.token_usage.is_none());
        assert!(execution.handoff.is_none());
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
    fn test_execution_variables_maps_token_usage() {
        use vertebrae_core::models::TokenUsage;

        let execution = StepExecution::new("task-1", "wf-1", "review")
            .with_token_usage(TokenUsage::new(1000, 500))
            .with_model_used("claude-opus")
            .with_cost_usd(0.05)
            .with_duration_ms(1500);

        // Verify the fields that would be sent as variables
        assert_eq!(execution.step_name, "review");
        assert_eq!(execution.model_used.as_deref(), Some("claude-opus"));
        assert_eq!(execution.cost_usd, Some(0.05));
        assert_eq!(execution.duration_ms, Some(1500));
        assert!(execution.token_usage.is_some());
        let usage = execution.token_usage.unwrap();
        assert_eq!(usage.input_tokens, 1000);
        assert_eq!(usage.output_tokens, 500);
    }

    #[test]
    fn test_execution_without_token_usage() {
        let execution = StepExecution::new("task-1", "wf-1", "review");

        assert!(execution.token_usage.is_none());
        assert!(execution.model_used.is_none());
        assert!(execution.cost_usd.is_none());
        assert!(execution.duration_ms.is_none());
    }

    // =========================================================================
    // Wiremock integration tests for execution service GraphQL methods
    // =========================================================================

    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn create_wiremock_service(server_url: &str) -> SacrumExecutionService {
        let client = GraphqlClient::new(crate::config::SacrumConfig::new(
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
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "create_step_execution": {
                        "id": "exec-new"
                    }
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
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "create_step_execution": {
                        "id": "exec-full"
                    }
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
    async fn test_create_execution_graphql_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "step_name can't be blank", "path": ["create_step_execution"]}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let execution = StepExecution::new("bad-task", "wf-1", "");
        let result = service.create_execution(execution).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_execution_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "step_execution": {
                        "id": "exec-1",
                        "task_id": "task-1",
                        "workflow_id": "wf-1",
                        "step_name": "review",
                        "status": "completed",
                        "context": "ctx",
                        "prompt": "prompt",
                        "output": "result",
                        "transition_result": "advance",
                        "model": "claude-opus",
                        "model_provider": null,
                        "input_tokens": 1000,
                        "output_tokens": 500,
                        "cost": 0.05,
                        "duration_ms": 1500,
                        "inserted_at": "2024-01-01T00:00:00Z",
                        "updated_at": "2024-01-01T00:01:00Z"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.get_execution("exec-1").await.unwrap();

        let exec = result.unwrap();
        assert_eq!(exec.id, Some("exec-1".to_string()));
        assert_eq!(exec.task_id, "task-1");
        assert_eq!(exec.status, ExecutionStatus::Completed);
        assert_eq!(exec.model_used.as_deref(), Some("claude-opus"));
    }

    #[tokio::test]
    async fn test_list_executions_for_task() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "step_executions": [
                        {
                            "id": "exec-1",
                            "task_id": "task-1",
                            "workflow_id": "wf-1",
                            "step_name": "backlog",
                            "status": "completed",
                            "inserted_at": "2024-01-01T00:00:00Z",
                            "updated_at": "2024-01-01T00:01:00Z"
                        },
                        {
                            "id": "exec-2",
                            "task_id": "task-1",
                            "workflow_id": "wf-1",
                            "step_name": "review",
                            "status": "in_progress",
                            "inserted_at": "2024-01-01T01:00:00Z",
                            "updated_at": "2024-01-01T01:00:00Z"
                        }
                    ]
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.list_executions_for_task("task-1").await.unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].step_name, "backlog");
        assert_eq!(result[1].step_name, "review");
    }

    #[tokio::test]
    async fn test_update_execution_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "update_step_execution": {
                        "id": "exec-1"
                    }
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

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "update_step_execution": {
                        "id": "exec-2"
                    }
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
    async fn test_update_execution_graphql_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "not_found"}]
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
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "create_session_log": {
                        "id": "log-new"
                    }
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
    async fn test_add_log_graphql_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "not_found"}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let log = SessionLog::new("bad-exec", "This should fail");
        let result = service.add_log(log).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_logs_for_execution() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "session_logs": [
                        {
                            "id": "log-1",
                            "step_execution_id": "exec-1",
                            "content": "First log entry",
                            "inserted_at": "2024-01-01T00:00:00Z",
                            "updated_at": "2024-01-01T00:00:00Z"
                        },
                        {
                            "id": "log-2",
                            "step_execution_id": "exec-1",
                            "content": "Second log entry",
                            "inserted_at": "2024-01-01T00:01:00Z",
                            "updated_at": "2024-01-01T00:01:00Z"
                        }
                    ]
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.list_logs_for_execution("exec-1").await.unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].content, "First log entry");
        assert_eq!(result[1].content, "Second log entry");
    }

    #[tokio::test]
    async fn test_get_latest_execution_for_task() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "step_executions": [
                        {
                            "id": "exec-1",
                            "task_id": "task-1",
                            "workflow_id": "wf-1",
                            "step_name": "backlog",
                            "status": "completed",
                            "inserted_at": "2024-01-01T00:00:00Z",
                            "updated_at": "2024-01-01T00:01:00Z"
                        },
                        {
                            "id": "exec-2",
                            "task_id": "task-1",
                            "workflow_id": "wf-1",
                            "step_name": "review",
                            "status": "in_progress",
                            "inserted_at": "2024-01-01T01:00:00Z",
                            "updated_at": "2024-01-01T01:00:00Z"
                        }
                    ]
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .get_latest_execution_for_task("task-1")
            .await
            .unwrap();

        let exec = result.unwrap();
        assert_eq!(exec.id, Some("exec-2".to_string()));
        assert_eq!(exec.step_name, "review");
    }

    #[tokio::test]
    async fn test_get_latest_execution_for_task_empty() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "step_executions": []
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .get_latest_execution_for_task("task-1")
            .await
            .unwrap();

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_run_step_returns_execution() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "run_step": {
                        "id": "exec-run-1",
                        "task_id": "task-1",
                        "workflow_id": "wf-1",
                        "step_name": "implement",
                        "status": "in_progress",
                        "context": null,
                        "prompt": null,
                        "output": null,
                        "transition_result": null,
                        "model": null,
                        "model_provider": null,
                        "input_tokens": null,
                        "output_tokens": null,
                        "cost": null,
                        "duration_ms": null,
                        "inserted_at": "2024-06-01T00:00:00Z",
                        "updated_at": "2024-06-01T00:00:00Z"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.run_step("task-1", "step-1").await.unwrap();

        assert_eq!(result.id, Some("exec-run-1".to_string()));
        assert_eq!(result.task_id, "task-1");
        assert_eq!(result.step_name, "implement");
        assert_eq!(result.status, ExecutionStatus::InProgress);
    }

    #[tokio::test]
    async fn test_run_step_graphql_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "no_daemon_connected"}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.run_step("task-1", "step-1").await;

        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("no_daemon_connected"),
            "Expected error about daemon, got: {}",
            err_msg
        );
    }

    // =========================================================================
    // update_execution_status tests
    // =========================================================================

    #[tokio::test]
    async fn test_update_execution_status_to_running() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "update_step_execution": {
                        "id": "exec-1"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let params = vertebrae_core::execution_service::UpdateExecutionStatusParams::new(
            ExecutionStatus::InProgress,
        );
        let result = service.update_execution_status("exec-1", params).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_update_execution_status_to_completed() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "update_step_execution": {
                        "id": "exec-2"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let params = vertebrae_core::execution_service::UpdateExecutionStatusParams::new(
            ExecutionStatus::Completed,
        );
        let result = service.update_execution_status("exec-2", params).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_update_execution_status_to_failed_with_output() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "update_step_execution": {
                        "id": "exec-3"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let params = vertebrae_core::execution_service::UpdateExecutionStatusParams::new(
            ExecutionStatus::Failed,
        )
        .with_output("Process exited with code 1");
        let result = service.update_execution_status("exec-3", params).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_update_execution_status_graphql_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "not_found"}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let params = vertebrae_core::execution_service::UpdateExecutionStatusParams::new(
            ExecutionStatus::Completed,
        );
        let result = service.update_execution_status("nonexistent", params).await;
        assert!(result.is_err());
    }

    // =========================================================================
    // orchestrate_task tests
    // =========================================================================

    #[tokio::test]
    async fn test_orchestrate_task_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "orchestrate_task": {
                        "id": "task-1"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.orchestrate_task("task-1").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_orchestrate_task_no_workflow_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "Task has no workflow assigned"}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.orchestrate_task("task-no-wf").await;

        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("no workflow assigned"),
            "Expected error about no workflow, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_orchestrate_task_already_completed_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "Cannot orchestrate a completed task"}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.orchestrate_task("task-done").await;

        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("completed task"),
            "Expected error about completed task, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_stop_orchestrator_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "stop_orchestrator": {
                        "id": "task-running"
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.stop_orchestrator("task-running").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_stop_orchestrator_task_not_found_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "Task not found"}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.stop_orchestrator("missing-task").await;

        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("not found"),
            "Expected error about not found, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_orchestrate_task_already_running_error() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": null,
                "errors": [{"message": "Orchestration is already running for this task"}]
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.orchestrate_task("task-running").await;

        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("already running"),
            "Expected error about already running, got: {}",
            err_msg
        );
    }
}
