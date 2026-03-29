//! Workflow update command

use clap::Args;
use vertebrae_core::{ServiceError, UpdateWorkflowOptions, WorkflowService};

/// Update a workflow's properties
#[derive(Debug, Args)]
pub struct WorkflowUpdateCommand {
    /// Workflow ID to update (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("workflow ID"))]
    pub id: String,

    /// New name for the workflow
    #[arg(short, long)]
    pub name: Option<String>,

    /// New description for the workflow
    #[arg(short, long)]
    pub description: Option<String>,

    /// Clear the workflow description
    #[arg(long, conflicts_with = "description")]
    pub clear_description: bool,

    /// Enable automatic advancement to the next step on successful completion
    #[arg(long, conflicts_with = "no_auto_advance")]
    pub auto_advance: bool,

    /// Disable automatic advancement to the next step
    #[arg(long, conflicts_with = "auto_advance")]
    pub no_auto_advance: bool,

    /// Track for categorizing the workflow (use empty string "" to clear)
    #[arg(long)]
    pub track: Option<String>,

    /// Kanban column for the workflow (use empty string "" to clear)
    #[arg(long = "kanban-column")]
    pub kanban_column: Option<String>,
}

impl WorkflowUpdateCommand {
    /// Execute the update workflow command.
    ///
    /// Updates the workflow with the specified ID using the provided options.
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
        // Build the update options
        let mut options = UpdateWorkflowOptions::new();

        if let Some(name) = &self.name {
            options = options.with_name(name);
        }

        if let Some(description) = &self.description {
            options = options.with_description(description);
        } else if self.clear_description {
            options = options.clear_description();
        }

        if self.auto_advance {
            options = options.with_auto_advance(true);
        } else if self.no_auto_advance {
            options = options.with_auto_advance(false);
        }

        if let Some(track) = &self.track {
            if track.is_empty() {
                options = options.clear_track();
            } else {
                options = options.with_track(track);
            }
        }

        if let Some(kanban_column) = &self.kanban_column {
            if kanban_column.is_empty() {
                options = options.clear_kanban_column();
            } else {
                options = options.with_kanban_column(kanban_column);
            }
        }

        // Check if any updates were provided
        if !options.has_updates() {
            return Err(ServiceError::validation_failed(
                "no updates specified (use --name, --description, --clear-description, --auto-advance, --no-auto-advance, --track, or --kanban-column options)",
            ));
        }

        // Apply the updates
        service.update_workflow(&self.id, options).await?;

        Ok(format!("Updated workflow: {}", self.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_update_command_debug() {
        let cmd = WorkflowUpdateCommand {
            id: "wf1".to_string(),
            name: Some("New Name".to_string()),
            description: None,
            clear_description: false,
            auto_advance: false,
            no_auto_advance: false,
            track: None,
            kanban_column: None,
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("WorkflowUpdateCommand"));
        assert!(debug.contains("wf1"));
        assert!(debug.contains("New Name"));
    }
}
