//! Error types for Sacrum client
//!
//! Defines error types for HTTP communication with the Sacrum API
//! and provides conversion to ServiceError for service layer integration.

use serde::Deserialize;
use thiserror::Error;
use vertebrae_core::error::ServiceError;

/// Sacrum client result type
pub type SacrumClientResult<T> = Result<T, SacrumClientError>;

/// One structured error item from a GraphQL `errors` array.
///
/// `extensions` is kept verbatim so callers can classify errors by
/// structured fields instead of parsing formatted message strings.
#[derive(Debug, Clone, Deserialize)]
pub struct GraphqlErrorItem {
    pub message: String,
    pub path: Option<Vec<String>>,
    pub extensions: Option<serde_json::Value>,
}

/// Errors that can occur when communicating with the Sacrum API
#[derive(Debug, Error)]
pub enum SacrumClientError {
    /// HTTP request failed
    #[error("HTTP request failed: {0}")]
    HttpError(#[from] reqwest::Error),

    /// API returned an error response
    #[error("API error ({status}): {message}")]
    ApiError { status: u16, message: String },

    /// GraphQL error response
    #[error("GraphQL error: {message}")]
    GraphqlError {
        items: Vec<GraphqlErrorItem>,
        messages: Vec<String>,
        message: String,
    },

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Serialization/deserialization error
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),
}

impl From<SacrumClientError> for ServiceError {
    fn from(err: SacrumClientError) -> Self {
        match &err {
            SacrumClientError::ApiError { status: 404, .. } => ServiceError::TaskNotFound {
                task_id: err.to_string(),
            },
            SacrumClientError::GraphqlError { messages, .. } => {
                let msg = messages.join("; ");
                if msg.contains("not_found") || msg.contains("Not Found") {
                    ServiceError::TaskNotFound { task_id: msg }
                } else {
                    ServiceError::InvalidInput(msg)
                }
            }
            _ => ServiceError::InvalidInput(err.to_string()),
        }
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
        assert!(matches!(service_error, ServiceError::InvalidInput(_)));
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
        assert!(matches!(service_error, ServiceError::InvalidInput(_)));
    }

    #[test]
    fn test_graphql_error_creation_and_display() {
        let error = SacrumClientError::GraphqlError {
            items: Vec::new(),
            messages: vec!["field is required".to_string()],
            message: "field is required".to_string(),
        };
        let msg = error.to_string();
        assert!(msg.contains("GraphQL error"));
        assert!(msg.contains("field is required"));
    }

    #[test]
    fn test_graphql_error_retains_structured_items() {
        let error = SacrumClientError::GraphqlError {
            items: vec![GraphqlErrorItem {
                message: "has already been taken".to_string(),
                path: Some(vec!["createDaemon".to_string()]),
                extensions: Some(serde_json::json!({ "field": "name" })),
            }],
            messages: vec!["has already been taken".to_string()],
            message: "has already been taken".to_string(),
        };
        let SacrumClientError::GraphqlError { items, .. } = &error else {
            panic!("expected GraphqlError");
        };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].message, "has already been taken");
        assert_eq!(items[0].path, Some(vec!["createDaemon".to_string()]));
        assert_eq!(
            items[0].extensions,
            Some(serde_json::json!({ "field": "name" }))
        );
    }

    #[test]
    fn test_graphql_error_not_found_converts_to_task_not_found() {
        let error = SacrumClientError::GraphqlError {
            items: Vec::new(),
            messages: vec!["not_found".to_string()],
            message: "not_found".to_string(),
        };
        let service_error: ServiceError = error.into();
        assert!(matches!(service_error, ServiceError::TaskNotFound { .. }));
    }

    #[test]
    fn test_graphql_error_not_found_variant_converts_to_task_not_found() {
        let error = SacrumClientError::GraphqlError {
            items: Vec::new(),
            messages: vec!["Not Found".to_string()],
            message: "Not Found".to_string(),
        };
        let service_error: ServiceError = error.into();
        assert!(matches!(service_error, ServiceError::TaskNotFound { .. }));
    }

    #[test]
    fn test_graphql_error_other_converts_to_invalid_input() {
        let error = SacrumClientError::GraphqlError {
            items: Vec::new(),
            messages: vec!["validation failed".to_string()],
            message: "validation failed".to_string(),
        };
        let service_error: ServiceError = error.into();
        assert!(matches!(service_error, ServiceError::InvalidInput(_)));
        assert!(service_error.to_string().contains("validation failed"));
    }

    #[test]
    fn test_api_error_404_converts_to_task_not_found() {
        let error = SacrumClientError::ApiError {
            status: 404,
            message: "Resource not found".to_string(),
        };
        let service_error: ServiceError = error.into();
        assert!(matches!(service_error, ServiceError::TaskNotFound { .. }));
    }
}
