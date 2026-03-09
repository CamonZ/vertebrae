//! Check-item command for marking checklist items as complete
//!
//! Implements the `vtb check-item` command to mark individual checklist items within a task as done.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Mark a checklist item as done within a task
#[derive(Debug, Args)]
pub struct CheckItemCommand {
    /// Task ID containing the checklist item (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Checklist item index (1-based) to mark as done
    #[arg(required = true)]
    pub index: usize,
}

/// Result of executing the check-item command
#[derive(Debug)]
pub struct CheckItemResult {
    /// The task ID
    pub task_id: String,
    /// The checklist item index that was marked done
    pub item_index: usize,
    /// The content of the checklist item that was marked done
    pub item_content: String,
}

impl std::fmt::Display for CheckItemResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Marked checklist item {} as done in {}: {}",
            self.item_index, self.task_id, self.item_content
        )
    }
}

impl CheckItemCommand {
    /// Execute the check-item command.
    ///
    /// Marks the specified checklist item as done within the task.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task does not exist
    /// - The checklist item index is out of bounds
    /// - Service operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<CheckItemResult, ServiceError> {
        let item = super::resolve_checklist_item(services, &self.id, self.index).await?;

        services
            .tasks()
            .mark_checklist_item_done(&item.id, item.section_order)
            .await?;

        Ok(CheckItemResult {
            task_id: item.id,
            item_index: self.index,
            item_content: item.content,
        })
    }
}
