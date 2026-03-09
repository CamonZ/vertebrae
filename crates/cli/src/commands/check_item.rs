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

        // Use the service method to mark checklist item as done
        services
            .tasks()
            .mark_checklist_item_done(&id, self.index)
            .await?;

        Ok(CheckItemResult {
            task_id: id,
            item_index: self.index,
            item_content,
        })
    }
}
