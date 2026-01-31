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
    fn test_error_response_deserialization() {
        let json = r#"{"message": "Not found", "code": "404"}"#;
        let error: ErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(error.message, "Not found");
        assert_eq!(error.code, Some("404".to_string()));
    }
}
