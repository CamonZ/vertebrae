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
    use clap::Parser;

    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        command: WorkflowDeleteCommand,
    }

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
    fn test_workflow_delete_command_parses_short_id() {
        let cli = TestCli::try_parse_from(["test", "0FBC3B2E"]).unwrap();
        assert_eq!(cli.command.id, "0fbc3b2e");
    }

    #[test]
    fn test_workflow_delete_command_parses_full_uuid() {
        let cli =
            TestCli::try_parse_from(["test", "0FBC3B2E-1111-4222-8333-123456789ABC"]).unwrap();
        assert_eq!(cli.command.id, "0fbc3b2e-1111-4222-8333-123456789abc");
    }

    #[test]
    fn test_workflow_delete_command_rejects_invalid_id() {
        let result = TestCli::try_parse_from(["test", "not-a-workflow-id"]);
        assert!(result.is_err());
    }
}
