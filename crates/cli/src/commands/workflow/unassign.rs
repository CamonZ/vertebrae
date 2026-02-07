//! Workflow unassign command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Remove workflow assignment from a task
#[derive(Debug, Args)]
pub struct WorkflowUnassignCommand {
    /// Task ID to unassign workflow from (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
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

    #[test]
    fn test_workflow_unassign_command_with_various_ids() {
        let ids = vec!["task1", "task-abc", "TASK123", "my-task"];
        for id in ids {
            let cmd = WorkflowUnassignCommand {
                task_id: id.to_string(),
            };
            assert_eq!(cmd.task_id, id);
        }
    }

    #[test]
    fn test_workflow_unassign_command_field_value() {
        let cmd = WorkflowUnassignCommand {
            task_id: "my-task".to_string(),
        };
        assert_eq!(cmd.task_id, "my-task");
    }

    #[test]
    fn test_workflow_unassign_command_case_preservation() {
        let cmd = WorkflowUnassignCommand {
            task_id: "MyTask".to_string(),
        };
        assert_eq!(cmd.task_id, "MyTask");
    }

    #[test]
    fn test_workflow_unassign_command_with_dashes() {
        let cmd = WorkflowUnassignCommand {
            task_id: "task-with-multiple-dashes".to_string(),
        };
        assert!(cmd.task_id.contains("task"));
        assert!(cmd.task_id.contains("dashes"));
    }
}
