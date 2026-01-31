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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_api_error_creation() {
        let error = SacrumClientError::ApiError {
            status: 404,
            message: "Not found".to_string(),
        };

        let error_msg = error.to_string();
        assert!(error_msg.contains("404"));
        assert!(error_msg.contains("Not found"));
    }

    #[test]
    fn test_config_error_creation() {
        let error = SacrumClientError::ConfigError("Missing config".to_string());
        assert!(error.to_string().contains("Missing config"));
    }

    #[test]
    fn test_config_error_message() {
        let error = SacrumClientError::ConfigError("Database path not found".to_string());
        assert!(error.to_string().contains("Configuration error"));
    }

    #[test]
    fn test_serialization_error_display() {
        let json_error = serde_json::json!({"key": "value"});
        let error_str = format!("{}", json_error);
        assert!(error_str.contains("key"));
    }

    #[test]
    fn test_api_error_500() {
        let error = SacrumClientError::ApiError {
            status: 500,
            message: "Internal server error".to_string(),
        };

        let msg = error.to_string();
        assert!(msg.contains("500"));
        assert!(msg.contains("Internal server error"));
    }

    #[test]
    fn test_api_error_401() {
        let error = SacrumClientError::ApiError {
            status: 401,
            message: "Unauthorized".to_string(),
        };

        let msg = error.to_string();
        assert!(msg.contains("401"));
        assert!(msg.contains("Unauthorized"));
    }

    #[test]
    fn test_service_error_conversion() {
        let sacrum_error = SacrumClientError::ConfigError("Test error".to_string());
        let service_error: ServiceError = sacrum_error.into();
        let error_msg = service_error.to_string();
        assert!(error_msg.contains("Test error"));
    }

    #[test]
    fn test_api_error_conversion_to_service_error() {
        let sacrum_error = SacrumClientError::ApiError {
            status: 429,
            message: "Rate limited".to_string(),
        };
        let service_error: ServiceError = sacrum_error.into();
        let error_msg = service_error.to_string();
        assert!(error_msg.contains("Rate limited"));
    }
}
