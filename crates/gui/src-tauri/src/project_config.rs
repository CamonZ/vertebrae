//! Project configuration management for the GUI
//!
//! Handles persistent storage of known projects and current project selection.
//! Projects are stored in the app data directory.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// A saved project in the project list
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SavedProject {
    /// Project slug (from config.toml key)
    pub slug: String,
    /// Sacrum project ID (UUID)
    pub project_id: String,
    /// Optional per-project URL override
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// The persisted project configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectConfigFile {
    /// Currently selected project slug (if any)
    pub current_project_slug: Option<String>,
}

/// Configuration manager for project settings
pub struct ProjectConfig {
    config_path: PathBuf,
}

impl ProjectConfig {
    /// Create a new project configuration manager
    pub fn new() -> Result<Self, String> {
        let config_dir = dirs::data_dir()
            .ok_or_else(|| "Could not determine app data directory".to_string())?
            .join("com.vertebrae.gui");

        // Ensure config directory exists
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }

        let config_path = config_dir.join("projects.json");

        Ok(Self { config_path })
    }

    /// Create a new project configuration manager with a custom config path.
    /// This is primarily for testing.
    #[cfg(test)]
    pub fn with_path(config_path: PathBuf) -> Self {
        Self { config_path }
    }

    /// Load the project configuration from disk
    fn load(&self) -> ProjectConfigFile {
        if !self.config_path.exists() {
            return ProjectConfigFile::default();
        }

        fs::read_to_string(&self.config_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    }

    /// Save the project configuration to disk
    fn save(&self, config: &ProjectConfigFile) -> Result<(), String> {
        let content = serde_json::to_string_pretty(config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        fs::write(&self.config_path, content).map_err(|e| format!("Failed to write config: {}", e))
    }

    /// Get all saved projects from config.toml
    pub fn get_projects(&self) -> Vec<SavedProject> {
        match vertebrae_sacrum_client::load_config_file() {
            Ok(config) => config
                .projects
                .into_iter()
                .map(|(slug, project_section)| SavedProject {
                    slug,
                    project_id: project_section.project_id,
                    url: project_section.url,
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Get the currently selected project slug
    pub fn get_current_project(&self) -> Option<String> {
        self.load().current_project_slug
    }

    /// Set the current project by slug
    pub fn set_current_project(&self, slug: Option<String>) -> Result<(), String> {
        // Validate that the project exists in config.toml (if setting a project)
        if let Some(ref s) = slug {
            let config = vertebrae_sacrum_client::load_config_file()
                .map_err(|e| format!("Failed to load config file: {}", e))?;
            if !config.projects.contains_key(s) {
                return Err(format!("Project '{}' not found in config", s));
            }
        }

        let mut config = self.load();
        config.current_project_slug = slug;
        self.save(&config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_config_path() -> PathBuf {
        env::temp_dir().join(format!("vtb-gui-test-{}", std::process::id()))
    }

    #[test]
    fn test_load_empty_config() {
        let config_dir = temp_config_path();
        let _ = fs::create_dir_all(&config_dir);

        let config = ProjectConfig {
            config_path: config_dir.join("projects.json"),
        };

        let result = config.load();
        assert!(result.current_project_slug.is_none());

        let _ = fs::remove_dir_all(&config_dir);
    }
}
