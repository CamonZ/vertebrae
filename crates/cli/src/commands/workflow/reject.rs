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

    #[test]
    fn test_workflow_reject_command_with_various_ids() {
        let ids = vec!["task1", "task-abc", "TASK123", "my-task"];
        for id in ids {
            let cmd = WorkflowRejectCommand {
                task_id: id.to_string(),
            };
            assert_eq!(cmd.task_id, id);
        }
    }

    #[test]
    fn test_workflow_reject_command_field_value() {
        let cmd = WorkflowRejectCommand {
            task_id: "my-task".to_string(),
        };
        assert_eq!(cmd.task_id, "my-task");
    }

    #[test]
    fn test_workflow_reject_command_case_preservation() {
        let cmd = WorkflowRejectCommand {
            task_id: "MyTask".to_string(),
        };
        assert_eq!(cmd.task_id, "MyTask");
    }

    #[test]
    fn test_workflow_reject_command_with_hyphens() {
        let cmd = WorkflowRejectCommand {
            task_id: "task-with-hyphens".to_string(),
        };
        assert!(cmd.task_id.contains("task"));
        assert!(cmd.task_id.contains("hyphens"));
    }

    #[test]
    fn test_workflow_reject_command_with_numbers() {
        let cmd = WorkflowRejectCommand {
            task_id: "task123abc456".to_string(),
        };
        assert_eq!(cmd.task_id, "task123abc456");
    }
}
