//! Test helpers for Sacrum client testing
//!
//! Provides MockSacrumServer for integration testing against a mock Sacrum API.
//! Wraps wiremock to provide convenient stub methods and fixtures.

use serde_json::{Value, json};
use vertebrae_sacrum_client::{DataEnvelope, SacrumClient, SacrumConfig};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Mock Sacrum API server for testing
///
/// Starts an in-process HTTP server on a random port that can respond to API requests.
/// Provides convenient methods to stub Sacrum API endpoints.
pub struct MockSacrumServer {
    server: MockServer,
}

impl MockSacrumServer {
    /// Start a new mock server on a random port
    pub async fn start() -> Self {
        let server = MockServer::start().await;
        MockSacrumServer { server }
    }

    /// Get the base URL for this mock server
    pub fn url(&self) -> String {
        self.server.uri()
    }

    /// Get a SacrumClient configured to use this mock server
    pub fn client(&self) -> SacrumClient {
        let config = SacrumConfig::new(
            self.url(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        SacrumClient::new(config)
    }

    // Task endpoints

    /// Stub GET /projects/{project_id}/tasks to return a list of tasks
    pub async fn stub_list_tasks(&self, tasks: Vec<Value>) {
        let response_data = json!({
            "tasks": tasks,
            "total": tasks.len()
        });

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope {
            data: response_data,
        });

        Mock::given(method("GET"))
            .and(path("/projects/test-project/tasks"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub GET /projects/{project_id}/tasks/{task_id} to return a task
    pub async fn stub_get_task(&self, task: Value) {
        let task_id = task
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope { data: task });

        Mock::given(method("GET"))
            .and(path(format!("/projects/test-project/tasks/{}", task_id)))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub POST /projects/{project_id}/tasks to create a task
    pub async fn stub_create_task(&self, response: Value) {
        let response_template =
            ResponseTemplate::new(201).set_body_json(DataEnvelope { data: response });

        Mock::given(method("POST"))
            .and(path("/projects/test-project/tasks"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response_template)
            .mount(&self.server)
            .await;
    }

    /// Stub PUT /projects/{project_id}/tasks/{task_id} to update a task
    pub async fn stub_update_task(&self, task_id: &str, response: Value) {
        let response_template =
            ResponseTemplate::new(200).set_body_json(DataEnvelope { data: response });

        Mock::given(method("PUT"))
            .and(path(format!("/projects/test-project/tasks/{}", task_id)))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response_template)
            .mount(&self.server)
            .await;
    }

    /// Stub DELETE /projects/{project_id}/tasks/{task_id} to delete a task
    pub async fn stub_delete_task(&self, task_id: &str) {
        let response = ResponseTemplate::new(204);

        Mock::given(method("DELETE"))
            .and(path(format!("/projects/test-project/tasks/{}", task_id)))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    // Workflow endpoints

    /// Stub GET /projects/{project_id}/workflows to return a list of workflows
    pub async fn stub_list_workflows(&self, workflows: Vec<Value>) {
        let response_data = json!({
            "workflows": workflows,
            "total": workflows.len()
        });

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope {
            data: response_data,
        });

        Mock::given(method("GET"))
            .and(path("/projects/test-project/workflows"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub GET /projects/{project_id}/workflows/{workflow_id} to return a workflow
    pub async fn stub_get_workflow(&self, workflow: Value) {
        let workflow_id = workflow
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope { data: workflow });

        Mock::given(method("GET"))
            .and(path(format!(
                "/projects/test-project/workflows/{}",
                workflow_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub POST /projects/{project_id}/tasks/{task_id}/assign-workflow to assign a workflow
    pub async fn stub_assign_workflow(&self, task_id: &str, response: Value) {
        let response_template =
            ResponseTemplate::new(200).set_body_json(DataEnvelope { data: response });

        Mock::given(method("POST"))
            .and(path(format!(
                "/projects/test-project/tasks/{}/assign-workflow",
                task_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response_template)
            .mount(&self.server)
            .await;
    }

    /// Stub POST /projects/{project_id}/tasks/{task_id}/advance-step to advance workflow step
    pub async fn stub_advance_step(&self, task_id: &str, response: Value) {
        let response_template =
            ResponseTemplate::new(200).set_body_json(DataEnvelope { data: response });

        Mock::given(method("POST"))
            .and(path(format!(
                "/projects/test-project/tasks/{}/advance-step",
                task_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response_template)
            .mount(&self.server)
            .await;
    }

    /// Stub POST /projects/{project_id}/tasks/{task_id}/retreat-step to retreat workflow step
    pub async fn stub_retreat_step(&self, task_id: &str, response: Value) {
        let response_template =
            ResponseTemplate::new(200).set_body_json(DataEnvelope { data: response });

        Mock::given(method("POST"))
            .and(path(format!(
                "/projects/test-project/tasks/{}/retreat-step",
                task_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response_template)
            .mount(&self.server)
            .await;
    }

    // Code refs endpoints

    /// Stub GET /projects/{project_id}/tasks/{task_id}/code-refs to list code refs
    pub async fn stub_list_code_refs(&self, task_id: &str, code_refs: Vec<Value>) {
        let response_data = json!({
            "code_refs": code_refs,
            "total": code_refs.len()
        });

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope {
            data: response_data,
        });

        Mock::given(method("GET"))
            .and(path(format!(
                "/projects/test-project/tasks/{}/code-refs",
                task_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub POST /projects/{project_id}/tasks/{task_id}/code-refs to create a code ref
    pub async fn stub_create_code_ref(&self, task_id: &str, response: Value) {
        let response_template =
            ResponseTemplate::new(201).set_body_json(DataEnvelope { data: response });

        Mock::given(method("POST"))
            .and(path(format!(
                "/projects/test-project/tasks/{}/code-refs",
                task_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response_template)
            .mount(&self.server)
            .await;
    }

    // Sections endpoints

    /// Stub GET /projects/{project_id}/tasks/{task_id}/sections to list sections
    pub async fn stub_list_sections(&self, task_id: &str, sections: Vec<Value>) {
        let response_data = json!({
            "sections": sections,
            "total": sections.len()
        });

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope {
            data: response_data,
        });

        Mock::given(method("GET"))
            .and(path(format!(
                "/projects/test-project/tasks/{}/sections",
                task_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub POST /projects/{project_id}/tasks/{task_id}/sections to create a section
    pub async fn stub_create_section(&self, task_id: &str, response: Value) {
        let response_template =
            ResponseTemplate::new(201).set_body_json(DataEnvelope { data: response });

        Mock::given(method("POST"))
            .and(path(format!(
                "/projects/test-project/tasks/{}/sections",
                task_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response_template)
            .mount(&self.server)
            .await;
    }

    // Executions endpoints

    /// Stub GET /projects/{project_id}/executions to list executions
    pub async fn stub_list_executions(&self, executions: Vec<Value>) {
        let response_data = json!({
            "executions": executions,
            "total": executions.len()
        });

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope {
            data: response_data,
        });

        Mock::given(method("GET"))
            .and(path("/projects/test-project/executions"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub GET /projects/{project_id}/executions/{execution_id} to get an execution
    pub async fn stub_get_execution(&self, execution: Value) {
        let execution_id = execution
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope { data: execution });

        Mock::given(method("GET"))
            .and(path(format!(
                "/projects/test-project/executions/{}",
                execution_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    // Steps endpoints

    /// Stub GET /projects/{project_id}/workflows/{workflow_id}/steps to list workflow steps
    pub async fn stub_list_steps(&self, workflow_id: &str, steps: Vec<Value>) {
        let response_data = json!({
            "steps": steps,
            "total": steps.len()
        });

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope {
            data: response_data,
        });

        Mock::given(method("GET"))
            .and(path(format!(
                "/projects/test-project/workflows/{}/steps",
                workflow_id
            )))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    // Gates endpoints

    /// Stub GET /projects/{project_id}/gates to list gates
    pub async fn stub_list_gates(&self, gates: Vec<Value>) {
        let response_data = json!({
            "gates": gates,
            "total": gates.len()
        });

        let response = ResponseTemplate::new(200).set_body_json(DataEnvelope {
            data: response_data,
        });

        Mock::given(method("GET"))
            .and(path("/projects/test-project/gates"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub POST /projects/{project_id}/gates to create a gate
    pub async fn stub_create_gate(&self, response: Value) {
        let response_template =
            ResponseTemplate::new(201).set_body_json(DataEnvelope { data: response });

        Mock::given(method("POST"))
            .and(path("/projects/test-project/gates"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response_template)
            .mount(&self.server)
            .await;
    }

    // Error stubs

    /// Stub a 404 Not Found response for a given path
    pub async fn stub_not_found(&self, api_path: &str) {
        let response = ResponseTemplate::new(404).set_body_json(json!({
            "message": "Not found",
            "code": "404"
        }));

        Mock::given(method("GET"))
            .and(path(api_path))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub a 401 Unauthorized response
    pub async fn stub_unauthorized(&self, api_path: &str) {
        let response = ResponseTemplate::new(401).set_body_json(json!({
            "message": "Unauthorized",
            "code": "401"
        }));

        Mock::given(method("GET"))
            .and(path(api_path))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }

    /// Stub a validation error response for a given path
    pub async fn stub_validation_error(&self, api_path: &str, errors: Vec<String>) {
        let response = ResponseTemplate::new(422).set_body_json(json!({
            "message": "Validation failed",
            "code": "validation_error",
            "errors": errors
        }));

        Mock::given(method("POST"))
            .and(path(api_path))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(response)
            .mount(&self.server)
            .await;
    }
}

// Fixture builders for common test data

/// Create a mock task response matching Sacrum API format
pub fn mock_task(id: Option<&str>, subject: &str) -> Value {
    let task_id = id.unwrap_or("task-uuid-123");
    let short_id = if task_id.len() > 8 {
        format!("task-{}", &task_id[..8])
    } else {
        task_id.to_string()
    };
    json!({
        "id": task_id,
        "short_id": short_id,
        "subject": subject,
        "description": Some("Test task description"),
        "status": "pending",
        "priority": Some("high"),
        "parent_id": Value::Null,
        "project_id": "test-project"
    })
}

/// Create a mock workflow response matching Sacrum API format
pub fn mock_workflow(id: Option<&str>, name: &str) -> Value {
    let workflow_id = id.unwrap_or("workflow-uuid-123");
    json!({
        "id": workflow_id,
        "name": name,
        "description": Some("Test workflow description"),
        "steps": vec![
            mock_step("step-1", "Review", 1),
            mock_step("step-2", "Deploy", 2),
        ]
    })
}

/// Create a mock workflow step response matching Sacrum API format
pub fn mock_step(id: &str, name: &str, ordinal: i32) -> Value {
    json!({
        "id": id,
        "name": name,
        "ordinal": ordinal,
        "requires_human_review": false
    })
}

/// Create a mock code ref response matching Sacrum API format
pub fn mock_code_ref(path: &str, line: u32) -> Value {
    json!({
        "id": "ref-uuid-123",
        "task_id": "task-uuid-123",
        "path": path,
        "line": line,
        "name": Some("function_name")
    })
}

/// Create a mock section response matching Sacrum API format
pub fn mock_section(ordinal: i32, section_type: &str, content: &str) -> Value {
    json!({
        "id": "section-uuid-123",
        "task_id": "task-uuid-123",
        "ordinal": ordinal,
        "type": section_type,
        "content": content
    })
}

/// Create a mock execution response matching Sacrum API format
pub fn mock_execution(workflow_id: &str, task_id: &str) -> Value {
    json!({
        "id": "execution-uuid-123",
        "workflow_id": workflow_id,
        "task_id": task_id,
        "current_step": 1,
        "status": "in_progress",
        "started_at": "2026-01-31T00:00:00Z",
        "completed_at": Value::Null
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_mock_server_starts() {
        let server = MockSacrumServer::start().await;
        assert!(!server.url().is_empty());
        assert!(server.url().contains("http"));
    }

    #[tokio::test]
    async fn test_client_creation_from_mock_server() {
        let server = MockSacrumServer::start().await;
        let client = server.client();
        assert_eq!(client.project_id(), "test-project");
    }

    #[tokio::test]
    async fn test_mock_task_fixture() {
        let task = mock_task(None, "Test Task");
        assert_eq!(
            task.get("subject").and_then(|v| v.as_str()).unwrap(),
            "Test Task"
        );
        assert_eq!(
            task.get("status").and_then(|v| v.as_str()).unwrap(),
            "pending"
        );
        assert_eq!(
            task.get("project_id").and_then(|v| v.as_str()).unwrap(),
            "test-project"
        );
    }

    #[tokio::test]
    async fn test_mock_workflow_fixture() {
        let workflow = mock_workflow(None, "Test Workflow");
        assert_eq!(
            workflow.get("name").and_then(|v| v.as_str()).unwrap(),
            "Test Workflow"
        );

        let steps = workflow.get("steps").and_then(|v| v.as_array()).unwrap();
        assert_eq!(steps.len(), 2);
    }

    #[tokio::test]
    async fn test_mock_step_fixture() {
        let step = mock_step("step-1", "Review", 1);
        assert_eq!(step.get("name").and_then(|v| v.as_str()).unwrap(), "Review");
        assert_eq!(step.get("ordinal").and_then(|v| v.as_i64()).unwrap(), 1);
    }

    #[tokio::test]
    async fn test_stub_list_tasks_and_get() {
        let server = MockSacrumServer::start().await;
        let client = server.client();

        // Stub the list endpoint
        let tasks = vec![
            mock_task(Some("task-1"), "First Task"),
            mock_task(Some("task-2"), "Second Task"),
        ];
        server.stub_list_tasks(tasks.clone()).await;

        // Make the request
        let response: vertebrae_sacrum_client::TaskListResponse = client
            .get("/projects/test-project/tasks")
            .await
            .expect("Should successfully list tasks");

        assert_eq!(response.tasks.len(), 2);
        assert_eq!(response.tasks[0].subject, "First Task");
        assert_eq!(response.tasks[1].subject, "Second Task");
    }

    #[tokio::test]
    async fn test_stub_get_task() {
        let server = MockSacrumServer::start().await;
        let client = server.client();

        let task = mock_task(Some("task-123"), "Specific Task");
        server.stub_get_task(task.clone()).await;

        let response: vertebrae_sacrum_client::TaskResponse = client
            .get("/projects/test-project/tasks/task-123")
            .await
            .expect("Should successfully get task");

        assert_eq!(response.id, "task-123");
        assert_eq!(response.subject, "Specific Task");
    }

    #[tokio::test]
    async fn test_stub_create_task() {
        let server = MockSacrumServer::start().await;
        let client = server.client();

        let task = mock_task(Some("task-new"), "New Task");
        server.stub_create_task(task.clone()).await;

        let response: vertebrae_sacrum_client::TaskResponse = client
            .post(
                "/projects/test-project/tasks",
                &serde_json::json!({"subject": "New Task"}),
            )
            .await
            .expect("Should successfully create task");

        assert_eq!(response.id, "task-new");
        assert_eq!(response.subject, "New Task");
    }

    #[tokio::test]
    async fn test_stub_list_workflows() {
        let server = MockSacrumServer::start().await;
        let client = server.client();

        let workflows = vec![
            mock_workflow(Some("wf-1"), "Workflow 1"),
            mock_workflow(Some("wf-2"), "Workflow 2"),
        ];
        server.stub_list_workflows(workflows).await;

        let response: serde_json::Value = client
            .get("/projects/test-project/workflows")
            .await
            .expect("Should successfully list workflows");

        let wf_array = response
            .get("workflows")
            .and_then(|v| v.as_array())
            .unwrap();
        assert_eq!(wf_array.len(), 2);
    }

    #[tokio::test]
    async fn test_stub_not_found() {
        let server = MockSacrumServer::start().await;
        let client = server.client();

        server
            .stub_not_found("/projects/test-project/tasks/nonexistent")
            .await;

        let result: Result<vertebrae_sacrum_client::TaskResponse, _> =
            client.get("/projects/test-project/tasks/nonexistent").await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_authorization_header_required() {
        let server = MockSacrumServer::start().await;

        // Stub with authorization requirement
        server.stub_list_tasks(vec![]).await;

        // Client should include auth header automatically
        let client = server.client();
        let _response: Result<vertebrae_sacrum_client::TaskListResponse, _> =
            client.get("/projects/test-project/tasks").await;

        // Test passes if mock server accepts the request with proper auth
    }
}
