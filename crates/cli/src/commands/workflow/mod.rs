//! Workflow commands for managing workflow definitions
//!
//! Implements the `vtb workflow` subcommand group for creating and managing workflows.

mod add;
mod advance;
mod assign;
mod delete;
mod list;
mod reject;
mod retreat;
mod show;
pub mod transition;
mod types;
mod unassign;
mod update;

// Tests disabled: Database tests not applicable with Sacrum HTTP backend
// #[cfg(test)]
// mod tests;

pub use add::{ParsedStep, WorkflowAddCommand, parse_step};
pub use advance::WorkflowAdvanceCommand;
pub use assign::WorkflowAssignCommand;
pub use delete::WorkflowDeleteCommand;
pub use list::WorkflowListCommand;
pub use reject::WorkflowRejectCommand;
pub use retreat::WorkflowRetreatCommand;
pub use show::WorkflowShowCommand;
pub use transition::TransitionCommand;
pub use types::{StepDisplayInfo, WorkflowDetail, WorkflowSummary, format_timestamp};
pub use unassign::WorkflowUnassignCommand;
pub use update::WorkflowUpdateCommand;

use clap::Subcommand;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Workflow management commands
#[derive(Debug, Subcommand)]
pub enum WorkflowCommand {
    /// Create a new workflow
    Add(WorkflowAddCommand),
    /// List all workflows
    List(WorkflowListCommand),
    /// Show details of a specific workflow
    Show(WorkflowShowCommand),
    /// Update a workflow's properties
    Update(WorkflowUpdateCommand),
    /// Delete a workflow
    Delete(WorkflowDeleteCommand),
    /// Assign a task to a workflow
    Assign(WorkflowAssignCommand),
    /// Remove workflow assignment from a task
    Unassign(WorkflowUnassignCommand),
    /// Advance a task to the next workflow step
    Advance(WorkflowAdvanceCommand),
    /// Retreat a task to the previous workflow step
    Retreat(WorkflowRetreatCommand),
    /// Reject a task in its workflow (unassigns workflow from task)
    Reject(WorkflowRejectCommand),
    /// Manage workflow transitions
    #[command(subcommand)]
    Transition(TransitionCommand),
}

impl WorkflowCommand {
    /// Execute the workflow subcommand.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let workflow_service = services.workflows();
        match self {
            WorkflowCommand::Add(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::List(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::Show(cmd) => cmd.execute(services).await,
            WorkflowCommand::Update(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::Delete(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::Assign(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::Unassign(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::Advance(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::Retreat(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::Reject(cmd) => cmd.execute(workflow_service).await,
            WorkflowCommand::Transition(cmd) => cmd.execute(workflow_service).await,
        }
    }
}
