//! Uncheck-item command for unchecking previously checked checklist items
//!
//! Implements the `vtb uncheck-item` command to toggle a previously checked checklist item
//! back to done=false, done_at=null.

use clap::Args;
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
#[derive(Debug)]
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
    /// Toggles the specified checklist item back to done=false within the task.
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
    ) -> Result<UncheckItemResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate index is positive
        if self.index == 0 {
            return Err(ServiceError::validation_failed(
                "Checklist item index must be 1 or greater",
            ));
        }

        // Fetch task via service to get the checklist item content before updating
        let task = services.tasks().get_task(&id).await?;

        let sections = task.sections.clone();

        // Filter to only checklist item sections and sort by order
        let mut items: Vec<(usize, &vertebrae_core::Section)> = sections
            .iter()
            .enumerate()
            .filter(|(_, s)| s.section_type == vertebrae_core::SectionType::ChecklistItem)
            .collect();
        items.sort_by_key(|(_, s)| s.order.unwrap_or(u32::MAX));

        // Find the checklist item by index (1-based)
        let item_idx = self.index - 1;
        if item_idx >= items.len() {
            return Err(ServiceError::validation_failed(format!(
                "Checklist item {} not found. Task has {} checklist item(s).",
                self.index,
                items.len()
            )));
        }

        let (_, item) = items[item_idx];
        let item_content = item.content.clone();
        let ordinal = item.order.unwrap_or(0);

        // Use the service method to toggle checklist item done status
        services
            .tasks()
            .toggle_checklist_item_done(&id, ordinal)
            .await?;

        Ok(UncheckItemResult {
            task_id: id,
            item_index: self.index,
            item_content,
        })
    }
}
