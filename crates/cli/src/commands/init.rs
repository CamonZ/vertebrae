//! Init command for initializing vertebrae in a project
//!
//! Implements the `vtb init` command to:
//! 1. Read or bootstrap global config at ~/.config/vertebrae/config.toml
//! 2. Accept --token flag for first-time setup (sets [sacrum].token)
//! 3. Accept --url flag for Sacrum API endpoint (default from config or localhost:4000)
//! 4. Derive project slug from current directory name
//! 5. Check if project exists in Sacrum API, create if needed
//! 6. Register the project in global config
//! 7. Write embedded skills to the configured target directory

use clap::Args;
use include_dir::{Dir, include_dir};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use vertebrae_sacrum_client::{
    GraphqlClient, SacrumConfig, config_path, load_config_file, register_project, save_config_file,
};

/// Embedded skills directory at compile time
const SKILLS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../skills");

/// Initialize vertebrae in the current project
#[derive(Debug, Args)]
pub struct InitCommand {
    /// Sacrum API base URL (overrides config file value)
    #[arg(long)]
    pub url: Option<String>,

    /// API token for Sacrum authentication (saved to config file)
    #[arg(long)]
    pub token: Option<String>,

    /// Target directory for skills (defaults to ".claude/skills")
    #[arg(long, default_value = ".claude/skills")]
    pub skills_target: PathBuf,
}

/// Result of the init command execution
#[derive(Debug, Serialize)]
pub struct InitResult {
    /// Path to the config file
    pub config_path: PathBuf,
    /// Project slug in config
    pub project_slug: String,
    /// Project ID in Sacrum
    pub project_id: String,
    /// Project name
    pub project_name: String,
    /// Number of skills copied
    pub skills_copied: usize,
    /// Directory where embedded skills were copied
    pub skills_target: PathBuf,
    /// Whether the project was newly created
    pub project_created: bool,
}

impl std::fmt::Display for InitResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Vertebrae initialized successfully!")?;
        writeln!(f)?;
        writeln!(f, "  Config file: {}", self.config_path.display())?;
        writeln!(f, "  Project slug: {}", self.project_slug)?;
        writeln!(f, "  Project name: {}", self.project_name)?;
        writeln!(f, "  Project ID: {}", self.project_id)?;

        if self.project_created {
            writeln!(f, "  Created new Sacrum project")?;
        } else {
            writeln!(f, "  Found existing Sacrum project")?;
        }

        if self.skills_copied > 0 {
            write!(
                f,
                "  Copied {} skill(s) to {}",
                self.skills_copied,
                self.skills_target.display()
            )?;
        } else {
            write!(
                f,
                "  No skills to copy (source directory not found or empty)"
            )?;
        }

        Ok(())
    }
}

/// Error type for init command failures
#[derive(Debug)]
pub enum InitError {
    /// Missing API token (not in config and not provided via --token)
    MissingToken(String),
    /// Failed to get current directory
    CurrentDir { reason: String },
    /// Failed to derive project slug
    SlugDerive { reason: String },
    /// Failed to communicate with Sacrum API
    SacrumApi { reason: String },
    /// Failed to create directory
    CreateDir { path: PathBuf, reason: String },
    /// Failed to copy file
    CopyFile {
        source: PathBuf,
        target: PathBuf,
        reason: String,
    },
    /// Failed to read directory
    ReadDir { path: PathBuf, reason: String },
    /// Failed to write config file
    WriteConfig { path: PathBuf, reason: String },
    /// Config error
    ConfigError { reason: String },
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InitError::MissingToken(reason) => write!(f, "{}", reason),
            InitError::CurrentDir { reason } => {
                write!(f, "Failed to get current directory: {}", reason)
            }
            InitError::SlugDerive { reason } => {
                write!(f, "Failed to derive project slug: {}", reason)
            }
            InitError::SacrumApi { reason } => {
                write!(f, "Failed to communicate with Sacrum API: {}", reason)
            }
            InitError::CreateDir { path, reason } => {
                write!(
                    f,
                    "Failed to create directory '{}': {}",
                    path.display(),
                    reason
                )
            }
            InitError::CopyFile {
                source,
                target,
                reason,
            } => {
                write!(
                    f,
                    "Failed to copy '{}' to '{}': {}",
                    source.display(),
                    target.display(),
                    reason
                )
            }
            InitError::ReadDir { path, reason } => {
                write!(
                    f,
                    "Failed to read directory '{}': {}",
                    path.display(),
                    reason
                )
            }
            InitError::WriteConfig { path, reason } => {
                write!(
                    f,
                    "Failed to write config file '{}': {}",
                    path.display(),
                    reason
                )
            }
            InitError::ConfigError { reason } => {
                write!(f, "Config error: {}", reason)
            }
        }
    }
}

impl std::error::Error for InitError {}

impl InitCommand {
    /// Execute the init command.
    ///
    /// 1. Loads or bootstraps global config
    /// 2. Resolves API token (from --token flag or existing config)
    /// 3. Gets current directory
    /// 4. Derives project slug from folder name
    /// 5. Checks if project exists in Sacrum, creates if not
    /// 6. Registers project in global config
    /// 7. Copies skills from source to target directory
    pub async fn execute(&self) -> Result<InitResult, InitError> {
        // Load existing global config (or default if none exists)
        let mut config_file = load_config_file().map_err(|e| InitError::ConfigError {
            reason: e.to_string(),
        })?;

        // Resolve API token: --token flag takes precedence, then existing config
        let api_token = if let Some(ref token) = self.token {
            // Update config with the provided token
            config_file.sacrum.token = Some(token.clone());
            token.clone()
        } else {
            config_file.sacrum.token.clone().ok_or_else(|| {
                InitError::MissingToken(
                    "No API token found.\n\
                     Hint: Run `vtb init --token <your_token>` to set up authentication,\n\
                     or add [sacrum].token to ~/.config/vertebrae/config.toml"
                        .to_string(),
                )
            })?
        };

        // Update URL if provided via --url flag
        if let Some(ref url) = self.url {
            config_file.sacrum.url = url.clone();
        }

        let base_url = config_file.sacrum.url.clone();

        // Save config if --token or --url were provided (bootstrap the [sacrum] section)
        if self.token.is_some() || self.url.is_some() {
            save_config_file(&config_file).map_err(|e| InitError::WriteConfig {
                path: config_path().unwrap_or_default(),
                reason: e.to_string(),
            })?;
        }

        // Get current directory
        let current_dir = std::env::current_dir().map_err(|e| InitError::CurrentDir {
            reason: e.to_string(),
        })?;

        // Derive project slug from current directory name
        let folder_name = current_dir
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| InitError::SlugDerive {
                reason: "Failed to extract folder name".to_string(),
            })?
            .to_string();

        let project_slug = self.derive_slug(&folder_name)?;

        // Create Sacrum client and check/create project
        let config = SacrumConfig::new(base_url, api_token, "temp".to_string());
        let client = GraphqlClient::new(config);

        let (project, created) = self
            .get_or_create_project(&client, &folder_name, &project_slug)
            .await?;

        // Register project in global config
        let project_path = current_dir
            .canonicalize()
            .unwrap_or(current_dir.clone())
            .to_string_lossy()
            .to_string();

        register_project(&project_slug, &project.id, &project_path).map_err(|e| {
            InitError::WriteConfig {
                path: config_path().unwrap_or_default(),
                reason: e.to_string(),
            }
        })?;

        // Copy skills
        let skills_target = current_dir.join(&self.skills_target);
        self.create_dir_if_not_exists(&skills_target)?;
        let skills_copied = self.copy_skills(&SKILLS_DIR, &skills_target)?;

        Ok(InitResult {
            config_path: config_path().unwrap_or_default(),
            project_slug,
            project_id: project.id,
            project_name: project.name,
            skills_copied,
            skills_target,
            project_created: created,
        })
    }

    /// Derive a URL-friendly slug from a folder name
    /// Converts to lowercase, replaces spaces and special chars with hyphens
    fn derive_slug(&self, name: &str) -> Result<String, InitError> {
        let slug = slug::slugify(name);
        if slug.is_empty() {
            return Err(InitError::SlugDerive {
                reason: format!("Could not create valid slug from: {}", name),
            });
        }
        Ok(slug)
    }

    /// Get existing project or create a new one
    async fn get_or_create_project(
        &self,
        client: &GraphqlClient,
        name: &str,
        slug: &str,
    ) -> Result<(vertebrae_sacrum_client::ProjectResponse, bool), InitError> {
        use vertebrae_sacrum_client::queries::projects;

        // Try to find existing project by slug
        match client
            .execute::<Vec<vertebrae_sacrum_client::ProjectResponse>>(
                projects::LIST_PROJECTS,
                serde_json::json!({}),
                "projects",
            )
            .await
        {
            Ok(projects) => {
                if let Some(project) = projects.iter().find(|p| p.slug == slug) {
                    return Ok((project.clone(), false));
                }
            }
            Err(e) => {
                return Err(InitError::SacrumApi {
                    reason: format!("Failed to list projects: {}", e),
                });
            }
        }

        // Project not found, create it
        match client
            .execute::<vertebrae_sacrum_client::ProjectResponse>(
                projects::CREATE_PROJECT,
                serde_json::json!({
                    "name": name,
                    "slug": slug,
                }),
                "create_project",
            )
            .await
        {
            Ok(project) => Ok((project, true)),
            Err(e) => Err(InitError::SacrumApi {
                reason: format!("Failed to create project: {}", e),
            }),
        }
    }

    /// Create a directory if it doesn't exist.
    ///
    /// Returns true if the directory was created, false if it already existed.
    fn create_dir_if_not_exists(&self, path: &Path) -> Result<bool, InitError> {
        if path.exists() {
            return Ok(false);
        }

        fs::create_dir_all(path).map_err(|e| InitError::CreateDir {
            path: path.to_path_buf(),
            reason: e.to_string(),
        })?;

        Ok(true)
    }

    /// Copy skill files from source to target directory.
    ///
    /// Recursively copies the embedded directory structure (e.g., skills/add/SKILL.md).
    /// Returns the number of files copied.
    fn copy_skills(&self, skills_source: &Dir, skills_target: &Path) -> Result<usize, InitError> {
        let mut copied = 0;

        // Copy files at this level
        for file in skills_source.files() {
            let target_path = skills_target.join(file.path());

            if let Some(parent) = target_path.parent() {
                self.create_dir_if_not_exists(parent)?;
            }

            let content = file.contents();
            fs::write(&target_path, content).map_err(|e| InitError::CopyFile {
                source: file.path().to_path_buf(),
                target: target_path.clone(),
                reason: e.to_string(),
            })?;

            copied += 1;
        }

        // Recurse into subdirectories
        for dir in skills_source.dirs() {
            let dir_target = skills_target.join(dir.path());
            self.create_dir_if_not_exists(&dir_target)?;

            for file in dir.files() {
                let target_path = skills_target.join(file.path());

                let content = file.contents();
                fs::write(&target_path, content).map_err(|e| InitError::CopyFile {
                    source: file.path().to_path_buf(),
                    target: target_path.clone(),
                    reason: e.to_string(),
                })?;

                copied += 1;
            }
        }

        Ok(copied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a temporary test directory
    fn create_temp_dir(prefix: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "vtb-init-test-{}-{}-{:?}-{}",
            prefix,
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// Clean up test directory
    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    fn default_cmd() -> InitCommand {
        InitCommand {
            url: None,
            token: None,
            skills_target: PathBuf::from(".claude/skills"),
        }
    }

    #[test]
    fn test_derive_slug_lowercase() {
        let cmd = default_cmd();
        let slug = cmd.derive_slug("My Project").unwrap();
        assert_eq!(slug, "my-project");
    }

    #[test]
    fn test_derive_slug_with_spaces() {
        let cmd = default_cmd();
        let slug = cmd.derive_slug("Project With Spaces").unwrap();
        assert_eq!(slug, "project-with-spaces");
    }

    #[test]
    fn test_derive_slug_with_special_chars() {
        let cmd = default_cmd();
        let slug = cmd.derive_slug("My-Project_123").unwrap();
        // slug crate will handle the conversion
        assert!(!slug.is_empty());
    }

    #[test]
    fn test_derive_slug_empty() {
        let cmd = default_cmd();
        let result = cmd.derive_slug("@#$%");
        assert!(result.is_err());
    }

    #[test]
    fn test_init_copies_skills() {
        let temp_dir = create_temp_dir("copy");
        fs::create_dir_all(&temp_dir).unwrap();

        let skills_target = temp_dir.join(".claude/skills");
        fs::create_dir_all(&skills_target).unwrap();

        let cmd = default_cmd();

        let result = cmd.copy_skills(&SKILLS_DIR, &skills_target);
        assert!(result.is_ok());
        // Should copy all the embedded skill files
        let count = result.unwrap();
        assert!(count > 0, "Should have copied at least one skill file");

        // Verify at least one known skill folder/file exists
        assert!(skills_target.join("add/SKILL.md").exists());

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_embedded_skills_exist() {
        // Verify that SKILLS_DIR contains subdirectories with SKILL.md files
        let dir_count = SKILLS_DIR.dirs().count();
        assert!(
            dir_count > 0,
            "SKILLS_DIR should contain embedded skill directories"
        );
    }

    #[test]
    fn test_init_does_not_embed_repo_internal_gui_dev_skill() {
        assert!(
            SKILLS_DIR.get_dir("gui-dev").is_none(),
            "repo-internal gui-dev skill should not be copied by vtb init"
        );
        assert!(
            SKILLS_DIR.get_file("gui-dev/SKILL.md").is_none(),
            "repo-internal gui-dev skill file should not be embedded"
        );
    }

    #[test]
    fn test_init_skips_nonexistent_source() {
        // This test is no longer applicable since skills are embedded
        // and always available. We just verify the embedded skills work.
        let temp_dir = create_temp_dir("nosource");
        fs::create_dir_all(&temp_dir).unwrap();

        let skills_target = temp_dir.join(".claude/skills");
        fs::create_dir_all(&skills_target).unwrap();

        let cmd = default_cmd();

        let result = cmd.copy_skills(&SKILLS_DIR, &skills_target);
        assert!(result.is_ok());
        // Embedded skills are always available
        assert!(result.unwrap() > 0);

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_writes_skill_content() {
        let temp_dir = create_temp_dir("content");
        fs::create_dir_all(&temp_dir).unwrap();

        let skills_target = temp_dir.join(".claude/skills");
        fs::create_dir_all(&skills_target).unwrap();

        let cmd = default_cmd();

        let result = cmd.copy_skills(&SKILLS_DIR, &skills_target);
        assert!(result.is_ok());

        // Verify that written files have content
        if skills_target.join("add/SKILL.md").exists() {
            let content = fs::read_to_string(skills_target.join("add/SKILL.md")).unwrap();
            assert!(!content.is_empty(), "Skill file should have content");
        }

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_create_dir_if_not_exists() {
        let temp_dir = create_temp_dir("createdir");
        fs::create_dir_all(&temp_dir).unwrap();

        let new_dir = temp_dir.join("new-dir");
        let cmd = default_cmd();

        let result = cmd.create_dir_if_not_exists(&new_dir);
        assert!(result.is_ok());
        assert!(result.unwrap());
        assert!(new_dir.exists());

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_existing_dir_not_created() {
        let temp_dir = create_temp_dir("existing");
        fs::create_dir_all(&temp_dir).unwrap();

        let cmd = default_cmd();

        let result = cmd.create_dir_if_not_exists(&temp_dir);
        assert!(result.is_ok());
        assert!(!result.unwrap()); // Was not newly created

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_result_display() {
        let result = InitResult {
            config_path: PathBuf::from("/home/user/.config/vertebrae/config.toml"),
            project_slug: "my-project".to_string(),
            project_id: "proj-123".to_string(),
            project_name: "My Project".to_string(),
            skills_copied: 5,
            skills_target: PathBuf::from("/tmp/my-project/.custom/skills"),
            project_created: true,
        };

        let output = format!("{}", result);
        assert!(output.contains("Vertebrae initialized successfully"));
        assert!(output.contains("config.toml"));
        assert!(output.contains("my-project"));
        assert!(output.contains("proj-123"));
        assert!(output.contains("My Project"));
        assert!(output.contains("Copied 5 skill(s)"));
        assert!(output.contains("/tmp/my-project/.custom/skills"));
    }

    #[test]
    fn test_init_result_display_existing_project() {
        let result = InitResult {
            config_path: PathBuf::from("/home/user/.config/vertebrae/config.toml"),
            project_slug: "vertebrae".to_string(),
            project_id: "proj-456".to_string(),
            project_name: "Vertebrae".to_string(),
            skills_copied: 0,
            skills_target: PathBuf::from(".claude/skills"),
            project_created: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Found existing Sacrum project"));
        assert!(output.contains("No skills to copy"));
    }

    #[test]
    fn test_init_error_missing_token() {
        let err = InitError::MissingToken("test error".to_string());
        let output = format!("{}", err);
        assert!(output.contains("test error"));
    }

    #[test]
    fn test_init_error_current_dir() {
        let err = InitError::CurrentDir {
            reason: "Permission denied".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Failed to get current directory"));
        assert!(output.contains("Permission denied"));
    }

    #[test]
    fn test_init_error_sacrum_api() {
        let err = InitError::SacrumApi {
            reason: "Connection failed".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Failed to communicate with Sacrum API"));
        assert!(output.contains("Connection failed"));
    }

    #[test]
    fn test_init_error_config_error() {
        let err = InitError::ConfigError {
            reason: "Could not serialize config".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Config error"));
    }

    #[test]
    fn test_init_command_debug() {
        let cmd = default_cmd();
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("InitCommand"));
    }
}
