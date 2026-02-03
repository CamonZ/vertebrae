//! Undepend command for removing task dependencies
//!
//! Implements the `vtb undepend` command to remove dependency relationships between tasks.
//! Uses the TaskService layer to ensure MutationCallback fires properly for GUI cache invalidation.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Remove a dependency relationship between tasks
#[derive(Debug, Args)]
pub struct UndependCommand {
    /// Task ID that depends on another task (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Task ID of the blocker to remove (case-insensitive)
    #[arg(long = "on", required = true)]
    pub blocker_id: String,
}

/// Result of the undepend command execution
#[derive(Debug)]
pub struct UndependResult {
    /// The task ID that no longer depends on the blocker
    pub task_id: String,
    /// The blocker task ID that was removed
    pub blocker_id: String,
    /// Whether the dependency existed before removal
    pub existed: bool,
}

impl std::fmt::Display for UndependResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.existed {
            write!(
                f,
                "Removed dependency: {} no longer depends on {}",
                self.task_id, self.blocker_id
            )
        } else {
            write!(
                f,
                "Warning: No dependency from {} to {} exists",
                self.task_id, self.blocker_id
            )
        }
    }
}

impl UndependCommand {
    /// Execute the undepend command.
    ///
    /// Removes a dependency relationship where the task identified by `id`
    /// depends on (is blocked by) the task identified by `blocker_id`.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The source task does not exist
    /// - Service operations fail
    ///
    /// Note: Non-existent dependency is handled gracefully with a warning.
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<UndependResult, ServiceError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let task_id = self.id.to_lowercase();
        let blocker_id = self.blocker_id.to_lowercase();

        // Fetch the task - validates it exists and gives us dependency_ids
        let task = services
            .tasks()
            .get_task(&task_id)
            .await
            .map_err(|_| ServiceError::task_not_found(&self.id))?;

        // Check if dependency exists using dependency_ids from task
        let existed = task.dependency_ids.contains(&blocker_id);

        if existed {
            // Remove the dependency using the service layer (fires mutation callback)
            services
                .tasks()
                .remove_dependency(&task_id, &blocker_id)
                .await?;
        }

        Ok(UndependResult {
            task_id,
            blocker_id,
            existed,
        })
    }
}
