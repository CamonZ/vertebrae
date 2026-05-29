//! Delete command for removing tasks.
//!
//! Implements `vtb delete <ID>` with optional cascading, confirmation prompts,
//! and dependency cleanup handled by the task service. Without `--cascade`,
//! deleting a task with children orphans those children when the user chooses
//! orphaning or passes `--force`.

use clap::Args;
use serde::Serialize;
use std::io::{self, Write};
use vertebrae_core::{ServiceError, VertebraeServices};

/// Delete a task with optional cascade behavior.
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

/// Structured result of a delete command.
#[derive(Debug, Serialize)]
pub struct DeleteResult {
    pub task_id: String,
    pub cascade: bool,
    pub deleted: bool,
    pub deleted_count: usize,
}

impl DeleteResult {
    fn cancelled(task_id: String) -> Self {
        Self {
            task_id,
            cascade: false,
            deleted: false,
            deleted_count: 0,
        }
    }
}

impl DeleteCommand {
    /// Execute the delete command and return a structured result.
    ///
    /// Cancelled prompts return `Ok(DeleteResult { deleted: false, .. })`
    /// without mutating the task.
    pub async fn execute_result(
        &self,
        services: &VertebraeServices,
    ) -> Result<DeleteResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        let task = services.tasks().get_task(&id).await?;
        let task_title = &task.title;
        let children_ids: Vec<String> =
            task.children.iter().map(|child| child.id.clone()).collect();
        let children_count = children_ids.len();

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
            return Ok(DeleteResult::cancelled(id));
        }

        // If not --force and task blocks others, warn and confirm
        if !self.force {
            let blocks_count = task.dependents.len();
            if blocks_count > 0 && !self.confirm_blocking(blocks_count)? {
                return Ok(DeleteResult::cancelled(id));
            }
        }

        // If not --force and no children, just confirm deletion
        if !self.force && children_count == 0 && !self.confirm_delete(task_title)? {
            return Ok(DeleteResult::cancelled(id));
        }

        // Determine if we should cascade
        let cascade = child_action == ChildAction::Cascade;

        // Count descendants for message (if cascading)
        let deleted_count = if cascade {
            self.count_descendants_from_children(services, &children_ids)
                .await?
                + 1
        } else {
            1
        };

        // Perform the deletion via service
        services.tasks().delete_task(&id, cascade).await?;

        Ok(DeleteResult {
            task_id: id,
            cascade,
            deleted: true,
            deleted_count,
        })
    }

    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let result = self.execute_result(services).await?;

        if !result.deleted {
            return Ok("Deletion cancelled".to_string());
        }

        if result.deleted_count == 1 {
            Ok(format!("Deleted task: {}", result.task_id))
        } else {
            Ok(format!(
                "Deleted {} tasks (including children)",
                result.deleted_count
            ))
        }
    }

    /// Count descendants from an already-known child list.
    async fn count_descendants_from_children(
        &self,
        services: &VertebraeServices,
        children_ids: &[String],
    ) -> Result<usize, ServiceError> {
        let mut count = children_ids.len();

        for child_id in children_ids {
            let grandchildren_ids = services.tasks().get_children(child_id).await?;
            count += Box::pin(self.count_descendants_from_children(services, &grandchildren_ids))
                .await?;
        }

        Ok(count)
    }

    fn prompt_input(prompt: &str) -> Result<String, ServiceError> {
        print!("{}", prompt);
        io::stdout().flush().map_err(|e| {
            ServiceError::validation_failed(format!("Failed to flush stdout: {}", e))
        })?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| ServiceError::validation_failed(format!("Failed to read input: {}", e)))?;
        Ok(input)
    }

    /// Prompt user for action when task has children.
    fn prompt_child_action(&self, children_count: usize) -> Result<ChildAction, ServiceError> {
        let input = Self::prompt_input(&format!(
            "Task has {} {}. [C]ascade delete / [O]rphan / [A]bort? ",
            children_count,
            if children_count == 1 {
                "child"
            } else {
                "children"
            }
        ))?;

        match input.trim().to_lowercase().as_str() {
            "c" | "cascade" => Ok(ChildAction::Cascade),
            "o" | "orphan" => Ok(ChildAction::Orphan),
            "a" | "abort" | "" => Ok(ChildAction::Cancel),
            _ => Ok(ChildAction::Cancel),
        }
    }

    /// Confirm deletion when task blocks other tasks.
    fn confirm_blocking(&self, blocks_count: usize) -> Result<bool, ServiceError> {
        let input = Self::prompt_input(&format!(
            "This task blocks {} other {}. Continue? [y/N] ",
            blocks_count,
            if blocks_count == 1 { "task" } else { "tasks" }
        ))?;

        Ok(matches!(input.trim().to_lowercase().as_str(), "y" | "yes"))
    }

    /// Confirm simple deletion.
    fn confirm_delete(&self, title: &str) -> Result<bool, ServiceError> {
        let input = Self::prompt_input(&format!("Delete task '{}'? [y/N] ", title))?;

        Ok(matches!(input.trim().to_lowercase().as_str(), "y" | "yes"))
    }
}
