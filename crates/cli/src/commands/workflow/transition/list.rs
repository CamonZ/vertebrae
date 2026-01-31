//! Workflow transition list command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// List workflow transitions
#[derive(Debug, Args)]
pub struct TransitionListCommand {
    /// Filter by source workflow ID (case-insensitive)
    #[arg(short, long)]
    pub workflow_id: Option<String>,
}

impl TransitionListCommand {
    /// Execute the list transitions command.
    ///
    /// Lists all workflow transitions, optionally filtered by source workflow.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        let transitions = service
            .list_workflow_transitions(self.workflow_id.as_deref())
            .await?;

        if transitions.is_empty() {
            let msg = if let Some(ref wf_id) = self.workflow_id {
                format!("No transitions found for workflow {}", wf_id)
            } else {
                "No workflow transitions found".to_string()
            };
            return Ok(msg);
        }

        let output = transitions
            .iter()
            .map(|t| {
                let from_id = &t.from_workflow;
                let to_id = &t.to_workflow;
                let target_step = t
                    .target_step
                    .as_ref()
                    .map(|s| format!(" -> step:{}", s))
                    .unwrap_or_default();

                format!("{} -> {} [{}]{}", from_id, to_id, t.label, target_step)
            })
            .collect::<Vec<_>>()
            .join("\n");

        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transition_list_command_debug() {
        let cmd = TransitionListCommand { workflow_id: None };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("TransitionListCommand"));
    }

    #[test]
    fn test_transition_list_command_with_filter() {
        let cmd = TransitionListCommand {
            workflow_id: Some("wf1".to_string()),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("wf1"));
    }
}
