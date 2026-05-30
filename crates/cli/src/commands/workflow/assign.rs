//! Workflow assign command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Assign a task to a workflow
#[derive(Debug, Args)]
pub struct WorkflowAssignCommand {
    /// Task ID to assign workflow to (case-insensitive full UUID or 8-character short ID)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub task_id: String,

    /// Workflow ID to assign (case-insensitive full UUID or 8-character short ID)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("workflow ID"))]
    pub workflow_id: String,
}

impl WorkflowAssignCommand {
    /// Execute the assign workflow command.
    ///
    /// Assigns a task to a workflow, setting the current step to the workflow's
    /// first step.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Malformed IDs are rejected by clap before execution. Short IDs are
    /// resolved before execution. Returns `ServiceError::NotFound` if the task
    /// or workflow doesn't exist, or another `ServiceError` if service
    /// operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
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
    use clap::Parser;

    #[derive(Debug, Parser)]
    struct TestCli {
        #[command(flatten)]
        command: WorkflowAssignCommand,
    }

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

    #[test]
    fn test_workflow_assign_accepts_short_ids_case_insensitively() {
        let cli = TestCli::try_parse_from(["test", "ABCDEF12", "1234ABCD"]).unwrap();
        assert_eq!(cli.command.task_id, "abcdef12");
        assert_eq!(cli.command.workflow_id, "1234abcd");
    }

    #[test]
    fn test_workflow_assign_rejects_malformed_ids() {
        let result = TestCli::try_parse_from(["test", "task1", "workflow1"]);
        assert!(result.is_err());
        let message = result.unwrap_err().to_string();
        assert!(message.contains("task ID 'task1' is not a valid UUID or short ID"));
    }
}
