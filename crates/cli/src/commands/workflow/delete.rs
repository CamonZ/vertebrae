//! Workflow delete command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Delete a workflow
#[derive(Debug, Args)]
pub struct WorkflowDeleteCommand {
    /// Workflow ID to delete (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("workflow ID"))]
    pub id: String,
}

impl WorkflowDeleteCommand {
    /// Execute the delete workflow command.
    ///
    /// Deletes the workflow with the specified workflow ID.
    ///
    /// The ID is validated by clap before execution and may be either a full
    /// UUID or an 8-character short ID. Successful JSON output is assembled by
    /// the top-level command dispatcher.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::WorkflowNotFound` if the workflow doesn't exist.
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
    fn test_workflow_delete_command_with_uuid_ids() {
        let ids = vec![
            "0fbc3b2e",
            "0fbc3b2e-1111-4222-8333-123456789abc",
            "0FBC3B2E-1111-4222-8333-123456789ABC",
        ];
        for id in ids {
            let cmd = WorkflowDeleteCommand { id: id.to_string() };
            assert_eq!(cmd.id, id);
        }
    }

    #[test]
    fn test_workflow_delete_command_field_value() {
        let cmd = WorkflowDeleteCommand {
            id: "0fbc3b2e".to_string(),
        };
        assert_eq!(cmd.id, "0fbc3b2e");
    }

    #[test]
    fn test_workflow_delete_command_case_preservation() {
        let cmd = WorkflowDeleteCommand {
            id: "0FBC3B2E-1111-4222-8333-123456789ABC".to_string(),
        };
        assert_eq!(cmd.id, "0FBC3B2E-1111-4222-8333-123456789ABC");
    }

    #[test]
    fn test_workflow_delete_command_with_full_uuid() {
        let cmd = WorkflowDeleteCommand {
            id: "0fbc3b2e-1111-4222-8333-123456789abc".to_string(),
        };
        assert_eq!(cmd.id.len(), 36);
        assert!(cmd.id.contains('-'));
    }
}
