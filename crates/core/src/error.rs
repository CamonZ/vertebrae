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
    InvalidTransition { from: String, to: String },

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
    #[error(transparent)]
    Database(#[from] DbError),
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

    /// Create an invalid transition error
    pub fn invalid_transition(from: impl Into<String>, to: impl Into<String>) -> Self {
        ServiceError::InvalidTransition {
            from: from.into(),
            to: to.into(),
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

    /// Get a user-friendly hint for how to resolve this error.
    ///
    /// Returns `None` if no specific guidance is available.
    pub fn hint(&self) -> Option<&'static str> {
        match self {
            ServiceError::TaskNotFound { .. } => {
                Some("Hint: Check the task ID with 'vtb list' or use a prefix of the full ID")
            }
            ServiceError::WorkflowNotFound { .. } => {
                Some("Hint: List available workflows with 'vtb workflow list'")
            }
            ServiceError::InvalidTransition { .. } => Some(
                "Hint: Valid transitions are: backlog→todo, todo→in_progress/rejected, in_progress→pending_review/done/rejected",
            ),
            ServiceError::TaskBlocked { .. } => Some(
                "Hint: Complete or remove blocking dependencies first. Use 'vtb blockers <id>' to see what's blocking",
            ),
            ServiceError::ParentNotFound { .. } => {
                Some("Hint: Check the parent task ID with 'vtb list'")
            }
            ServiceError::DependencyNotFound { .. } => {
                Some("Hint: Check the dependency task ID with 'vtb list'")
            }
            ServiceError::CyclicDependency => {
                Some("Hint: A task cannot depend on itself or create a circular dependency chain")
            }
            ServiceError::Database(db_err) => db_err.hint(),
            ServiceError::ValidationFailed { .. } => None,
            ServiceError::InvalidInput(_) => None,
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
        let err = ServiceError::invalid_transition("backlog", "done");
        let hint = err.hint();
        assert!(hint.is_some());
        assert!(hint.unwrap().contains("Valid transitions"));
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
}
