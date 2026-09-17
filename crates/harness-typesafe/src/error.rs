use std::time::Duration;

use reqwest::StatusCode;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TypeSafeError {
    #[error("TypeSafe API key is missing")]
    MissingApiKey,
    #[error("invalid TypeSafe client configuration: {0}")]
    InvalidConfiguration(String),
    #[error("invalid TypeSafe request: {0}")]
    InvalidRequest(String),
    #[error("TypeSafe request timed out after {timeout:?}")]
    Timeout { timeout: Duration },
    #[error("TypeSafe transport request failed")]
    Transport(#[source] reqwest::Error),
    #[error("TypeSafe response body exceeded the configured limit")]
    ResponseTooLarge,
    #[error("TypeSafe response was malformed: {0}")]
    MalformedResponse(String),
    #[error("TypeSafe API returned HTTP {status}: {message}")]
    ApiError {
        status: u16,
        message: String,
        request_id: String,
    },
    #[error("failed to serialize TypeSafe request")]
    RequestSerialization(#[source] serde_json::Error),
}

impl TypeSafeError {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::ApiError { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::ApiError { request_id, .. } if !request_id.is_empty() => Some(request_id),
            _ => None,
        }
    }
}

pub(crate) fn status_message(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 | 422 => "request validation failed",
        401 => "authentication failed",
        403 => "access denied",
        404 => "resource not found",
        408 => "request timed out at the service",
        429 => "rate limit exceeded",
        529 => "service overloaded",
        code if (500..=599).contains(&code) => "service error",
        _ => "unexpected HTTP response",
    }
}

pub(crate) fn redacted_decode_error(error: &serde_json::Error) -> String {
    error.to_string().replace('\n', " ")
}
