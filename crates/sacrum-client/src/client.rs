//! HTTP client for Sacrum API
//!
//! Provides a wrapper around reqwest::Client that handles:
//! - Bearer token authentication
//! - Automatic response deserialization with DataEnvelope unwrapping
//! - Standard HTTP methods (GET, POST, PUT, DELETE)

use crate::api_types::DataEnvelope;
use crate::config::SacrumConfig;
use crate::error::{SacrumClientError, SacrumClientResult};
use reqwest::Client;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tracing::debug;

/// HTTP client for Sacrum API
///
/// Wraps reqwest::Client and manages authentication, base URLs,
/// and automatic response envelope unwrapping.
#[derive(Clone)]
pub struct SacrumClient {
    client: Client,
    base_url: String,
    api_token: String,
    project_id: String,
}

impl SacrumClient {
    /// Create a new SacrumClient from configuration
    pub fn new(config: SacrumConfig) -> Self {
        SacrumClient {
            client: Client::new(),
            base_url: config.base_url,
            api_token: config.api_token,
            project_id: config.project_id,
        }
    }

    /// Get the project ID this client is configured for
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// Perform a GET request and deserialize the response
    ///
    /// # Arguments
    /// * `path` - The API path (relative to base_url, should start with /)
    ///
    /// # Returns
    /// The deserialized response data (unwrapped from DataEnvelope)
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> SacrumClientResult<T> {
        debug!("GET request to: {}{}", self.base_url, path);

        let url = format!("{}{}", self.base_url, path);
        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.api_token)
            .send()
            .await?;

        self.handle_response::<T>(response).await
    }

    /// Perform a POST request and deserialize the response
    ///
    /// # Arguments
    /// * `path` - The API path (relative to base_url, should start with /)
    /// * `body` - The request body to serialize and send
    ///
    /// # Returns
    /// The deserialized response data (unwrapped from DataEnvelope)
    pub async fn post<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> SacrumClientResult<T> {
        debug!("POST request to: {}{}", self.base_url, path);

        let url = format!("{}{}", self.base_url, path);
        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.api_token)
            .json(body)
            .send()
            .await?;

        self.handle_response::<T>(response).await
    }

    /// Perform a PUT request and deserialize the response
    ///
    /// # Arguments
    /// * `path` - The API path (relative to base_url, should start with /)
    /// * `body` - The request body to serialize and send
    ///
    /// # Returns
    /// The deserialized response data (unwrapped from DataEnvelope)
    pub async fn put<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> SacrumClientResult<T> {
        debug!("PUT request to: {}{}", self.base_url, path);

        let url = format!("{}{}", self.base_url, path);
        let response = self
            .client
            .put(&url)
            .bearer_auth(&self.api_token)
            .json(body)
            .send()
            .await?;

        self.handle_response::<T>(response).await
    }

    /// Perform a DELETE request
    ///
    /// # Arguments
    /// * `path` - The API path (relative to base_url, should start with /)
    pub async fn delete(&self, path: &str) -> SacrumClientResult<()> {
        debug!("DELETE request to: {}{}", self.base_url, path);

        let url = format!("{}{}", self.base_url, path);
        let response = self
            .client
            .delete(&url)
            .bearer_auth(&self.api_token)
            .send()
            .await?;

        // For DELETE, we just check the status code
        if response.status().is_success() {
            Ok(())
        } else {
            let status = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            Err(SacrumClientError::ApiError { status, message })
        }
    }

    /// Handle HTTP response, unwrapping DataEnvelope and converting errors
    async fn handle_response<T: DeserializeOwned>(
        &self,
        response: reqwest::Response,
    ) -> SacrumClientResult<T> {
        let status = response.status();

        if status.is_success() {
            let envelope: DataEnvelope<T> = response.json().await?;
            Ok(envelope.into_inner())
        } else {
            let status_code = status.as_u16();
            let message = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            Err(SacrumClientError::ApiError {
                status: status_code,
                message,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sacrum_client_creation() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = SacrumClient::new(config);

        assert_eq!(client.project_id(), "test-project");
    }

    #[tokio::test]
    async fn test_client_bearer_auth() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "secret-token".to_string(),
            "proj-123".to_string(),
        );
        let client = SacrumClient::new(config);

        // Verify the client has the token
        assert_eq!(client.api_token, "secret-token");
    }
}
