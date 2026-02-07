//! Complete-step command for workflow step lifecycle management
//!
//! Implements the `vtb complete-step` command to complete a workflow step for a task.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Complete a workflow step for a task
#[derive(Debug, Args)]
pub struct CompleteStepCommand {
    /// Task ID to complete the step for (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,
}

/// Result of executing the complete-step command
#[derive(Debug)]
pub struct CompleteStepResult {
    /// The task ID
    pub task_id: String,
}

impl std::fmt::Display for CompleteStepResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Completed step for task '{}'", self.task_id)
    }
}

impl CompleteStepCommand {
    /// Execute the complete-step command.
    ///
    /// Completes the current workflow step for the task and transitions to the next step.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task does not exist
    /// - The service operation fails
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<CompleteStepResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Verify task exists
        let _ = services.tasks().get_task(&id).await?;

        // Complete the step
        services.tasks().complete_step(&id).await?;

        Ok(CompleteStepResult { task_id: id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_complete_step_command_debug() {
        let cmd = CompleteStepCommand {
            id: "task-123".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("CompleteStepCommand"));
        assert!(debug.contains("task-123"));
    }

    #[test]
    fn test_complete_step_result_debug() {
        let result = CompleteStepResult {
            task_id: "task-123".to_string(),
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("CompleteStepResult"));
        assert!(debug.contains("task-123"));
    }

    #[test]
    fn test_complete_step_result_display() {
        let result = CompleteStepResult {
            task_id: "task-xyz-789".to_string(),
        };
        let output = format!("{}", result);
        assert!(output.contains("Completed step for task 'task-xyz-789'"));
    }
}
