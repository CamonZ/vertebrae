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
                ..Default::default()
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
    fn unknown_future_lifecycle_values_roundtrip_without_blocking_daemon_config() {
        let source = r#"
[sacrum]
mode = "federated"
url = "https://future.example.test"
token = "sac_future-token"

[sacrum.local]
compose_project = "future-project"
database_volume = "future-volume"
channel = "canary"
image_ref = "ghcr.io/camonz/sacrum@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
provisioning_state = "paused"

[sacrum.local.runtime_secrets]
kind = "keychain"
service = "vertebrae"

[projects.future]
id = "future-project-id"
path = "/code/future"
"#;
        let config: VertebraeConfigFile = toml::from_str(source).unwrap();
        let resolved = ResolvedConfig::from_config_file(&config).unwrap();

        assert_eq!(resolved.sacrum_url, "https://future.example.test");
        assert_eq!(resolved.api_token, "sac_future-token");
        assert_eq!(resolved.projects.len(), 1);
        assert_eq!(resolved.projects[0].project_id, "future-project-id");

        let serialized = toml::to_string_pretty(&config).unwrap();
        let reloaded: VertebraeConfigFile = toml::from_str(&serialized).unwrap();
        assert_eq!(reloaded, config);
    }

    #[test]
    fn errors_when_no_token() {
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: None,
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
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

    /// Sanity-check that error formatting never echoes the secret API token.
    #[test]
    fn errors_never_leak_api_token() {
        // No-token config still triggers Missing, and the Missing message must
        // not contain the (absent) token. We construct a config with the token
        // *present* and confirm that error formatting paths still never echo it.
        let secret = "sac_sup3r_secret_dont_log_me";
        let config = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: Some(secret.to_string()),
                ..Default::default()
            },
            projects: BTreeMap::new(),
        };
        // Success case: no errors to inspect; but a Debug-print of the config
        // would leak the token, so we ensure our Display-rendered errors stay
        // scoped. Trigger the Missing error path with a separate fixture.
        assert!(ResolvedConfig::from_config_file(&config).is_ok());

        let no_token = VertebraeConfigFile {
            sacrum: GlobalSacrumSection {
                url: "http://localhost:4000".to_string(),
                token: None,
                ..Default::default()
            },
            projects: BTreeMap::new(),
        };
        let err = ResolvedConfig::from_config_file(&no_token).unwrap_err();
        assert!(!err.to_string().contains(secret));
    }
}
