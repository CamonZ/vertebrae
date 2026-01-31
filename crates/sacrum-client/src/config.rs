//! Configuration for Sacrum client
//!
//! Loads configuration from ~/.config/vertebrae/config.toml and environment variables.
//! Configuration resolution order:
//! - SACRUM_API_TOKEN environment variable for API token
//! - ~/.config/vertebrae/config.toml for base URL and project settings
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

/// Top-level config file structure for ~/.config/vertebrae/config.toml
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct VertebraeConfigFile {
    /// Global sacrum defaults
    #[serde(default)]
    pub sacrum: GlobalSacrumSection,
    /// Per-project configuration keyed by slug
    #[serde(default)]
    pub projects: BTreeMap<String, ProjectSection>,
}

/// Global sacrum defaults
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

fn default_url() -> String {
    "http://localhost:4000".to_string()
}

/// Per-project configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSection {
    /// Sacrum project ID (UUID)
    pub project_id: String,
    /// Optional per-project URL override
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl SacrumConfig {
    /// Load configuration for a project identified by slug.
    ///
    /// Reads ~/.config/vertebrae/config.toml, looks up the project by slug,
    /// and loads the API token from SACRUM_API_TOKEN env var.
    pub fn load(slug: &str) -> SacrumClientResult<Self> {
        // Load API token from environment
        let api_token = std::env::var("SACRUM_API_TOKEN").map_err(|_| {
            SacrumClientError::ConfigError(
                "SACRUM_API_TOKEN environment variable not set".to_string(),
            )
        })?;

        let config_file = load_config_file()?;

        let project = config_file.projects.get(slug).ok_or_else(|| {
            SacrumClientError::ConfigError(format!(
                "No project '{}' found in config file at {}",
                slug,
                config_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ))
        })?;

        let base_url = project
            .url
            .clone()
            .unwrap_or_else(|| config_file.sacrum.url.clone());

        Ok(SacrumConfig {
            base_url,
            api_token,
            project_id: project.project_id.clone(),
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

/// Returns the path to ~/.config/vertebrae/config.toml
pub fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("vertebrae").join("config.toml"))
}

/// Load and parse the config file. Returns Default if file is missing.
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

/// Serialize and write the config file. Creates parent directories if needed.
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

    #[test]
    fn test_vertebrae_config_file_default() {
        let config = VertebraeConfigFile::default();
        assert_eq!(config.sacrum.url, "http://localhost:4000");
        assert!(config.projects.is_empty());
    }

    #[test]
    fn test_vertebrae_config_file_roundtrip() {
        let mut config = VertebraeConfigFile::default();
        config.sacrum.url = "http://custom:5000".to_string();
        config.projects.insert(
            "my-project".to_string(),
            ProjectSection {
                project_id: "uuid-123".to_string(),
                url: None,
            },
        );
        config.projects.insert(
            "other".to_string(),
            ProjectSection {
                project_id: "uuid-456".to_string(),
                url: Some("https://other-server.com".to_string()),
            },
        );

        let toml_str = toml::to_string_pretty(&config).unwrap();
        let parsed: VertebraeConfigFile = toml::from_str(&toml_str).unwrap();

        assert_eq!(parsed.sacrum.url, "http://custom:5000");
        assert_eq!(parsed.projects.len(), 2);
        assert_eq!(parsed.projects["my-project"].project_id, "uuid-123");
        assert!(parsed.projects["my-project"].url.is_none());
        assert_eq!(parsed.projects["other"].project_id, "uuid-456");
        assert_eq!(
            parsed.projects["other"].url.as_deref(),
            Some("https://other-server.com")
        );
    }

    #[test]
    fn test_vertebrae_config_file_parse_minimal() {
        let toml_str = r#"
[sacrum]
url = "http://localhost:4000"

[projects.vertebrae]
project_id = "bb747fd8-5395-486f-bc8b-24ccd1615e18"
"#;
        let config: VertebraeConfigFile = toml::from_str(toml_str).unwrap();
        assert_eq!(config.sacrum.url, "http://localhost:4000");
        assert_eq!(config.projects.len(), 1);
        assert_eq!(
            config.projects["vertebrae"].project_id,
            "bb747fd8-5395-486f-bc8b-24ccd1615e18"
        );
    }

    #[test]
    fn test_vertebrae_config_file_parse_with_override() {
        let toml_str = r#"
[sacrum]
url = "http://localhost:4000"

[projects.vertebrae]
project_id = "uuid-1"

[projects.other-project]
project_id = "uuid-2"
url = "https://custom-server.com"
"#;
        let config: VertebraeConfigFile = toml::from_str(toml_str).unwrap();
        assert_eq!(config.projects.len(), 2);
        assert!(config.projects["vertebrae"].url.is_none());
        assert_eq!(
            config.projects["other-project"].url.as_deref(),
            Some("https://custom-server.com")
        );
    }

    #[test]
    fn test_config_path_returns_some() {
        // On most systems, config_dir should return Some
        let path = config_path();
        if let Some(p) = path {
            assert!(p.ends_with("vertebrae/config.toml"));
        }
    }

    #[test]
    fn test_project_section_url_skip_serializing_none() {
        let section = ProjectSection {
            project_id: "uuid-123".to_string(),
            url: None,
        };
        let toml_str = toml::to_string(&section).unwrap();
        assert!(!toml_str.contains("url"));

        let section_with_url = ProjectSection {
            project_id: "uuid-123".to_string(),
            url: Some("http://custom.com".to_string()),
        };
        let toml_str = toml::to_string(&section_with_url).unwrap();
        assert!(toml_str.contains("url"));
    }
}
