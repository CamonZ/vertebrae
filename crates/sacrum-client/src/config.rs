//! Configuration for Sacrum client
//!
//! Loads configuration from .vtb/config.toml and environment variables.
//! Configuration resolution order:
//! - SACRUM_API_TOKEN environment variable for API token
//! - .vtb/config.toml for base URL and project ID
//! - Default base URL: http://localhost:4000

use crate::error::{SacrumClientError, SacrumClientResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Configuration for Sacrum client
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SacrumConfig {
    /// Base URL for Sacrum API (e.g., http://localhost:4000)
    pub base_url: String,
    /// API authentication token
    pub api_token: String,
    /// Project ID in Sacrum
    pub project_id: String,
}

/// TOML configuration file structure
#[derive(Debug, Deserialize)]
pub struct TomlConfig {
    sacrum: TomlSacrumSection,
}

/// Sacrum section in TOML config
#[derive(Debug, Deserialize)]
pub struct TomlSacrumSection {
    pub url: Option<String>,
    pub project_id: String,
}

impl SacrumConfig {
    /// Load configuration from .vtb/config.toml and environment variables
    ///
    /// # Resolution order
    /// - API token: SACRUM_API_TOKEN environment variable (required)
    /// - Base URL: .vtb/config.toml sacrum.url or default to http://localhost:4000
    /// - Project ID: .vtb/config.toml sacrum.project_id (required)
    pub fn load() -> SacrumClientResult<Self> {
        // Load API token from environment
        let api_token = std::env::var("SACRUM_API_TOKEN").map_err(|_| {
            SacrumClientError::ConfigError(
                "SACRUM_API_TOKEN environment variable not set".to_string(),
            )
        })?;

        // Load config from .vtb/config.toml
        let config_path = PathBuf::from(".vtb/config.toml");
        let config_content = std::fs::read_to_string(&config_path).map_err(|e| {
            SacrumClientError::ConfigError(format!(
                "Failed to read config file at {}: {}",
                config_path.display(),
                e
            ))
        })?;

        let toml_config: TomlConfig = toml::from_str(&config_content).map_err(|e| {
            SacrumClientError::ConfigError(format!("Failed to parse config file: {}", e))
        })?;

        let base_url = toml_config
            .sacrum
            .url
            .unwrap_or_else(|| "http://localhost:4000".to_string());

        Ok(SacrumConfig {
            base_url,
            api_token,
            project_id: toml_config.sacrum.project_id,
        })
    }

    /// Create a new SacrumConfig with explicit values (useful for testing)
    pub fn new(base_url: String, api_token: String, project_id: String) -> Self {
        SacrumConfig {
            base_url,
            api_token,
            project_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_creation() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );

        assert_eq!(config.base_url, "http://localhost:4000");
        assert_eq!(config.api_token, "test-token");
        assert_eq!(config.project_id, "test-project");
    }

    #[test]
    fn test_config_with_different_base_urls() {
        let config1 = SacrumConfig::new(
            "http://localhost:3000".to_string(),
            "token".to_string(),
            "proj1".to_string(),
        );
        assert_eq!(config1.base_url, "http://localhost:3000");

        let config2 = SacrumConfig::new(
            "https://api.example.com".to_string(),
            "token".to_string(),
            "proj2".to_string(),
        );
        assert_eq!(config2.base_url, "https://api.example.com");
    }

    #[test]
    fn test_config_with_different_tokens() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token1".to_string(),
            "proj".to_string(),
        );
        assert_eq!(config1.api_token, "token1");

        let config2 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "very-long-token-string-with-special-chars-123".to_string(),
            "proj".to_string(),
        );
        assert_eq!(
            config2.api_token,
            "very-long-token-string-with-special-chars-123"
        );
    }

    #[test]
    fn test_config_with_different_project_ids() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "my-project".to_string(),
        );
        assert_eq!(config1.project_id, "my-project");

        let config2 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "project-123-xyz".to_string(),
        );
        assert_eq!(config2.project_id, "project-123-xyz");
    }

    #[test]
    fn test_config_clone() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let config2 = config1.clone();

        assert_eq!(config1.base_url, config2.base_url);
        assert_eq!(config1.api_token, config2.api_token);
        assert_eq!(config1.project_id, config2.project_id);
    }

    #[test]
    fn test_config_serialization() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );

        let json = serde_json::to_string(&config).expect("Should serialize to JSON");
        assert!(json.contains("http://localhost:4000"));
        assert!(json.contains("test-token"));
        assert!(json.contains("test-project"));
    }

    #[test]
    fn test_config_with_special_characters_in_token() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token-with-special_chars.123!@#".to_string(),
            "proj".to_string(),
        );

        assert_eq!(config.api_token, "token-with-special_chars.123!@#");
        assert_eq!(config.base_url, "http://localhost:4000");
    }

    #[test]
    fn test_config_debug_representation() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );

        let debug_str = format!("{:?}", config);
        assert!(debug_str.contains("base_url"));
        assert!(debug_str.contains("api_token"));
        assert!(debug_str.contains("project_id"));
    }

    #[test]
    fn test_config_new_with_empty_strings() {
        let config = SacrumConfig::new("".to_string(), "".to_string(), "".to_string());

        assert_eq!(config.base_url, "");
        assert_eq!(config.api_token, "");
        assert_eq!(config.project_id, "");
    }

    #[test]
    fn test_config_new_with_very_long_values() {
        let long_url = "http://very-long-subdomain-name.api.example.com:9000/path/to/api";
        let long_token = "very-long-token-string-".repeat(10);
        let long_project = "project-".repeat(20);

        let config = SacrumConfig::new(
            long_url.to_string(),
            long_token.clone(),
            long_project.clone(),
        );

        assert_eq!(config.base_url, long_url);
        assert_eq!(config.api_token, long_token);
        assert_eq!(config.project_id, long_project);
    }

    #[test]
    fn test_config_with_different_url_schemes() {
        let configs = vec![
            SacrumConfig::new(
                "http://localhost:4000".to_string(),
                "token".to_string(),
                "proj".to_string(),
            ),
            SacrumConfig::new(
                "https://api.example.com".to_string(),
                "token".to_string(),
                "proj".to_string(),
            ),
            SacrumConfig::new(
                "http://192.168.1.1:4000".to_string(),
                "token".to_string(),
                "proj".to_string(),
            ),
        ];

        assert!(configs[0].base_url.starts_with("http://"));
        assert!(configs[1].base_url.starts_with("https://"));
        assert!(configs[2].base_url.contains("192.168"));
    }

    #[test]
    fn test_config_preserves_case_sensitivity() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "MyToken".to_string(),
            "MyProject".to_string(),
        );

        assert_eq!(config.api_token, "MyToken");
        assert_eq!(config.project_id, "MyProject");
    }

    #[test]
    fn test_multiple_config_instances_are_independent() {
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

        assert_ne!(config1.base_url, config2.base_url);
        assert_ne!(config1.api_token, config2.api_token);
        assert_ne!(config1.project_id, config2.project_id);
    }

    #[test]
    fn test_config_deserialization() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );

        let json = serde_json::to_string(&config).expect("Should serialize");
        let deserialized: SacrumConfig = serde_json::from_str(&json).expect("Should deserialize");

        assert_eq!(deserialized.base_url, config.base_url);
        assert_eq!(deserialized.api_token, config.api_token);
        assert_eq!(deserialized.project_id, config.project_id);
    }

    #[test]
    fn test_config_with_numeric_project_ids() {
        let configs = vec![
            SacrumConfig::new(
                "http://localhost:4000".to_string(),
                "token".to_string(),
                "123".to_string(),
            ),
            SacrumConfig::new(
                "http://localhost:4000".to_string(),
                "token".to_string(),
                "0".to_string(),
            ),
            SacrumConfig::new(
                "http://localhost:4000".to_string(),
                "token".to_string(),
                "999999".to_string(),
            ),
        ];

        assert_eq!(configs[0].project_id, "123");
        assert_eq!(configs[1].project_id, "0");
        assert_eq!(configs[2].project_id, "999999");
    }

    #[test]
    fn test_config_equality_with_same_values() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "project".to_string(),
        );
        let config2 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "project".to_string(),
        );

        assert_eq!(config1.base_url, config2.base_url);
        assert_eq!(config1.api_token, config2.api_token);
        assert_eq!(config1.project_id, config2.project_id);
    }

    #[test]
    fn test_config_inequality_with_different_urls() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "project".to_string(),
        );
        let config2 = SacrumConfig::new(
            "http://localhost:5000".to_string(),
            "token".to_string(),
            "project".to_string(),
        );

        assert_ne!(config1.base_url, config2.base_url);
    }

    #[test]
    fn test_config_with_trailing_slashes_in_url() {
        let config = SacrumConfig::new(
            "http://localhost:4000/".to_string(),
            "token".to_string(),
            "project".to_string(),
        );

        assert_eq!(config.base_url, "http://localhost:4000/");
    }

    #[test]
    fn test_config_clone_independence() {
        let config1 = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "project".to_string(),
        );
        let config2 = config1.clone();

        // Verify they have the same values
        assert_eq!(config1.base_url, config2.base_url);
        // But modifying string values should be independent
        let mut modified = config1;
        modified.api_token = "different-token".to_string();
        assert_ne!(modified.api_token, config2.api_token);
    }

    #[test]
    fn test_config_with_unicode_project_id() {
        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "projekt-日本語".to_string(),
        );

        assert_eq!(config.project_id, "projekt-日本語");
    }

    #[test]
    fn test_config_serialization_roundtrip() {
        let original = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: SacrumConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(original.base_url, deserialized.base_url);
        assert_eq!(original.api_token, deserialized.api_token);
        assert_eq!(original.project_id, deserialized.project_id);
    }
}
