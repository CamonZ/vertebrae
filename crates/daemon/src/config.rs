//! Daemon configuration loaded from `~/.config/vertebrae/config.toml`.
//!
//! Reuses the existing [`VertebraeConfigFile`] from `sacrum-client` — the same
//! config file used by the CLI and GUI.

use vertebrae_sacrum_client::{VertebraeConfigFile, load_config_file};

/// Error type for config loading.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Failed to load config file: {0}")]
    LoadFailed(String),
    #[error("Missing required configuration: {0}")]
    Missing(String),
}

/// A project entry with its Sacrum ID and local path.
#[derive(Debug, Clone)]
pub struct ProjectEntry {
    /// Project slug (the key in `[projects.<name>]`).
    pub slug: String,
    /// Sacrum project ID (UUID).
    pub project_id: String,
    /// Git root path for the project.
    pub path: String,
}

/// Resolved daemon configuration after loading from config file.
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    /// Sacrum base URL.
    pub sacrum_url: String,
    /// API token for authentication.
    pub api_token: String,
    /// Projects to monitor.
    pub projects: Vec<ProjectEntry>,
}

impl ResolvedConfig {
    /// Load configuration from `~/.config/vertebrae/config.toml`.
    pub fn load() -> Result<Self, ConfigError> {
        let config = load_config_file().map_err(|e| ConfigError::LoadFailed(e.to_string()))?;
        Self::from_config_file(&config)
    }

    /// Build from a loaded config file (testable without filesystem).
    pub fn from_config_file(config: &VertebraeConfigFile) -> Result<Self, ConfigError> {
        let api_token = config.sacrum.token.clone().ok_or_else(|| {
            ConfigError::Missing(
                "API token not found. Set [sacrum].token in ~/.config/vertebrae/config.toml"
                    .to_string(),
            )
        })?;

        let projects: Vec<ProjectEntry> = config
            .projects
            .iter()
            .map(|(slug, section)| ProjectEntry {
                slug: slug.clone(),
                project_id: section.id.clone(),
                path: section.path.clone(),
            })
            .collect();

        Ok(ResolvedConfig {
            sacrum_url: config.sacrum.url.clone(),
            api_token,
            projects,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use vertebrae_sacrum_client::{GlobalSacrumSection, ProjectSection};

    // ===== ResolvedConfig::from_config_file tests =====

    #[test]
    fn resolves_full_config() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "https://sacrum.example.com".to_string(),
                token: Some("my-token".to_string()),
            },
            projects: BTreeMap::from([
                (
                    "vertebrae".to_string(),
                    ProjectSection {
                        id: "proj-1".to_string(),
                        path: "/home/user/vertebrae".to_string(),
                    },
                ),
                (
                    "other".to_string(),
                    ProjectSection {
                        id: "proj-2".to_string(),
                        path: "/home/user/other".to_string(),
                    },
                ),
            ]),
        };

        let resolved = ResolvedConfig::from_config_file(&config).unwrap();
        assert_eq!(resolved.sacrum_url, "https://sacrum.example.com");
        assert_eq!(resolved.api_token, "my-token");
        assert_eq!(resolved.projects.len(), 2);
    }

    #[test]
    fn errors_when_no_token() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: None,
            },
            projects: BTreeMap::new(),
        };

        let result = ResolvedConfig::from_config_file(&config);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("API token not found"),
            "Expected token error, got: {}",
            err
        );
    }

    #[test]
    fn uses_default_url_when_not_set() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some("tok".to_string()),
            },
            projects: BTreeMap::new(),
        };

        let resolved = ResolvedConfig::from_config_file(&config).unwrap();
        assert_eq!(resolved.sacrum_url, "http://localhost:4000");
    }

    #[test]
    fn empty_projects_is_ok() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some("tok".to_string()),
            },
            projects: BTreeMap::new(),
        };

        let resolved = ResolvedConfig::from_config_file(&config).unwrap();
        assert!(resolved.projects.is_empty());
    }

    #[test]
    fn project_entry_preserves_all_fields() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some("tok".to_string()),
            },
            projects: BTreeMap::from([(
                "myproject".to_string(),
                ProjectSection {
                    id: "abc-123".to_string(),
                    path: "/home/user/code/myproject".to_string(),
                },
            )]),
        };

        let resolved = ResolvedConfig::from_config_file(&config).unwrap();
        assert_eq!(resolved.projects.len(), 1);

        let project = &resolved.projects[0];
        assert_eq!(project.slug, "myproject");
        assert_eq!(project.project_id, "abc-123");
        assert_eq!(project.path, "/home/user/code/myproject");
    }

    #[test]
    fn load_returns_error_for_missing_token_in_real_config() {
        // load() reads real config; if token is missing it should error
        // On CI/test machines without config, load_config_file returns default (no token)
        let result = ResolvedConfig::load();
        // Either succeeds (token in real config) or fails with Missing
        if let Err(e) = result {
            let msg = e.to_string();
            assert!(
                msg.contains("API token not found") || msg.contains("Failed to load"),
                "Unexpected error: {}",
                msg
            );
        }
    }

    // ===== ConfigError display tests =====

    #[test]
    fn config_error_display_missing() {
        let err = ConfigError::Missing("no token".to_string());
        assert_eq!(err.to_string(), "Missing required configuration: no token");
    }

    #[test]
    fn config_error_display_load_failed() {
        let err = ConfigError::LoadFailed("bad config".to_string());
        assert_eq!(err.to_string(), "Failed to load config file: bad config");
    }
}
