//! GUI app-state management.
//!
//! Persists GUI-local view state to `app-state.json` in the shared Vertebrae
//! data directory (`vertebrae_installer::data_dir()`, e.g. on macOS
//! `~/Library/Application Support/Vertebrae/`):
//!
//! - the last opened project.
//!
//! The project *registry* (which projects exist, their ids and paths) lives in
//! the shared `config.toml` read via `vertebrae_sacrum_client`; this file only
//! tracks GUI-local view state on top of it.

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
    /// Git root path for the project
    pub path: String,
}

/// The persisted GUI app state (`app-state.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppStateFile {
    /// Currently selected project slug (if any)
    pub current_project_slug: Option<String>,
}

/// Manager for the GUI app-state file.
pub struct ProjectConfig {
    config_path: PathBuf,
}

impl ProjectConfig {
    /// Create a new app-state manager rooted at the shared Vertebrae data dir.
    pub fn new() -> Result<Self, String> {
        let config_dir = vertebrae_installer::data_dir()
            .map_err(|e| format!("Could not determine app data directory: {}", e))?;

        // Ensure config directory exists
        if !config_dir.exists() {
            fs::create_dir_all(&config_dir)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }

        let config_path = config_dir.join("app-state.json");

        Ok(Self { config_path })
    }

    /// Create a new app-state manager with a custom config path.
    /// This is primarily for testing.
    #[cfg(test)]
    pub fn with_path(config_path: PathBuf) -> Self {
        Self { config_path }
    }

    /// Load the app state from disk
    fn load(&self) -> AppStateFile {
        if !self.config_path.exists() {
            return AppStateFile::default();
        }

        fs::read_to_string(&self.config_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    }

    /// Save the app state to disk
    fn save(&self, config: &AppStateFile) -> Result<(), String> {
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
                    project_id: project_section.id,
                    path: project_section.path,
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

    fn unique_config(suffix: &str) -> (PathBuf, ProjectConfig) {
        let config_dir =
            env::temp_dir().join(format!("vtb-gui-test-{}-{}", std::process::id(), suffix));
        let _ = fs::create_dir_all(&config_dir);
        let config_path = config_dir.join("app-state.json");
        let config = ProjectConfig {
            config_path: config_path.clone(),
        };
        (config_dir, config)
    }

    #[test]
    fn test_load_empty_config() {
        let (dir, config) = unique_config("empty");

        let result = config.load();
        assert!(result.current_project_slug.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_current_project_round_trips_when_unvalidated() {
        // Bypass set_current_project's config.toml validation by writing the
        // state file directly, then confirm it survives a fresh load.
        let (dir, _) = unique_config("round-trip");
        let config_path = dir.join("app-state.json");

        {
            let config = ProjectConfig {
                config_path: config_path.clone(),
            };
            config
                .save(&AppStateFile {
                    current_project_slug: Some("alpha".to_string()),
                })
                .unwrap();
        }

        let config = ProjectConfig { config_path };
        assert_eq!(config.get_current_project(), Some("alpha".to_string()));

        let _ = fs::remove_dir_all(&dir);
    }
}
