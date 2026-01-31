//! API types for Sacrum responses
//!
//! Defines structures for deserializing Sacrum JSON responses.
//! All Sacrum API responses use a {data: ...} envelope format.

use serde::{Deserialize, Serialize};

/// Standard Sacrum API response envelope
///
/// All Sacrum API responses wrap the actual data in this envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataEnvelope<T> {
    /// The actual response data
    pub data: T,
}

impl<T> DataEnvelope<T> {
    /// Extract the inner data from the envelope
    pub fn into_inner(self) -> T {
        self.data
    }
}

/// Task response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResponse {
    /// Task UUID
    pub id: String,
    /// Short task ID
    #[serde(default)]
    pub short_id: Option<String>,
    /// Task subject/title
    pub subject: String,
    /// Task description
    #[serde(default)]
    pub description: Option<String>,
    /// Task status
    pub status: String,
    /// Task priority
    #[serde(default)]
    pub priority: Option<String>,
    /// Parent task ID if nested
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Project ID
    pub project_id: String,
}

/// Workflow response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowResponse {
    /// Workflow UUID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Workflow description
    #[serde(default)]
    pub description: Option<String>,
    /// List of workflow steps
    #[serde(default)]
    pub steps: Vec<StepResponse>,
}

/// Workflow step response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResponse {
    /// Step UUID
    pub id: String,
    /// Step name
    pub name: String,
    /// Step ordinal position
    pub ordinal: i32,
    /// Whether human review is required for this step
    #[serde(default)]
    pub requires_human_review: bool,
}

/// Task list response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskListResponse {
    /// List of tasks
    pub tasks: Vec<TaskResponse>,
    /// Total count of tasks (for pagination)
    #[serde(default)]
    pub total: Option<i32>,
}

/// Error response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    /// Error message
    pub message: String,
    /// Optional error code
    #[serde(default)]
    pub code: Option<String>,
}

/// Project response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectResponse {
    /// Project UUID
    pub id: String,
    /// Project name
    pub name: String,
    /// Project slug (URL-friendly identifier)
    pub slug: String,
    /// Project description
    #[serde(default)]
    pub description: Option<String>,
}

/// Request to create a new project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProjectRequest {
    /// Project name
    pub name: String,
    /// Project slug (URL-friendly identifier)
    pub slug: String,
}

/// Project list response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectListResponse {
    /// List of projects
    pub projects: Vec<ProjectResponse>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_data_envelope_deserialization() {
        let json = r#"{"data": {"id": "123", "name": "test"}}"#;
        let envelope: DataEnvelope<serde_json::Value> = serde_json::from_str(json).unwrap();
        assert_eq!(envelope.data["id"], "123");
        assert_eq!(envelope.data["name"], "test");
    }

    #[test]
    fn test_data_envelope_into_inner() {
        let envelope = DataEnvelope {
            data: "test_data".to_string(),
        };
        let inner = envelope.into_inner();
        assert_eq!(inner, "test_data");
    }

    #[test]
    fn test_task_response_deserialization() {
        let json = r#"{
            "id": "task-uuid-123",
            "short_id": "task-123",
            "subject": "Test Task",
            "description": "Test description",
            "status": "pending",
            "priority": "high",
            "parent_id": null,
            "project_id": "proj-123"
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(task.id, "task-uuid-123");
        assert_eq!(task.short_id, Some("task-123".to_string()));
        assert_eq!(task.subject, "Test Task");
        assert_eq!(task.status, "pending");
    }

    #[test]
    fn test_task_response_with_all_fields() {
        let json = r#"{
            "id": "task-123",
            "short_id": "t-123",
            "subject": "Full Task",
            "description": "Complete description",
            "status": "completed",
            "priority": "low",
            "parent_id": "epic-456",
            "project_id": "proj-789"
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(task.id, "task-123");
        assert_eq!(task.short_id.as_deref(), Some("t-123"));
        assert_eq!(task.subject, "Full Task");
        assert_eq!(task.description.as_deref(), Some("Complete description"));
        assert_eq!(task.status, "completed");
        assert_eq!(task.priority.as_deref(), Some("low"));
        assert_eq!(task.parent_id.as_deref(), Some("epic-456"));
        assert_eq!(task.project_id, "proj-789");
    }

    #[test]
    fn test_workflow_response_with_steps() {
        let json = r#"{
            "id": "wf-123",
            "name": "Review Workflow",
            "description": "Multi-step review process",
            "steps": [
                {"id": "step-1", "name": "Initial", "ordinal": 0, "requires_human_review": false},
                {"id": "step-2", "name": "Review", "ordinal": 1, "requires_human_review": true},
                {"id": "step-3", "name": "Final", "ordinal": 2, "requires_human_review": false}
            ]
        }"#;

        let workflow: WorkflowResponse = serde_json::from_str(json).unwrap();
        assert_eq!(workflow.id, "wf-123");
        assert_eq!(workflow.name, "Review Workflow");
        assert_eq!(
            workflow.description.as_deref(),
            Some("Multi-step review process")
        );
        assert_eq!(workflow.steps.len(), 3);
        assert_eq!(workflow.steps[1].requires_human_review, true);
    }

    #[test]
    fn test_step_response_serialization() {
        let step = StepResponse {
            id: "step-123".to_string(),
            name: "Review".to_string(),
            ordinal: 0,
            requires_human_review: true,
        };

        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("step-123"));
        assert!(json.contains("Review"));
        assert!(json.contains("true"));
    }

    #[test]
    fn test_task_list_response() {
        let json = r#"{
            "tasks": [
                {"id": "t1", "short_id": null, "subject": "Task 1", "description": null, "status": "pending", "priority": null, "parent_id": null, "project_id": "p1"},
                {"id": "t2", "short_id": null, "subject": "Task 2", "description": null, "status": "pending", "priority": null, "parent_id": null, "project_id": "p1"}
            ],
            "total": 2
        }"#;

        let list: TaskListResponse = serde_json::from_str(json).unwrap();
        assert_eq!(list.tasks.len(), 2);
        assert_eq!(list.total, Some(2));
    }

    #[test]
    fn test_error_response_deserialization() {
        let json = r#"{"message": "Not found", "code": "404"}"#;
        let error: ErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(error.message, "Not found");
        assert_eq!(error.code, Some("404".to_string()));
    }

    #[test]
    fn test_error_response_with_code() {
        let json = r#"{"message": "Invalid request", "code": "INVALID_INPUT"}"#;
        let error: ErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(error.message, "Invalid request");
        assert_eq!(error.code.as_deref(), Some("INVALID_INPUT"));
    }

    #[test]
    fn test_project_response_complete() {
        let json = r#"{
            "id": "proj-123",
            "name": "My Project",
            "slug": "my-project",
            "description": "A test project"
        }"#;

        let project: ProjectResponse = serde_json::from_str(json).unwrap();
        assert_eq!(project.id, "proj-123");
        assert_eq!(project.name, "My Project");
        assert_eq!(project.slug, "my-project");
        assert_eq!(project.description.as_deref(), Some("A test project"));
    }

    #[test]
    fn test_create_project_request() {
        let request = CreateProjectRequest {
            name: "New Project".to_string(),
            slug: "new-project".to_string(),
        };

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("New Project"));
        assert!(json.contains("new-project"));
    }

    #[test]
    fn test_project_list_response() {
        let json = r#"{
            "projects": [
                {"id": "p1", "name": "Project 1", "slug": "proj-1", "description": null},
                {"id": "p2", "name": "Project 2", "slug": "proj-2", "description": "A project"}
            ]
        }"#;

        let list: ProjectListResponse = serde_json::from_str(json).unwrap();
        assert_eq!(list.projects.len(), 2);
        assert_eq!(list.projects[0].name, "Project 1");
        assert_eq!(list.projects[1].description.as_deref(), Some("A project"));
    }

    #[test]
    fn test_data_envelope_with_complex_data() {
        #[derive(serde::Serialize, serde::Deserialize)]
        struct ComplexData {
            id: String,
            value: i32,
        }

        let complex = ComplexData {
            id: "test".to_string(),
            value: 42,
        };

        let envelope = DataEnvelope { data: complex };

        let json = serde_json::to_string(&envelope).unwrap();
        let deserialized: DataEnvelope<ComplexData> = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.data.id, "test");
        assert_eq!(deserialized.data.value, 42);
    }
}
