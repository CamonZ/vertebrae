//! Error types for the vertebrae-core service layer
//!
//! Provides error handling for business logic operations, wrapping
//! database errors and adding service-specific error variants.

use thiserror::Error;
use vertebrae_db::DbError;

/// Service layer result type
pub type ServiceResult<T> = Result<T, ServiceError>;

/// Service layer errors
///
/// Encompasses both business logic errors and underlying database errors.
#[derive(Debug, Error)]
pub enum ServiceError {
    /// A task with the given ID was not found
    #[error("Task not found: {task_id}")]
    TaskNotFound { task_id: String },

    /// A workflow with the given ID was not found
    #[error("Workflow not found: {workflow_id}")]
    WorkflowNotFound { workflow_id: String },

    /// Invalid task state transition
    #[error("Invalid status transition from '{from}' to '{to}'")]
    InvalidTransition {
        from: String,
        to: String,
        /// Valid transitions from the current status
        valid_transitions: Vec<String>,
    },

    /// Task is blocked by incomplete dependencies
    #[error("Task '{task_id}' is blocked by incomplete dependencies")]
    TaskBlocked { task_id: String },

    /// Validation failed
    #[error("Validation failed: {message}")]
    ValidationFailed { message: String },

    /// A parent task was not found
    #[error("Parent task not found: {parent_id}")]
    ParentNotFound { parent_id: String },

    /// A dependency task was not found
    #[error("Dependency task not found: {dependency_id}")]
    DependencyNotFound { dependency_id: String },

    /// Creating a dependency would cause a cycle
    #[error("Dependency would create a cycle")]
    CyclicDependency,

    /// Invalid input error
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// Database error from the underlying storage layer
    /// NOTE: Kept for backward compatibility during migration to Sacrum backend.
    /// Will be removed when crates/db is deleted.
    #[error(transparent)]
    Database(#[from] DbError),

    /// API error from the Sacrum backend
    #[error("API error (HTTP {status}): {message}")]
    ApiError { status: u16, message: String },

    /// Network connectivity error
    #[error("Network error: {0}")]
    NetworkError(String),

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),
}

impl ServiceError {
    /// Create a task not found error
    pub fn task_not_found(task_id: impl Into<String>) -> Self {
        ServiceError::TaskNotFound {
            task_id: task_id.into(),
        }
    }

    /// Create a workflow not found error
    pub fn workflow_not_found(workflow_id: impl Into<String>) -> Self {
        ServiceError::WorkflowNotFound {
            workflow_id: workflow_id.into(),
        }
    }

    /// Create an invalid transition error with valid transitions
    pub fn invalid_transition_with_valid(
        from: impl Into<String>,
        to: impl Into<String>,
        valid_transitions: Vec<String>,
    ) -> Self {
        ServiceError::InvalidTransition {
            from: from.into(),
            to: to.into(),
            valid_transitions,
        }
    }

    /// Create an invalid transition error (without valid transitions)
    pub fn invalid_transition(from: impl Into<String>, to: impl Into<String>) -> Self {
        ServiceError::InvalidTransition {
            from: from.into(),
            to: to.into(),
            valid_transitions: Vec::new(),
        }
    }

    /// Create a validation failed error
    pub fn validation_failed(message: impl Into<String>) -> Self {
        ServiceError::ValidationFailed {
            message: message.into(),
        }
    }

    /// Create a parent not found error
    pub fn parent_not_found(parent_id: impl Into<String>) -> Self {
        ServiceError::ParentNotFound {
            parent_id: parent_id.into(),
        }
    }

    /// Create a dependency not found error
    pub fn dependency_not_found(dependency_id: impl Into<String>) -> Self {
        ServiceError::DependencyNotFound {
            dependency_id: dependency_id.into(),
        }
    }

    /// Create an API error from Sacrum backend
    pub fn api_error(status: u16, message: impl Into<String>) -> Self {
        ServiceError::ApiError {
            status,
            message: message.into(),
        }
    }

    /// Create a network error
    pub fn network_error(message: impl Into<String>) -> Self {
        ServiceError::NetworkError(message.into())
    }

    /// Create a configuration error
    pub fn config_error(message: impl Into<String>) -> Self {
        ServiceError::ConfigError(message.into())
    }

    /// Get a user-friendly hint for how to resolve this error.
    ///
    /// Returns `None` if no specific guidance is available.
    pub fn hint(&self) -> Option<String> {
        match self {
            ServiceError::TaskNotFound { .. } => {
                Some("Hint: Check the task ID with 'vtb list' or use a prefix of the full ID".to_string())
            }
            ServiceError::WorkflowNotFound { .. } => {
                Some("Hint: List available workflows with 'vtb workflow list'".to_string())
            }
            ServiceError::InvalidTransition { valid_transitions, .. } => {
                if valid_transitions.is_empty() {
                    Some("Hint: Check 'vtb list' for current status".to_string())
                } else {
                    Some(format!(
                        "Hint: Valid transitions from current status: {}",
                        valid_transitions.join(", ")
                    ))
                }
            }
            ServiceError::TaskBlocked { .. } => Some(
                "Hint: Complete or remove blocking dependencies first. Use 'vtb blockers <id>' to see what's blocking".to_string(),
            ),
            ServiceError::ParentNotFound { .. } => {
                Some("Hint: Check the parent task ID with 'vtb list'".to_string())
            }
            ServiceError::DependencyNotFound { .. } => {
                Some("Hint: Check the dependency task ID with 'vtb list'".to_string())
            }
            ServiceError::CyclicDependency => {
                Some("Hint: A task cannot depend on itself or create a circular dependency chain".to_string())
            }
            ServiceError::Database(db_err) => db_err.hint().map(String::from),
            ServiceError::ValidationFailed { .. } => None,
            ServiceError::InvalidInput(_) => None,
            ServiceError::ApiError { status, .. } => {
                match *status {
                    401 => Some("Hint: Check SACRUM_API_TOKEN environment variable and ensure it's valid".to_string()),
                    404 => Some("Hint: Resource not found on server. Verify the request is correct".to_string()),
                    422 => Some("Hint: Invalid request data. Check the parameters and try again".to_string()),
                    500 => Some("Hint: Server error. Try again later or contact the server administrator".to_string()),
                    _ => Some(format!("Hint: HTTP {} error. Check the API response for details", status)),
                }
            }
            ServiceError::NetworkError(_) => {
                Some("Hint: Check your network connection and ensure the server is reachable".to_string())
            }
            ServiceError::ConfigError(_) => {
                Some("Hint: Check your configuration settings and environment variables".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_not_found_error() {
        let err = ServiceError::task_not_found("abc123");
        assert!(matches!(err, ServiceError::TaskNotFound { .. }));
        assert!(err.to_string().contains("abc123"));
    }

    #[test]
    fn test_workflow_not_found_error() {
        let err = ServiceError::workflow_not_found("default");
        assert!(matches!(err, ServiceError::WorkflowNotFound { .. }));
        assert!(err.to_string().contains("default"));
    }

    #[test]
    fn test_invalid_transition_error() {
        let err = ServiceError::invalid_transition("backlog", "done");
        assert!(matches!(err, ServiceError::InvalidTransition { .. }));
        let msg = err.to_string();
        assert!(msg.contains("backlog"));
        assert!(msg.contains("done"));
    }

    #[test]
    fn test_validation_failed_error() {
        let err = ServiceError::validation_failed("Title cannot be empty");
        assert!(matches!(err, ServiceError::ValidationFailed { .. }));
        assert!(err.to_string().contains("Title cannot be empty"));
    }

    #[test]
    fn test_parent_not_found_error() {
        let err = ServiceError::parent_not_found("parent123");
        assert!(matches!(err, ServiceError::ParentNotFound { .. }));
        assert!(err.to_string().contains("parent123"));
    }

    #[test]
    fn test_dependency_not_found_error() {
        let err = ServiceError::dependency_not_found("dep456");
        assert!(matches!(err, ServiceError::DependencyNotFound { .. }));
        assert!(err.to_string().contains("dep456"));
    }

    #[test]
    fn test_cyclic_dependency_error() {
        let err = ServiceError::CyclicDependency;
        assert!(err.to_string().contains("cycle"));
    }

    #[test]
    fn test_task_blocked_error() {
        let err = ServiceError::TaskBlocked {
            task_id: "blocked123".to_string(),
        };
        assert!(err.to_string().contains("blocked123"));
        assert!(err.to_string().contains("blocked"));
    }

    #[test]
    fn test_database_error_conversion() {
        let db_err = DbError::TaskNotFound {
            task_id: "test".to_string(),
        };
        let service_err: ServiceError = db_err.into();
        assert!(matches!(service_err, ServiceError::Database(_)));
    }

    #[test]
    fn test_hint_task_not_found() {
        let err = ServiceError::task_not_found("abc123");
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("vtb list"));
    }

    #[test]
    fn test_hint_workflow_not_found() {
        let err = ServiceError::workflow_not_found("default");
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("vtb workflow list"));
    }

    #[test]
    fn test_hint_invalid_transition() {
        // Test with valid transitions provided
        let err = ServiceError::invalid_transition_with_valid(
            "backlog",
            "done",
            vec!["in_progress".to_string(), "rejected".to_string()],
        );
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(
            hint.unwrap()
                .contains("Valid transitions from current status: in_progress, rejected")
        );
    }

    #[test]
    fn test_hint_invalid_transition_terminal_state() {
        // Test with empty valid transitions (terminal state)
        let err = ServiceError::invalid_transition("done", "backlog");
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("Check 'vtb list'"));
    }

    #[test]
    fn test_hint_task_blocked() {
        let err = ServiceError::TaskBlocked {
            task_id: "blocked123".to_string(),
        };
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("vtb blockers"));
    }

    #[test]
    fn test_hint_cyclic_dependency() {
        let err = ServiceError::CyclicDependency;
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("circular"));
    }

    #[test]
    fn test_hint_validation_failed_returns_none() {
        let err = ServiceError::validation_failed("Some validation error");
        assert!(err.hint().is_none());
    }

    #[test]
    fn test_hint_database_error_delegates_to_db_error() {
        let db_err = DbError::TaskNotFound {
            task_id: "test".to_string(),
        };
        let service_err: ServiceError = db_err.into();
        let hint = service_err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("vtb list"));
    }

    #[test]
    fn test_api_error_401_unauthorized() {
        let err = ServiceError::api_error(401, "Unauthorized");
        assert!(matches!(err, ServiceError::ApiError { status: 401, .. }));
        assert!(err.to_string().contains("401"));
        assert!(err.to_string().contains("Unauthorized"));
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("SACRUM_API_TOKEN"));
    }

    #[test]
    fn test_api_error_404_not_found() {
        let err = ServiceError::api_error(404, "Not found");
        assert!(matches!(err, ServiceError::ApiError { status: 404, .. }));
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("Resource not found"));
    }

    #[test]
    fn test_api_error_422_unprocessable() {
        let err = ServiceError::api_error(422, "Invalid input");
        assert!(matches!(err, ServiceError::ApiError { status: 422, .. }));
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("Invalid request data"));
    }

    #[test]
    fn test_api_error_500_server_error() {
        let err = ServiceError::api_error(500, "Internal server error");
        assert!(matches!(err, ServiceError::ApiError { status: 500, .. }));
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("Server error"));
    }

    #[test]
    fn test_api_error_generic_status() {
        let err = ServiceError::api_error(429, "Too many requests");
        assert!(matches!(err, ServiceError::ApiError { status: 429, .. }));
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("429"));
    }

    #[test]
    fn test_network_error() {
        let err = ServiceError::network_error("Connection timeout");
        assert!(matches!(err, ServiceError::NetworkError(_)));
        assert!(err.to_string().contains("Connection timeout"));
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("network connection"));
    }

    #[test]
    fn test_config_error() {
        let err = ServiceError::config_error("Missing environment variable");
        assert!(matches!(err, ServiceError::ConfigError(_)));
        assert!(err.to_string().contains("Missing environment variable"));
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("configuration"));
    }

    #[test]
    fn test_api_error_display_format() {
        let err = ServiceError::api_error(400, "Bad Request");
        let display = err.to_string();
        assert!(display.contains("API error"));
        assert!(display.contains("400"));
        assert!(display.contains("Bad Request"));
    }

    #[test]
    fn test_network_error_display_format() {
        let err = ServiceError::network_error("DNS resolution failed");
        assert!(err.to_string().contains("DNS resolution failed"));
    }

    #[test]
    fn test_config_error_display_format() {
        let err = ServiceError::config_error("Invalid configuration file");
        assert!(err.to_string().contains("Invalid configuration file"));
    }
}
