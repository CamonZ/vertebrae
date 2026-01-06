//! Done command for transitioning tasks to done status
//!
//! Implements the `vtb done` command to mark a task as complete.
//! Provides soft enforcement by warning about incomplete children without blocking.
//! Reports tasks that were blocked by this one and are now unblocked.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError, Status};

/// Mark a task as complete (transition to done)
#[derive(Debug, Args)]
pub struct DoneCommand {
    /// Task ID to complete (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Result from querying a task's status
#[derive(Debug, Deserialize)]
struct TaskStatusRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    status: String,
}

/// Incomplete child task info
#[derive(Debug, Deserialize)]
struct IncompleteChild {
    id: surrealdb::sql::Thing,
    title: String,
    status: String,
}

/// Unblocked task info (tasks that depended on the completed task)
#[derive(Debug, Deserialize)]
struct UnblockedTask {
    id: surrealdb::sql::Thing,
    title: String,
}

/// Result of the done command execution
#[derive(Debug)]
pub struct DoneResult {
    /// The task ID that was completed
    pub id: String,
    /// Whether the task was already done
    pub already_done: bool,
    /// List of incomplete children (warnings)
    pub incomplete_children: Vec<(String, String, String)>, // (id, title, status)
    /// List of tasks that are now unblocked
    pub unblocked_tasks: Vec<(String, String)>, // (id, title)
}

impl std::fmt::Display for DoneResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Show warnings about incomplete children first
        if !self.incomplete_children.is_empty() {
            writeln!(f, "Warning: Task has incomplete children:")?;
            for (id, title, status) in &self.incomplete_children {
                writeln!(f, "  - {} ({}) [{}]", id, title, status)?;
            }
            writeln!(f)?;
        }

        if self.already_done {
            write!(f, "Task '{}' is already done", self.id)?;
        } else {
            write!(f, "Completed task: {}", self.id)?;
        }

        // Show unblocked tasks if any
        if !self.unblocked_tasks.is_empty() {
            writeln!(f)?;
            writeln!(f)?;
            writeln!(f, "Unblocked tasks:")?;
            for (id, title) in &self.unblocked_tasks {
                writeln!(f, "  - {} ({})", id, title)?;
            }
        }

        Ok(())
    }
}

impl DoneCommand {
    /// Execute the done command.
    ///
    /// Transitions a task to `done` status from any status.
    /// Warns if the task has incomplete children but still proceeds (soft enforcement).
    /// Reports tasks that were blocked by this one and are now unblocked.
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
    pub async fn execute(&self, db: &Database) -> Result<DoneResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = self.fetch_task(db, &id).await?;

        // Parse the current status
        let current_status = parse_status(&task.status);

        // Handle already done case
        if current_status == Status::Done {
            return Ok(DoneResult {
                id,
                already_done: true,
                incomplete_children: vec![],
                unblocked_tasks: vec![],
            });
        }

        // Check for incomplete children (soft enforcement - warn only)
        let incomplete_children = self.fetch_incomplete_children(db, &id).await?;

        // Find tasks that depend on this one and will become unblocked
        let unblocked_tasks = self.find_unblocked_tasks(db, &id).await?;

        // Update status to done and timestamp
        self.update_status(db, &id).await?;

        Ok(DoneResult {
            id,
            already_done: false,
            incomplete_children: incomplete_children
                .into_iter()
                .map(|child| (child.id.id.to_string(), child.title, child.status))
                .collect(),
            unblocked_tasks: unblocked_tasks
                .into_iter()
                .map(|task| (task.id.id.to_string(), task.title))
                .collect(),
        })
    }

    /// Fetch the task by ID and return its status.
    async fn fetch_task(&self, db: &Database, id: &str) -> Result<TaskStatusRow, DbError> {
        let query = format!("SELECT id, status FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskStatusRow> = result.take(0)?;

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.id),
            reason: format!("Task '{}' not found", self.id),
        })
    }

    /// Fetch incomplete children of a task.
    ///
    /// Returns children tasks that are not yet done.
    async fn fetch_incomplete_children(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<Vec<IncompleteChild>, DbError> {
        // Query tasks that are children of this task where status != 'done'
        // The child_of relation goes from child -> parent, so we need to find
        // tasks that have a child_of relation pointing to this task
        let query = format!(
            "SELECT id, title, status FROM task \
             WHERE ->child_of->task CONTAINS task:{} \
             AND status != 'done'",
            id
        );

        let mut result = db.client().query(&query).await?;
        let children: Vec<IncompleteChild> = result.take(0)?;

        Ok(children)
    }

    /// Find tasks that depend on the completed task and will become unblocked.
    ///
    /// A task becomes unblocked when ALL its dependencies are done.
    /// This method finds tasks that depend on the current task and checks
    /// if completing this task will make them fully unblocked.
    async fn find_unblocked_tasks(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<Vec<UnblockedTask>, DbError> {
        // Find all tasks that depend on this task
        // The depends_on relation goes from dependent -> dependency
        // So we need tasks that have depends_on pointing to this task
        // We use a two-step approach:
        // 1. Get all tasks that depend on this task
        // 2. For each, check if all other dependencies are done

        let dependents_query = format!(
            "SELECT id, title FROM task WHERE ->depends_on->task CONTAINS task:{}",
            id
        );

        let mut result = db.client().query(&dependents_query).await?;
        let dependents: Vec<UnblockedTask> = result.take(0)?;

        // For each dependent, check if this is their only incomplete dependency
        let mut unblocked = Vec::new();

        for dependent in dependents {
            let dep_id = &dependent.id.id.to_string();

            // Count incomplete dependencies for this task (excluding the current task which we're completing)
            let count_query = format!(
                "SELECT count() as cnt FROM task \
                 WHERE <-depends_on<-task CONTAINS task:{} \
                 AND id != task:{} \
                 AND status != 'done'",
                dep_id, id
            );

            #[derive(Debug, Deserialize)]
            struct CountResult {
                cnt: i64,
            }

            let mut count_result = db.client().query(&count_query).await?;
            let count: Option<CountResult> = count_result.take(0)?;

            // If no other incomplete dependencies, this task will be unblocked
            if count.is_none() || count.is_some_and(|c| c.cnt == 0) {
                unblocked.push(dependent);
            }
        }

        Ok(unblocked)
    }

    /// Update the task status to done and refresh updated_at and completed_at.
    async fn update_status(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!(
            "UPDATE task:{} SET status = 'done', updated_at = time::now(), completed_at = time::now()",
            id
        );
        db.client().query(&query).await?;
        Ok(())
    }
}

/// Parse a status string into Status enum
fn parse_status(s: &str) -> Status {
    match s {
        "todo" => Status::Todo,
        "in_progress" => Status::InProgress,
        "done" => Status::Done,
        "blocked" => Status::Blocked,
        // Default to Todo if unknown (should not happen with schema validation)
        _ => Status::Todo,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-done-test-{}-{:?}-{}",
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
                tags = [],
                sections = [],
                refs = []"#,
            id, title, level, status
        );

        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a child_of relationship (child -> parent)
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a depends_on relationship (dependent -> dependency)
    async fn create_depends_on(db: &Database, dependent_id: &str, dependency_id: &str) {
        let query = format!(
            "RELATE task:{} -> depends_on -> task:{}",
            dependent_id, dependency_id
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to get task status from database
    async fn get_task_status(db: &Database, id: &str) -> String {
        #[derive(Deserialize)]
        struct StatusRow {
            status: String,
        }

        let query = format!("SELECT status FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let row: Option<StatusRow> = result.take(0).unwrap();
        row.unwrap().status
    }

    /// Helper to check if updated_at was set
    async fn has_updated_at(db: &Database, id: &str) -> bool {
        #[derive(Deserialize)]
        struct TimestampRow {
            updated_at: Option<surrealdb::sql::Datetime>,
        }

        let query = format!("SELECT updated_at FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let row: Option<TimestampRow> = result.take(0).unwrap();
        row.map(|r| r.updated_at.is_some()).unwrap_or(false)
    }

    /// Helper to get completed_at timestamp
    async fn get_completed_at(db: &Database, id: &str) -> Option<surrealdb::sql::Datetime> {
        #[derive(Deserialize)]
        struct TimestampRow {
            completed_at: Option<surrealdb::sql::Datetime>,
        }

        let query = format!("SELECT completed_at FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let row: Option<TimestampRow> = result.take(0).unwrap();
        row.and_then(|r| r.completed_at)
    }

    /// Helper to get started_at timestamp
    async fn get_started_at(db: &Database, id: &str) -> Option<surrealdb::sql::Datetime> {
        #[derive(Deserialize)]
        struct TimestampRow {
            started_at: Option<surrealdb::sql::Datetime>,
        }

        let query = format!("SELECT started_at FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let row: Option<TimestampRow> = result.take(0).unwrap();
        row.and_then(|r| r.started_at)
    }

    /// Helper to set started_at timestamp for a task
    async fn set_started_at(db: &Database, id: &str) {
        let query = format!("UPDATE task:{} SET started_at = time::now()", id);
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn test_parse_status() {
        assert_eq!(parse_status("todo"), Status::Todo);
        assert_eq!(parse_status("in_progress"), Status::InProgress);
        assert_eq!(parse_status("done"), Status::Done);
        assert_eq!(parse_status("blocked"), Status::Blocked);
        // Unknown defaults to Todo
        assert_eq!(parse_status("unknown"), Status::Todo);
    }

    #[tokio::test]
    async fn test_done_todo_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done failed: {:?}", result.err());

        let done_result = result.unwrap();
        assert_eq!(done_result.id, "task1");
        assert!(!done_result.already_done);
        assert!(done_result.incomplete_children.is_empty());
        assert!(done_result.unblocked_tasks.is_empty());

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_in_progress_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "In Progress Task", "task", "in_progress").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done failed: {:?}", result.err());

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_blocked_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Blocked Task", "task", "blocked").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done failed: {:?}", result.err());

        // Verify status changed - can complete from any status
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_already_done() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Done Task", "task", "done").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed with info message");

        let done_result = result.unwrap();
        assert!(done_result.already_done);

        // Status should remain done
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = DoneCommand {
            id: "nonexistent".to_string(),
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
    async fn test_done_with_incomplete_children_warns() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task
        create_task(&db, "parent", "Parent Task", "ticket", "in_progress").await;
        // Create child task (not done)
        create_task(&db, "child1", "Child Task 1", "task", "todo").await;
        // Create child relationship
        create_child_of(&db, "child1", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed with warnings");

        let done_result = result.unwrap();
        assert!(!done_result.already_done);
        assert!(!done_result.incomplete_children.is_empty());
        assert_eq!(done_result.incomplete_children.len(), 1);
        assert_eq!(done_result.incomplete_children[0].0, "child1");

        // Task should still be marked done despite incomplete children
        let status = get_task_status(&db, "parent").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_with_complete_children_no_warning() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task
        create_task(&db, "parent", "Parent Task", "ticket", "in_progress").await;
        // Create child task (done)
        create_task(&db, "child1", "Child Task 1", "task", "done").await;
        // Create child relationship
        create_child_of(&db, "child1", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let done_result = result.unwrap();
        assert!(done_result.incomplete_children.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_with_multiple_incomplete_children() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task
        create_task(&db, "parent", "Parent Task", "epic", "in_progress").await;
        // Create multiple child tasks
        create_task(&db, "child1", "Child 1", "ticket", "todo").await;
        create_task(&db, "child2", "Child 2", "ticket", "blocked").await;
        create_task(&db, "child3", "Child 3", "ticket", "done").await;
        // Create child relationships
        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;
        create_child_of(&db, "child3", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let done_result = result.unwrap();
        // Only child1 and child2 are incomplete (child3 is done)
        assert_eq!(done_result.incomplete_children.len(), 2);

        // Verify specific incomplete children
        use std::collections::HashSet;
        let incomplete_ids: HashSet<_> = done_result
            .incomplete_children
            .iter()
            .map(|(id, _, _)| id.as_str())
            .collect();
        assert!(
            incomplete_ids.contains("child1"),
            "Should contain child1 (status=todo)"
        );
        assert!(
            incomplete_ids.contains("child2"),
            "Should contain child2 (status=blocked)"
        );
        assert!(
            !incomplete_ids.contains("child3"),
            "Should not contain child3 (status=done)"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_unblocks_dependent_task() {
        let (db, temp_dir) = setup_test_db().await;

        // Create blocker task
        create_task(&db, "blocker", "Blocker Task", "task", "in_progress").await;
        // Create dependent task
        create_task(&db, "dependent", "Dependent Task", "task", "blocked").await;
        // Create dependency relationship
        create_depends_on(&db, "dependent", "blocker").await;

        let cmd = DoneCommand {
            id: "blocker".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let done_result = result.unwrap();
        assert!(!done_result.unblocked_tasks.is_empty());
        assert_eq!(done_result.unblocked_tasks.len(), 1);

        // Verify both fields of the unblocked task tuple (id, title)
        let (unblocked_id, unblocked_title) = &done_result.unblocked_tasks[0];
        assert_eq!(unblocked_id, "dependent");
        assert_eq!(unblocked_title, "Dependent Task");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_does_not_unblock_with_other_deps() {
        let (db, temp_dir) = setup_test_db().await;

        // Create two blocker tasks
        create_task(&db, "blocker1", "Blocker 1", "task", "in_progress").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "todo").await;
        // Create dependent task with two dependencies
        create_task(&db, "dependent", "Dependent Task", "task", "blocked").await;
        create_depends_on(&db, "dependent", "blocker1").await;
        create_depends_on(&db, "dependent", "blocker2").await;

        // Complete blocker1 - dependent should NOT be unblocked (blocker2 still incomplete)
        let cmd = DoneCommand {
            id: "blocker1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let done_result = result.unwrap();
        // Dependent should NOT be in unblocked list since blocker2 is still incomplete
        assert!(done_result.unblocked_tasks.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_unblocks_when_all_deps_done() {
        let (db, temp_dir) = setup_test_db().await;

        // Create two blocker tasks, one already done
        create_task(&db, "blocker1", "Blocker 1", "task", "done").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "in_progress").await;
        // Create dependent task with two dependencies
        create_task(&db, "dependent", "Dependent Task", "task", "blocked").await;
        create_depends_on(&db, "dependent", "blocker1").await;
        create_depends_on(&db, "dependent", "blocker2").await;

        // Complete blocker2 - dependent SHOULD be unblocked (both deps now done)
        let cmd = DoneCommand {
            id: "blocker2".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let done_result = result.unwrap();
        assert_eq!(done_result.unblocked_tasks.len(), 1);
        assert_eq!(done_result.unblocked_tasks[0].0, "dependent");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_unblocks_multiple_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        // Create blocker task
        create_task(&db, "blocker", "Blocker Task", "task", "in_progress").await;
        // Create multiple dependent tasks
        create_task(&db, "dep1", "Dependent 1", "task", "blocked").await;
        create_task(&db, "dep2", "Dependent 2", "task", "todo").await;
        create_depends_on(&db, "dep1", "blocker").await;
        create_depends_on(&db, "dep2", "blocker").await;

        let cmd = DoneCommand {
            id: "blocker".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let done_result = result.unwrap();
        assert_eq!(done_result.unblocked_tasks.len(), 2);

        // Verify all fields of each unblocked task tuple (id, title)
        use std::collections::HashMap;
        let unblocked_map: HashMap<_, _> = done_result
            .unblocked_tasks
            .iter()
            .map(|(id, title)| (id.as_str(), title.as_str()))
            .collect();

        assert!(
            unblocked_map.contains_key("dep1"),
            "Should contain dep1 as unblocked"
        );
        assert_eq!(unblocked_map.get("dep1"), Some(&"Dependent 1"));

        assert!(
            unblocked_map.contains_key("dep2"),
            "Should contain dep2 as unblocked"
        );
        assert_eq!(unblocked_map.get("dep2"), Some(&"Dependent 2"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify updated_at was set
        assert!(has_updated_at(&db, "task1").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = DoneCommand {
            id: "TASK1".to_string(), // Uppercase
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_done_result_display_normal() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: false,
            incomplete_children: vec![],
            unblocked_tasks: vec![],
        };

        let output = format!("{}", result);
        assert_eq!(output, "Completed task: task1");
    }

    #[test]
    fn test_done_result_display_already_done() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: true,
            incomplete_children: vec![],
            unblocked_tasks: vec![],
        };

        let output = format!("{}", result);
        assert!(output.contains("already done"));
    }

    #[test]
    fn test_done_result_display_with_children() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: false,
            incomplete_children: vec![
                (
                    "child1".to_string(),
                    "First Child".to_string(),
                    "todo".to_string(),
                ),
                (
                    "child2".to_string(),
                    "Second Child".to_string(),
                    "blocked".to_string(),
                ),
            ],
            unblocked_tasks: vec![],
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning: Task has incomplete children"));
        assert!(output.contains("child1"));
        assert!(output.contains("First Child"));
        assert!(output.contains("todo"));
        assert!(output.contains("child2"));
        assert!(output.contains("blocked"));
        assert!(output.contains("Completed task: task1"));
    }

    #[test]
    fn test_done_result_display_with_unblocked() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: false,
            incomplete_children: vec![],
            unblocked_tasks: vec![
                ("dep1".to_string(), "Dependent 1".to_string()),
                ("dep2".to_string(), "Dependent 2".to_string()),
            ],
        };

        let output = format!("{}", result);
        assert!(output.contains("Completed task: task1"));
        assert!(output.contains("Unblocked tasks:"));
        assert!(output.contains("dep1"));
        assert!(output.contains("Dependent 1"));
        assert!(output.contains("dep2"));
        assert!(output.contains("Dependent 2"));
    }

    #[test]
    fn test_done_result_display_with_all() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: false,
            incomplete_children: vec![(
                "child1".to_string(),
                "Child".to_string(),
                "todo".to_string(),
            )],
            unblocked_tasks: vec![("dep1".to_string(), "Dependent".to_string())],
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning: Task has incomplete children"));
        assert!(output.contains("child1"));
        assert!(output.contains("Completed task: task1"));
        assert!(output.contains("Unblocked tasks:"));
        assert!(output.contains("dep1"));
    }

    #[test]
    fn test_done_command_debug() {
        let cmd = DoneCommand {
            id: "test123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("DoneCommand") && debug_str.contains("id: \"test123\""),
            "Debug output should contain DoneCommand and id field value"
        );
    }

    #[tokio::test]
    async fn test_done_sets_completed_at() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        // Record time before execution
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        // Record time after execution
        let after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Verify completed_at was set
        let completed_at = get_completed_at(&db, "task1").await;
        assert!(
            completed_at.is_some(),
            "completed_at should be set after vtb done"
        );

        // Verify completed_at is within 1 second of command execution
        let completed_timestamp = completed_at.unwrap().0.timestamp() as u64;
        assert!(
            completed_timestamp >= before && completed_timestamp <= after + 1,
            "completed_at ({}) should be within execution window ({} - {})",
            completed_timestamp,
            before,
            after + 1
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_already_done_does_not_update_completed_at() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task that's already done with a completed_at timestamp
        let query = r#"CREATE task:task1 SET
            title = "Already Done Task",
            level = "task",
            status = "done",
            tags = [],
            sections = [],
            refs = [],
            completed_at = d'2025-01-01T00:00:00Z'"#;
        db.client().query(query).await.unwrap();

        // Get the original completed_at
        let original_completed_at = get_completed_at(&db, "task1").await;
        assert!(
            original_completed_at.is_some(),
            "Task should have completed_at set"
        );

        // Try to mark the task as done again
        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert!(
            result.unwrap().already_done,
            "Task should be reported as already done"
        );

        // Verify completed_at was NOT updated
        let new_completed_at = get_completed_at(&db, "task1").await;
        assert_eq!(
            original_completed_at, new_completed_at,
            "completed_at should not be updated when task is already done"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_sets_completed_at_with_incomplete_children() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task
        create_task(&db, "parent", "Parent Task", "ticket", "in_progress").await;
        // Create incomplete child task
        create_task(&db, "child1", "Child Task", "task", "todo").await;
        create_child_of(&db, "child1", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        let done_result = result.unwrap();

        // Task should have warnings about incomplete children
        assert!(
            !done_result.incomplete_children.is_empty(),
            "Should warn about incomplete children"
        );

        // But completed_at should still be set (soft enforcement)
        let completed_at = get_completed_at(&db, "parent").await;
        assert!(
            completed_at.is_some(),
            "completed_at should be set even with incomplete children"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_completed_at_after_started_at() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        // Set started_at before marking done
        set_started_at(&db, "task1").await;

        // Small delay to ensure time difference
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let started_at = get_started_at(&db, "task1").await;
        let completed_at = get_completed_at(&db, "task1").await;

        assert!(started_at.is_some(), "started_at should be set");
        assert!(completed_at.is_some(), "completed_at should be set");

        let started_timestamp = started_at.unwrap().0.timestamp();
        let completed_timestamp = completed_at.unwrap().0.timestamp();

        assert!(
            completed_timestamp >= started_timestamp,
            "completed_at ({}) should be >= started_at ({})",
            completed_timestamp,
            started_timestamp
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_completed_at_persists_in_database() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Persist Test", "task", "todo").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };
        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify completed_at is persisted in database (query it fresh)
        let completed_at = get_completed_at(&db, "task1").await;
        assert!(
            completed_at.is_some(),
            "completed_at should persist in database"
        );

        // Verify status is persisted
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done", "status should persist in database");

        // Verify the value survives multiple queries (testing persistence)
        let completed_at_again = get_completed_at(&db, "task1").await;
        assert_eq!(
            completed_at, completed_at_again,
            "completed_at should remain consistent across queries"
        );

        cleanup(&temp_dir);
    }
}
