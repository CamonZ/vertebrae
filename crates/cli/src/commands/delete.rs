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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

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

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.id),
            reason: format!("Task '{}' not found", self.id),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-delete-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let db = Database::connect(&temp_dir).await.unwrap();
        db.init().await.unwrap();

        (db, temp_dir)
    }

    /// Helper to create a task in the database
    async fn create_task(db: &Database, id: &str, title: &str, level: &str, status: &str) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                status = "{}",
                priority = NONE,
                tags = []"#,
            id, title, level, status
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a child_of relationship
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a depends_on relationship
    async fn create_depends_on(db: &Database, task_id: &str, dep_id: &str) {
        let query = format!("RELATE task:{} -> depends_on -> task:{}", task_id, dep_id);
        db.client().query(&query).await.unwrap();
    }

    /// Helper to check if a task exists
    async fn task_exists(db: &Database, id: &str) -> bool {
        #[derive(Deserialize)]
        struct IdRow {
            #[allow(dead_code)]
            id: surrealdb::sql::Thing,
        }

        let query = format!("SELECT id FROM task:{} LIMIT 1", id);
        let mut result = db.client().query(&query).await.unwrap();
        let rows: Vec<IdRow> = result.take(0).unwrap();
        !rows.is_empty()
    }

    /// Helper to check if a depends_on relationship exists
    async fn depends_on_exists(db: &Database, task_id: &str, dep_id: &str) -> bool {
        #[derive(Deserialize)]
        struct EdgeRow {
            #[allow(dead_code)]
            id: surrealdb::sql::Thing,
        }

        let query = format!(
            "SELECT id FROM depends_on WHERE in = task:{} AND out = task:{}",
            task_id, dep_id
        );
        let mut result = db.client().query(&query).await.unwrap();
        let rows: Vec<EdgeRow> = result.take(0).unwrap();
        !rows.is_empty()
    }

    /// Helper to get parent of a task
    async fn get_parent_id(db: &Database, id: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct IdRow {
            id: surrealdb::sql::Thing,
        }

        let query = format!(
            "SELECT id FROM task WHERE <-child_of<-task CONTAINS task:{}",
            id
        );
        let mut result = db.client().query(&query).await.unwrap();
        let rows: Vec<IdRow> = result.take(0).unwrap();
        rows.first().map(|r| r.id.id.to_string())
    }

    /// Helper to check if a child_of relationship exists
    async fn child_of_exists(db: &Database, child_id: &str, parent_id: &str) -> bool {
        #[derive(Deserialize)]
        struct EdgeRow {
            #[allow(dead_code)]
            id: surrealdb::sql::Thing,
        }

        let query = format!(
            "SELECT id FROM child_of WHERE in = task:{} AND out = task:{}",
            child_id, parent_id
        );
        let mut result = db.client().query(&query).await.unwrap();
        let rows: Vec<EdgeRow> = result.take(0).unwrap();
        !rows.is_empty()
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_delete_simple_task_with_force() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test Task", "task", "todo").await;
        assert!(task_exists(&db, "abc123").await);

        let cmd = DeleteCommand {
            id: "abc123".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Delete failed: {:?}", result.err());
        assert_eq!(result.unwrap(), "Deleted task: abc123");

        assert!(!task_exists(&db, "abc123").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = DeleteCommand {
            id: "nonexistent".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("not found"),
                    "Expected 'not found' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("nonexistent"),
                    "Expected task ID 'nonexistent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test Task", "task", "todo").await;

        let cmd = DeleteCommand {
            id: "ABC123".to_string(), // Uppercase
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        assert!(!task_exists(&db, "abc123").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_cascade_delete() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent with children
        create_task(&db, "parent1", "Parent Task", "epic", "todo").await;
        create_task(&db, "child1", "Child 1", "ticket", "todo").await;
        create_task(&db, "child2", "Child 2", "ticket", "todo").await;
        create_task(&db, "grandchild", "Grandchild", "task", "todo").await;

        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;
        create_child_of(&db, "grandchild", "child1").await;

        // Verify child_of edges exist before deletion
        assert!(
            child_of_exists(&db, "child1", "parent1").await,
            "child1 -> parent1 edge should exist before delete"
        );
        assert!(
            child_of_exists(&db, "child2", "parent1").await,
            "child2 -> parent1 edge should exist before delete"
        );
        assert!(
            child_of_exists(&db, "grandchild", "child1").await,
            "grandchild -> child1 edge should exist before delete"
        );

        let cmd = DeleteCommand {
            id: "parent1".to_string(),
            cascade: true,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Cascade delete failed: {:?}", result.err());
        assert_eq!(result.unwrap(), "Deleted 4 tasks (including children)");

        // Verify all tasks are deleted
        assert!(!task_exists(&db, "parent1").await);
        assert!(!task_exists(&db, "child1").await);
        assert!(!task_exists(&db, "child2").await);
        assert!(!task_exists(&db, "grandchild").await);

        // Verify all child_of edges are cleaned up
        assert!(
            !child_of_exists(&db, "child1", "parent1").await,
            "child1 -> parent1 edge should be removed"
        );
        assert!(
            !child_of_exists(&db, "child2", "parent1").await,
            "child2 -> parent1 edge should be removed"
        );
        assert!(
            !child_of_exists(&db, "grandchild", "child1").await,
            "grandchild -> child1 edge should be removed"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_orphan_children() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent with children
        create_task(&db, "parent1", "Parent Task", "epic", "todo").await;
        create_task(&db, "child1", "Child 1", "ticket", "todo").await;
        create_task(&db, "child2", "Child 2", "ticket", "todo").await;

        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;

        // Force but no cascade = orphan children
        let cmd = DeleteCommand {
            id: "parent1".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Orphan delete failed: {:?}", result.err());

        // Parent should be deleted
        assert!(!task_exists(&db, "parent1").await);

        // Children should still exist as root tasks
        assert!(task_exists(&db, "child1").await);
        assert!(task_exists(&db, "child2").await);

        // Children should have no parent
        assert!(get_parent_id(&db, "child1").await.is_none());
        assert!(get_parent_id(&db, "child2").await.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_cleans_up_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks with dependencies
        create_task(&db, "blocker", "Blocker Task", "task", "done").await;
        create_task(&db, "blocked", "Blocked Task", "task", "blocked").await;
        create_depends_on(&db, "blocked", "blocker").await;

        // Verify dependency exists
        assert!(depends_on_exists(&db, "blocked", "blocker").await);

        let cmd = DeleteCommand {
            id: "blocker".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Blocker should be deleted
        assert!(!task_exists(&db, "blocker").await);

        // Blocked task should still exist
        assert!(task_exists(&db, "blocked").await);

        // Dependency edge should be cleaned up
        assert!(!depends_on_exists(&db, "blocked", "blocker").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_cleans_up_reverse_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks with dependencies
        create_task(&db, "dep", "Dependency Task", "task", "done").await;
        create_task(&db, "main", "Main Task", "task", "todo").await;
        create_depends_on(&db, "main", "dep").await;

        // Verify dependency exists
        assert!(depends_on_exists(&db, "main", "dep").await);

        // Delete the task that depends on another
        let cmd = DeleteCommand {
            id: "main".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Main should be deleted
        assert!(!task_exists(&db, "main").await);

        // Dep should still exist
        assert!(task_exists(&db, "dep").await);

        // Dependency edge should be cleaned up
        assert!(!depends_on_exists(&db, "main", "dep").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_cleans_up_child_of_as_child() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent-child relationship
        create_task(&db, "parent", "Parent Task", "epic", "todo").await;
        create_task(&db, "child", "Child Task", "ticket", "todo").await;
        create_child_of(&db, "child", "parent").await;

        // Delete the child
        let cmd = DeleteCommand {
            id: "child".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Child should be deleted
        assert!(!task_exists(&db, "child").await);

        // Parent should still exist
        assert!(task_exists(&db, "parent").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_cascade_delete_with_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a complex graph
        create_task(&db, "root", "Root", "epic", "todo").await;
        create_task(&db, "child", "Child", "ticket", "todo").await;
        create_task(&db, "external", "External", "task", "todo").await;

        create_child_of(&db, "child", "root").await;
        create_depends_on(&db, "external", "child").await;

        // Verify setup
        assert!(depends_on_exists(&db, "external", "child").await);

        let cmd = DeleteCommand {
            id: "root".to_string(),
            cascade: true,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Root and child should be deleted
        assert!(!task_exists(&db, "root").await);
        assert!(!task_exists(&db, "child").await);

        // External should still exist
        assert!(task_exists(&db, "external").await);

        // Dependency should be cleaned up
        assert!(!depends_on_exists(&db, "external", "child").await);

        cleanup(&temp_dir);
    }

    #[test]
    fn test_child_action_enum() {
        // Test ChildAction enum variants and traits
        let cascade = ChildAction::Cascade;
        let orphan = ChildAction::Orphan;
        let cancel = ChildAction::Cancel;

        assert_eq!(cascade, ChildAction::Cascade);
        assert_ne!(cascade, orphan);

        // Test Clone
        let cloned = cascade;
        assert_eq!(cloned, ChildAction::Cascade);

        // Test Debug
        let debug_str = format!("{:?}", cancel);
        assert_eq!(debug_str, "Cancel");
    }

    #[tokio::test]
    async fn test_fetch_task_info() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "info1", "Info Task", "task", "todo").await;

        let cmd = DeleteCommand {
            id: "info1".to_string(),
            cascade: false,
            force: true,
        };

        let info = cmd.fetch_task_info(&db, "info1").await;
        assert!(info.is_ok());
        let info = info.unwrap();
        assert_eq!(info.title, "Info Task");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_fetch_children_ids() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent", "Parent", "epic", "todo").await;
        create_task(&db, "child1", "Child 1", "ticket", "todo").await;
        create_task(&db, "child2", "Child 2", "ticket", "todo").await;
        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;

        let cmd = DeleteCommand {
            id: "parent".to_string(),
            cascade: false,
            force: true,
        };

        let children = cmd.fetch_children_ids(&db, "parent").await;
        assert!(children.is_ok());
        let children = children.unwrap();
        assert_eq!(children.len(), 2);
        assert!(children.contains(&"child1".to_string()));
        assert!(children.contains(&"child2".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_fetch_blocked_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "blocker", "Blocker", "task", "todo").await;
        create_task(&db, "blocked1", "Blocked 1", "task", "blocked").await;
        create_task(&db, "blocked2", "Blocked 2", "task", "blocked").await;
        create_depends_on(&db, "blocked1", "blocker").await;
        create_depends_on(&db, "blocked2", "blocker").await;

        let cmd = DeleteCommand {
            id: "blocker".to_string(),
            cascade: false,
            force: true,
        };

        let blocked = cmd.fetch_blocked_tasks(&db, "blocker").await;
        assert!(blocked.is_ok());
        let blocked = blocked.unwrap();
        assert_eq!(blocked.len(), 2);

        // Verify specific blocked tasks
        use std::collections::HashSet;
        let blocked_ids: HashSet<_> = blocked.iter().map(|id| id.as_str()).collect();
        assert!(blocked_ids.contains("blocked1"), "Should contain blocked1");
        assert!(blocked_ids.contains("blocked2"), "Should contain blocked2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_collect_all_descendants() {
        let (db, temp_dir) = setup_test_db().await;

        // Create hierarchy: parent -> child -> grandchild
        create_task(&db, "parent", "Parent", "epic", "todo").await;
        create_task(&db, "child", "Child", "ticket", "todo").await;
        create_task(&db, "grandchild", "Grandchild", "task", "todo").await;
        create_child_of(&db, "child", "parent").await;
        create_child_of(&db, "grandchild", "child").await;

        let cmd = DeleteCommand {
            id: "parent".to_string(),
            cascade: true,
            force: true,
        };

        let descendants = cmd.collect_all_descendants(&db, "parent").await;
        assert!(descendants.is_ok());
        let descendants = descendants.unwrap();
        assert_eq!(descendants.len(), 2);
        assert!(descendants.contains(&"child".to_string()));
        assert!(descendants.contains(&"grandchild".to_string()));

        cleanup(&temp_dir);
    }

    #[test]
    fn test_delete_command_debug() {
        let cmd = DeleteCommand {
            id: "test".to_string(),
            cascade: true,
            force: false,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("DeleteCommand") && debug_str.contains("cascade: true"),
            "Debug output should contain DeleteCommand and cascade: true"
        );
    }

    #[tokio::test]
    async fn test_delete_task_no_children_no_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "lonely", "Lonely Task", "task", "todo").await;

        let cmd = DeleteCommand {
            id: "lonely".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert!(!task_exists(&db, "lonely").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_cascade_delete_deep_hierarchy() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a 3-level hierarchy: level1 -> level2 -> level3
        create_task(&db, "level1", "Level 1", "epic", "todo").await;
        create_task(&db, "level2", "Level 2", "ticket", "todo").await;
        create_task(&db, "level3", "Level 3", "task", "todo").await;

        create_child_of(&db, "level2", "level1").await;
        create_child_of(&db, "level3", "level2").await;

        let cmd = DeleteCommand {
            id: "level1".to_string(),
            cascade: true,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Deleted 3 tasks (including children)");

        assert!(!task_exists(&db, "level1").await);
        assert!(!task_exists(&db, "level2").await);
        assert!(!task_exists(&db, "level3").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_preserves_unrelated_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "target", "Target", "task", "todo").await;
        create_task(&db, "unrelated", "Unrelated", "task", "todo").await;

        let cmd = DeleteCommand {
            id: "target".to_string(),
            cascade: false,
            force: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        assert!(!task_exists(&db, "target").await);
        assert!(task_exists(&db, "unrelated").await);

        cleanup(&temp_dir);
    }
}
