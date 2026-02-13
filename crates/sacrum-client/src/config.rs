//! Configuration for Sacrum client
//!
//! Loads configuration from .vtb/config.toml in the project directory (found by walking up from CWD)
//! and environment variables.
//!
//! Configuration resolution order:
//! - SACRUM_API_TOKEN environment variable for API token
//! - .vtb/config.toml (found by walking up from current directory) for project settings and base URL
//! - Default base URL: http://localhost:4000

use crate::error::{SacrumClientError, SacrumClientResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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

/// Local project configuration structure for .vtb/config.toml
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct LocalProjectConfig {
    /// Project settings
    #[serde(default)]
    pub project: ProjectSettings,
    /// Sacrum settings
    #[serde(default)]
    pub sacrum: LocalSacrumSection,
}

/// Project settings in local config
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ProjectSettings {
    /// Project ID (UUID)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Project slug
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
}

/// Local sacrum settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalSacrumSection {
    /// Sacrum API URL
    #[serde(default = "default_url")]
    pub url: String,
}

impl Default for LocalSacrumSection {
    fn default() -> Self {
        Self { url: default_url() }
    }
}

fn default_url() -> String {
    "http://localhost:4000".to_string()
}

/// Top-level config file structure for ~/.config/vertebrae/config.toml (legacy/deprecated)
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct VertebraeConfigFile {
    /// Global sacrum defaults
    #[serde(default)]
    pub sacrum: GlobalSacrumSection,
    /// Per-project configuration keyed by slug
    #[serde(default)]
    pub projects: BTreeMap<String, ProjectSection>,
}

/// Global sacrum defaults (legacy/deprecated)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalSacrumSection {
    /// Default Sacrum API URL
    #[serde(default = "default_url")]
    pub url: String,
}

impl Default for GlobalSacrumSection {
    fn default() -> Self {
        Self { url: default_url() }
    }
}

/// Per-project configuration (legacy/deprecated)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSection {
    /// Sacrum project ID (UUID)
    pub project_id: String,
    /// Optional per-project URL override
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Optional git root path for the project
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl SacrumConfig {
    /// Load configuration by finding .vtb/config.toml in the current directory or parent directories.
    ///
    /// Walks up from CWD looking for .vtb/config.toml, loads the project settings,
    /// and loads the API token from SACRUM_API_TOKEN env var.
    ///
    /// Returns an error with a helpful message if no .vtb/config.toml is found.
    pub fn load() -> SacrumClientResult<Self> {
        // Load API token from environment
        let api_token = std::env::var("SACRUM_API_TOKEN").map_err(|_| {
            SacrumClientError::ConfigError(
                "SACRUM_API_TOKEN environment variable not set".to_string(),
            )
        })?;

        // Find and load local config file
        let config = find_and_load_local_config()?;

        let project_id = config.project.id.ok_or_else(|| {
            SacrumClientError::ConfigError("No project ID found in .vtb/config.toml".to_string())
        })?;

        Ok(SacrumConfig {
            base_url: config.sacrum.url,
            api_token,
            project_id,
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

/// Find and load local config by walking up from CWD
/// Returns an error if .vtb/config.toml is not found anywhere in the path
pub fn find_and_load_local_config() -> SacrumClientResult<LocalProjectConfig> {
    let mut current_dir = std::env::current_dir().map_err(|e| {
        SacrumClientError::ConfigError(format!("Failed to get current directory: {}", e))
    })?;

    loop {
        let config_path = current_dir.join(".vtb").join("config.toml");

        if config_path.exists() {
            return load_local_config_file(&config_path);
        }

        if !current_dir.pop() {
            // Reached the root directory without finding config
            return Err(SacrumClientError::ConfigError(
                "No vertebrae project found. Run `vtb init` to initialize a project.\n\
                 (Looking for .vtb/config.toml in current directory or parent directories)"
                    .to_string(),
            ));
        }
    }
}

/// Load and parse a local config file
pub fn load_local_config_file(path: &std::path::Path) -> SacrumClientResult<LocalProjectConfig> {
    let content = std::fs::read_to_string(path).map_err(|e| {
        SacrumClientError::ConfigError(format!(
            "Failed to read config file at {}: {}",
            path.display(),
            e
        ))
    })?;

    let config: LocalProjectConfig = toml::from_str(&content).map_err(|e| {
        SacrumClientError::ConfigError(format!("Failed to parse config file: {}", e))
    })?;

    Ok(config)
}

/// Returns the path to ~/.config/vertebrae/config.toml (legacy/deprecated)
pub fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("vertebrae").join("config.toml"))
}

/// Load and parse the legacy global config file. Returns Default if file is missing.
/// This function is deprecated and will be removed in a future version.
pub fn load_config_file() -> SacrumClientResult<VertebraeConfigFile> {
    let path = config_path().ok_or_else(|| {
        SacrumClientError::ConfigError("Could not determine config directory".to_string())
    })?;

    if !path.exists() {
        return Ok(VertebraeConfigFile::default());
    }

    let content = std::fs::read_to_string(&path).map_err(|e| {
        SacrumClientError::ConfigError(format!(
            "Failed to read config file at {}: {}",
            path.display(),
            e
        ))
    })?;

    let config: VertebraeConfigFile = toml::from_str(&content).map_err(|e| {
        SacrumClientError::ConfigError(format!("Failed to parse config file: {}", e))
    })?;

    Ok(config)
}

/// Serialize and write the legacy config file. Creates parent directories if needed.
/// This function is deprecated and will be removed in a future version.
pub fn save_config_file(config: &VertebraeConfigFile) -> SacrumClientResult<()> {
    let path = config_path().ok_or_else(|| {
        SacrumClientError::ConfigError("Could not determine config directory".to_string())
    })?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            SacrumClientError::ConfigError(format!(
                "Failed to create config directory {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    let content = toml::to_string_pretty(config).map_err(|e| {
        SacrumClientError::ConfigError(format!("Failed to serialize config: {}", e))
    })?;

    std::fs::write(&path, content).map_err(|e| {
        SacrumClientError::ConfigError(format!(
            "Failed to write config file at {}: {}",
            path.display(),
            e
        ))
    })?;

    Ok(())
}

/// Save a local project config to .vtb/config.toml
/// Creates .vtb directory if it doesn't exist
pub fn save_local_config(
    path: &std::path::Path,
    config: &LocalProjectConfig,
) -> SacrumClientResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            SacrumClientError::ConfigError(format!(
                "Failed to create .vtb directory {}: {}",
                parent.display(),
                e
            ))
        })?;
    }

    let content = toml::to_string_pretty(config).map_err(|e| {
        SacrumClientError::ConfigError(format!("Failed to serialize config: {}", e))
    })?;

    std::fs::write(path, content).map_err(|e| {
        SacrumClientError::ConfigError(format!(
            "Failed to write config file at {}: {}",
            path.display(),
            e
        ))
    })?;

    Ok(())
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
            "another-project-uuid".to_string(),
        );
        assert_eq!(config2.project_id, "another-project-uuid");
    }
}
