//! GraphQL client for Sacrum API
//!
//! Provides a wrapper around reqwest::Client that handles:
//! - Bearer token authentication (via default headers)
//! - GraphQL query execution with variable support
//! - Automatic response parsing and error extraction
//! - Fragment concatenation for reusable query parts

use crate::config::SacrumConfig;
use crate::error::{SacrumClientError, SacrumClientResult};
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// GraphQL response envelope
#[derive(Debug, Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphqlErrorItem>>,
}

/// Individual GraphQL error
#[derive(Debug, Deserialize)]
struct GraphqlErrorItem {
    message: String,
    #[allow(dead_code)]
    path: Option<Vec<String>>,
    #[allow(dead_code)]
    extensions: Option<Value>,
}

/// GraphQL request body
#[derive(Serialize)]
struct GraphqlRequest<'a> {
    query: &'a str,
    variables: Value,
}

/// GraphQL client for Sacrum API
///
/// Wraps reqwest::Client and manages authentication and the
/// GraphQL endpoint URL. Bearer auth is set once via default
/// headers in the constructor.
#[derive(Clone)]
pub struct GraphqlClient {
    client: Client,
    endpoint: String,
    pub(crate) project_id: String,
}

impl GraphqlClient {
    /// Create a new GraphqlClient from configuration
    ///
    /// Sets the bearer token and content-type as default headers on
    /// the underlying reqwest::Client. Builds the endpoint as
    /// `{base_url}/graphql`.
    pub fn new(config: SacrumConfig) -> Self {
        use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};

        let mut default_headers = HeaderMap::new();
        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", config.api_token)) {
            default_headers.insert(AUTHORIZATION, val);
        }
        default_headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let client = Client::builder()
            .default_headers(default_headers)
            .build()
            .expect("Failed to build reqwest client");

        let endpoint = format!("{}/graphql", config.base_url);

        GraphqlClient {
            client,
            endpoint,
            project_id: config.project_id,
        }
    }

    /// Get the project ID this client is configured for
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// Execute a GraphQL query and extract a typed field from the response data
    ///
    /// # Arguments
    /// * `query` - The GraphQL query string
    /// * `variables` - Query variables as a serde_json::Value
    /// * `field` - The top-level field name to extract from the `data` object
    ///
    /// # Returns
    /// The deserialized value of `data.{field}`
    pub async fn execute<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
        field: &str,
    ) -> SacrumClientResult<T> {
        let request_body = GraphqlRequest { query, variables };
        let op = extract_operation_name(query);

        let start = std::time::Instant::now();
        log::info!("[GQL] {} (field: {})", op, field);

        let response = self
            .client
            .post(&self.endpoint)
            .json(&request_body)
            .send()
            .await?;
        let status = response.status();

        if !status.is_success() {
            let status_code = status.as_u16();
            let message = response.text().await.unwrap_or_default();
            log::info!(
                "[GQL] {} -> {} ({}ms)",
                op,
                status_code,
                start.elapsed().as_millis()
            );
            return Err(SacrumClientError::ApiError {
                status: status_code,
                message,
            });
        }

        let bytes = response.bytes().await?;
        let gql_response: GraphqlResponse<Value> = serde_json::from_slice(&bytes)?;

        log::info!(
            "[GQL] {} -> {} ({}ms)",
            op,
            status.as_u16(),
            start.elapsed().as_millis()
        );

        // Check for GraphQL-level errors
        if let Some(errors) = gql_response.errors
            && !errors.is_empty()
        {
            let messages: Vec<String> = errors.into_iter().map(|e| e.message).collect();
            let message = messages.join("; ");
            return Err(SacrumClientError::GraphqlError { messages, message });
        }

        // Extract the requested field from data
        let data = gql_response
            .data
            .ok_or_else(|| SacrumClientError::GraphqlError {
                messages: vec!["No data in response".to_string()],
                message: "No data in response".to_string(),
            })?;

        let field_value = data
            .get(field)
            .ok_or_else(|| {
                let msg = format!("Field '{}' not found in response", field);
                SacrumClientError::GraphqlError {
                    messages: vec![msg.clone()],
                    message: msg,
                }
            })?
            .clone();

        let result: T = serde_json::from_value(field_value)?;
        Ok(result)
    }

    /// Execute a GraphQL mutation that doesn't need to return data
    ///
    /// Checks for HTTP errors and GraphQL-level errors but doesn't
    /// extract any field from the response data.
    ///
    /// # Arguments
    /// * `query` - The GraphQL query/mutation string
    /// * `variables` - Query variables as a serde_json::Value
    pub async fn execute_void(&self, query: &str, variables: Value) -> SacrumClientResult<()> {
        let request_body = GraphqlRequest { query, variables };
        let op = extract_operation_name(query);

        let start = std::time::Instant::now();
        log::info!("[GQL] {} (void)", op);

        let response = self
            .client
            .post(&self.endpoint)
            .json(&request_body)
            .send()
            .await?;
        let status = response.status();

        if !status.is_success() {
            let status_code = status.as_u16();
            let message = response.text().await.unwrap_or_default();
            log::info!(
                "[GQL] {} -> {} ({}ms)",
                op,
                status_code,
                start.elapsed().as_millis()
            );
            return Err(SacrumClientError::ApiError {
                status: status_code,
                message,
            });
        }

        let bytes = response.bytes().await?;
        let gql_response: GraphqlResponse<Value> = serde_json::from_slice(&bytes)?;

        log::info!(
            "[GQL] {} -> {} ({}ms)",
            op,
            status.as_u16(),
            start.elapsed().as_millis()
        );

        // Check for GraphQL-level errors
        if let Some(errors) = gql_response.errors
            && !errors.is_empty()
        {
            let messages: Vec<String> = errors.into_iter().map(|e| e.message).collect();
            let message = messages.join("; ");
            return Err(SacrumClientError::GraphqlError { messages, message });
        }

        Ok(())
    }
}

/// Concatenate GraphQL fragments before a query string
///
/// Joins all fragment definitions with the main query, separated by newlines.
/// This allows reusing common fragment definitions across multiple queries.
///
/// # Arguments
/// * `query` - The main GraphQL query/mutation string
/// * `fragments` - Slice of fragment definition strings to prepend
///
/// # Returns
/// A single string with all fragments followed by the query
pub fn with_fragments(query: &str, fragments: &[&str]) -> String {
    let mut parts: Vec<&str> = fragments.to_vec();
    parts.push(query);
    parts.join("\n")
}

/// Extract the operation name from a GraphQL query string.
///
/// Looks for patterns like `query GetTask(...)` or `mutation UpdateTask(...)`.
/// Returns a formatted string like `"query GetTask"` or `"mutation UpdateTask"`.
/// Falls back to `"unknown operation"` if no operation name is found.
fn extract_operation_name(query: &str) -> String {
    for token in ["query", "mutation", "subscription"] {
        if let Some(pos) = query.find(token) {
            let after = &query[pos + token.len()..];
            let name: String = after
                .trim_start()
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                return format!("{} {}", token, name);
            }
        }
    }
    "unknown operation".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_graphql_client_creation() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = GraphqlClient::new(config);

        assert_eq!(client.project_id(), "test-project");
    }

    #[test]
    fn test_client_endpoint_construction() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );
        let client = GraphqlClient::new(config);
        assert_eq!(client.endpoint, "http://localhost:4000/graphql");

        let config2 = SacrumConfig::new(
            "https://api.example.com".to_string(),
            "token".to_string(),
            "proj".to_string(),
        );
        let client2 = GraphqlClient::new(config2);
        assert_eq!(client2.endpoint, "https://api.example.com/graphql");
    }

    #[test]
    fn test_client_project_id_accessor() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "my-special-project".to_string(),
        );
        let client = GraphqlClient::new(config);

        let project_id = client.project_id();
        assert_eq!(project_id, "my-special-project");
        assert_eq!(project_id.len(), 18);
    }

    #[test]
    fn test_client_cloning() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client1 = GraphqlClient::new(config);
        let client2 = client1.clone();

        assert_eq!(client1.project_id(), client2.project_id());
        assert_eq!(client1.endpoint, client2.endpoint);
    }

    #[test]
    fn test_client_preserves_config_values() {
        let config = SacrumConfig::new(
            "http://my-server:5000".to_string(),
            "my-secret-token".to_string(),
            "my-project-id".to_string(),
        );
        let client = GraphqlClient::new(config);

        assert_eq!(client.endpoint, "http://my-server:5000/graphql");
        assert_eq!(client.project_id(), "my-project-id");
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

        let client1 = GraphqlClient::new(config1);
        let client2 = GraphqlClient::new(config2);

        assert_eq!(client1.project_id(), "project1");
        assert_eq!(client2.project_id(), "project2");
        assert_ne!(client1.endpoint, client2.endpoint);
    }

    #[test]
    fn test_client_with_various_base_urls() {
        let urls = vec![
            ("http://localhost:3000", "http://localhost:3000/graphql"),
            ("http://localhost:4000", "http://localhost:4000/graphql"),
            ("http://localhost:5000", "http://localhost:5000/graphql"),
            ("http://api.example.com", "http://api.example.com/graphql"),
            ("https://api.example.com", "https://api.example.com/graphql"),
            (
                "https://staging-api.example.com",
                "https://staging-api.example.com/graphql",
            ),
        ];

        for (base_url, expected_endpoint) in urls {
            let config = SacrumConfig::new(
                base_url.to_string(),
                "token".to_string(),
                "proj".to_string(),
            );
            let client = GraphqlClient::new(config);
            assert_eq!(client.endpoint, expected_endpoint);
        }
    }

    #[test]
    fn test_client_preserves_immutability() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = GraphqlClient::new(config);

        assert_eq!(client.project_id(), "test-project");
        assert_eq!(client.project_id(), "test-project");
        assert_eq!(client.endpoint, "http://localhost:4000/graphql");
        assert_eq!(client.endpoint, "http://localhost:4000/graphql");
    }

    #[test]
    fn test_client_clone_creates_independent_copy() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client1 = GraphqlClient::new(config);
        let client2 = client1.clone();

        assert_eq!(client1.project_id(), client2.project_id());
        assert_eq!(client1.endpoint, client2.endpoint);
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
            let client = GraphqlClient::new(config);
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

        let client1 = GraphqlClient::new(config1);
        let client2 = GraphqlClient::new(config2);

        assert_eq!(client1.project_id(), client2.project_id());
        assert_eq!(client1.endpoint, client2.endpoint);
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

        let localhost_client = GraphqlClient::new(localhost_config);
        let remote_client = GraphqlClient::new(remote_config);

        assert!(localhost_client.endpoint.contains("localhost"));
        assert!(remote_client.endpoint.contains("production"));
        assert_ne!(localhost_client.endpoint, remote_client.endpoint);
    }

    #[test]
    fn test_with_fragments_single() {
        let fragment = "fragment TaskFields on Task { id name }";
        let query = "query { tasks { ...TaskFields } }";
        let result = with_fragments(query, &[fragment]);
        assert!(result.contains(fragment));
        assert!(result.contains(query));
    }

    #[test]
    fn test_with_fragments_multiple() {
        let frag1 = "fragment A on Task { id }";
        let frag2 = "fragment B on Task { name }";
        let query = "query { tasks { ...A ...B } }";
        let result = with_fragments(query, &[frag1, frag2]);
        assert!(result.contains(frag1));
        assert!(result.contains(frag2));
        assert!(result.contains(query));
    }

    #[test]
    fn test_with_fragments_empty() {
        let query = "query { tasks { id } }";
        let result = with_fragments(query, &[]);
        assert_eq!(result, query);
    }

    #[test]
    fn test_project_id_pub_crate_access() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "direct-access-project".to_string(),
        );
        let client = GraphqlClient::new(config);

        // Verify direct field access works (pub(crate) visibility)
        assert_eq!(client.project_id, "direct-access-project");
    }

    #[test]
    fn test_extract_operation_name_query() {
        let query = r#"query GetTask($id: Uuid4!) { task(id: $id) { id title } }"#;
        assert_eq!(extract_operation_name(query), "query GetTask");
    }

    #[test]
    fn test_extract_operation_name_mutation() {
        let query = r#"mutation UpdateTask($id: Uuid4!, $title: String) { update_task(id: $id, title: $title) { id } }"#;
        assert_eq!(extract_operation_name(query), "mutation UpdateTask");
    }

    #[test]
    fn test_extract_operation_name_with_leading_whitespace() {
        let query = r#"
            mutation CreateTask($title: String!) { create_task(title: $title) { id } }
        "#;
        assert_eq!(extract_operation_name(query), "mutation CreateTask");
    }

    #[test]
    fn test_extract_operation_name_unknown() {
        let query = "{ tasks { id } }";
        assert_eq!(extract_operation_name(query), "unknown operation");
    }
}
