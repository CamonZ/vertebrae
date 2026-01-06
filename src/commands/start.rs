//! Start command for transitioning tasks to in_progress status
//!
//! Implements the `vtb start` command to mark a task as actively being worked on.
//! Provides soft enforcement by warning about incomplete dependencies without blocking.

use crate::db::{Database, DbError, Status};
use clap::Args;
use serde::Deserialize;

/// Start working on a task (transition to in_progress)
#[derive(Debug, Args)]
pub struct StartCommand {
    /// Task ID to start (case-insensitive)
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

/// Incomplete dependency task info
#[derive(Debug, Deserialize)]
struct IncompleteDep {
    id: surrealdb::sql::Thing,
    title: String,
    status: String,
}

/// Result of the start command execution
#[derive(Debug)]
pub struct StartResult {
    /// The task ID that was started
    pub id: String,
    /// Whether the task was already in_progress
    pub already_in_progress: bool,
    /// List of incomplete dependencies (warnings)
    pub incomplete_deps: Vec<(String, String, String)>, // (id, title, status)
}

impl std::fmt::Display for StartResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Show warnings first
        if !self.incomplete_deps.is_empty() {
            writeln!(f, "Warning: Task depends on incomplete tasks:")?;
            for (id, title, status) in &self.incomplete_deps {
                writeln!(f, "  - {} ({}) [{}]", id, title, status)?;
            }
            writeln!(f)?;
        }

        if self.already_in_progress {
            write!(f, "Warning: Task '{}' is already in progress", self.id)
        } else {
            write!(f, "Started task: {}", self.id)
        }
    }
}

impl StartCommand {
    /// Execute the start command.
    ///
    /// Transitions a task from `todo` or `blocked` to `in_progress`.
    /// Warns if the task has incomplete dependencies but still proceeds (soft enforcement).
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The task is already `done` (cannot restart completed tasks)
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<StartResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = self.fetch_task(db, &id).await?;

        // Parse the current status
        let current_status = parse_status(&task.status);

        // Handle different status cases
        match current_status {
            Status::Done => {
                return Err(DbError::InvalidPath {
                    path: std::path::PathBuf::from(&self.id),
                    reason: format!(
                        "Cannot start task '{}': task is already done. Use a different command to reopen.",
                        self.id
                    ),
                });
            }
            Status::InProgress => {
                // Already in progress - return warning, no-op
                return Ok(StartResult {
                    id,
                    already_in_progress: true,
                    incomplete_deps: vec![],
                });
            }
            Status::Todo | Status::Blocked => {
                // Valid transitions - continue
            }
        }

        // Check for incomplete dependencies (soft enforcement - warn only)
        let incomplete_deps = self.fetch_incomplete_dependencies(db, &id).await?;

        // Update status to in_progress and timestamp
        self.update_status(db, &id).await?;

        Ok(StartResult {
            id,
            already_in_progress: false,
            incomplete_deps: incomplete_deps
                .into_iter()
                .map(|dep| (dep.id.id.to_string(), dep.title, dep.status))
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

    /// Fetch incomplete dependencies for a task.
    ///
    /// Returns tasks that this task depends on which are not yet done.
    async fn fetch_incomplete_dependencies(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<Vec<IncompleteDep>, DbError> {
        // Query tasks that this task depends on where status != 'done'
        let query = format!(
            "SELECT id, title, status FROM task \
             WHERE <-depends_on<-task CONTAINS task:{} \
             AND status != 'done'",
            id
        );

        let mut result = db.client().query(&query).await?;
        let deps: Vec<IncompleteDep> = result.take(0)?;

        Ok(deps)
    }

    /// Update the task status to in_progress and refresh updated_at.
    async fn update_status(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!(
            "UPDATE task:{} SET status = 'in_progress', updated_at = time::now()",
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
            "vtb-start-test-{}-{:?}-{}",
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

    /// Helper to create a depends_on relationship
    async fn create_depends_on(db: &Database, task_id: &str, dep_id: &str) {
        let query = format!("RELATE task:{} -> depends_on -> task:{}", task_id, dep_id);
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
    async fn test_start_todo_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start failed: {:?}", result.err());

        let start_result = result.unwrap();
        assert_eq!(start_result.id, "task1");
        assert!(!start_result.already_in_progress);
        assert!(start_result.incomplete_deps.is_empty());

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_blocked_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Blocked Task", "task", "blocked").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start failed: {:?}", result.err());

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_already_in_progress() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "In Progress Task", "task", "in_progress").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start should succeed with warning");

        let start_result = result.unwrap();
        assert!(start_result.already_in_progress);

        // Status should remain in_progress
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_done_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Done Task", "task", "done").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("already done"),
                    "Expected 'already done' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        // Status should remain done
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = StartCommand {
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
    async fn test_start_with_incomplete_deps_warns() {
        let (db, temp_dir) = setup_test_db().await;

        // Create dependency task (not done)
        create_task(&db, "dep1", "Dependency Task", "task", "todo").await;
        // Create main task
        create_task(&db, "task1", "Main Task", "task", "todo").await;
        // Create dependency relationship
        create_depends_on(&db, "task1", "dep1").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start should succeed with warnings");

        let start_result = result.unwrap();
        assert!(!start_result.already_in_progress);
        assert!(!start_result.incomplete_deps.is_empty());
        assert_eq!(start_result.incomplete_deps.len(), 1);

        // Verify all fields of the incomplete dependency tuple (id, title, status)
        let (dep_id, dep_title, dep_status) = &start_result.incomplete_deps[0];
        assert_eq!(dep_id, "dep1");
        assert_eq!(dep_title, "Dependency Task");
        assert_eq!(dep_status, "todo");

        // Task should still be started despite incomplete deps
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_with_complete_deps_no_warning() {
        let (db, temp_dir) = setup_test_db().await;

        // Create dependency task (done)
        create_task(&db, "dep1", "Dependency Task", "task", "done").await;
        // Create main task
        create_task(&db, "task1", "Main Task", "task", "todo").await;
        // Create dependency relationship
        create_depends_on(&db, "task1", "dep1").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let start_result = result.unwrap();
        assert!(start_result.incomplete_deps.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_with_multiple_incomplete_deps() {
        let (db, temp_dir) = setup_test_db().await;

        // Create multiple dependency tasks
        create_task(&db, "dep1", "First Dep", "task", "todo").await;
        create_task(&db, "dep2", "Second Dep", "task", "blocked").await;
        create_task(&db, "dep3", "Third Dep", "task", "done").await;
        // Create main task
        create_task(&db, "task1", "Main Task", "task", "todo").await;
        // Create dependency relationships
        create_depends_on(&db, "task1", "dep1").await;
        create_depends_on(&db, "task1", "dep2").await;
        create_depends_on(&db, "task1", "dep3").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let start_result = result.unwrap();
        // Only dep1 and dep2 are incomplete (dep3 is done)
        assert_eq!(start_result.incomplete_deps.len(), 2);

        // Verify specific incomplete dependencies
        use std::collections::HashSet;
        let incomplete_ids: HashSet<_> = start_result
            .incomplete_deps
            .iter()
            .map(|(id, _, _)| id.as_str())
            .collect();
        assert!(
            incomplete_ids.contains("dep1"),
            "Should contain dep1 (status=todo)"
        );
        assert!(
            incomplete_ids.contains("dep2"),
            "Should contain dep2 (status=blocked)"
        );
        assert!(
            !incomplete_ids.contains("dep3"),
            "Should not contain dep3 (status=done)"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify updated_at was set
        assert!(has_updated_at(&db, "task1").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = StartCommand {
            id: "TASK1".to_string(), // Uppercase
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_start_result_display_normal() {
        let result = StartResult {
            id: "task1".to_string(),
            already_in_progress: false,
            incomplete_deps: vec![],
        };

        let output = format!("{}", result);
        assert_eq!(output, "Started task: task1");
    }

    #[test]
    fn test_start_result_display_already_in_progress() {
        let result = StartResult {
            id: "task1".to_string(),
            already_in_progress: true,
            incomplete_deps: vec![],
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning"));
        assert!(output.contains("already in progress"));
    }

    #[test]
    fn test_start_result_display_with_deps() {
        let result = StartResult {
            id: "task1".to_string(),
            already_in_progress: false,
            incomplete_deps: vec![
                (
                    "dep1".to_string(),
                    "First Dep".to_string(),
                    "todo".to_string(),
                ),
                (
                    "dep2".to_string(),
                    "Second Dep".to_string(),
                    "blocked".to_string(),
                ),
            ],
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning: Task depends on incomplete tasks"));
        assert!(output.contains("dep1"));
        assert!(output.contains("First Dep"));
        assert!(output.contains("todo"));
        assert!(output.contains("dep2"));
        assert!(output.contains("blocked"));
        assert!(output.contains("Started task: task1"));
    }

    #[test]
    fn test_start_command_debug() {
        let cmd = StartCommand {
            id: "test123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("StartCommand") && debug_str.contains("id: \"test123\""),
            "Debug output should contain StartCommand and id field value"
        );
    }
}
