//! Workflow delete command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Delete a workflow
#[derive(Debug, Args)]
pub struct WorkflowDeleteCommand {
    /// Workflow ID to delete (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

impl WorkflowDeleteCommand {
    /// Execute the delete workflow command.
    ///
    /// Deletes the workflow with the specified ID.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the workflow doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        service.delete_workflow(&self.id).await?;
        Ok(format!("Deleted workflow: {}", self.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_delete_command_debug() {
        let cmd = WorkflowDeleteCommand {
            id: "wf1".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowDeleteCommand"));
        assert!(debug.contains("wf1"));
    }

    #[test]
    fn test_workflow_delete_command_with_various_ids() {
        let ids = vec!["wf1", "workflow-abc", "WORKFLOW123", "my-workflow"];
        for id in ids {
            let cmd = WorkflowDeleteCommand { id: id.to_string() };
            assert_eq!(cmd.id, id);
        }
    }

    #[test]
    fn test_workflow_delete_command_field_value() {
        let cmd = WorkflowDeleteCommand {
            id: "my-workflow".to_string(),
        };
        assert_eq!(cmd.id, "my-workflow");
    }

    #[test]
    fn test_workflow_delete_command_case_preservation() {
        let cmd = WorkflowDeleteCommand {
            id: "MyWorkflow".to_string(),
        };
        assert_eq!(cmd.id, "MyWorkflow");
    }

    #[test]
    fn test_workflow_delete_command_with_special_ids() {
        let cmd = WorkflowDeleteCommand {
            id: "workflow-with-many-dashes-and-numbers-123".to_string(),
        };
        assert!(cmd.id.contains("workflow"));
        assert!(cmd.id.contains("123"));
    }
}
