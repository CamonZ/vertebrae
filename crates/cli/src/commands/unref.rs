//! Unref command for removing code references from tasks
//!
//! Implements the `vtb unref` command to remove code references from tasks.
//! Supports removing by file path or removing all references.

use clap::Args;
use vertebrae_core::ServiceError;

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
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Service operations fail
    pub async fn execute(
        &self,
        service: &dyn vertebrae_core::TaskService,
    ) -> Result<UnrefResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task to get current refs
        let task = service
            .get_task(&id)
            .await
            .map_err(|_| ServiceError::task_not_found(&id))?;

        let code_refs = task.code_refs.clone();
        let original_count = code_refs.len();

        if self.all {
            // Remove all references using service layer (which fires MutationCallback)
            if original_count > 0 {
                service.remove_code_refs(&id, None).await?;
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
                service
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
            // Should not reach here due to clap validation
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
}
