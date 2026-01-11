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
}
