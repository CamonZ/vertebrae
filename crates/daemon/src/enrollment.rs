use std::time::Duration;

use futures::StreamExt;
use serde::Deserialize;
use url::Url;

const EXCHANGE_PATH: &str = "/api/daemon/exchange";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub struct EnrollmentResult {
    pub daemon_id: String,
    pub reconnect_token: String,
    pub expires_at: String,
}

impl std::fmt::Debug for EnrollmentResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnrollmentResult")
            .field("daemon_id", &self.daemon_id)
            .field("reconnect_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EnrollmentError {
    #[error("invalid endpoint: {0}")]
    InvalidEndpoint(String),
    #[error("invalid daemon ID: {0}")]
    InvalidDaemonId(String),
    #[error("bootstrap token is empty")]
    EmptyToken,
    #[error("bootstrap credential was rejected; request a fresh credential from the GUI")]
    InvalidCredentials,
    #[error("bootstrap exchange request failed: {0}")]
    Transport(String),
    #[error("bootstrap exchange is unavailable; retry when the backend is reachable")]
    Unavailable,
    #[error("bootstrap exchange returned HTTP status {0}")]
    HttpStatus(u16),
    #[error("bootstrap exchange returned an invalid response: {0}")]
    MalformedResponse(String),
}

#[derive(Debug, Deserialize)]
struct ExchangeResponse {
    daemon_id: String,
    reconnect_token: String,
    expires_at: String,
}

pub struct DaemonEnrollmentClient {
    client: reqwest::Client,
}

impl Default for DaemonEnrollmentClient {
    fn default() -> Self {
        Self::new().expect("default enrollment client must have valid settings")
    }
}

impl DaemonEnrollmentClient {
    pub fn new() -> Result<Self, EnrollmentError> {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| EnrollmentError::Transport(error.to_string()))?;
        Ok(Self { client })
    }

    pub async fn exchange(
        &self,
        endpoint: &str,
        daemon_id: &str,
        bootstrap_token: &str,
    ) -> Result<EnrollmentResult, EnrollmentError> {
        let url = exchange_url(endpoint)?;
        validate_daemon_id(daemon_id)?;
        if bootstrap_token.trim().is_empty() {
            return Err(EnrollmentError::EmptyToken);
        }

        let response = self
            .client
            .post(url)
            .json(&serde_json::json!({
                "daemon_id": daemon_id,
                "bootstrap_token": bootstrap_token,
            }))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() || error.is_connect() {
                    EnrollmentError::Unavailable
                } else {
                    EnrollmentError::Transport(error.to_string())
                }
            })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(EnrollmentError::InvalidCredentials);
        }
        if status == reqwest::StatusCode::BAD_REQUEST {
            return Err(EnrollmentError::HttpStatus(status.as_u16()));
        }
        if status == reqwest::StatusCode::SERVICE_UNAVAILABLE || status.is_server_error() {
            return Err(EnrollmentError::Unavailable);
        }
        if !status.is_success() {
            return Err(EnrollmentError::HttpStatus(status.as_u16()));
        }

        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
        {
            return Err(EnrollmentError::MalformedResponse(
                "response exceeded the 16 KiB limit".to_string(),
            ));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| EnrollmentError::Transport(error.to_string()))?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
                return Err(EnrollmentError::MalformedResponse(
                    "response exceeded the 16 KiB limit".to_string(),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let response: ExchangeResponse = serde_json::from_slice(&body)
            .map_err(|error| EnrollmentError::MalformedResponse(error.to_string()))?;
        if response.daemon_id != daemon_id {
            return Err(EnrollmentError::MalformedResponse(
                "response daemon ID did not match the requested identity".to_string(),
            ));
        }
        if response.reconnect_token.is_empty() || response.reconnect_token.len() > 512 {
            return Err(EnrollmentError::MalformedResponse(
                "response reconnect credential was invalid".to_string(),
            ));
        }
        if chrono::DateTime::parse_from_rfc3339(&response.expires_at).is_err() {
            return Err(EnrollmentError::MalformedResponse(
                "response expiry was not RFC 3339".to_string(),
            ));
        }

        Ok(EnrollmentResult {
            daemon_id: response.daemon_id,
            reconnect_token: response.reconnect_token,
            expires_at: response.expires_at,
        })
    }
}

pub fn validate_daemon_id(daemon_id: &str) -> Result<(), EnrollmentError> {
    uuid::Uuid::parse_str(daemon_id)
        .map(|_| ())
        .map_err(|error| EnrollmentError::InvalidDaemonId(error.to_string()))
}

pub fn exchange_url(endpoint: &str) -> Result<Url, EnrollmentError> {
    let mut url = Url::parse(endpoint)
        .map_err(|error| EnrollmentError::InvalidEndpoint(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(EnrollmentError::InvalidEndpoint(
            "scheme must be http or https".to_string(),
        ));
    }
    if !crate::phoenix::endpoint_allows_cleartext(&url) {
        return Err(EnrollmentError::InvalidEndpoint(
            "unencrypted endpoints are permitted only for loopback hosts".to_string(),
        ));
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(EnrollmentError::InvalidEndpoint(
            "endpoint must include a host and no embedded credentials".to_string(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(EnrollmentError::InvalidEndpoint(
            "endpoint must not include a query or fragment".to_string(),
        ));
    }
    let path = url.path().trim_end_matches('/');
    if !path.ends_with(EXCHANGE_PATH) {
        let path = format!("{path}{EXCHANGE_PATH}");
        url.set_path(&path);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAEMON_ID: &str = "33333333-3333-3333-3333-333333333333";

    #[test]
    fn endpoint_validation_preserves_proxy_path_and_rejects_credentials() {
        assert_eq!(
            exchange_url("https://sacrum.example.test/proxy/")
                .unwrap()
                .as_str(),
            "https://sacrum.example.test/proxy/api/daemon/exchange"
        );
        assert!(exchange_url("https://user:secret@sacrum.example.test").is_err());
        assert!(exchange_url("ftp://sacrum.example.test").is_err());
        assert!(exchange_url("http://sacrum.example.test").is_err());
        assert!(exchange_url("http://127.0.0.1:4000").is_ok());
        assert!(exchange_url("https://sacrum.example.test?token=secret").is_err());
    }

    #[test]
    fn daemon_id_validation_requires_uuid() {
        assert!(validate_daemon_id(DAEMON_ID).is_ok());
        assert!(validate_daemon_id("not-a-daemon").is_err());
    }

    #[test]
    fn response_debug_redacts_reconnect_token() {
        let response = EnrollmentResult {
            daemon_id: DAEMON_ID.to_string(),
            reconnect_token: "secret".to_string(),
            expires_at: "2026-09-07T12:00:00Z".to_string(),
        };
        let debug = format!("{response:?}");
        assert!(!debug.contains("secret"));
        assert!(debug.contains("<redacted>"));
    }
}
