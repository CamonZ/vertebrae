//! Workflow retreat command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Retreat a task to the previous workflow step
#[derive(Debug, Args)]
pub struct WorkflowRetreatCommand {
    /// Task ID to retreat (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,
}

impl WorkflowRetreatCommand {
    /// Execute the retreat workflow command.
    ///
    /// Moves the task to the previous step in its assigned workflow.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task doesn't exist.
    /// Returns `ServiceError::Validation` if the task is not assigned to a workflow
    /// or is already at the first step.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Retreat the task to the previous step
        let result = service.retreat_step(&self.task_id).await?;

        // Get the execution ID for display (truncated to 6 chars)
        let exec_id = result
            .execution_id
            .as_deref()
            .unwrap_or("unknown")
            .chars()
            .take(6)
            .collect::<String>();

        Ok(format!(
            "Retreated task {} to step {}/{}: {} (execution: {})",
            result.task_id,
            result.to_step + 1,
            result.total_steps,
            result.step_name,
            exec_id
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_retreat_command_debug() {
        let cmd = WorkflowRetreatCommand {
            task_id: "task1".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowRetreatCommand"));
        assert!(debug.contains("task1"));
    }
}
