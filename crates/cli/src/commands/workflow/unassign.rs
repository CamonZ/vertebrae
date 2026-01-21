//! Workflow unassign command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Remove workflow assignment from a task
#[derive(Debug, Args)]
pub struct WorkflowUnassignCommand {
    /// Task ID to unassign (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,
}

impl WorkflowUnassignCommand {
    /// Execute the unassign workflow command.
    ///
    /// Removes workflow assignment from a task, clearing workflow_id and current_step_id.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Unassign the workflow
        service.unassign_workflow(&self.task_id).await?;

        Ok(format!("Unassigned workflow from task {}", self.task_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_unassign_command_debug() {
        let cmd = WorkflowUnassignCommand {
            task_id: "task1".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowUnassignCommand"));
        assert!(debug.contains("task1"));
    }
}
