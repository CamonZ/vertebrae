//! Review command for toggling the needs_human_review flag
//!
//! Implements the `vtb review` command to toggle the needs_human_review flag on tasks.

use clap::Args;
use serde::Serialize;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Toggle the needs_human_review flag on a task
#[derive(Debug, Args)]
pub struct ReviewCommand {
    /// Task ID to toggle review flag (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Set the flag to a specific value instead of toggling
    #[arg(long)]
    pub set: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ReviewResult {
    pub task_id: String,
    pub needs_human_review: bool,
}

impl ReviewCommand {
    /// Execute the review command.
    ///
    /// Toggles the needs_human_review flag on the specified task,
    /// or sets it to a specific value if --set is provided.
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
    pub async fn execute_result(
        &self,
        services: &VertebraeServices,
    ) -> Result<ReviewResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch current flag value
        let current = self.get_current_flag(services, &id).await?;

        // Determine new value
        let new_value = match self.set {
            Some(value) => value,
            None => !current, // Toggle
        };

        // Update the flag using service layer (which fires MutationCallback)
        self.update_flag(services, &id, new_value).await?;

        Ok(ReviewResult {
            task_id: id,
            needs_human_review: new_value,
        })
    }

    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let result = self.execute_result(services).await?;

        let action = if result.needs_human_review {
            "marked as needing review"
        } else {
            "marked as not needing review"
        };

        Ok(format!("Task {} {}", result.task_id, action))
    }

    /// Get the current needs_human_review flag value.
    async fn get_current_flag(
        &self,
        services: &VertebraeServices,
        id: &str,
    ) -> Result<bool, ServiceError> {
        let task = services.tasks().get_task(id).await?;
        Ok(task.needs_human_review.unwrap_or(false))
    }

    /// Update the needs_human_review flag using service layer.
    async fn update_flag(
        &self,
        services: &VertebraeServices,
        id: &str,
        value: bool,
    ) -> Result<(), ServiceError> {
        let options = vertebrae_core::UpdateTaskOptions::new().with_needs_human_review(value);
        services.tasks().update_task(id, options).await?;
        Ok(())
    }
}

// Integration tests are in tests/ directory and use TestContext
