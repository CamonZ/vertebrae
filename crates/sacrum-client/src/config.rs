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
}
