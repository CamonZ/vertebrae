//! Workflow show command

use super::types::{StepDisplayInfo, WorkflowDetail};
use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Show details of a specific workflow
#[derive(Debug, Args)]
pub struct WorkflowShowCommand {
    /// Workflow ID to show (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("workflow ID"))]
    pub id: String,
}

impl WorkflowShowCommand {
    /// Execute the show workflow command.
    ///
    /// Fetches the workflow with the given ID and returns detailed information.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the workflow doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let workflow = services.workflows().get_workflow(&self.id).await?;

        let workflow_id = workflow
            .id
            .as_ref()
            .cloned()
            .unwrap_or_else(|| self.id.clone());

        // Get steps from first-class Step entities
        let steps = if let Some(ref workflow_id_str) = workflow.id {
            let first_class_steps = services
                .steps()
                .list_steps_for_workflow(workflow_id_str.as_str())
                .await?;
            // Convert to display format
            first_class_steps
                .into_iter()
                .map(|s| StepDisplayInfo {
                    name: s.name,
                    model: s.agent_config.model,
                    order: s.order,
                    prompt: s.prompt,
                    eval_prompt: s.eval_prompt,
                })
                .collect()
        } else {
            Vec::new()
        };

        let detail = WorkflowDetail {
            id: workflow_id,
            name: workflow.name,
            description: workflow.description,
            auto_advance: workflow.auto_advance,
            steps,
            metadata: workflow.metadata,
            created_at: workflow.created_at.map(|dt| dt.to_rfc3339()),
            updated_at: workflow.updated_at.map(|dt| dt.to_rfc3339()),
        };
        Ok(detail.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_show_command_debug() {
        let cmd = WorkflowShowCommand {
            id: "test".to_string(),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowShowCommand"));
        assert!(debug.contains("test"));
    }
}
