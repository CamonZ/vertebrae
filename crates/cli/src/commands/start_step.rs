//! Start-step command for workflow step lifecycle management
//!
//! Implements the `vtb start-step` command to start a workflow step for a task.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Start a workflow step for a task
#[derive(Debug, Args)]
pub struct StartStepCommand {
    /// Task ID to start the step for (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,
}

/// Result of executing the start-step command
#[derive(Debug)]
pub struct StartStepResult {
    /// The task ID
    pub task_id: String,
}

impl std::fmt::Display for StartStepResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Started step for task '{}'", self.task_id)
    }
}

impl StartStepCommand {
    /// Execute the start-step command.
    ///
    /// Starts the current workflow step for the task.
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
    ) -> Result<StartStepResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Verify task exists
        let _ = services.tasks().get_task(&id).await?;

        // Start the step
        services.tasks().start_step(&id).await?;

        Ok(StartStepResult { task_id: id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_start_step_command_debug() {
        let cmd = StartStepCommand {
            id: "task-123".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("StartStepCommand"));
        assert!(debug.contains("task-123"));
    }

    #[test]
    fn test_start_step_result_debug() {
        let result = StartStepResult {
            task_id: "task-123".to_string(),
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("StartStepResult"));
        assert!(debug.contains("task-123"));
    }

    #[test]
    fn test_start_step_result_display() {
        let result = StartStepResult {
            task_id: "task-abc-def".to_string(),
        };
        let output = format!("{}", result);
        assert!(output.contains("Started step for task 'task-abc-def'"));
    }
}
