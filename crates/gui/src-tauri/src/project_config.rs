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
    /// Display name for the project
    pub name: String,
    /// Path to the project directory
    pub path: String,
    /// Whether a vtb database exists at this project path
    pub has_database: bool,
    /// Whether the project directory still exists on disk
    pub exists: bool,
}

/// The persisted project configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectConfigFile {
    /// List of known project paths
    pub projects: Vec<ProjectEntry>,
    /// Currently selected project path (if any)
    pub current_project: Option<String>,
}

/// A project entry in the config file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// Display name for the project
    pub name: String,
    /// Path to the project directory
    pub path: String,
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

    /// Get all saved projects with their current status
    pub fn get_projects(&self) -> Vec<SavedProject> {
        let config = self.load();

        config
            .projects
            .into_iter()
            .map(|entry| {
                let path = PathBuf::from(&entry.path);
                let exists = path.exists();
                let has_database = exists && path.join(".vtb/data").exists();

                SavedProject {
                    name: entry.name,
                    path: entry.path,
                    has_database,
                    exists,
                }
            })
            .collect()
    }

    /// Add a project to the saved list
    ///
    /// Returns the saved project with current status
    pub fn add_project(&self, name: String, path: String) -> Result<SavedProject, String> {
        let path_buf = PathBuf::from(&path);

        // Validate the path exists
        if !path_buf.exists() {
            return Err(format!("Directory does not exist: {}", path));
        }

        // Check if already added
        let mut config = self.load();
        if config.projects.iter().any(|p| p.path == path) {
            return Err("Project already exists in list".to_string());
        }

        // Add to list
        config.projects.push(ProjectEntry {
            name: name.clone(),
            path: path.clone(),
        });

        self.save(&config)?;

        let has_database = path_buf.join(".vtb/data").exists();

        Ok(SavedProject {
            name,
            path,
            has_database,
            exists: true,
        })
    }

    /// Remove a project from the saved list
    pub fn remove_project(&self, path: &str) -> Result<(), String> {
        let mut config = self.load();
        let initial_len = config.projects.len();

        config.projects.retain(|p| p.path != path);

        if config.projects.len() == initial_len {
            return Err("Project not found in list".to_string());
        }

        // Clear current project if it was removed
        if config.current_project.as_deref() == Some(path) {
            config.current_project = None;
        }

        self.save(&config)
    }

    /// Get the currently selected project path
    pub fn get_current_project(&self) -> Option<String> {
        self.load().current_project
    }

    /// Set the current project
    pub fn set_current_project(&self, path: Option<String>) -> Result<(), String> {
        let mut config = self.load();

        // Validate that the project is in the list (if setting a project)
        if let Some(ref p) = path {
            if !config.projects.iter().any(|proj| &proj.path == p) {
                return Err("Project not in saved list".to_string());
            }
        }

        config.current_project = path;
        self.save(&config)
    }

    /// Check if a vtb database exists at the given path
    pub fn database_exists(path: &str) -> bool {
        PathBuf::from(path).join(".vtb/data").exists()
    }

    /// Initialize a vtb database at the given path
    pub async fn init_database(path: &str) -> Result<(), String> {
        let db_path = PathBuf::from(path).join(".vtb/data");

        let db = vertebrae_db::Database::connect(&db_path)
            .await
            .map_err(|e| format!("Failed to connect to database: {}", e))?;

        db.init()
            .await
            .map_err(|e| format!("Failed to initialize database: {}", e))
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
        assert!(result.projects.is_empty());
        assert!(result.current_project.is_none());

        let _ = fs::remove_dir_all(&config_dir);
    }
}
