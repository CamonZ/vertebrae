//! Init command for initializing vertebrae in a project
//!
//! Implements the `vtb init` command to:
//! 1. Create the .vtb/ database directory
//! 2. Copy skills from skills/ to .claude/skills/

use clap::Args;
use std::fs;
use std::path::{Path, PathBuf};
use vertebrae_db::find_project_root;

/// Initialize vertebrae in the current project
#[derive(Debug, Args)]
pub struct InitCommand {
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
    /// Path to the created .vtb/ directory
    pub db_path: PathBuf,
    /// Number of skills copied
    pub skills_copied: usize,
    /// Whether the db directory was newly created
    pub db_created: bool,
    /// Whether the skills directory was newly created
    pub skills_dir_created: bool,
}

impl std::fmt::Display for InitResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Vertebrae initialized successfully!")?;
        writeln!(f)?;

        if self.db_created {
            writeln!(
                f,
                "  Created database directory: {}",
                self.db_path.display()
            )?;
        } else {
            writeln!(
                f,
                "  Database directory already exists: {}",
                self.db_path.display()
            )?;
        }

        if self.skills_dir_created {
            writeln!(f, "  Created skills directory: .claude/skills/")?;
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
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
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
        }
    }
}

impl std::error::Error for InitError {}

impl InitCommand {
    /// Execute the init command.
    ///
    /// Creates the .vtb/ database directory and copies skills from the source
    /// directory to .claude/skills/.
    ///
    /// # Errors
    ///
    /// Returns `InitError` if:
    /// - Failed to create directories
    /// - Failed to copy skill files
    pub fn execute(&self) -> Result<InitResult, InitError> {
        // Use git project root if available, otherwise fall back to current directory
        let base_path = find_project_root().unwrap_or_else(|| PathBuf::from("."));
        let db_path = base_path.join(".vtb/data");
        let db_created = self.create_dir_if_not_exists(&db_path)?;

        // Resolve skills paths relative to project root
        let skills_source = base_path.join(&self.skills_source);
        let skills_target = base_path.join(&self.skills_target);

        let skills_dir_created = self.create_dir_if_not_exists(&skills_target)?;
        let skills_copied = self.copy_skills(&skills_source, &skills_target)?;

        Ok(InitResult {
            db_path,
            skills_copied,
            db_created,
            skills_dir_created,
        })
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

    #[test]
    fn test_init_creates_db_directory() {
        let temp_dir = create_temp_dir("db");
        fs::create_dir_all(&temp_dir).unwrap();

        // Use absolute paths for the test
        let db_path = temp_dir.join(".vtb/data");
        let skills_target = temp_dir.join(".claude/skills");

        let cmd = InitCommand {
            skills_source: temp_dir.join("nonexistent-skills"),
            skills_target: skills_target.clone(),
        };

        // Execute with a custom db_path by calling create_dir_if_not_exists directly
        let db_created = cmd.create_dir_if_not_exists(&db_path);
        assert!(db_created.is_ok(), "Init failed: {:?}", db_created.err());
        assert!(db_created.unwrap());
        assert!(db_path.exists());

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_creates_skills_directory() {
        let temp_dir = create_temp_dir("skills");
        fs::create_dir_all(&temp_dir).unwrap();

        let skills_target = temp_dir.join(".claude/skills");

        let cmd = InitCommand {
            skills_source: temp_dir.join("nonexistent-skills"),
            skills_target: skills_target.clone(),
        };

        let result = cmd.create_dir_if_not_exists(&skills_target);
        assert!(result.is_ok());
        assert!(result.unwrap());
        assert!(skills_target.exists());

        cleanup(&temp_dir);
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

        let cmd = InitCommand {
            skills_source: skills_source.clone(),
            skills_target: skills_target.clone(),
        };

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

        let cmd = InitCommand {
            skills_source: skills_source.clone(),
            skills_target: skills_target.clone(),
        };

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

        let cmd = InitCommand {
            skills_source: skills_source.clone(),
            skills_target: skills_target.clone(),
        };

        let result = cmd.copy_skills(&skills_source, &skills_target);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 1); // Only the file, not the subdir

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_existing_db_dir_not_created() {
        let temp_dir = create_temp_dir("existing");
        fs::create_dir_all(&temp_dir).unwrap();

        // Pre-create the db directory
        let db_path = temp_dir.join(".vtb/data");
        fs::create_dir_all(&db_path).unwrap();

        let cmd = InitCommand {
            skills_source: temp_dir.join("nonexistent"),
            skills_target: temp_dir.join(".claude/skills"),
        };

        let result = cmd.create_dir_if_not_exists(&db_path);
        assert!(result.is_ok());
        assert!(!result.unwrap()); // Was not newly created

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_result_display() {
        let result = InitResult {
            db_path: PathBuf::from(".vtb/data"),
            skills_copied: 5,
            db_created: true,
            skills_dir_created: true,
        };

        let output = format!("{}", result);
        assert!(output.contains("Vertebrae initialized successfully"));
        assert!(output.contains("Created database directory"));
        assert!(output.contains(".vtb/data"));
        assert!(output.contains("Copied 5 skill(s)"));
    }

    #[test]
    fn test_init_result_display_existing() {
        let result = InitResult {
            db_path: PathBuf::from(".vtb/data"),
            skills_copied: 0,
            db_created: false,
            skills_dir_created: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Database directory already exists"));
        assert!(output.contains("No skills to copy"));
    }

    #[test]
    fn test_init_error_display() {
        let err = InitError::CreateDir {
            path: PathBuf::from("/test/path"),
            reason: "Permission denied".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Failed to create directory"));
        assert!(output.contains("/test/path"));
        assert!(output.contains("Permission denied"));

        let err = InitError::CopyFile {
            source: PathBuf::from("/source"),
            target: PathBuf::from("/target"),
            reason: "No space".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Failed to copy"));
        assert!(output.contains("/source"));
        assert!(output.contains("/target"));

        let err = InitError::ReadDir {
            path: PathBuf::from("/dir"),
            reason: "Not found".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Failed to read directory"));
    }

    #[test]
    fn test_init_command_debug() {
        let cmd = InitCommand {
            skills_source: PathBuf::from("skills"),
            skills_target: PathBuf::from(".claude/skills"),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("InitCommand"));
        assert!(debug_str.contains("skills_source"));
        assert!(debug_str.contains("skills_target"));
    }
}
