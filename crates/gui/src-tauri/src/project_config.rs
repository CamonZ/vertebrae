//! Project configuration management for the GUI
//!
//! Handles persistent storage of known projects and current project selection.
//! Projects are stored in the app data directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

/// The persisted project configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectConfigFile {
    /// Currently selected project slug (if any)
    pub current_project_slug: Option<String>,
    /// Last-used live chat session id per project slug. Allows the GUI to
    /// reopen the previous conversation on relaunch / project switch since the
    /// V0 sacrum API exposes no list-sessions-for-project query.
    #[serde(default)]
    pub active_chat_sessions: HashMap<String, String>,
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

    /// Get the cached active chat session id for the given project slug, if any.
    pub fn get_active_chat_session(&self, slug: &str) -> Option<String> {
        self.load().active_chat_sessions.get(slug).cloned()
    }

    /// Set or clear the cached active chat session id for the given project slug.
    pub fn set_active_chat_session(
        &self,
        slug: &str,
        session_id: Option<String>,
    ) -> Result<(), String> {
        let mut config = self.load();
        match session_id {
            Some(id) => {
                config.active_chat_sessions.insert(slug.to_string(), id);
            }
            None => {
                config.active_chat_sessions.remove(slug);
            }
        }
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
        assert!(result.active_chat_sessions.is_empty());

        let _ = fs::remove_dir_all(&config_dir);
    }

    fn unique_config(slug_suffix: &str) -> (PathBuf, ProjectConfig) {
        let config_dir = env::temp_dir().join(format!(
            "vtb-gui-test-chat-{}-{}",
            std::process::id(),
            slug_suffix
        ));
        let _ = fs::create_dir_all(&config_dir);
        let config_path = config_dir.join("projects.json");
        let config = ProjectConfig {
            config_path: config_path.clone(),
        };
        (config_dir, config)
    }

    #[test]
    fn test_set_and_get_active_chat_session_round_trips() {
        let (dir, config) = unique_config("round-trip");

        assert!(config.get_active_chat_session("alpha").is_none());

        config
            .set_active_chat_session("alpha", Some("sess-abc".to_string()))
            .unwrap();

        assert_eq!(
            config.get_active_chat_session("alpha"),
            Some("sess-abc".to_string())
        );

        // Other slugs are untouched.
        assert!(config.get_active_chat_session("beta").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_clearing_active_chat_session_removes_entry() {
        let (dir, config) = unique_config("clear");

        config
            .set_active_chat_session("alpha", Some("sess-1".to_string()))
            .unwrap();
        config
            .set_active_chat_session("beta", Some("sess-2".to_string()))
            .unwrap();

        config.set_active_chat_session("alpha", None).unwrap();

        assert!(config.get_active_chat_session("alpha").is_none());
        assert_eq!(
            config.get_active_chat_session("beta"),
            Some("sess-2".to_string())
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_active_chat_session_persists_across_loads() {
        let (dir, _) = unique_config("persist");
        let config_path = dir.join("projects.json");

        {
            let config = ProjectConfig {
                config_path: config_path.clone(),
            };
            config
                .set_active_chat_session("alpha", Some("sess-persist".to_string()))
                .unwrap();
            config
                .set_active_chat_session("beta", Some("sess-other".to_string()))
                .unwrap();
        }

        let config = ProjectConfig { config_path };
        assert_eq!(
            config.get_active_chat_session("alpha"),
            Some("sess-persist".to_string())
        );
        assert_eq!(
            config.get_active_chat_session("beta"),
            Some("sess-other".to_string())
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
