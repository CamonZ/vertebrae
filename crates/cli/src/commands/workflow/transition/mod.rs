//! Workflow transition commands
//!
//! Subcommands for managing transitions between workflows.

mod add;
mod delete;
mod list;

pub use add::TransitionAddCommand;
pub use delete::TransitionDeleteCommand;
pub use list::TransitionListCommand;

use clap::Subcommand;
use vertebrae_core::{ServiceError, WorkflowService};

/// Transition management commands
#[derive(Debug, Subcommand)]
pub enum TransitionCommand {
    /// Create a new workflow transition
    Add(TransitionAddCommand),
    /// List workflow transitions
    List(TransitionListCommand),
    /// Delete a workflow transition
    Delete(TransitionDeleteCommand),
}

impl TransitionCommand {
    /// Execute the transition subcommand.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        match self {
            TransitionCommand::Add(cmd) => cmd.execute(service).await,
            TransitionCommand::List(cmd) => cmd.execute(service).await,
            TransitionCommand::Delete(cmd) => cmd.execute(service).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transition_command_debug() {
        let cmd = TransitionCommand::List(TransitionListCommand { workflow_id: None });
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("List"));
    }
}
