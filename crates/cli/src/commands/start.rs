//! Start command for transitioning tasks to in_progress status
//!
//! Implements the `vtb start` command to mark a task as actively being worked on.
//! Provides soft enforcement by warning about incomplete dependencies without blocking.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError, Status, TaskUpdate};

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

        // Handle already in_progress case (no-op)
        if current_status == Status::InProgress {
            return Ok(StartResult {
                id,
                already_in_progress: true,
                incomplete_deps: vec![],
            });
        }

        // Validate the status transition using centralized validation
        db.tasks()
            .validate_status_transition(&id, &current_status, &Status::InProgress)?;

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
        let task = db.tasks().get(id).await?;

        task.map(|t| TaskStatusRow {
            id: surrealdb::sql::thing(&format!("task:{}", id)).expect("valid task ID format"),
            status: t.status.as_str().to_string(),
        })
        .ok_or_else(|| DbError::InvalidPath {
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

    /// Update the task status to in_progress and set started_at if not already set.
    ///
    /// Also sets started_at to the current time if it hasn't been set before.
    /// This ensures that re-starting a blocked task preserves the original start time.
    async fn update_status(&self, db: &Database, id: &str) -> Result<(), DbError> {
        // Update status to in_progress and conditionally set started_at
        // set_started_at_if_null uses null-coalescing (started_at ?? time::now())
        // to preserve existing start times when restarting a blocked task
        let updates = TaskUpdate::new()
            .with_status(Status::InProgress)
            .set_started_at_if_null();
        db.tasks().update(id, &updates).await?;
        Ok(())
    }
}

/// Parse a status string into Status enum
fn parse_status(s: &str) -> Status {
    Status::parse(s).unwrap_or(Status::Todo)
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
        let task = db.tasks().get(id).await.unwrap().unwrap();
        task.status.as_str().to_string()
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
        assert_eq!(parse_status("backlog"), Status::Backlog);
        assert_eq!(parse_status("todo"), Status::Todo);
        assert_eq!(parse_status("in_progress"), Status::InProgress);
        assert_eq!(parse_status("pending_review"), Status::PendingReview);
        assert_eq!(parse_status("done"), Status::Done);
        assert_eq!(parse_status("rejected"), Status::Rejected);
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
    async fn test_start_backlog_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Backlog Task", "task", "backlog").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        // Should fail - backlog cannot transition directly to in_progress
        match result {
            Err(DbError::InvalidStatusTransition { message, .. }) => {
                assert!(
                    message.contains("backlog"),
                    "Error should mention backlog status: {}",
                    message
                );
                assert!(
                    message.contains("in_progress"),
                    "Error should mention in_progress status: {}",
                    message
                );
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        // Status should remain backlog
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "backlog");

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
            Err(DbError::InvalidStatusTransition { message, .. }) => {
                assert!(
                    message.contains("final state"),
                    "Expected 'final state' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        // Status should remain done
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_rejected_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Rejected Task", "task", "rejected").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition { message, .. }) => {
                assert!(
                    message.contains("final state"),
                    "Expected 'final state' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        // Status should remain rejected
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "rejected");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_pending_review_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "task1",
            "Pending Review Task",
            "task",
            "pending_review",
        )
        .await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        // pending_review can transition to in_progress (back for rework), so this should succeed
        // Actually, looking at the workflow: pending_review -> in_progress, done
        // So starting a pending_review task should transition it back to in_progress
        assert!(
            result.is_ok(),
            "Start from pending_review should succeed: {:?}",
            result.err()
        );

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

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
        create_task(&db, "dep2", "Second Dep", "task", "backlog").await;
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
            "Should contain dep2 (status=backlog)"
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
                    "backlog".to_string(),
                ),
            ],
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning: Task depends on incomplete tasks"));
        assert!(output.contains("dep1"));
        assert!(output.contains("First Dep"));
        assert!(output.contains("todo"));
        assert!(output.contains("dep2"));
        assert!(output.contains("backlog"));
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

    /// Helper to get started_at timestamp from database
    async fn get_started_at(db: &Database, id: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        let task = db.tasks().get(id).await.unwrap().unwrap();
        task.started_at
    }

    /// Helper to create a task with a pre-set started_at timestamp
    async fn create_task_with_started_at(
        db: &Database,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
        started_at_expr: &str,
    ) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                status = "{}",
                tags = [],
                sections = [],
                refs = [],
                started_at = {}"#,
            id, title, level, status, started_at_expr
        );

        db.client().query(&query).await.unwrap();
    }

    #[tokio::test]
    async fn test_start_sets_started_at() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        // Verify started_at is initially NULL
        let initial_started_at = get_started_at(&db, "task1").await;
        assert!(
            initial_started_at.is_none(),
            "started_at should be NULL before starting"
        );

        let before_start = std::time::SystemTime::now();

        let cmd = StartCommand {
            id: "task1".to_string(),
        };
        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start failed: {:?}", result.err());

        let after_start = std::time::SystemTime::now();

        // Verify started_at is now set
        let started_at = get_started_at(&db, "task1").await;
        assert!(started_at.is_some(), "started_at should be set after start");

        // Verify started_at is within 1 second of command execution time
        let started_at_ts = started_at.unwrap();
        let before_ts = chrono::DateTime::<chrono::Utc>::from(before_start);
        let after_ts = chrono::DateTime::<chrono::Utc>::from(after_start);

        assert!(
            started_at_ts >= before_ts - chrono::Duration::seconds(1),
            "started_at should be after (or within 1 second of) command start: {} vs {}",
            started_at_ts,
            before_ts
        );
        assert!(
            started_at_ts <= after_ts + chrono::Duration::seconds(1),
            "started_at should be before (or within 1 second of) command end: {} vs {}",
            started_at_ts,
            after_ts
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_sets_started_at_even_with_incomplete_deps() {
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

        // started_at should still be set even with incomplete dependencies
        let started_at = get_started_at(&db, "task1").await;
        assert!(
            started_at.is_some(),
            "started_at should be set even with incomplete dependencies (soft enforcement)"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_already_in_progress_does_not_update_started_at() {
        let (db, temp_dir) = setup_test_db().await;

        // Create task that is already in_progress with a started_at timestamp
        let past_time = "d'2025-01-01T00:00:00Z'";
        create_task_with_started_at(
            &db,
            "task1",
            "In Progress Task",
            "task",
            "in_progress",
            past_time,
        )
        .await;

        // Record the original started_at
        let original_started_at = get_started_at(&db, "task1").await;
        assert!(
            original_started_at.is_some(),
            "Task should have started_at set"
        );

        let cmd = StartCommand {
            id: "task1".to_string(),
        };
        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start should succeed with warning");
        assert!(
            result.unwrap().already_in_progress,
            "Should indicate already in progress"
        );

        // Verify started_at was NOT updated (should still be the original value)
        let after_started_at = get_started_at(&db, "task1").await;
        assert_eq!(
            original_started_at, after_started_at,
            "Re-running vtb start on in_progress task should NOT update started_at"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_restart_pending_review_task_preserves_started_at() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a pending_review task with an existing started_at (was started before, sent for review)
        let past_time = "d'2025-06-15T12:30:00Z'";
        create_task_with_started_at(
            &db,
            "task1",
            "Previously Started Task",
            "task",
            "pending_review",
            past_time,
        )
        .await;

        // Record the original started_at
        let original_started_at = get_started_at(&db, "task1").await;
        assert!(
            original_started_at.is_some(),
            "Task should have started_at set"
        );
        let original_ts = original_started_at.unwrap();

        let cmd = StartCommand {
            id: "task1".to_string(),
        };
        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start failed: {:?}", result.err());

        // Verify status changed to in_progress
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        // Verify started_at was NOT updated (should preserve original)
        let after_started_at = get_started_at(&db, "task1").await;
        assert!(after_started_at.is_some(), "started_at should still be set");

        let after_ts = after_started_at.unwrap();
        assert_eq!(
            original_ts, after_ts,
            "started_at should preserve the original value when restarting pending_review task. \
             Original: {}, After: {}",
            original_ts, after_ts
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_start_pending_review_task_without_started_at_sets_it() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a pending_review task WITHOUT started_at (edge case)
        create_task(&db, "task1", "Review Task", "task", "pending_review").await;

        // Verify started_at is initially NULL
        let initial_started_at = get_started_at(&db, "task1").await;
        assert!(
            initial_started_at.is_none(),
            "started_at should be NULL initially"
        );

        let cmd = StartCommand {
            id: "task1".to_string(),
        };
        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start failed: {:?}", result.err());

        // Verify started_at is now set
        let started_at = get_started_at(&db, "task1").await;
        assert!(
            started_at.is_some(),
            "started_at should be set when starting a pending_review task for rework"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_started_at_persists_after_query() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Persistence Test", "task", "todo").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };
        cmd.execute(&db).await.unwrap();

        // Query started_at multiple times to verify persistence
        let first_query = get_started_at(&db, "task1").await;
        let second_query = get_started_at(&db, "task1").await;
        let third_query = get_started_at(&db, "task1").await;

        assert!(
            first_query.is_some(),
            "First query should return started_at"
        );
        assert!(
            second_query.is_some(),
            "Second query should return started_at"
        );
        assert!(
            third_query.is_some(),
            "Third query should return started_at"
        );

        assert_eq!(
            first_query, second_query,
            "started_at should be consistent across queries"
        );
        assert_eq!(
            second_query, third_query,
            "started_at should be consistent across queries"
        );

        cleanup(&temp_dir);
    }
}
