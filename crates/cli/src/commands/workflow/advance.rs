//! Workflow advance command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Advance a task to the next workflow step
#[derive(Debug, Args)]
pub struct WorkflowAdvanceCommand {
    /// Task ID to advance (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,
}

impl WorkflowAdvanceCommand {
    /// Execute the advance workflow command.
    ///
    /// Moves the task to the next step in its assigned workflow.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task doesn't exist.
    /// Returns `ServiceError::Validation` if the task is not assigned to a workflow
    /// or is already at the last step.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Advance the task to the next step
        let result = service.advance_step(&self.task_id).await?;

        // Get the execution ID for display (truncated to 6 chars)
        let exec_id = result
            .execution_id
            .as_deref()
            .unwrap_or("unknown")
            .chars()
            .take(6)
            .collect::<String>();

        // Build output message based on whether workflow chaining occurred
        let message = if let Some(chained_to) = &result.chained_to_workflow {
            format!(
                "Completed workflow {} and chained task {} to workflow {} at step 1: {} (execution: {})",
                result.workflow_id,
                result.task_id,
                chained_to,
                "Step 1", // The service returns the new step info
                exec_id
            )
        } else {
            format!(
                "Advanced task {} to step {}/{}: {} (execution: {})",
                result.task_id,
                result.to_step + 1,
                result.total_steps,
                result.step_name,
                exec_id
            )
        };

        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_advance_command_debug() {
        let cmd = WorkflowAdvanceCommand {
            task_id: "task1".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowAdvanceCommand"));
        assert!(debug.contains("task1"));
    }
}
