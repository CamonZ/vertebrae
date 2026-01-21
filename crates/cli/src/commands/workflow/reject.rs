//! Workflow reject command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Reject a task in its workflow, unassigning the workflow from the task
#[derive(Debug, Args)]
pub struct WorkflowRejectCommand {
    /// Task ID to reject (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,
}

impl WorkflowRejectCommand {
    /// Execute the reject workflow command.
    ///
    /// Rejects the task in its current workflow and unassigns the workflow from the task.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task doesn't exist.
    /// Returns `ServiceError::Validation` if the task is not assigned to a workflow.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Reject the task in its workflow
        let result = service.reject_task(&self.task_id).await?;

        Ok(format!(
            "Rejected task {} from workflow {} (workflow unassigned)",
            result.task_id, result.from_workflow_id
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_reject_command_debug() {
        let cmd = WorkflowRejectCommand {
            task_id: "task1".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowRejectCommand"));
        assert!(debug.contains("task1"));
    }
}
