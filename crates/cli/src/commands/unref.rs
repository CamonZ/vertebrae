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
