//! Error conversion utilities for the CLI
//!
//! Provides conversion between service errors and database errors for CLI compatibility.

use vertebrae_core::ServiceError;
use vertebrae_db::DbError;

/// Convert a ServiceError to a DbError for CLI compatibility
pub fn service_error_to_db_error(err: ServiceError) -> DbError {
    match err {
        ServiceError::ValidationFailed { message } => DbError::InvalidPath {
            path: std::path::PathBuf::from("validation"),
            reason: message,
        },
        ServiceError::TaskNotFound { task_id } => DbError::InvalidPath {
            path: std::path::PathBuf::from(&task_id),
            reason: format!("task '{}' not found", task_id),
        },
        ServiceError::WorkflowNotFound { workflow_id } => DbError::InvalidPath {
            path: std::path::PathBuf::from(&workflow_id),
            reason: format!("workflow '{}' not found", workflow_id),
        },
        ServiceError::ParentNotFound { parent_id } => DbError::InvalidPath {
            path: std::path::PathBuf::from(&parent_id),
            reason: format!("parent task '{}' does not exist", parent_id),
        },
        ServiceError::DependencyNotFound { dependency_id } => DbError::InvalidPath {
            path: std::path::PathBuf::from(&dependency_id),
            reason: format!("dependency task '{}' does not exist", dependency_id),
        },
        ServiceError::InvalidTransition { from, to } => DbError::InvalidPath {
            path: std::path::PathBuf::from("status"),
            reason: format!("invalid transition from '{}' to '{}'", from, to),
        },
        ServiceError::TaskBlocked { task_id } => DbError::InvalidPath {
            path: std::path::PathBuf::from(&task_id),
            reason: format!("task '{}' is blocked by incomplete dependencies", task_id),
        },
        ServiceError::CyclicDependency => DbError::InvalidPath {
            path: std::path::PathBuf::from("dependency"),
            reason: "cyclic dependency detected".to_string(),
        },
        ServiceError::Database(db_err) => db_err,
    }
}
