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
    #[arg(required = true)]
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

        // Get task with all its relationships
        let task_with_relations = services.tasks().get_task_with_relations(&id).await?;
        let task_title = &task_with_relations.task.title;
        let children_count = task_with_relations.children_ids.len();
        let blocks_count = task_with_relations.dependent_ids.len();

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
        let relations = services.tasks().get_task_with_relations(id).await?;
        let mut count = relations.children_ids.len();

        for child_id in &relations.children_ids {
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

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::{CreateTaskOptions, Database, Level, VertebraeServices};

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> VertebraeServices {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    /// Helper to create a task via the service layer
    async fn create_task(services: &VertebraeServices, id: &str, title: &str) {
        let options = CreateTaskOptions::new(title)
            .with_id(id)
            .with_level(Level::Task)
            .with_status("in_progress");
        services.tasks().create_task(options).await.unwrap();
    }

    /// Helper to create a parent-child relationship
    async fn create_child_of(services: &VertebraeServices, child_id: &str, parent_id: &str) {
        services
            .tasks()
            .set_parent(child_id, parent_id)
            .await
            .unwrap();
    }

    // ========================================
    // ChildAction enum tests
    // ========================================

    #[test]
    fn test_child_action_eq() {
        assert_eq!(ChildAction::Cascade, ChildAction::Cascade);
        assert_eq!(ChildAction::Orphan, ChildAction::Orphan);
        assert_eq!(ChildAction::Cancel, ChildAction::Cancel);
        assert_ne!(ChildAction::Cascade, ChildAction::Orphan);
        assert_ne!(ChildAction::Cascade, ChildAction::Cancel);
        assert_ne!(ChildAction::Orphan, ChildAction::Cancel);
    }

    #[test]
    fn test_child_action_clone() {
        let action = ChildAction::Cascade;
        let cloned = action;
        assert_eq!(action, cloned);
    }

    #[test]
    fn test_child_action_debug() {
        let debug_str = format!("{:?}", ChildAction::Cascade);
        assert!(debug_str.contains("Cascade"));
        let debug_str = format!("{:?}", ChildAction::Orphan);
        assert!(debug_str.contains("Orphan"));
        let debug_str = format!("{:?}", ChildAction::Cancel);
        assert!(debug_str.contains("Cancel"));
    }

    // ========================================
    // DeleteCommand parsing tests
    // ========================================

    #[test]
    fn test_delete_command_debug() {
        let cmd = DeleteCommand {
            id: "abc123".to_string(),
            cascade: true,
            force: false,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("DeleteCommand"));
        assert!(debug_str.contains("abc123"));
        assert!(debug_str.contains("cascade: true"));
        assert!(debug_str.contains("force: false"));
    }

    #[test]
    fn test_delete_command_defaults() {
        let cmd = DeleteCommand {
            id: "test".to_string(),
            cascade: false,
            force: false,
        };
        assert_eq!(cmd.id, "test");
        assert!(!cmd.cascade);
        assert!(!cmd.force);
    }

    // ========================================
    // Async execution tests
    // ========================================

    #[tokio::test]
    async fn test_delete_simple_task_with_force() {
        let services = setup_test_service().await;
        create_task(&services, "task1", "Task to delete").await;

        let cmd = DeleteCommand {
            id: "task1".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Delete failed: {:?}", result.err());
        assert_eq!(result.unwrap(), "Deleted task: task1");

        // Verify task is gone
        let exists = services.tasks().task_exists("task1").await.unwrap();
        assert!(!exists);
    }

    #[tokio::test]
    async fn test_delete_nonexistent_task() {
        let services = setup_test_service().await;

        let cmd = DeleteCommand {
            id: "nonexistent".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err(), "Should fail for nonexistent task");
    }

    #[tokio::test]
    async fn test_delete_case_insensitive() {
        let services = setup_test_service().await;
        create_task(&services, "abc123", "Task to delete").await;

        let cmd = DeleteCommand {
            id: "ABC123".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&services).await;
        assert!(
            result.is_ok(),
            "Case-insensitive delete failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_delete_cascade_with_children() {
        let services = setup_test_service().await;

        // Create parent with children
        let parent_opts = CreateTaskOptions::new("Parent")
            .with_id("parent1")
            .with_level(Level::Epic)
            .with_status("in_progress");
        services.tasks().create_task(parent_opts).await.unwrap();

        create_task(&services, "child1", "Child 1").await;
        create_task(&services, "child2", "Child 2").await;
        create_child_of(&services, "child1", "parent1").await;
        create_child_of(&services, "child2", "parent1").await;

        let cmd = DeleteCommand {
            id: "parent1".to_string(),
            cascade: true,
            force: true,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Cascade delete failed: {:?}", result.err());

        let msg = result.unwrap();
        assert!(
            msg.contains("Deleted 3 tasks"),
            "Expected '3 tasks' in message, got: {}",
            msg
        );

        // Verify all tasks are gone
        assert!(!services.tasks().task_exists("parent1").await.unwrap());
        assert!(!services.tasks().task_exists("child1").await.unwrap());
        assert!(!services.tasks().task_exists("child2").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_force_orphans_children() {
        let services = setup_test_service().await;

        let parent_opts = CreateTaskOptions::new("Parent")
            .with_id("parent1")
            .with_level(Level::Epic)
            .with_status("in_progress");
        services.tasks().create_task(parent_opts).await.unwrap();

        create_task(&services, "child1", "Child 1").await;
        create_child_of(&services, "child1", "parent1").await;

        // --force without --cascade should orphan children
        let cmd = DeleteCommand {
            id: "parent1".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&services).await;
        assert!(
            result.is_ok(),
            "Delete with orphan failed: {:?}",
            result.err()
        );
        assert_eq!(result.unwrap(), "Deleted task: parent1");

        // Parent gone, child still exists
        assert!(!services.tasks().task_exists("parent1").await.unwrap());
        assert!(services.tasks().task_exists("child1").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_cascade_nested_children() {
        let services = setup_test_service().await;

        let grandparent_opts = CreateTaskOptions::new("Grandparent")
            .with_id("gp1")
            .with_level(Level::Epic)
            .with_status("in_progress");
        services
            .tasks()
            .create_task(grandparent_opts)
            .await
            .unwrap();

        let parent_opts = CreateTaskOptions::new("Parent")
            .with_id("p1")
            .with_level(Level::Ticket)
            .with_status("in_progress");
        services.tasks().create_task(parent_opts).await.unwrap();

        create_task(&services, "c1", "Child").await;

        create_child_of(&services, "p1", "gp1").await;
        create_child_of(&services, "c1", "p1").await;

        let cmd = DeleteCommand {
            id: "gp1".to_string(),
            cascade: true,
            force: true,
        };

        let result = cmd.execute(&services).await;
        assert!(
            result.is_ok(),
            "Nested cascade delete failed: {:?}",
            result.err()
        );

        let msg = result.unwrap();
        assert!(
            msg.contains("Deleted 3 tasks"),
            "Expected '3 tasks' in message, got: {}",
            msg
        );

        assert!(!services.tasks().task_exists("gp1").await.unwrap());
        assert!(!services.tasks().task_exists("p1").await.unwrap());
        assert!(!services.tasks().task_exists("c1").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_task_no_children_force() {
        let services = setup_test_service().await;
        create_task(&services, "solo", "Solo Task").await;

        let cmd = DeleteCommand {
            id: "solo".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Deleted task: solo");
    }
}
