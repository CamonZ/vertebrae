use std::path::PathBuf;
use thiserror::Error;

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
    #[error("Query execution failed: {0}")]
    Query(#[source] Box<surrealdb::Error>),

    /// Error with database path (invalid or inaccessible)
    #[error("Invalid database path: {path} - {reason}")]
    InvalidPath { path: PathBuf, reason: String },

    /// Error creating database directory
    #[error("Failed to create database directory at {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl From<surrealdb::Error> for DbError {
    fn from(err: surrealdb::Error) -> Self {
        DbError::Query(Box::new(err))
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
        assert!(err.to_string().contains("/invalid/path"));
        assert!(err.to_string().contains("Directory does not exist"));
    }

    #[test]
    fn test_create_directory_error_display() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "access denied");
        let err = DbError::CreateDirectory {
            path: PathBuf::from("/root/vtb"),
            source: io_err,
        };
        assert!(err.to_string().contains("/root/vtb"));
    }

    #[test]
    fn test_db_error_debug() {
        let err = DbError::InvalidPath {
            path: PathBuf::from("/test"),
            reason: "test reason".to_string(),
        };
        // Test that Debug is implemented
        let debug_str = format!("{:?}", err);
        assert!(debug_str.contains("InvalidPath"));
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
}
