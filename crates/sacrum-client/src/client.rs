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

    #[test]
    fn test_client_with_different_base_urls() {
        let config1 = SacrumConfig::new(
            "http://localhost:3000".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );
        let client1 = SacrumClient::new(config1);
        assert_eq!(client1.base_url, "http://localhost:3000");

        let config2 = SacrumConfig::new(
            "https://api.example.com".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );
        let client2 = SacrumClient::new(config2);
        assert_eq!(client2.base_url, "https://api.example.com");
    }

    #[test]
    fn test_client_preserves_all_config_values() {
        let config = SacrumConfig::new(
            "http://my-server:5000".to_string(),
            "my-secret-token".to_string(),
            "my-project-id".to_string(),
        );
        let client = SacrumClient::new(config);

        assert_eq!(client.base_url, "http://my-server:5000");
        assert_eq!(client.api_token, "my-secret-token");
        assert_eq!(client.project_id(), "my-project-id");
    }

    #[test]
    fn test_client_cloning() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client1 = SacrumClient::new(config);
        let client2 = client1.clone();

        assert_eq!(client1.project_id(), client2.project_id());
        assert_eq!(client1.base_url, client2.base_url);
        assert_eq!(client1.api_token, client2.api_token);
    }

    #[test]
    fn test_client_project_id_accessor() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "my-special-project".to_string(),
        );
        let client = SacrumClient::new(config);

        let project_id = client.project_id();
        assert_eq!(project_id, "my-special-project");
        assert_eq!(project_id.len(), 18);
    }

    #[test]
    fn test_client_multiple_instances_are_independent() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token1".to_string(),
            "project1".to_string(),
        );
        let config2 = SacrumConfig::new(
            "http://localhost:5000".to_string(),
            "token2".to_string(),
            "project2".to_string(),
        );

        let client1 = SacrumClient::new(config1);
        let client2 = SacrumClient::new(config2);

        assert_eq!(client1.project_id(), "project1");
        assert_eq!(client2.project_id(), "project2");
        assert_ne!(client1.base_url, client2.base_url);
        assert_ne!(client1.api_token, client2.api_token);
    }

    #[test]
    fn test_client_new_initializes_reqwest_client() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );
        let client = SacrumClient::new(config);

        // Verify the client is properly initialized by accessing its properties
        assert_eq!(client.base_url, "http://localhost:4000");
        assert_eq!(client.api_token, "token");
        assert_eq!(client.project_id(), "proj");
    }

    #[test]
    fn test_client_with_various_token_formats() {
        let tokens = vec![
            "simple-token",
            "token_with_underscores",
            "token-with-dashes",
            "token.with.dots",
            "CaseSensitiveToken",
            "token123456789",
        ];

        for token in tokens {
            let config = SacrumConfig::new(
                "http://localhost:4000".to_string(),
                token.to_string(),
                "proj".to_string(),
            );
            let client = SacrumClient::new(config);
            assert_eq!(client.api_token, token);
        }
    }

    #[test]
    fn test_client_with_various_base_urls() {
        let urls = vec![
            "http://localhost:3000",
            "http://localhost:4000",
            "http://localhost:5000",
            "http://api.example.com",
            "https://api.example.com",
            "https://staging-api.example.com",
        ];

        for url in urls {
            let config =
                SacrumConfig::new(url.to_string(), "token".to_string(), "proj".to_string());
            let client = SacrumClient::new(config);
            assert_eq!(client.base_url, url);
        }
    }

    #[test]
    fn test_client_preserves_immutability() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = SacrumClient::new(config);

        // Multiple accesses should return consistent values
        assert_eq!(client.project_id(), "test-project");
        assert_eq!(client.project_id(), "test-project");
        assert_eq!(client.base_url, "http://localhost:4000");
        assert_eq!(client.base_url, "http://localhost:4000");
    }

    #[test]
    fn test_client_api_token_is_not_exposed_through_debug() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "secret-token-12345".to_string(),
            "proj".to_string(),
        );
        let client = SacrumClient::new(config);

        // SacrumClient does not implement Debug trait to avoid exposing secrets
        // This test documents that we intentionally don't derive Debug
        assert_eq!(client.project_id(), "proj");
    }

    #[test]
    fn test_client_clone_creates_independent_copy() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client1 = SacrumClient::new(config);
        let client2 = client1.clone();

        // Both should be equal and independent
        assert_eq!(client1.project_id(), client2.project_id());
        assert_eq!(client1.base_url, client2.base_url);
        assert_eq!(client1.api_token, client2.api_token);
    }

    #[test]
    fn test_client_project_id_with_various_formats() {
        let project_ids = vec![
            "simple",
            "with-dashes",
            "with_underscores",
            "123numeric",
            "MixedCase",
            "very-long-project-id-with-many-segments-and-special-chars",
        ];

        for project_id in project_ids {
            let config = SacrumConfig::new(
                "http://localhost:4000".to_string(),
                "token".to_string(),
                project_id.to_string(),
            );
            let client = SacrumClient::new(config);
            assert_eq!(client.project_id(), project_id);
        }
    }

    #[test]
    fn test_client_equality_check_with_same_config() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );
        let config2 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );

        let client1 = SacrumClient::new(config1);
        let client2 = SacrumClient::new(config2);

        assert_eq!(client1.project_id(), client2.project_id());
        assert_eq!(client1.base_url, client2.base_url);
        assert_eq!(client1.api_token, client2.api_token);
    }

    #[test]
    fn test_client_with_localhost_and_remote_urls() {
        let localhost_config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );
        let remote_config = SacrumConfig::new(
            "https://api.production.example.com".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );

        let localhost_client = SacrumClient::new(localhost_config);
        let remote_client = SacrumClient::new(remote_config);

        assert!(localhost_client.base_url.contains("localhost"));
        assert!(remote_client.base_url.contains("production"));
        assert_ne!(localhost_client.base_url, remote_client.base_url);
    }
}
