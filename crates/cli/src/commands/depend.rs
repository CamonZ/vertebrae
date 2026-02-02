//! Depend command for creating task dependencies
//!
//! Implements the `vtb depend` command to create dependency relationships between tasks
//! with cycle detection to ensure the dependency graph remains acyclic.
//!
//! Uses the TaskService layer to create dependencies, which ensures that MutationCallback
//! fires properly for GUI cache invalidation.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Create a dependency relationship between tasks
#[derive(Debug, Args)]
pub struct DependCommand {
    /// Task ID that will depend on another task (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Task ID that this task depends on (the blocker)
    #[arg(long = "on", required = true)]
    pub blocker_id: String,
}

/// Result of the depend command execution
#[derive(Debug)]
pub struct DependResult {
    /// The task ID that now depends on the blocker
    pub task_id: String,
    /// The blocker task ID
    pub blocker_id: String,
    /// Whether the dependency already existed (idempotent)
    pub already_existed: bool,
}

impl std::fmt::Display for DependResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.already_existed {
            write!(
                f,
                "Dependency already exists: {} -> {}",
                self.task_id, self.blocker_id
            )
        } else {
            write!(
                f,
                "Created dependency: {} depends on {}",
                self.task_id, self.blocker_id
            )
        }
    }
}

impl DependCommand {
    /// Execute the depend command.
    ///
    /// Creates a dependency relationship where the task identified by `id`
    /// depends on (is blocked by) the task identified by `blocker_id`.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - Either task does not exist
    /// - Self-dependency is attempted (task depends on itself)
    /// - Creating the dependency would form a cycle
    /// - Service operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<DependResult, ServiceError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let task_id = self.id.to_lowercase();
        let blocker_id = self.blocker_id.to_lowercase();

        // Check for self-dependency
        if task_id == blocker_id {
            return Err(ServiceError::validation_failed(
                "Task cannot depend on itself",
            ));
        }

        // Validate both tasks exist using service layer
        if !services.tasks().task_exists(&task_id).await? {
            return Err(ServiceError::task_not_found(&self.id));
        }

        if !services.tasks().task_exists(&blocker_id).await? {
            return Err(ServiceError::task_not_found(&self.blocker_id));
        }

        // Check if dependency already exists (idempotent) using service layer
        let existing_deps = services.tasks().get_dependencies(&task_id).await?;

        if existing_deps.contains(&blocker_id) {
            // Dependency already exists - idempotent behavior
            return Ok(DependResult {
                task_id,
                blocker_id,
                already_existed: true,
            });
        }

        // Create the dependency using the service layer
        // This fires MutationCallback for GUI cache invalidation
        services
            .tasks()
            .add_dependency(&task_id, &blocker_id)
            .await?;

        Ok(DependResult {
            task_id,
            blocker_id,
            already_existed: false,
        })
    }
}
