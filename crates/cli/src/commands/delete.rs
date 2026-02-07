//! Delete command for removing tasks
//!
//! Implements the `vtb delete` command to remove tasks with proper handling
//! of children and dependencies.

use clap::Args;
use std::io::{self, Write};
use vertebrae_core::{ServiceError, VertebraeServices};

/// Delete a task with optional cascade behavior
#[derive(Debug, Args)]
pub struct DeleteCommand {
    /// Task ID to delete (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Also delete all children recursively
    #[arg(long)]
    pub cascade: bool,

    /// Skip confirmation prompt
    #[arg(short, long)]
    pub force: bool,
}

/// Choice for handling children when deleting a task
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildAction {
    /// Delete all children recursively
    Cascade,
    /// Make children root tasks (remove parent relationship)
    Orphan,
    /// Cancel the deletion
    Cancel,
}

impl DeleteCommand {
    /// Execute the delete command.
    ///
    /// Deletes the task with the given ID, handling children and dependencies
    /// according to the specified options.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Service operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Get task and its relationships separately
        let task = services.tasks().get_task(&id).await?;
        let task_title = &task.title;
        let children_ids = services.tasks().get_children(&id).await?;
        let children_count = children_ids.len();
        let dependent_ids = services.tasks().get_dependents(&id).await?;
        let blocks_count = dependent_ids.len();

        // Determine action for children
        let child_action = if children_count > 0 {
            if self.cascade {
                ChildAction::Cascade
            } else if self.force {
                // With --force but no --cascade, we orphan children
                ChildAction::Orphan
            } else {
                // Interactive: ask user
                self.prompt_child_action(children_count)?
            }
        } else {
            // No children, no action needed
            ChildAction::Orphan
        };

        // Handle cancel
        if child_action == ChildAction::Cancel {
            return Ok("Deletion cancelled".to_string());
        }

        // If not --force and task blocks others, warn and confirm
        if !self.force && blocks_count > 0 && !self.confirm_blocking(blocks_count)? {
            return Ok("Deletion cancelled".to_string());
        }

        // If not --force and no children, just confirm deletion
        if !self.force && children_count == 0 && !self.confirm_delete(task_title)? {
            return Ok("Deletion cancelled".to_string());
        }

        // Determine if we should cascade
        let cascade = child_action == ChildAction::Cascade;

        // Count descendants for message (if cascading)
        let deleted_count = if cascade {
            self.count_descendants(services, &id).await? + 1
        } else {
            1
        };

        // Perform the deletion via service
        services.tasks().delete_task(&id, cascade).await?;

        if deleted_count == 1 {
            Ok(format!("Deleted task: {}", id))
        } else {
            Ok(format!(
                "Deleted {} tasks (including children)",
                deleted_count
            ))
        }
    }

    /// Count all descendants of a task recursively.
    async fn count_descendants(
        &self,
        services: &VertebraeServices,
        id: &str,
    ) -> Result<usize, ServiceError> {
        let children_ids = services.tasks().get_children(id).await?;
        let mut count = children_ids.len();

        for child_id in &children_ids {
            count += Box::pin(self.count_descendants(services, child_id)).await?;
        }

        Ok(count)
    }

    /// Prompt user for action when task has children.
    fn prompt_child_action(&self, children_count: usize) -> Result<ChildAction, ServiceError> {
        print!(
            "Task has {} {}. [C]ascade delete / [O]rphan / [A]bort? ",
            children_count,
            if children_count == 1 {
                "child"
            } else {
                "children"
            }
        );
        io::stdout().flush().map_err(|e| {
            ServiceError::validation_failed(format!("Failed to flush stdout: {}", e))
        })?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| ServiceError::validation_failed(format!("Failed to read input: {}", e)))?;

        match input.trim().to_lowercase().as_str() {
            "c" | "cascade" => Ok(ChildAction::Cascade),
            "o" | "orphan" => Ok(ChildAction::Orphan),
            "a" | "abort" | "" => Ok(ChildAction::Cancel),
            _ => Ok(ChildAction::Cancel),
        }
    }

    /// Confirm deletion when task blocks other tasks.
    fn confirm_blocking(&self, blocks_count: usize) -> Result<bool, ServiceError> {
        print!(
            "This task blocks {} other {}. Continue? [y/N] ",
            blocks_count,
            if blocks_count == 1 { "task" } else { "tasks" }
        );
        io::stdout().flush().map_err(|e| {
            ServiceError::validation_failed(format!("Failed to flush stdout: {}", e))
        })?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| ServiceError::validation_failed(format!("Failed to read input: {}", e)))?;

        Ok(matches!(input.trim().to_lowercase().as_str(), "y" | "yes"))
    }

    /// Confirm simple deletion.
    fn confirm_delete(&self, title: &str) -> Result<bool, ServiceError> {
        print!("Delete task '{}'? [y/N] ", title);
        io::stdout().flush().map_err(|e| {
            ServiceError::validation_failed(format!("Failed to flush stdout: {}", e))
        })?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| ServiceError::validation_failed(format!("Failed to read input: {}", e)))?;

        Ok(matches!(input.trim().to_lowercase().as_str(), "y" | "yes"))
    }
}
