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
}
