//! Error types for Sacrum client
//!
//! Defines error types for HTTP communication with the Sacrum API
//! and provides conversion to ServiceError for service layer integration.

use thiserror::Error;
use vertebrae_core::error::ServiceError;

/// Sacrum client result type
pub type SacrumClientResult<T> = Result<T, SacrumClientError>;

/// Errors that can occur when communicating with the Sacrum API
#[derive(Debug, Error)]
pub enum SacrumClientError {
    /// HTTP request failed
    #[error("HTTP request failed: {0}")]
    HttpError(#[from] reqwest::Error),

    /// API returned an error response
    #[error("API error ({status}): {message}")]
    ApiError { status: u16, message: String },

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Serialization/deserialization error
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),
}

impl From<SacrumClientError> for ServiceError {
    fn from(err: SacrumClientError) -> Self {
        ServiceError::InvalidInput(err.to_string())
    }
}
