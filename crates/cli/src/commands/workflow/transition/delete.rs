//! Workflow transition delete command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Delete a workflow transition.
///
/// Source and target workflow IDs accept full UUIDs or 8-character short IDs.
/// The command has no command-specific flags; the global `--json` flag returns
/// a structured operation result with the resolved source and target workflow IDs.
#[derive(Debug, Args)]
pub struct TransitionDeleteCommand {
    /// Source workflow ID (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("source workflow ID"))]
    pub from_workflow_id: String,

    /// Target workflow ID (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("target workflow ID"))]
    pub to_workflow_id: String,
}

impl TransitionDeleteCommand {
    /// Execute the delete transition command.
    ///
    /// Deletes the transition between two workflows.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the transition doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        service
            .delete_workflow_transition(&self.from_workflow_id, &self.to_workflow_id)
            .await?;

        Ok(format!(
            "Deleted transition from workflow {} to workflow {}",
            self.from_workflow_id, self.to_workflow_id
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transition_delete_command_debug() {
        let cmd = TransitionDeleteCommand {
            from_workflow_id: "wf1".to_string(),
            to_workflow_id: "wf2".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("TransitionDeleteCommand"));
        assert!(debug.contains("wf1"));
        assert!(debug.contains("wf2"));
    }
}
