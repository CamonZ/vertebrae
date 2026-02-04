//! HTTP client for Sacrum API
//!
//! Provides a wrapper around reqwest::Client that handles:
//! - Bearer token authentication (via default headers)
//! - Automatic response deserialization with DataEnvelope unwrapping
//! - Standard HTTP methods (GET, POST, PUT, DELETE)
//! - Query parameter support on GET requests

use crate::api_types::DataEnvelope;
use crate::config::SacrumConfig;
use crate::error::{SacrumClientError, SacrumClientResult};
use reqwest::Client;
use serde::Serialize;
use serde::de::DeserializeOwned;

/// HTTP client for Sacrum API
///
/// Wraps reqwest::Client and manages authentication, base URLs,
/// and automatic response envelope unwrapping.
///
/// Bearer auth is set once via default headers in the constructor,
/// so individual requests don't need to attach the token.
#[derive(Clone)]
pub struct SacrumClient {
    client: Client,
    base_url: String,
    project_id: String,
}

impl SacrumClient {
    /// Create a new SacrumClient from configuration
    ///
    /// Sets the bearer token as a default header on the underlying reqwest::Client.
    pub fn new(config: SacrumConfig) -> Self {
        use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};

        let mut default_headers = HeaderMap::new();
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", config.api_token)) {
            default_headers.insert(AUTHORIZATION, val);
        }

        let client = Client::builder()
            .default_headers(default_headers)
            .build()
            .expect("Failed to build reqwest client");

        SacrumClient {
            client,
            base_url: config.base_url,
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
    /// * `query` - Query parameters to serialize. Pass `&()` for no params.
    ///
    /// # Returns
    /// The deserialized response data (unwrapped from DataEnvelope)
    pub async fn get<T: DeserializeOwned, Q: Serialize>(
        &self,
        path: &str,
        query: &Q,
    ) -> SacrumClientResult<T> {
        let url = format!("{}{}", self.base_url, path);
        let start = std::time::Instant::now();
        log::info!("[HTTP] GET {}", url);

        let response = self.client.get(&url).query(query).send().await?;
        let send_time = start.elapsed().as_millis();

        let status = response.status();
        let result = self.handle_response::<T>(response).await;
        let total_time = start.elapsed().as_millis();

        log::info!(
            "[HTTP] GET {} -> {} (send: {}ms, parse: {}ms, total: {}ms)",
            url,
            status.as_u16(),
            send_time,
            total_time - send_time,
            total_time
        );
        result
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
        let url = format!("{}{}", self.base_url, path);
        let start = std::time::Instant::now();
        log::info!("[HTTP] POST {}", url);

        let response = self.client.post(&url).json(body).send().await?;
        let status = response.status();
        let result = self.handle_response::<T>(response).await;

        log::info!(
            "[HTTP] POST {} -> {} ({}ms)",
            url,
            status.as_u16(),
            start.elapsed().as_millis()
        );
        result
    }

    /// Perform a POST request that doesn't return data
    ///
    /// # Arguments
    /// * `path` - The API path (relative to base_url, should start with /)
    /// * `body` - The request body to serialize and send
    pub async fn post_void<B: Serialize>(&self, path: &str, body: &B) -> SacrumClientResult<()> {
        let url = format!("{}{}", self.base_url, path);
        let start = std::time::Instant::now();
        log::info!("[HTTP] POST {}", url);

        let response = self.client.post(&url).json(body).send().await?;
        let status = response.status();

        let result = if response.status().is_success() {
            Ok(())
        } else {
            let status_code = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            Err(SacrumClientError::ApiError {
                status: status_code,
                message,
            })
        };

        log::info!(
            "[HTTP] POST {} -> {} ({}ms)",
            url,
            status.as_u16(),
            start.elapsed().as_millis()
        );
        result
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
        let url = format!("{}{}", self.base_url, path);
        let start = std::time::Instant::now();
        log::info!("[HTTP] PUT {}", url);

        let response = self.client.put(&url).json(body).send().await?;
        let status = response.status();
        let result = self.handle_response::<T>(response).await;

        log::info!(
            "[HTTP] PUT {} -> {} ({}ms)",
            url,
            status.as_u16(),
            start.elapsed().as_millis()
        );
        result
    }

    /// Perform a PATCH request that doesn't return data
    ///
    /// # Arguments
    /// * `path` - The API path (relative to base_url, should start with /)
    /// * `body` - The request body to serialize and send
    pub async fn patch<B: Serialize>(&self, path: &str, body: &B) -> SacrumClientResult<()> {
        let url = format!("{}{}", self.base_url, path);
        let start = std::time::Instant::now();
        log::info!("[HTTP] PATCH {}", url);

        let response = self.client.patch(&url).json(body).send().await?;
        let status = response.status();

        let result = if response.status().is_success() {
            Ok(())
        } else {
            let status_code = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            Err(SacrumClientError::ApiError {
                status: status_code,
                message,
            })
        };

        log::info!(
            "[HTTP] PATCH {} -> {} ({}ms)",
            url,
            status.as_u16(),
            start.elapsed().as_millis()
        );
        result
    }

    /// Perform a DELETE request
    ///
    /// # Arguments
    /// * `path` - The API path (relative to base_url, should start with /)
    pub async fn delete(&self, path: &str) -> SacrumClientResult<()> {
        let url = format!("{}{}", self.base_url, path);
        let start = std::time::Instant::now();
        log::info!("[HTTP] DELETE {}", url);

        let response = self.client.delete(&url).send().await?;
        let status = response.status();

        // For DELETE, we just check the status code
        let result = if response.status().is_success() {
            Ok(())
        } else {
            let status_code = response.status().as_u16();
            let message = response.text().await.unwrap_or_default();
            Err(SacrumClientError::ApiError {
                status: status_code,
                message,
            })
        };

        log::info!(
            "[HTTP] DELETE {} -> {} ({}ms)",
            url,
            status.as_u16(),
            start.elapsed().as_millis()
        );
        result
    }

    /// Handle HTTP response, unwrapping DataEnvelope and converting errors
    async fn handle_response<T: DeserializeOwned>(
        &self,
        response: reqwest::Response,
    ) -> SacrumClientResult<T> {
        let status = response.status();

        if status.is_success() {
            let bytes = response.bytes().await?;
            log::debug!("[HTTP] Response body: {} bytes", bytes.len());
            let envelope: DataEnvelope<T> = serde_json::from_slice(&bytes)?;
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
    fn test_client_preserves_config_values() {
        let config = SacrumConfig::new(
            "http://my-server:5000".to_string(),
            "my-secret-token".to_string(),
            "my-project-id".to_string(),
        );
        let client = SacrumClient::new(config);

        assert_eq!(client.base_url, "http://my-server:5000");
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

        assert_eq!(client.project_id(), "test-project");
        assert_eq!(client.project_id(), "test-project");
        assert_eq!(client.base_url, "http://localhost:4000");
        assert_eq!(client.base_url, "http://localhost:4000");
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

        assert_eq!(client1.project_id(), client2.project_id());
        assert_eq!(client1.base_url, client2.base_url);
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
