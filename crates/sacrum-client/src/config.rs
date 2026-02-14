//! Configuration for Sacrum client
//!
//! Loads configuration from ~/.config/vertebrae/config.toml (global config).
//!
//! Configuration resolution:
//! - `[sacrum].token` in config file for API token
//! - `[sacrum].url` in config file for base URL (default: http://localhost:4000)
//! - `[projects.<name>]` entries matched by CWD longest-prefix (CLI) or by name (GUI)

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

/// Global sacrum settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalSacrumSection {
    /// Default Sacrum API URL
    #[serde(default = "default_url")]
    pub url: String,
    /// API token for authentication
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl Default for GlobalSacrumSection {
    fn default() -> Self {
        Self {
            url: default_url(),
            token: None,
        }
    }
}

/// Per-project configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSection {
    /// Sacrum project ID (UUID)
    #[serde(alias = "project_id")]
    pub id: String,
    /// Git root path for the project
    #[serde(default)]
    pub path: String,
}

fn default_url() -> String {
    "http://localhost:4000".to_string()
}

impl SacrumConfig {
    /// Load configuration by matching CWD against project paths in the global config.
    ///
    /// 1. Reads ~/.config/vertebrae/config.toml
    /// 2. Extracts `[sacrum].token` (error if missing)
    /// 3. Canonicalizes CWD
    /// 4. Finds the project whose `path` is the longest prefix of CWD
    /// 5. Returns `SacrumConfig { base_url, api_token, project_id }`
    pub fn load() -> SacrumClientResult<Self> {
        let config = load_config_file()?;

        let api_token = config.sacrum.token.clone().ok_or_else(|| {
            SacrumClientError::ConfigError(
                "No API token found. Set [sacrum].token in ~/.config/vertebrae/config.toml"
                    .to_string(),
            )
        })?;

        let cwd = std::env::current_dir().map_err(|e| {
            SacrumClientError::ConfigError(format!("Failed to get current directory: {}", e))
        })?;

        let cwd = cwd.canonicalize().unwrap_or(cwd);

        let base_url = config.sacrum.url.clone();
        let (_name, section) = find_project_by_path(&config, &cwd)?;

        Ok(SacrumConfig {
            base_url,
            api_token,
            project_id: section.id.clone(),
        })
    }

    /// Load configuration for a specific project by name.
    ///
    /// Used by the GUI which doesn't have a meaningful CWD.
    pub fn load_for_project(name: &str) -> SacrumClientResult<Self> {
        let config = load_config_file()?;

        let api_token = config.sacrum.token.clone().ok_or_else(|| {
            SacrumClientError::ConfigError(
                "No API token found. Set [sacrum].token in ~/.config/vertebrae/config.toml"
                    .to_string(),
            )
        })?;

        let section = config.projects.get(name).ok_or_else(|| {
            SacrumClientError::ConfigError(format!(
                "Project '{}' not found in ~/.config/vertebrae/config.toml",
                name
            ))
        })?;

        Ok(SacrumConfig {
            base_url: config.sacrum.url,
            api_token,
            project_id: section.id.clone(),
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

/// Find the project whose path is the longest prefix of the given directory.
fn find_project_by_path<'a>(
    config: &'a VertebraeConfigFile,
    cwd: &std::path::Path,
) -> SacrumClientResult<(&'a str, &'a ProjectSection)> {
    let mut best_match: Option<(&str, &ProjectSection, usize)> = None;

    for (name, section) in &config.projects {
        let project_path = std::path::Path::new(&section.path);
        let project_path = project_path
            .canonicalize()
            .unwrap_or_else(|_| project_path.to_path_buf());

        if cwd.starts_with(&project_path) {
            let depth = project_path.components().count();
            if best_match.as_ref().is_none_or(|(_, _, d)| depth > *d) {
                best_match = Some((name, section, depth));
            }
        }
    }

    best_match
        .map(|(name, section, _)| (name, section))
        .ok_or_else(|| {
            SacrumClientError::ConfigError(
                "No vertebrae project found for the current directory.\n\
             Run `vtb init` to register this project, or check ~/.config/vertebrae/config.toml"
                    .to_string(),
            )
        })
}

/// Returns the path to ~/.config/vertebrae/config.toml
pub fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("vertebrae").join("config.toml"))
}

/// Load and parse the global config file. Returns Default if file is missing.
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

/// Serialize and write the global config file. Creates parent directories if needed.
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

/// Register a project in the global config file.
///
/// Inserts or updates the project entry and saves.
pub fn register_project(name: &str, project_id: &str, path: &str) -> SacrumClientResult<()> {
    let mut config = load_config_file()?;
    config.projects.insert(
        name.to_string(),
        ProjectSection {
            id: project_id.to_string(),
            path: path.to_string(),
        },
    );
    save_config_file(&config)
}

/// Remove a project from the global config file.
///
/// Returns true if the project was found and removed, false if not found.
pub fn unregister_project(name: &str) -> SacrumClientResult<bool> {
    let mut config = load_config_file()?;
    let removed = config.projects.remove(name).is_some();
    if removed {
        save_config_file(&config)?;
    }
    Ok(removed)
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

    #[test]
    fn test_find_project_by_path_longest_prefix() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some("test".to_string()),
            },
            projects: BTreeMap::from([
                (
                    "parent".to_string(),
                    ProjectSection {
                        id: "id-parent".to_string(),
                        path: "/home/user/code".to_string(),
                    },
                ),
                (
                    "child".to_string(),
                    ProjectSection {
                        id: "id-child".to_string(),
                        path: "/home/user/code/child-project".to_string(),
                    },
                ),
            ]),
        };

        // CWD inside child-project should match the child (longer prefix)
        let cwd = std::path::Path::new("/home/user/code/child-project/src");
        let (name, section) = find_project_by_path(&config, cwd).unwrap();
        assert_eq!(name, "child");
        assert_eq!(section.id, "id-child");

        // CWD inside parent but not child should match parent
        let cwd = std::path::Path::new("/home/user/code/other-stuff");
        let (name, section) = find_project_by_path(&config, cwd).unwrap();
        assert_eq!(name, "parent");
        assert_eq!(section.id, "id-parent");
    }

    #[test]
    fn test_find_project_by_path_no_match() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection::default(),
            projects: BTreeMap::from([(
                "myproject".to_string(),
                ProjectSection {
                    id: "id1".to_string(),
                    path: "/home/user/code/myproject".to_string(),
                },
            )]),
        };

        let cwd = std::path::Path::new("/tmp/unrelated");
        let result = find_project_by_path(&config, cwd);
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("No vertebrae project found")
        );
    }

    #[test]
    fn test_find_project_by_path_exact_match() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection::default(),
            projects: BTreeMap::from([(
                "myproject".to_string(),
                ProjectSection {
                    id: "id1".to_string(),
                    path: "/home/user/code/myproject".to_string(),
                },
            )]),
        };

        let cwd = std::path::Path::new("/home/user/code/myproject");
        let (name, section) = find_project_by_path(&config, cwd).unwrap();
        assert_eq!(name, "myproject");
        assert_eq!(section.id, "id1");
    }

    #[test]
    fn test_load_for_project_missing_token() {
        // This will use the real config path; if no config exists, it defaults
        // and the token will be None, so we should get an error.
        // We can't easily mock the filesystem, so just test the error path.
        let result = SacrumConfig::load_for_project("nonexistent-project-xyz");
        assert!(result.is_err());
    }

    #[test]
    fn test_global_sacrum_section_default() {
        let section = GlobalSacrumSection::default();
        assert_eq!(section.url, "http://localhost:4000");
        assert!(section.token.is_none());
    }

    #[test]
    fn test_vertebrae_config_file_roundtrip() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some("sac_test123".to_string()),
            },
            projects: BTreeMap::from([(
                "vertebrae".to_string(),
                ProjectSection {
                    id: "bb747fd8-5395-486f-bc8b-24ccd1615e18".to_string(),
                    path: "/Users/test/code/vertebrae".to_string(),
                },
            )]),
        };

        let serialized = toml::to_string_pretty(&config).unwrap();
        let deserialized: VertebraeConfigFile = toml::from_str(&serialized).unwrap();

        assert_eq!(deserialized.sacrum.url, "http://localhost:4000");
        assert_eq!(deserialized.sacrum.token.as_deref(), Some("sac_test123"));
        assert_eq!(deserialized.projects.len(), 1);
        let project = deserialized.projects.get("vertebrae").unwrap();
        assert_eq!(project.id, "bb747fd8-5395-486f-bc8b-24ccd1615e18");
        assert_eq!(project.path, "/Users/test/code/vertebrae");
    }

    #[test]
    fn test_config_file_deserialize_without_token() {
        let toml_str = r#"
[sacrum]
url = "http://localhost:4000"

[projects.myproject]
id = "abc123"
path = "/tmp/myproject"
"#;

        let config: VertebraeConfigFile = toml::from_str(toml_str).unwrap();
        assert!(config.sacrum.token.is_none());
        assert_eq!(config.sacrum.url, "http://localhost:4000");
        assert_eq!(config.projects.len(), 1);
    }

    #[test]
    fn test_config_file_deserialize_with_token() {
        let toml_str = r#"
[sacrum]
url = "http://localhost:4000"
token = "sac_mytoken"

[projects.vertebrae]
id = "bb747fd8"
path = "/Users/test/vertebrae"

[projects.other]
id = "other-id"
path = "/Users/test/other"
"#;

        let config: VertebraeConfigFile = toml::from_str(toml_str).unwrap();
        assert_eq!(config.sacrum.token.as_deref(), Some("sac_mytoken"));
        assert_eq!(config.projects.len(), 2);
    }
}
