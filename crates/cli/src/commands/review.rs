//! Review command for toggling the needs_human_review flag
//!
//! Implements the `vtb review` command to toggle the needs_human_review flag on tasks.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

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
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Service operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
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

    #[test]
    fn test_review_command_with_set_true() {
        let cmd = ReviewCommand {
            id: "task-abc".to_string(),
            set: Some(true),
        };
        assert_eq!(cmd.id, "task-abc");
        assert_eq!(cmd.set, Some(true));
    }

    #[test]
    fn test_review_command_with_set_false() {
        let cmd = ReviewCommand {
            id: "task-xyz".to_string(),
            set: Some(false),
        };
        assert_eq!(cmd.id, "task-xyz");
        assert_eq!(cmd.set, Some(false));
    }

    #[test]
    fn test_review_command_with_set_none() {
        let cmd = ReviewCommand {
            id: "task-123".to_string(),
            set: None,
        };
        assert_eq!(cmd.id, "task-123");
        assert!(cmd.set.is_none());
    }

    #[test]
    fn test_review_command_different_ids() {
        let ids = vec!["abc123", "task-1", "MyTask", "UPPERCASE"];
        for id in ids {
            let cmd = ReviewCommand {
                id: id.to_string(),
                set: None,
            };
            assert_eq!(cmd.id, id);
        }
    }

    #[test]
    fn test_review_command_case_sensitivity() {
        let cmd_lower = ReviewCommand {
            id: "task-abc".to_string(),
            set: None,
        };
        let cmd_upper = ReviewCommand {
            id: "TASK-ABC".to_string(),
            set: None,
        };
        assert_ne!(cmd_lower.id, cmd_upper.id);
    }

    // ==================== Async execute tests ====================

    async fn setup_services() -> VertebraeServices {
        let db = vertebrae_core::Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    async fn create_task(services: &VertebraeServices, title: &str) -> String {
        let options = vertebrae_core::CreateTaskOptions::new(title);
        services.tasks().create_task(options).await.unwrap()
    }

    #[tokio::test]
    async fn test_execute_review_toggle_on() {
        let services = setup_services().await;
        let id = create_task(&services, "Test task").await;

        // Default is false/None, toggling should set to true
        let cmd = ReviewCommand {
            id: id.clone(),
            set: None,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.contains("marked as needing review"));

        // Verify the flag was set
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.needs_human_review, Some(true));
    }

    #[tokio::test]
    async fn test_execute_review_toggle_off() {
        let services = setup_services().await;
        let id = create_task(&services, "Test task").await;

        // Set to true first
        let cmd = ReviewCommand {
            id: id.clone(),
            set: Some(true),
        };
        cmd.execute(&services).await.unwrap();

        // Toggle should set to false
        let cmd = ReviewCommand {
            id: id.clone(),
            set: None,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.contains("marked as not needing review"));

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.needs_human_review, Some(false));
    }

    #[tokio::test]
    async fn test_execute_review_set_true() {
        let services = setup_services().await;
        let id = create_task(&services, "Test task").await;

        let cmd = ReviewCommand {
            id: id.clone(),
            set: Some(true),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.contains("marked as needing review"));

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.needs_human_review, Some(true));
    }

    #[tokio::test]
    async fn test_execute_review_set_false() {
        let services = setup_services().await;
        let id = create_task(&services, "Test task").await;

        let cmd = ReviewCommand {
            id: id.clone(),
            set: Some(false),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.contains("marked as not needing review"));

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.needs_human_review, Some(false));
    }

    #[tokio::test]
    async fn test_execute_review_nonexistent_task() {
        let services = setup_services().await;

        let cmd = ReviewCommand {
            id: "nonexistent".to_string(),
            set: None,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_execute_review_case_insensitive_id() {
        let services = setup_services().await;
        let id = create_task(&services, "Test task").await;

        // Use uppercase version of the ID
        let cmd = ReviewCommand {
            id: id.to_uppercase(),
            set: Some(true),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.contains("marked as needing review"));
    }
}
