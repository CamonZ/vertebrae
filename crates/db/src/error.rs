use std::path::PathBuf;
use thiserror::Error;

/// Information about an incomplete child task blocking completion
#[derive(Debug, Clone)]
pub struct IncompleteChildInfo {
    /// Task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Current status
    pub status: String,
    /// Hierarchy level (epic, ticket, task)
    pub level: String,
}

/// Database error types for Vertebrae
#[derive(Error, Debug)]
pub enum DbError {
    /// Error establishing connection to the database
    #[error("Failed to connect to database at {path}: {source}")]
    Connection {
        path: PathBuf,
        #[source]
        source: Box<surrealdb::Error>,
    },

    /// Error during schema initialization
    #[error("Failed to initialize database schema: {0}")]
    Schema(#[source] Box<surrealdb::Error>),

    /// Error executing a query
    #[error("Query execution failed")]
    Query(#[source] Box<surrealdb::Error>),

    /// Error with database path (invalid or inaccessible)
    #[error("Invalid database path: {path} - {reason}")]
    InvalidPath { path: PathBuf, reason: String },

    /// Error when a requested task was not found
    #[error("Task '{task_id}' not found")]
    NotFound { task_id: String },

    /// Error creating database directory
    #[error("Failed to create database directory at {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Error when trying to complete a task with incomplete children
    #[error("Cannot complete task '{task_id}': has incomplete children")]
    IncompleteChildren {
        task_id: String,
        children: Vec<IncompleteChildInfo>,
    },

    /// Error when attempting an invalid status transition
    #[error("{message}")]
    InvalidStatusTransition {
        task_id: String,
        from_status: String,
        to_status: String,
        message: String,
    },

    /// Error for invalid input or validation failure
    #[error("{message}")]
    ValidationError { message: String },
}

impl From<surrealdb::Error> for DbError {
    fn from(err: surrealdb::Error) -> Self {
        DbError::Query(Box::new(err))
    }
}

impl DbError {
    /// Get the full error message including nested SurrealDB error details.
    ///
    /// This is useful for displaying detailed error information to users.
    pub fn full_message(&self) -> String {
        match self {
            DbError::Query(err) => {
                // Format the error with all its details
                format!("Query execution failed: {}", err)
            }
            other => other.to_string(),
        }
    }
}

/// Result type alias for database operations
pub type DbResult<T> = Result<T, DbError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invalid_path_error_display() {
        let err = DbError::InvalidPath {
            path: PathBuf::from("/invalid/path"),
            reason: "Directory does not exist".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "Invalid database path: /invalid/path - Directory does not exist"
        );
    }

    #[test]
    fn test_create_directory_error_display() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let err = DbError::CreateDirectory {
            path: PathBuf::from("/root/vtb"),
            source: io_err,
        };
        assert_eq!(
            err.to_string(),
            "Failed to create database directory at /root/vtb: access denied"
        );
    }

    #[test]
    fn test_db_error_debug() {
        let err = DbError::InvalidPath {
            path: PathBuf::from("/test/path"),
            reason: "test reason message".to_string(),
        };
        // Test that Debug is implemented and shows field values
        let debug_str = format!("{:?}", err);
        assert!(
            debug_str.contains("InvalidPath")
                && debug_str.contains("/test/path")
                && debug_str.contains("test reason message"),
            "Debug output should contain InvalidPath and its field values"
        );
    }

    #[test]
    fn test_db_result_type_alias() {
        // Test that DbResult works correctly
        let ok_result: DbResult<i32> = Ok(42);
        assert_eq!(ok_result.unwrap(), 42);

        let err_result: DbResult<i32> = Err(DbError::InvalidPath {
            path: PathBuf::from("/test"),
            reason: "test".to_string(),
        });
        assert!(err_result.is_err());
    }

    #[test]
    fn test_incomplete_children_error_display() {
        let err = DbError::IncompleteChildren {
            task_id: "epic123".to_string(),
            children: vec![IncompleteChildInfo {
                id: "task1".to_string(),
                title: "Incomplete Task".to_string(),
                status: "todo".to_string(),
                level: "task".to_string(),
            }],
        };
        assert_eq!(
            err.to_string(),
            "Cannot complete task 'epic123': has incomplete children"
        );
    }

    #[test]
    fn test_incomplete_children_error_debug() {
        let err = DbError::IncompleteChildren {
            task_id: "epic123".to_string(),
            children: vec![
                IncompleteChildInfo {
                    id: "task1".to_string(),
                    title: "Incomplete Task".to_string(),
                    status: "todo".to_string(),
                    level: "task".to_string(),
                },
                IncompleteChildInfo {
                    id: "task2".to_string(),
                    title: "Another Task".to_string(),
                    status: "blocked".to_string(),
                    level: "task".to_string(),
                },
            ],
        };
        let debug_str = format!("{:?}", err);
        assert!(
            debug_str.contains("IncompleteChildren")
                && debug_str.contains("epic123")
                && debug_str.contains("task1")
                && debug_str.contains("task2"),
            "Debug output should contain IncompleteChildren and task IDs"
        );
    }

    #[test]
    fn test_incomplete_child_info_clone() {
        let info = IncompleteChildInfo {
            id: "test1".to_string(),
            title: "Test Task".to_string(),
            status: "todo".to_string(),
            level: "task".to_string(),
        };
        let cloned = info.clone();
        assert_eq!(info.id, cloned.id);
        assert_eq!(info.title, cloned.title);
        assert_eq!(info.status, cloned.status);
        assert_eq!(info.level, cloned.level);
    }

    #[test]
    fn test_incomplete_child_info_debug() {
        let info = IncompleteChildInfo {
            id: "test1".to_string(),
            title: "Test Task".to_string(),
            status: "todo".to_string(),
            level: "task".to_string(),
        };
        let debug_str = format!("{:?}", info);
        assert!(
            debug_str.contains("IncompleteChildInfo")
                && debug_str.contains("test1")
                && debug_str.contains("Test Task")
                && debug_str.contains("todo")
                && debug_str.contains("task"),
            "Debug output should contain all field values"
        );
    }

    #[test]
    fn test_invalid_status_transition_error_display() {
        let err = DbError::InvalidStatusTransition {
            task_id: "task123".to_string(),
            from_status: "todo".to_string(),
            to_status: "done".to_string(),
            message: "Invalid status transition from 'todo' to 'done'. Valid transitions from 'todo' are: in_progress, rejected".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "Invalid status transition from 'todo' to 'done'. Valid transitions from 'todo' are: in_progress, rejected"
        );
    }

    #[test]
    fn test_invalid_status_transition_error_debug() {
        let err = DbError::InvalidStatusTransition {
            task_id: "task123".to_string(),
            from_status: "done".to_string(),
            to_status: "todo".to_string(),
            message: "Cannot transition from 'done': this is a final state".to_string(),
        };
        let debug_str = format!("{:?}", err);
        assert!(
            debug_str.contains("InvalidStatusTransition")
                && debug_str.contains("task123")
                && debug_str.contains("done")
                && debug_str.contains("todo"),
            "Debug output should contain InvalidStatusTransition and relevant fields"
        );
    }

    #[test]
    fn test_not_found_error_display() {
        let err = DbError::NotFound {
            task_id: "abc123".to_string(),
        };
        assert_eq!(err.to_string(), "Task 'abc123' not found");
    }

    #[test]
    fn test_not_found_error_debug() {
        let err = DbError::NotFound {
            task_id: "xyz789".to_string(),
        };
        let debug_str = format!("{:?}", err);
        assert!(
            debug_str.contains("NotFound") && debug_str.contains("xyz789"),
            "Debug output should contain NotFound and task_id"
        );
    }

    #[test]
    fn test_validation_error_display() {
        let err = DbError::ValidationError {
            message: "Search query cannot be empty".to_string(),
        };
        assert_eq!(err.to_string(), "Search query cannot be empty");
    }

    #[test]
    fn test_validation_error_debug() {
        let err = DbError::ValidationError {
            message: "Invalid input value".to_string(),
        };
        let debug_str = format!("{:?}", err);
        assert!(
            debug_str.contains("ValidationError") && debug_str.contains("Invalid input value"),
            "Debug output should contain ValidationError and message"
        );
    }
}
