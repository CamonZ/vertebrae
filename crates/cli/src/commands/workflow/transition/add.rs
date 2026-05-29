//! Workflow transition add command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// Create a new workflow transition.
///
/// Workflow and target step IDs accept full UUIDs or 8-character short IDs.
/// `--label`/`-l` is required; `--target-step`/`-t` is optional.
#[derive(Debug, Args)]
pub struct TransitionAddCommand {
    /// Source workflow ID (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("source workflow ID"))]
    pub from_workflow_id: String,

    /// Target workflow ID (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("target workflow ID"))]
    pub to_workflow_id: String,

    /// Label for the transition (e.g., "approve", "reject", "escalate")
    #[arg(short, long, required = true)]
    pub label: String,

    /// Optional target step ID in the destination workflow
    #[arg(short, long, value_parser = crate::commands::parse_uuid("target step ID"))]
    pub target_step: Option<String>,
}

impl TransitionAddCommand {
    /// Execute the add transition command.
    ///
    /// Creates a new transition from one workflow to another.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if either workflow, or the optional
    /// target step, doesn't exist.
    /// Returns `ServiceError::AlreadyExists` if the transition already exists.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        let transition = service
            .create_workflow_transition(
                &self.from_workflow_id,
                &self.to_workflow_id,
                &self.label,
                self.target_step.as_deref(),
            )
            .await?;

        let target_step_info = transition
            .target_step
            .map(|s| format!(" at step {}", s))
            .unwrap_or_default();

        Ok(format!(
            "Created transition '{}' from workflow {} to workflow {}{}",
            transition.label, self.from_workflow_id, self.to_workflow_id, target_step_info
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transition_add_command_debug() {
        let cmd = TransitionAddCommand {
            from_workflow_id: "wf1".to_string(),
            to_workflow_id: "wf2".to_string(),
            label: "approve".to_string(),
            target_step: None,
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("TransitionAddCommand"));
        assert!(debug.contains("wf1"));
        assert!(debug.contains("wf2"));
        assert!(debug.contains("approve"));
    }

    #[test]
    fn test_transition_add_command_with_target_step() {
        let cmd = TransitionAddCommand {
            from_workflow_id: "wf1".to_string(),
            to_workflow_id: "wf2".to_string(),
            label: "escalate".to_string(),
            target_step: Some("step3".to_string()),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("step3"));
    }
}
