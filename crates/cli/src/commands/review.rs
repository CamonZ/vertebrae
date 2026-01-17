//! Review command for toggling the needs_human_review flag
//!
//! Implements the `vtb review` command to toggle the needs_human_review flag on tasks.

use clap::Args;
use vertebrae_core::ServiceError;

/// Toggle the needs_human_review flag on a task
#[derive(Debug, Args)]
pub struct ReviewCommand {
    /// Task ID to toggle review flag (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Set the flag to a specific value instead of toggling
    #[arg(long)]
    pub set: Option<bool>,
}

impl ReviewCommand {
    /// Execute the review command.
    ///
    /// Toggles the needs_human_review flag on the specified task,
    /// or sets it to a specific value if --set is provided.
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
    ) -> Result<String, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch current flag value
        let current = self.get_current_flag(service, &id).await?;

        // Determine new value
        let new_value = match self.set {
            Some(value) => value,
            None => !current, // Toggle
        };

        // Update the flag using service layer (which fires MutationCallback)
        self.update_flag(service, &id, new_value).await?;

        let action = if new_value {
            "marked as needing review"
        } else {
            "marked as not needing review"
        };

        Ok(format!("Task {} {}", id, action))
    }

    /// Get the current needs_human_review flag value.
    async fn get_current_flag(
        &self,
        service: &dyn vertebrae_core::TaskService,
        id: &str,
    ) -> Result<bool, ServiceError> {
        let task = service.get_task(id).await?;
        Ok(task.needs_human_review.unwrap_or(false))
    }

    /// Update the needs_human_review flag using service layer.
    async fn update_flag(
        &self,
        service: &dyn vertebrae_core::TaskService,
        id: &str,
        value: bool,
    ) -> Result<(), ServiceError> {
        let options = vertebrae_core::UpdateTaskOptions::new().with_needs_human_review(value);
        service.update_task(id, options).await?;
        Ok(())
    }
}

// Integration tests are in tests/ directory and use TestContext
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_review_command_debug() {
        let cmd = ReviewCommand {
            id: "test123".to_string(),
            set: Some(true),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("ReviewCommand") && debug_str.contains("test123"),
            "Debug output should contain ReviewCommand and id field value"
        );
    }
}
