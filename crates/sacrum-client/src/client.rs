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
    path: Option<Vec<String>>,
    extensions: Option<Value>,
}

fn format_graphql_error(error: &GraphqlErrorItem) -> String {
    let mut message = error.message.clone();

    if let Some(path) = error.path.as_ref().filter(|path| !path.is_empty()) {
        message.push_str(&format!(" (path: {})", path.join(".")));
    }

    if let Some(extensions) = &error.extensions {
        message.push_str(&format!(" (extensions: {})", extensions));
    }

    message
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
    connection_identity: String,
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
        let connection_identity = connection_identity(&config.base_url, &config.api_token);

        GraphqlClient {
            client,
            endpoint,
            project_id: config.project_id,
            connection_identity,
        }
    }

    /// Get the project ID this client is configured for
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// Stable, non-reversible identity of this client's backend URL and
    /// account token.
    ///
    /// Account-scoped caches (such as the daemon fleet) are keyed by this
    /// identity instead of the selected project, so switching projects on one
    /// backend reuses the same scope while switching backend or account can
    /// never read the previous account's data. The digest never exposes the
    /// token itself.
    pub fn connection_identity(&self) -> &str {
        &self.connection_identity
    }

    async fn send_request<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
        context: &str,
    ) -> SacrumClientResult<GraphqlResponse<T>> {
        let request_body = GraphqlRequest { query, variables };
        let op = extract_operation_name(query);

        let start = std::time::Instant::now();
        log::info!("[GQL] {} {}", op, context);

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
        let gql_response: GraphqlResponse<T> = serde_json::from_slice(&bytes)?;

        log::info!(
            "[GQL] {} -> {} ({}ms)",
            op,
            status.as_u16(),
            start.elapsed().as_millis()
        );

        if let Some(errors) = gql_response.errors.as_ref()
            && !errors.is_empty()
        {
            let messages: Vec<String> = errors.iter().map(format_graphql_error).collect();
            let message = messages.join("; ");
            return Err(SacrumClientError::GraphqlError { messages, message });
        }

        Ok(gql_response)
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
        let gql_response: GraphqlResponse<Value> = self
            .send_request(query, variables, &format!("(field: {field})"))
            .await?;

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

    /// Execute a GraphQL query and deserialize the full response data object.
    ///
    /// Use this for compound queries with multiple top-level roots, where no
    /// single `data.{field}` should be extracted.
    pub async fn execute_compound<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
    ) -> SacrumClientResult<T> {
        let gql_response: GraphqlResponse<T> =
            self.send_request(query, variables, "(compound)").await?;

        gql_response
            .data
            .ok_or_else(|| SacrumClientError::GraphqlError {
                messages: vec!["No data in response".to_string()],
                message: "No data in response".to_string(),
            })
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
        self.send_request::<Value>(query, variables, "(void)")
            .await?;
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

/// Derive a stable, non-reversible identity for a backend URL and account
/// token.
///
/// The identity is the first 8 bytes of `SHA-256(url || 0x00 || token)` in
/// lowercase hex. It exists to scope account-owned client caches: identical
/// backend and account produce the same identity, while any change to either
/// produces an unrelated one. It is a cache key, not a security boundary, but
/// the truncation and hashing keep the token unrecoverable from it.
fn connection_identity(base_url: &str, api_token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(base_url.as_bytes());
    hasher.update([0u8]);
    hasher.update(api_token.as_bytes());
    let digest = hasher.finalize();
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
    fn test_graphql_error_keeps_path_and_extensions_diagnostics() {
        let error = GraphqlErrorItem {
            message: "route_config is invalid".to_string(),
            path: Some(vec![
                "updateWorkflowStep".to_string(),
                "routeConfig".to_string(),
            ]),
            extensions: Some(serde_json::json!({
                "rule": "reference must exist",
                "field_path": "$.rules[0].transition.step_id"
            })),
        };

        let formatted = format_graphql_error(&error);
        assert!(formatted.contains("route_config is invalid"));
        assert!(formatted.contains("path: updateWorkflowStep.routeConfig"));
        assert!(formatted.contains("reference must exist"));
        assert!(formatted.contains("$.rules[0].transition.step_id"));
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

    #[test]
    fn test_connection_identity_is_stable_for_same_backend_and_account() {
        let config1 = SacrumConfig::new(
            "https://vertebrae.dev".to_string(),
            "same-account-token".to_string(),
            "project-a".to_string(),
        );
        // A different project on the same backend/account keeps the identity.
        let config2 = SacrumConfig::new(
            "https://vertebrae.dev".to_string(),
            "same-account-token".to_string(),
            "project-b".to_string(),
        );
        assert_eq!(
            GraphqlClient::new(config1).connection_identity(),
            GraphqlClient::new(config2).connection_identity()
        );
    }

    #[test]
    fn test_connection_identity_separates_accounts_and_backends() {
        let base = SacrumConfig::new(
            "https://vertebrae.dev".to_string(),
            "account-one-token".to_string(),
            "project".to_string(),
        );
        let other_account = SacrumConfig::new(
            "https://vertebrae.dev".to_string(),
            "account-two-token".to_string(),
            "project".to_string(),
        );
        let other_backend = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "account-one-token".to_string(),
            "project".to_string(),
        );
        let base_identity = GraphqlClient::new(base).connection_identity().to_string();
        assert_ne!(
            base_identity,
            GraphqlClient::new(other_account).connection_identity()
        );
        assert_ne!(
            base_identity,
            GraphqlClient::new(other_backend).connection_identity()
        );
    }

    #[test]
    fn test_connection_identity_is_a_short_hex_digest_without_the_token() {
        let token = "sac_super_secret_account_token";
        let identity = GraphqlClient::new(SacrumConfig::new(
            "https://vertebrae.dev".into(),
            token.into(),
            "p".into(),
        ))
        .connection_identity()
        .to_string();
        assert_eq!(identity.len(), 16);
        assert!(identity.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!identity.contains(token));
    }
}
