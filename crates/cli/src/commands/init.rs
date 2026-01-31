//! Init command for initializing vertebrae in a project
//!
//! Implements the `vtb init` command to:
//! 1. Check SACRUM_API_TOKEN environment variable is set
//! 2. Accept --url flag for Sacrum API endpoint (default localhost:4000)
//! 3. Derive project slug from git root folder name (or use --slug override)
//! 4. Check if project exists in Sacrum API, create if needed
//! 5. Upsert project entry into ~/.config/vertebrae/config.toml
//! 6. Copy skills from skills/ to .claude/skills/

use clap::Args;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use vertebrae_sacrum_client::{
    CreateProjectRequest, ProjectResponse, ProjectSection, SacrumClient, SacrumConfig,
    load_config_file, save_config_file,
};

/// Initialize vertebrae in the current project
#[derive(Debug, Args)]
pub struct InitCommand {
    /// Sacrum API base URL (default: http://localhost:4000)
    #[arg(long, default_value = "http://localhost:4000")]
    pub url: String,

    /// Override the auto-derived project slug
    #[arg(long)]
    pub slug: Option<String>,

    /// Source directory containing skills (defaults to "skills/")
    #[arg(long, default_value = "skills")]
    pub skills_source: PathBuf,

    /// Target directory for skills (defaults to ".claude/skills/")
    #[arg(long, default_value = ".claude/skills")]
    pub skills_target: PathBuf,
}

/// Result of the init command execution
#[derive(Debug)]
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
                "  Copied {} skill(s) to .claude/skills/",
                self.skills_copied
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
    /// Missing SACRUM_API_TOKEN environment variable
    MissingToken(String),
    /// Failed to get git root
    GitRoot { reason: String },
    /// Failed to derive project slug
    SlugDerive { reason: String },
    /// Duplicate slug in config
    DuplicateSlug { slug: String },
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
            InitError::GitRoot { reason } => {
                write!(f, "Failed to get git root directory: {}", reason)
            }
            InitError::SlugDerive { reason } => {
                write!(f, "Failed to derive project slug: {}", reason)
            }
            InitError::DuplicateSlug { slug } => {
                write!(
                    f,
                    "Project slug '{}' already exists in config. Use --slug to specify a different slug.",
                    slug
                )
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
    /// 1. Checks SACRUM_API_TOKEN is set
    /// 2. Gets git root directory
    /// 3. Derives project slug from folder name (or uses --slug override)
    /// 4. Checks if project exists in Sacrum, creates if not
    /// 5. Upserts project entry into ~/.config/vertebrae/config.toml
    /// 6. Copies skills from source to target directory
    pub async fn execute(&self) -> Result<InitResult, InitError> {
        // Check SACRUM_API_TOKEN is set
        let api_token = std::env::var("SACRUM_API_TOKEN").map_err(|_| {
            InitError::MissingToken(
                "Error: SACRUM_API_TOKEN environment variable not set\n\
                 Hint: Export your Sacrum API token: export SACRUM_API_TOKEN=your_token_here"
                    .to_string(),
            )
        })?;

        // Get git root directory
        let git_root = self.get_git_root()?;
        let base_path = &git_root;

        // Derive project slug from folder name
        let folder_name = base_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| InitError::SlugDerive {
                reason: "Failed to extract folder name".to_string(),
            })?
            .to_string();

        let project_slug = match &self.slug {
            Some(s) => self.derive_slug(s)?,
            None => self.derive_slug(&folder_name)?,
        };

        // Load existing config and check for duplicate slug
        let mut config_file = load_config_file().map_err(|e| InitError::ConfigError {
            reason: e.to_string(),
        })?;

        if config_file.projects.contains_key(&project_slug) {
            return Err(InitError::DuplicateSlug { slug: project_slug });
        }

        // Create Sacrum client and check/create project
        let config = SacrumConfig::new(self.url.clone(), api_token, "temp".to_string());
        let client = SacrumClient::new(config);

        let (project, created) = self
            .get_or_create_project(&client, &folder_name, &project_slug)
            .await?;

        // Upsert project entry into config file
        let url_override =
            if self.url != "http://localhost:4000" && self.url != config_file.sacrum.url {
                Some(self.url.clone())
            } else {
                None
            };

        config_file.projects.insert(
            project_slug.clone(),
            ProjectSection {
                project_id: project.id.clone(),
                url: url_override,
            },
        );

        let config_path =
            vertebrae_sacrum_client::config_path().ok_or_else(|| InitError::ConfigError {
                reason: "Could not determine config directory".to_string(),
            })?;

        save_config_file(&config_file).map_err(|e| InitError::WriteConfig {
            path: config_path.clone(),
            reason: e.to_string(),
        })?;

        // Copy skills
        let skills_target = base_path.join(&self.skills_target);
        self.create_dir_if_not_exists(&skills_target)?;
        let skills_source = base_path.join(&self.skills_source);
        let skills_copied = self.copy_skills(&skills_source, &skills_target)?;

        Ok(InitResult {
            config_path,
            project_slug,
            project_id: project.id,
            project_name: project.name,
            skills_copied,
            project_created: created,
        })
    }

    /// Get the git root directory
    fn get_git_root(&self) -> Result<PathBuf, InitError> {
        let output = StdCommand::new("git")
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .map_err(|e| InitError::GitRoot {
                reason: format!("Failed to run git command: {}", e),
            })?;

        if !output.status.success() {
            return Err(InitError::GitRoot {
                reason: "Not a git repository or git not installed".to_string(),
            });
        }

        let path = String::from_utf8(output.stdout)
            .map_err(|e| InitError::GitRoot {
                reason: format!("Invalid UTF-8 from git: {}", e),
            })?
            .trim()
            .to_string();

        Ok(PathBuf::from(path))
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
        client: &SacrumClient,
        name: &str,
        slug: &str,
    ) -> Result<(ProjectResponse, bool), InitError> {
        // Try to find existing project by slug
        match client.get::<Vec<ProjectResponse>>("/api/projects").await {
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
        let req = CreateProjectRequest {
            name: name.to_string(),
            slug: slug.to_string(),
        };

        match client
            .post::<ProjectResponse, _>("/api/projects", &req)
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
    /// Returns the number of files copied.
    fn copy_skills(&self, skills_source: &Path, skills_target: &Path) -> Result<usize, InitError> {
        // If source directory doesn't exist, return 0 (not an error)
        if !skills_source.exists() {
            return Ok(0);
        }

        let entries = fs::read_dir(skills_source).map_err(|e| InitError::ReadDir {
            path: skills_source.to_path_buf(),
            reason: e.to_string(),
        })?;

        let mut copied = 0;

        for entry in entries {
            let entry = entry.map_err(|e| InitError::ReadDir {
                path: skills_source.to_path_buf(),
                reason: e.to_string(),
            })?;

            let path = entry.path();

            // Only copy files (not directories)
            if !path.is_file() {
                continue;
            }

            // Get the file name
            let file_name = match path.file_name() {
                Some(name) => name,
                None => continue,
            };

            let target_path = skills_target.join(file_name);

            fs::copy(&path, &target_path).map_err(|e| InitError::CopyFile {
                source: path.clone(),
                target: target_path.clone(),
                reason: e.to_string(),
            })?;

            copied += 1;
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
            url: "http://localhost:4000".to_string(),
            slug: None,
            skills_source: PathBuf::from("skills"),
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

        // Create source skills directory with test files
        let skills_source = temp_dir.join("skills");
        fs::create_dir_all(&skills_source).unwrap();
        fs::write(skills_source.join("skill1.md"), "# Skill 1").unwrap();
        fs::write(skills_source.join("skill2.md"), "# Skill 2").unwrap();

        let skills_target = temp_dir.join(".claude/skills");
        fs::create_dir_all(&skills_target).unwrap();

        let cmd = default_cmd();

        let result = cmd.copy_skills(&skills_source, &skills_target);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 2);

        // Verify files were copied
        assert!(skills_target.join("skill1.md").exists());
        assert!(skills_target.join("skill2.md").exists());

        // Verify content
        let content = fs::read_to_string(skills_target.join("skill1.md")).unwrap();
        assert_eq!(content, "# Skill 1");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_skips_nonexistent_source() {
        let temp_dir = create_temp_dir("nosource");
        fs::create_dir_all(&temp_dir).unwrap();

        let skills_source = temp_dir.join("nonexistent");
        let skills_target = temp_dir.join(".claude/skills");
        fs::create_dir_all(&skills_target).unwrap();

        let cmd = default_cmd();

        let result = cmd.copy_skills(&skills_source, &skills_target);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_skips_directories_in_skills() {
        let temp_dir = create_temp_dir("subdir");
        fs::create_dir_all(&temp_dir).unwrap();

        // Create source with file and subdirectory
        let skills_source = temp_dir.join("skills");
        fs::create_dir_all(&skills_source).unwrap();
        fs::write(skills_source.join("skill.md"), "# Skill").unwrap();
        fs::create_dir_all(skills_source.join("subdir")).unwrap();

        let skills_target = temp_dir.join(".claude/skills");
        fs::create_dir_all(&skills_target).unwrap();

        let cmd = default_cmd();

        let result = cmd.copy_skills(&skills_source, &skills_target);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 1); // Only the file, not the subdir

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
            project_created: true,
        };

        let output = format!("{}", result);
        assert!(output.contains("Vertebrae initialized successfully"));
        assert!(output.contains(".config/vertebrae/config.toml"));
        assert!(output.contains("my-project"));
        assert!(output.contains("proj-123"));
        assert!(output.contains("My Project"));
        assert!(output.contains("Copied 5 skill(s)"));
    }

    #[test]
    fn test_init_result_display_existing_project() {
        let result = InitResult {
            config_path: PathBuf::from("/home/user/.config/vertebrae/config.toml"),
            project_slug: "vertebrae".to_string(),
            project_id: "proj-456".to_string(),
            project_name: "Vertebrae".to_string(),
            skills_copied: 0,
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
    fn test_init_error_git_root() {
        let err = InitError::GitRoot {
            reason: "Not a git repo".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Failed to get git root directory"));
        assert!(output.contains("Not a git repo"));
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
    fn test_init_error_duplicate_slug() {
        let err = InitError::DuplicateSlug {
            slug: "my-project".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("my-project"));
        assert!(output.contains("already exists"));
        assert!(output.contains("--slug"));
    }

    #[test]
    fn test_init_error_config_error() {
        let err = InitError::ConfigError {
            reason: "Could not determine config directory".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Config error"));
    }

    #[test]
    fn test_init_command_debug() {
        let cmd = default_cmd();
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("InitCommand"));
        assert!(debug_str.contains("url"));
    }

    #[test]
    fn test_init_command_with_slug_override() {
        let cmd = InitCommand {
            url: "http://localhost:4000".to_string(),
            slug: Some("custom-slug".to_string()),
            skills_source: PathBuf::from("skills"),
            skills_target: PathBuf::from(".claude/skills"),
        };
        assert_eq!(cmd.slug.as_deref(), Some("custom-slug"));
    }
}
