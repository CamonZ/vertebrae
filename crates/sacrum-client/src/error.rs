//! Error types for Sacrum client
//!
//! Defines error types for HTTP communication with the Sacrum API
//! and provides conversion to ServiceError for service layer integration.

use serde::Deserialize;
use thiserror::Error;
use vertebrae_core::error::{HumanInputRejection, ServiceError};

/// Sacrum client result type
pub type SacrumClientResult<T> = Result<T, SacrumClientError>;

/// One structured error item from a GraphQL `errors` array.
///
/// `code` and `extensions` are kept verbatim so callers can classify errors
/// by structured fields instead of parsing formatted message strings.
#[derive(Debug, Clone, Deserialize)]
pub struct GraphqlErrorItem {
    pub message: String,
    pub path: Option<Vec<String>>,
    /// Machine-readable error code Sacrum sets beside `message`.
    #[serde(default)]
    pub code: Option<String>,
    pub extensions: Option<serde_json::Value>,
}

/// Prefix Sacrum puts before each `invalid_human_input` violation.
const SCHEMA_VIOLATION_PREFIX: &str = "artifact does not satisfy the output_schema: ";

/// Classify the gate errors Sacrum returns when an artifact attached to a
/// waiting `human_input` execution is rejected.
fn human_input_rejection(items: &[GraphqlErrorItem]) -> Option<HumanInputRejection> {
    let with_code = |code: &'static str| {
        items
            .iter()
            .filter(move |item| item.code.as_deref() == Some(code))
    };
    if let Some(item) = with_code("human_input_execution_not_waiting").next() {
        return Some(HumanInputRejection::NotWaiting {
            message: item.message.clone(),
        });
    }
    if let Some(item) = with_code("invalid_human_input_json").next() {
        let message = item.message.as_str();
        return Some(HumanInputRejection::InvalidJson {
            message: message
                .strip_prefix("artifact body is not valid JSON: ")
                .unwrap_or(message)
                .to_string(),
        });
    }
    let violations: Vec<String> = with_code("invalid_human_input")
        .map(|item| {
            let message = item.message.as_str();
            message
                .strip_prefix(SCHEMA_VIOLATION_PREFIX)
                .unwrap_or(message)
                .to_string()
        })
        .collect();
    (!violations.is_empty()).then_some(HumanInputRejection::SchemaViolations { violations })
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
        match err {
            SacrumClientError::ApiError {
                status: 404,
                message,
            } => ServiceError::TaskNotFound {
                task_id: format!("API error (404): {message}"),
            },
            SacrumClientError::GraphqlError { items, .. }
                if let Some(rejection) = human_input_rejection(&items) =>
            {
                ServiceError::HumanInputRejected(rejection)
            }
            SacrumClientError::GraphqlError { messages, .. } => {
                let msg = messages.join("; ");
                if msg.contains("not_found") || msg.contains("Not Found") {
                    ServiceError::TaskNotFound { task_id: msg }
                } else {
                    ServiceError::InvalidInput(msg)
                }
            }
            SacrumClientError::HttpError(error) => ServiceError::network_error(error.to_string()),
            SacrumClientError::ApiError { status, message } => {
                ServiceError::api_error(status, message)
            }
            SacrumClientError::ConfigError(message) => ServiceError::config_error(message),
            SacrumClientError::SerializationError(error) => {
                ServiceError::invalid_input(error.to_string())
            }
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
        assert!(matches!(service_error, ServiceError::ConfigError(_)));
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
        assert!(matches!(
            service_error,
            ServiceError::ApiError { status: 429, .. }
        ));
    }

    #[test]
    fn test_http_error_conversion_to_network_error() {
        let request_error = reqwest::Client::new()
            .get("not a URL")
            .build()
            .expect_err("invalid URL should fail before any request");
        let service_error: ServiceError = SacrumClientError::HttpError(request_error).into();
        assert!(matches!(service_error, ServiceError::NetworkError(_)));
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
                code: None,
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

    fn gate_error(items: &[(&str, &str)]) -> SacrumClientError {
        let items: Vec<GraphqlErrorItem> = items
            .iter()
            .map(|(code, message)| {
                serde_json::from_value(serde_json::json!({"message": message, "code": code}))
                    .unwrap()
            })
            .collect();
        let messages = items.iter().map(|item| item.message.clone()).collect();
        SacrumClientError::GraphqlError {
            items,
            messages,
            message: String::new(),
        }
    }

    #[test]
    fn test_human_input_gate_codes_convert_to_distinct_rejections() {
        let error: ServiceError = gate_error(&[
            (
                "invalid_human_input",
                "artifact does not satisfy the output_schema: #/approved: Type mismatch.",
            ),
            (
                "invalid_human_input",
                "artifact does not satisfy the output_schema: #: Required property reason was not present.",
            ),
        ])
        .into();
        let ServiceError::HumanInputRejected(HumanInputRejection::SchemaViolations { violations }) =
            &error
        else {
            panic!("expected schema violations, got {error:?}");
        };
        assert_eq!(
            violations,
            &[
                "#/approved: Type mismatch.",
                "#: Required property reason was not present."
            ]
        );

        let error: ServiceError = gate_error(&[(
            "invalid_human_input_json",
            "artifact body is not valid JSON: unexpected byte at position 0: 0x79 (\"y\")",
        )])
        .into();
        assert!(matches!(
            &error,
            ServiceError::HumanInputRejected(HumanInputRejection::InvalidJson { message })
                if message == "unexpected byte at position 0: 0x79 (\"y\")"
        ));

        let error: ServiceError = gate_error(&[(
            "human_input_execution_not_waiting",
            "step execution is not waiting for human input",
        )])
        .into();
        assert!(matches!(
            &error,
            ServiceError::HumanInputRejected(HumanInputRejection::NotWaiting { message })
                if message == "step execution is not waiting for human input"
        ));

        let error: ServiceError = gate_error(&[("other_code", "something else")]).into();
        assert!(matches!(error, ServiceError::InvalidInput(_)));
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
