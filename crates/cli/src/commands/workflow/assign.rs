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

    #[test]
    fn test_workflow_assign_command_with_various_ids() {
        let test_cases = vec![
            ("task1", "workflow1"),
            ("task-abc", "workflow-xyz"),
            ("TASK123", "WORKFLOW456"),
            ("t1", "w1"),
        ];

        for (task_id, workflow_id) in test_cases {
            let cmd = WorkflowAssignCommand {
                task_id: task_id.to_string(),
                workflow_id: workflow_id.to_string(),
            };
            assert_eq!(cmd.task_id, task_id);
            assert_eq!(cmd.workflow_id, workflow_id);
        }
    }

    #[test]
    fn test_workflow_assign_command_field_values() {
        let cmd = WorkflowAssignCommand {
            task_id: "my-task".to_string(),
            workflow_id: "my-workflow".to_string(),
        };
        assert_eq!(cmd.task_id, "my-task");
        assert_eq!(cmd.workflow_id, "my-workflow");
    }

    #[test]
    fn test_workflow_assign_command_case_preservation() {
        let cmd = WorkflowAssignCommand {
            task_id: "TaskABC".to_string(),
            workflow_id: "WorkflowXYZ".to_string(),
        };
        assert_eq!(cmd.task_id, "TaskABC");
        assert_eq!(cmd.workflow_id, "WorkflowXYZ");
    }

    #[test]
    fn test_workflow_assign_command_with_hyphens() {
        let cmd = WorkflowAssignCommand {
            task_id: "task-with-hyphens".to_string(),
            workflow_id: "workflow-with-hyphens".to_string(),
        };
        assert_eq!(cmd.task_id, "task-with-hyphens");
        assert_eq!(cmd.workflow_id, "workflow-with-hyphens");
    }

    #[test]
    fn test_workflow_assign_command_with_numbers() {
        let cmd = WorkflowAssignCommand {
            task_id: "task123".to_string(),
            workflow_id: "workflow456".to_string(),
        };
        assert_eq!(cmd.task_id, "task123");
        assert_eq!(cmd.workflow_id, "workflow456");
    }
}
