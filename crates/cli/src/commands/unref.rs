//! Unref command for removing code references from tasks
//!
//! Implements the `vtb unref` command to remove code references from tasks.
//! Supports removing by file path or removing all references.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Remove code references from a task
#[derive(Debug, Args)]
pub struct UnrefCommand {
    /// Task ID to remove references from (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// File path to remove references for (removes all refs to that file)
    #[arg(required_unless_present = "all")]
    pub file: Option<String>,

    /// Remove all references from the task
    #[arg(long, conflicts_with = "file")]
    pub all: bool,
}

/// Result of the unref command execution
#[derive(Debug)]
pub struct UnrefResult {
    /// The task ID that was updated
    pub id: String,
    /// The file path that was removed (if specified)
    pub file: Option<String>,
    /// Whether --all was used
    pub removed_all: bool,
    /// Number of references removed
    pub removed_count: usize,
}

impl std::fmt::Display for UnrefResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.removed_all {
            if self.removed_count == 0 {
                write!(f, "No references to remove from task: {}", self.id)
            } else {
                write!(
                    f,
                    "Removed all {} reference(s) from task: {}",
                    self.removed_count, self.id
                )
            }
        } else if let Some(ref file) = self.file {
            if self.removed_count == 0 {
                write!(f, "Warning: No references to {} in task: {}", file, self.id)
            } else {
                write!(
                    f,
                    "Removed {} reference(s) to {} from task: {}",
                    self.removed_count, file, self.id
                )
            }
        } else {
            write!(f, "No references removed from task: {}", self.id)
        }
    }
}

impl UnrefCommand {
    /// Execute the unref command.
    ///
    /// Removes code references from a task based on file path or --all flag.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Service operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<UnrefResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task to get current refs
        let task = services.tasks().get_task(&id).await?;

        let code_refs = task.code_refs.clone();
        let original_count = code_refs.len();

        if self.all {
            // Remove all references using service layer (which fires MutationCallback)
            if original_count > 0 {
                services.tasks().remove_code_refs(&id, None).await?;
            }

            Ok(UnrefResult {
                id,
                file: None,
                removed_all: true,
                removed_count: original_count,
            })
        } else if let Some(ref file) = self.file {
            // Calculate which refs would be removed
            let refs_to_remove_indices: Vec<usize> = code_refs
                .iter()
                .enumerate()
                .filter(|(_, r)| r.path.as_str() == file.as_str())
                .map(|(i, _)| i)
                .collect();

            let removed_count = refs_to_remove_indices.len();

            if removed_count > 0 {
                // Remove refs by index using service layer (which fires MutationCallback)
                services
                    .tasks()
                    .remove_code_refs(&id, Some(refs_to_remove_indices))
                    .await?;
            }

            Ok(UnrefResult {
                id,
                file: Some(file.clone()),
                removed_all: false,
                removed_count,
            })
        } else {
            // Should not happen due to clap validation, but handle gracefully
            Ok(UnrefResult {
                id,
                file: None,
                removed_all: false,
                removed_count: 0,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== Display tests ====================

    #[test]
    fn test_unref_result_display_file_removed() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: Some("src/auth.ex".to_string()),
            removed_all: false,
            removed_count: 2,
        };

        let output = format!("{}", result);
        assert_eq!(
            output,
            "Removed 2 reference(s) to src/auth.ex from task: task1"
        );
    }

    #[test]
    fn test_unref_result_display_file_warning() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: Some("src/nonexistent.ex".to_string()),
            removed_all: false,
            removed_count: 0,
        };

        let output = format!("{}", result);
        assert_eq!(
            output,
            "Warning: No references to src/nonexistent.ex in task: task1"
        );
    }

    #[test]
    fn test_unref_result_display_all_removed() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: None,
            removed_all: true,
            removed_count: 5,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Removed all 5 reference(s) from task: task1");
    }

    #[test]
    fn test_unref_result_display_all_empty() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: None,
            removed_all: true,
            removed_count: 0,
        };

        let output = format!("{}", result);
        assert_eq!(output, "No references to remove from task: task1");
    }

    #[test]
    fn test_unref_command_debug() {
        let cmd = UnrefCommand {
            id: "test".to_string(),
            file: Some("src/main.rs".to_string()),
            all: false,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("UnrefCommand")
                && debug_str.contains("id: \"test\"")
                && debug_str.contains("file: Some(\"src/main.rs\")"),
            "Debug output should contain UnrefCommand and its fields"
        );
    }

    #[test]
    fn test_unref_result_debug() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: None,
            removed_all: true,
            removed_count: 0,
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("UnrefResult")
                && debug_str.contains("id: \"task1\"")
                && debug_str.contains("removed_all: true"),
            "Debug output should contain UnrefResult and its fields"
        );
    }

    // ==================== Display fallback branch ====================

    #[test]
    fn test_unref_result_display_no_file_not_all() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: None,
            removed_all: false,
            removed_count: 0,
        };
        let output = format!("{}", result);
        assert_eq!(output, "No references removed from task: task1");
    }

    #[test]
    fn test_unref_result_display_single_file_ref() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: Some("src/main.rs".to_string()),
            removed_all: false,
            removed_count: 1,
        };
        let output = format!("{}", result);
        assert_eq!(
            output,
            "Removed 1 reference(s) to src/main.rs from task: task1"
        );
    }

    #[test]
    fn test_unref_result_display_all_single_ref() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: None,
            removed_all: true,
            removed_count: 1,
        };
        let output = format!("{}", result);
        assert_eq!(output, "Removed all 1 reference(s) from task: task1");
    }

    // ==================== UnrefCommand struct tests ====================

    #[test]
    fn test_unref_command_with_all_flag() {
        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: None,
            all: true,
        };
        assert!(cmd.all);
        assert!(cmd.file.is_none());
    }

    #[test]
    fn test_unref_command_with_file() {
        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: Some("src/lib.rs".to_string()),
            all: false,
        };
        assert!(!cmd.all);
        assert_eq!(cmd.file, Some("src/lib.rs".to_string()));
    }

    // ==================== Async execute tests ====================

    async fn setup_services() -> VertebraeServices {
        let db = vertebrae_core::Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    async fn create_task_with_refs(services: &VertebraeServices, ref_paths: &[&str]) -> String {
        let options = vertebrae_core::CreateTaskOptions::new("Task with refs");
        let id = services.tasks().create_task(options).await.unwrap();

        for path in ref_paths {
            let code_ref = vertebrae_core::CodeRef {
                path: path.to_string(),
                name: Some(format!("ref-{}", path)),
                line_start: Some(1),
                line_end: None,
                description: None,
            };
            services.tasks().add_code_ref(&id, code_ref).await.unwrap();
        }

        id
    }

    #[tokio::test]
    async fn test_execute_unref_remove_all() {
        let services = setup_services().await;
        let id = create_task_with_refs(&services, &["src/main.rs", "src/lib.rs"]).await;

        let cmd = UnrefCommand {
            id: id.clone(),
            file: None,
            all: true,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.removed_all);
        assert_eq!(result.removed_count, 2);

        // Verify refs were removed
        let task = services.tasks().get_task(&id).await.unwrap();
        assert!(task.code_refs.is_empty());
    }

    #[tokio::test]
    async fn test_execute_unref_remove_by_file() {
        let services = setup_services().await;
        let id =
            create_task_with_refs(&services, &["src/main.rs", "src/lib.rs", "src/main.rs"]).await;

        let cmd = UnrefCommand {
            id: id.clone(),
            file: Some("src/main.rs".to_string()),
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(!result.removed_all);
        assert_eq!(result.removed_count, 2); // two refs to main.rs
        assert_eq!(result.file, Some("src/main.rs".to_string()));

        // Verify only lib.rs ref remains
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/lib.rs");
    }

    #[tokio::test]
    async fn test_execute_unref_remove_all_empty() {
        let services = setup_services().await;
        let options = vertebrae_core::CreateTaskOptions::new("No refs task");
        let id = services.tasks().create_task(options).await.unwrap();

        let cmd = UnrefCommand {
            id: id.clone(),
            file: None,
            all: true,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.removed_all);
        assert_eq!(result.removed_count, 0);
    }

    #[tokio::test]
    async fn test_execute_unref_file_not_found() {
        let services = setup_services().await;
        let id = create_task_with_refs(&services, &["src/main.rs"]).await;

        let cmd = UnrefCommand {
            id: id.clone(),
            file: Some("src/nonexistent.rs".to_string()),
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.removed_count, 0);
        assert_eq!(result.file, Some("src/nonexistent.rs".to_string()));
    }

    #[tokio::test]
    async fn test_execute_unref_nonexistent_task() {
        let services = setup_services().await;

        let cmd = UnrefCommand {
            id: "nonexistent".to_string(),
            file: None,
            all: true,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_execute_unref_case_insensitive_id() {
        let services = setup_services().await;
        let id = create_task_with_refs(&services, &["src/main.rs"]).await;

        let cmd = UnrefCommand {
            id: id.to_uppercase(),
            file: None,
            all: true,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().removed_count, 1);
    }
}
