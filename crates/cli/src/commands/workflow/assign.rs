//! Workflow assign command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Assign a task to a workflow
#[derive(Debug, Args)]
pub struct WorkflowAssignCommand {
    /// Task ID to assign (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,

    /// Workflow ID to assign to (case-insensitive)
    #[arg(required = true)]
    pub workflow_id: String,
}

impl WorkflowAssignCommand {
    /// Execute the assign workflow command.
    ///
    /// Assigns a task to a workflow, setting the current step to the first step (0).
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task or workflow doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Assign the task to the workflow
        let result = service
            .assign_workflow(&self.task_id, &self.workflow_id)
            .await?;

        Ok(format!(
            "Assigned task {} to workflow {} at step 1: {}",
            result.task_id, result.workflow_id, result.first_step_name
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_assign_command_debug() {
        let cmd = WorkflowAssignCommand {
            task_id: "task1".to_string(),
            workflow_id: "wf1".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowAssignCommand"));
        assert!(debug.contains("task1"));
        assert!(debug.contains("wf1"));
    }
}
