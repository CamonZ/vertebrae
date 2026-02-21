//! Daemon configuration loaded from `~/.vertebrae/daemon.toml` and environment variables.
//!
//! The config file is optional. All settings can be provided via CLI args or env vars.
//! Resolution order (highest priority first):
//! 1. CLI arguments (--sacrum-url, --api-token, --project)
//! 2. Environment variables (SACRUM_API_TOKEN)
//! 3. Config file (~/.vertebrae/daemon.toml)
//! 4. Defaults (sacrum_url: http://localhost:4000)

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// On-disk representation of `~/.vertebrae/daemon.toml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConfigFile {
    /// Sacrum base URL (e.g. "http://localhost:4000").
    #[serde(default = "default_sacrum_url")]
    pub sacrum_url: String,
    /// API token for Sacrum authentication.
    /// Prefer SACRUM_API_TOKEN env var over this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_token: Option<String>,
    /// Project IDs to monitor (UUID strings).
    #[serde(default)]
    pub project_ids: Vec<String>,
}

impl Default for DaemonConfigFile {
    fn default() -> Self {
        Self {
            sacrum_url: default_sacrum_url(),
            api_token: None,
            project_ids: Vec::new(),
        }
    }
}

fn default_sacrum_url() -> String {
    "http://localhost:4000".to_string()
}

/// Error type for config loading.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Failed to read config file at {path}: {source}")]
    ReadFile {
        path: String,
        source: std::io::Error,
    },
    #[error("Failed to parse config file: {0}")]
    Parse(String),
    #[error("Missing required configuration: {0}")]
    Missing(String),
}

/// Returns the path to `~/.vertebrae/daemon.toml`.
pub fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".vertebrae").join("daemon.toml"))
}

/// Load the config file if it exists, otherwise return defaults.
pub fn load_config_file() -> Result<DaemonConfigFile, ConfigError> {
    let Some(path) = config_path() else {
        return Ok(DaemonConfigFile::default());
    };

    if !path.exists() {
        return Ok(DaemonConfigFile::default());
    }

    let content = std::fs::read_to_string(&path).map_err(|e| ConfigError::ReadFile {
        path: path.display().to_string(),
        source: e,
    })?;

    let config: DaemonConfigFile =
        toml::from_str(&content).map_err(|e| ConfigError::Parse(e.to_string()))?;

    Ok(config)
}

/// Resolved daemon configuration after merging file, env vars, and CLI args.
/// This is the final config used to start the daemon.
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    /// Sacrum base URL.
    pub sacrum_url: String,
    /// API token for authentication.
    pub api_token: String,
    /// Project IDs to subscribe to.
    pub project_ids: Vec<String>,
}

impl ResolvedConfig {
    /// Build the resolved config by merging sources.
    ///
    /// Reads `SACRUM_API_TOKEN` from the environment and delegates to [`resolve_with_env`].
    ///
    /// Priority (highest first):
    /// 1. `cli_sacrum_url`, `cli_api_token`, `cli_project_ids` (from CLI args)
    /// 2. `SACRUM_API_TOKEN` env var
    /// 3. Values from the config file
    /// 4. Defaults
    pub fn resolve(
        file: &DaemonConfigFile,
        cli_sacrum_url: Option<&str>,
        cli_api_token: Option<&str>,
        cli_project_ids: &[String],
    ) -> Result<Self, ConfigError> {
        let env_token = std::env::var("SACRUM_API_TOKEN").ok();
        Self::resolve_with_env(
            file,
            cli_sacrum_url,
            cli_api_token,
            env_token.as_deref(),
            cli_project_ids,
        )
    }

    /// Build the resolved config by merging sources, with an explicit env token value.
    ///
    /// This method is testable without mutating process environment variables.
    ///
    /// Token priority: `cli_api_token` > `env_api_token` > `file.api_token`.
    pub fn resolve_with_env(
        file: &DaemonConfigFile,
        cli_sacrum_url: Option<&str>,
        cli_api_token: Option<&str>,
        env_api_token: Option<&str>,
        cli_project_ids: &[String],
    ) -> Result<Self, ConfigError> {
        let sacrum_url = cli_sacrum_url
            .map(String::from)
            .unwrap_or_else(|| file.sacrum_url.clone());

        // Token priority: CLI arg > env var > config file
        let api_token = cli_api_token
            .map(String::from)
            .or_else(|| env_api_token.map(String::from))
            .or_else(|| file.api_token.clone())
            .ok_or_else(|| {
                ConfigError::Missing(
                    "API token not found. Set SACRUM_API_TOKEN env var, \
                     pass --api-token, or add api_token to ~/.vertebrae/daemon.toml"
                        .to_string(),
                )
            })?;

        // Merge project IDs: CLI args take precedence if provided, otherwise use file
        let project_ids = if cli_project_ids.is_empty() {
            file.project_ids.clone()
        } else {
            cli_project_ids.to_vec()
        };

        Ok(ResolvedConfig {
            sacrum_url,
            api_token,
            project_ids,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== DaemonConfigFile deserialization tests =====

    #[test]
    fn parse_full_config() {
        let toml_str = r#"
sacrum_url = "https://api.example.com"
api_token = "secret-token"
project_ids = ["proj-1", "proj-2"]
"#;
        let config: DaemonConfigFile = toml::from_str(toml_str).unwrap();
        assert_eq!(config.sacrum_url, "https://api.example.com");
        assert_eq!(config.api_token.as_deref(), Some("secret-token"));
        assert_eq!(config.project_ids, vec!["proj-1", "proj-2"]);
    }

    #[test]
    fn parse_minimal_config() {
        let toml_str = "";
        let config: DaemonConfigFile = toml::from_str(toml_str).unwrap();
        assert_eq!(config.sacrum_url, "http://localhost:4000");
        assert!(config.api_token.is_none());
        assert!(config.project_ids.is_empty());
    }

    #[test]
    fn parse_config_with_only_url() {
        let toml_str = r#"sacrum_url = "http://custom:5000""#;
        let config: DaemonConfigFile = toml::from_str(toml_str).unwrap();
        assert_eq!(config.sacrum_url, "http://custom:5000");
        assert!(config.api_token.is_none());
        assert!(config.project_ids.is_empty());
    }

    #[test]
    fn parse_config_with_empty_project_ids() {
        let toml_str = r#"
sacrum_url = "http://localhost:4000"
api_token = "tok"
project_ids = []
"#;
        let config: DaemonConfigFile = toml::from_str(toml_str).unwrap();
        assert!(config.project_ids.is_empty());
    }

    // ===== config_path tests =====

    #[test]
    fn config_path_returns_some() {
        // Should return Some on any platform with a home directory
        let path = config_path();
        assert!(path.is_some());
        let p = path.unwrap();
        assert!(p.ends_with(".vertebrae/daemon.toml"));
    }

    // ===== load_config_file tests =====

    #[test]
    fn load_config_file_returns_defaults_when_missing() {
        // The test runner's home dir likely doesn't have ~/.vertebrae/daemon.toml
        // but even if it does, this should not error
        let result = load_config_file();
        assert!(result.is_ok());
    }

    // ===== ResolvedConfig::resolve tests =====

    #[test]
    fn resolve_uses_cli_args_over_file() {
        let file = DaemonConfigFile {
            sacrum_url: "http://file-url:4000".to_string(),
            api_token: Some("file-token".to_string()),
            project_ids: vec!["file-proj".to_string()],
        };

        let resolved = ResolvedConfig::resolve_with_env(
            &file,
            Some("http://cli-url:5000"),
            Some("cli-token"),
            None,
            &["cli-proj".to_string()],
        )
        .unwrap();

        assert_eq!(resolved.sacrum_url, "http://cli-url:5000");
        assert_eq!(resolved.api_token, "cli-token");
        assert_eq!(resolved.project_ids, vec!["cli-proj"]);
    }

    #[test]
    fn resolve_falls_back_to_file_values() {
        let file = DaemonConfigFile {
            sacrum_url: "http://file-url:4000".to_string(),
            api_token: Some("file-token".to_string()),
            project_ids: vec!["file-proj".to_string()],
        };

        let resolved = ResolvedConfig::resolve_with_env(&file, None, None, None, &[]).unwrap();

        assert_eq!(resolved.sacrum_url, "http://file-url:4000");
        assert_eq!(resolved.api_token, "file-token");
        assert_eq!(resolved.project_ids, vec!["file-proj"]);
    }

    #[test]
    fn resolve_errors_when_no_token_available() {
        let file = DaemonConfigFile {
            sacrum_url: "http://localhost:4000".to_string(),
            api_token: None,
            project_ids: vec![],
        };

        let result = ResolvedConfig::resolve_with_env(&file, None, None, None, &[]);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("API token not found"),
            "Expected token error, got: {}",
            err
        );
    }

    #[test]
    fn resolve_uses_env_var_over_file_token() {
        let file = DaemonConfigFile {
            sacrum_url: "http://localhost:4000".to_string(),
            api_token: Some("file-token".to_string()),
            project_ids: vec![],
        };

        let resolved =
            ResolvedConfig::resolve_with_env(&file, None, None, Some("env-token"), &[]).unwrap();
        assert_eq!(resolved.api_token, "env-token");
    }

    #[test]
    fn resolve_cli_token_overrides_env_var() {
        let file = DaemonConfigFile::default();

        let resolved = ResolvedConfig::resolve_with_env(
            &file,
            None,
            Some("cli-token"),
            Some("env-token"),
            &[],
        )
        .unwrap();
        assert_eq!(resolved.api_token, "cli-token");
    }

    #[test]
    fn resolve_empty_cli_projects_falls_back_to_file() {
        let file = DaemonConfigFile {
            sacrum_url: "http://localhost:4000".to_string(),
            api_token: Some("tok".to_string()),
            project_ids: vec!["p1".to_string(), "p2".to_string()],
        };

        let resolved = ResolvedConfig::resolve_with_env(&file, None, None, None, &[]).unwrap();
        assert_eq!(resolved.project_ids, vec!["p1", "p2"]);
    }

    #[test]
    fn resolve_default_sacrum_url() {
        let file = DaemonConfigFile::default();

        let resolved =
            ResolvedConfig::resolve_with_env(&file, None, Some("tok"), None, &[]).unwrap();
        assert_eq!(resolved.sacrum_url, "http://localhost:4000");
    }

    #[test]
    fn resolve_env_token_used_when_no_cli_or_file_token() {
        let file = DaemonConfigFile {
            sacrum_url: "http://localhost:4000".to_string(),
            api_token: None,
            project_ids: vec![],
        };

        let resolved =
            ResolvedConfig::resolve_with_env(&file, None, None, Some("env-only"), &[]).unwrap();
        assert_eq!(resolved.api_token, "env-only");
    }

    #[test]
    fn resolve_cli_url_overrides_file_url() {
        let file = DaemonConfigFile {
            sacrum_url: "http://file:4000".to_string(),
            api_token: Some("tok".to_string()),
            project_ids: vec![],
        };

        let resolved =
            ResolvedConfig::resolve_with_env(&file, Some("http://cli:5000"), None, None, &[])
                .unwrap();
        assert_eq!(resolved.sacrum_url, "http://cli:5000");
    }

    #[test]
    fn resolve_cli_projects_override_file_projects() {
        let file = DaemonConfigFile {
            sacrum_url: "http://localhost:4000".to_string(),
            api_token: Some("tok".to_string()),
            project_ids: vec!["file-p1".to_string(), "file-p2".to_string()],
        };

        let resolved =
            ResolvedConfig::resolve_with_env(&file, None, None, None, &["cli-p1".to_string()])
                .unwrap();
        assert_eq!(resolved.project_ids, vec!["cli-p1"]);
    }

    // ===== ConfigError display tests =====

    #[test]
    fn config_error_display_missing() {
        let err = ConfigError::Missing("no token".to_string());
        assert_eq!(err.to_string(), "Missing required configuration: no token");
    }

    #[test]
    fn config_error_display_parse() {
        let err = ConfigError::Parse("bad toml".to_string());
        assert_eq!(err.to_string(), "Failed to parse config file: bad toml");
    }

    // ===== Serialization roundtrip test =====

    #[test]
    fn config_file_roundtrip() {
        let config = DaemonConfigFile {
            sacrum_url: "https://sacrum.example.com".to_string(),
            api_token: Some("my-secret".to_string()),
            project_ids: vec!["id-1".to_string(), "id-2".to_string()],
        };

        let serialized = toml::to_string_pretty(&config).unwrap();
        let deserialized: DaemonConfigFile = toml::from_str(&serialized).unwrap();

        assert_eq!(deserialized.sacrum_url, config.sacrum_url);
        assert_eq!(deserialized.api_token, config.api_token);
        assert_eq!(deserialized.project_ids, config.project_ids);
    }
}
