//! Workflow list command

use clap::Args;
use vertebrae_core::{ServiceError, WorkflowService};

/// List all workflows
#[derive(Debug, Args)]
pub struct WorkflowListCommand {}

impl WorkflowListCommand {
    /// Execute the list workflows command.
    ///
    /// Fetches all workflows from the database and returns a formatted list.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        let summaries = service.list_workflows().await?;

        if summaries.is_empty() {
            return Ok("No workflows found".to_string());
        }

        let output = summaries
            .iter()
            .map(|s| {
                format!(
                    "{} - {} ({} steps){}",
                    s.id,
                    s.name,
                    s.step_count,
                    s.description
                        .as_ref()
                        .map(|d| format!(" - {}", d))
                        .unwrap_or_default()
                )
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
    fn test_workflow_list_command_debug() {
        let cmd = WorkflowListCommand {};
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowListCommand"));
    }
}
