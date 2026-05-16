//! Uncheck-item command for unchecking previously checked checklist items
//!
//! Implements the `vtb uncheck-item` command to set a previously checked checklist item
//! back to done=false, done_at=null.

use clap::Args;
use serde::Serialize;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Uncheck a previously checked checklist item within a task
#[derive(Debug, Args)]
pub struct UncheckItemCommand {
    /// Task ID containing the checklist item (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Checklist item index (1-based) to uncheck
    #[arg(required = true)]
    pub index: usize,
}

/// Result of executing the uncheck-item command
#[derive(Debug, Serialize)]
pub struct UncheckItemResult {
    /// The task ID
    pub task_id: String,
    /// The checklist item index that was unchecked
    pub item_index: usize,
    /// The content of the checklist item that was unchecked
    pub item_content: String,
}

impl std::fmt::Display for UncheckItemResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Unchecked checklist item {} in {}: {}",
            self.item_index, self.task_id, self.item_content
        )
    }
}

impl UncheckItemCommand {
    /// Execute the uncheck-item command.
    ///
    /// Sets the specified checklist item to done=false within the task.
    /// Returns an error if the item is not currently checked.
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
    /// - The checklist item is not currently checked
    /// - Service operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<UncheckItemResult, ServiceError> {
        let resolved = super::resolve_checklist_item(services, &self.id, self.index).await?;

        if !resolved.done {
            return Err(ServiceError::validation_failed(format!(
                "Checklist item {} is not checked",
                self.index
            )));
        }

        services
            .tasks()
            .toggle_checklist_item_done(&resolved.id, resolved.section_order)
            .await?;

        Ok(UncheckItemResult {
            task_id: resolved.id,
            item_index: self.index,
            item_content: resolved.content,
        })
    }
}
