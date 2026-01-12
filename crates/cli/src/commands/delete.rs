//! Delete command for removing tasks
//!
//! Implements the `vtb delete` command to remove tasks with proper handling
//! of children and dependencies.

use clap::Args;
use serde::Deserialize;
use std::io::{self, Write};
use vertebrae_db::{Database, DbError};

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

/// Information about a task for deletion
#[derive(Debug, Deserialize)]
struct TaskInfo {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    title: String,
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
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - Service operations fail
    pub async fn execute(
        &self,
        service: &dyn vertebrae_core::TaskService,
    ) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Need database access for detailed operations
        let db = service.database();

        // Verify task exists
        let task_info = self.fetch_task_info(db, &id).await?;

        // Get children count
        let children = self.fetch_children_ids(db, &id).await?;
        let children_count = children.len();

        // Get tasks that this task blocks
        let blocked_tasks = self.fetch_blocked_tasks(db, &id).await?;
        let blocks_count = blocked_tasks.len();

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
        if !self.force && children_count == 0 && !self.confirm_delete(&task_info.title)? {
            return Ok("Deletion cancelled".to_string());
        }

        // Perform the deletion
        let deleted_count = match child_action {
            ChildAction::Cascade => self.cascade_delete(db, &id).await?,
            ChildAction::Orphan => {
                self.orphan_children(db, &id).await?;
                self.delete_single_task(db, &id).await?;
                1
            }
            ChildAction::Cancel => unreachable!(), // Already handled above
        };

        if deleted_count == 1 {
            Ok(format!("Deleted task: {}", id))
        } else {
            Ok(format!(
                "Deleted {} tasks (including children)",
                deleted_count
            ))
        }
    }

    /// Fetch basic task info to verify existence and get title.
    async fn fetch_task_info(&self, db: &Database, id: &str) -> Result<TaskInfo, DbError> {
        let query = format!("SELECT id, title FROM task:{} LIMIT 1", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskInfo> = result.take(0)?;

        task.ok_or_else(|| DbError::TaskNotFound {
            task_id: self.id.clone(),
        })
    }

    /// Fetch IDs of all children of a task.
    async fn fetch_children_ids(&self, db: &Database, id: &str) -> Result<Vec<String>, DbError> {
        #[derive(Debug, Deserialize)]
        struct IdRow {
            id: surrealdb::sql::Thing,
        }

        // Children are tasks that have a child_of edge pointing to this task
        let query = format!(
            "SELECT id FROM task WHERE ->child_of->task CONTAINS task:{}",
            id
        );

        let mut result = db.client().query(&query).await?;
        let rows: Vec<IdRow> = result.take(0)?;

        Ok(rows.into_iter().map(|r| r.id.id.to_string()).collect())
    }

    /// Fetch tasks that depend on (are blocked by) this task.
    async fn fetch_blocked_tasks(&self, db: &Database, id: &str) -> Result<Vec<String>, DbError> {
        #[derive(Debug, Deserialize)]
        struct IdRow {
            id: surrealdb::sql::Thing,
        }

        // Tasks that depend on this task (this task blocks them)
        let query = format!(
            "SELECT id FROM task WHERE ->depends_on->task CONTAINS task:{}",
            id
        );

        let mut result = db.client().query(&query).await?;
        let rows: Vec<IdRow> = result.take(0)?;

        Ok(rows.into_iter().map(|r| r.id.id.to_string()).collect())
    }

    /// Recursively collect all descendant IDs (children, grandchildren, etc.)
    async fn collect_all_descendants(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<Vec<String>, DbError> {
        let mut all_descendants = Vec::new();
        let mut to_process = vec![id.to_string()];

        while let Some(current_id) = to_process.pop() {
            let children = self.fetch_children_ids(db, &current_id).await?;
            for child_id in children {
                if !all_descendants.contains(&child_id) {
                    all_descendants.push(child_id.clone());
                    to_process.push(child_id);
                }
            }
        }

        Ok(all_descendants)
    }

    /// Delete a task and all its descendants recursively.
    async fn cascade_delete(&self, db: &Database, id: &str) -> Result<usize, DbError> {
        // Collect all descendants first
        let descendants = self.collect_all_descendants(db, id).await?;

        // Delete all tasks (root + descendants)
        let all_ids: Vec<&str> = std::iter::once(id)
            .chain(descendants.iter().map(|s| s.as_str()))
            .collect();

        // Delete edges first
        for task_id in &all_ids {
            self.delete_all_edges(db, task_id).await?;
        }

        // Delete tasks
        for task_id in &all_ids {
            let query = format!("DELETE task:{}", task_id);
            db.client().query(&query).await?;
        }

        Ok(all_ids.len())
    }

    /// Make children of a task into root tasks (orphan them).
    async fn orphan_children(&self, db: &Database, id: &str) -> Result<(), DbError> {
        // Delete child_of edges where children point to this task
        let query = format!("DELETE child_of WHERE out = task:{}", id);
        db.client().query(&query).await?;
        Ok(())
    }

    /// Delete a single task and clean up its edges.
    async fn delete_single_task(&self, db: &Database, id: &str) -> Result<(), DbError> {
        // Clean up all edges
        self.delete_all_edges(db, id).await?;

        // Delete the task
        let query = format!("DELETE task:{}", id);
        db.client().query(&query).await?;

        Ok(())
    }

    /// Delete all edges connected to a task.
    async fn delete_all_edges(&self, db: &Database, id: &str) -> Result<(), DbError> {
        // Delete child_of edges where this task is the child (out direction)
        let query = format!("DELETE child_of WHERE in = task:{}", id);
        db.client().query(&query).await?;

        // Delete child_of edges where this task is the parent (in direction)
        let query = format!("DELETE child_of WHERE out = task:{}", id);
        db.client().query(&query).await?;

        // Delete depends_on edges where this task depends on something
        let query = format!("DELETE depends_on WHERE in = task:{}", id);
        db.client().query(&query).await?;

        // Delete depends_on edges where something depends on this task
        let query = format!("DELETE depends_on WHERE out = task:{}", id);
        db.client().query(&query).await?;

        Ok(())
    }

    /// Prompt user for action when task has children.
    fn prompt_child_action(&self, children_count: usize) -> Result<ChildAction, DbError> {
        print!(
            "Task has {} {}. [C]ascade delete / [O]rphan / [A]bort? ",
            children_count,
            if children_count == 1 {
                "child"
            } else {
                "children"
            }
        );
        io::stdout().flush().map_err(|e| DbError::InvalidPath {
            path: std::path::PathBuf::from("stdout"),
            reason: format!("Failed to flush stdout: {}", e),
        })?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from("stdin"),
                reason: format!("Failed to read input: {}", e),
            })?;

        match input.trim().to_lowercase().as_str() {
            "c" | "cascade" => Ok(ChildAction::Cascade),
            "o" | "orphan" => Ok(ChildAction::Orphan),
            "a" | "abort" | "" => Ok(ChildAction::Cancel),
            _ => Ok(ChildAction::Cancel),
        }
    }

    /// Confirm deletion when task blocks other tasks.
    fn confirm_blocking(&self, blocks_count: usize) -> Result<bool, DbError> {
        print!(
            "This task blocks {} other {}. Continue? [y/N] ",
            blocks_count,
            if blocks_count == 1 { "task" } else { "tasks" }
        );
        io::stdout().flush().map_err(|e| DbError::InvalidPath {
            path: std::path::PathBuf::from("stdout"),
            reason: format!("Failed to flush stdout: {}", e),
        })?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from("stdin"),
                reason: format!("Failed to read input: {}", e),
            })?;

        Ok(matches!(input.trim().to_lowercase().as_str(), "y" | "yes"))
    }

    /// Confirm simple deletion.
    fn confirm_delete(&self, title: &str) -> Result<bool, DbError> {
        print!("Delete task '{}'? [y/N] ", title);
        io::stdout().flush().map_err(|e| DbError::InvalidPath {
            path: std::path::PathBuf::from("stdout"),
            reason: format!("Failed to flush stdout: {}", e),
        })?;

        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from("stdin"),
                reason: format!("Failed to read input: {}", e),
            })?;

        Ok(matches!(input.trim().to_lowercase().as_str(), "y" | "yes"))
    }
}
