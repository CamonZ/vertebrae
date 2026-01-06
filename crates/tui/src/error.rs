//! Error types for the TUI module.

use std::io;
use thiserror::Error;

/// Result type for TUI operations.
pub type TuiResult<T> = Result<T, TuiError>;

/// Error type for TUI operations.
#[derive(Debug, Error)]
pub enum TuiError {
    /// Failed to initialize or restore the terminal.
    #[error("Terminal error: {0}")]
    Terminal(#[from] io::Error),

    /// Database connection or query error.
    #[error("Database error: {0}")]
    Database(#[from] vertebrae_db::DbError),

    /// SurrealDB error (for direct queries).
    #[error("SurrealDB error: {0}")]
    Surreal(Box<surrealdb::Error>),
}

impl From<surrealdb::Error> for TuiError {
    fn from(err: surrealdb::Error) -> Self {
        TuiError::Surreal(Box::new(err))
    }
}
