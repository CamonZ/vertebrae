//! Triage command for transitioning tasks from backlog to todo
//!
//! Implements the `vtb triage` command to mark a task as ready for work.

use clap::Args;
use vertebrae_db::{Database, DbError, Status, TaskUpdate};

/// Triage a task (transition from backlog to todo)
#[derive(Debug, Args)]
pub struct TriageCommand {
    /// Task ID to triage (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Result of the triage command execution
#[derive(Debug)]
pub struct TriageResult {
    /// The task ID that was triaged
    pub id: String,
    /// Whether the task was already in todo
    pub already_todo: bool,
}

impl std::fmt::Display for TriageResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.already_todo {
            write!(f, "Task '{}' is already in todo", self.id)
        } else {
            write!(f, "Triaged task: {}", self.id)
        }
    }
}

impl TriageCommand {
    /// Execute the triage command.
    ///
    /// Transitions a task from `backlog` to `todo`.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The task is not in `backlog` status
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<TriageResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = db
            .tasks()
            .get(&id)
            .await?
            .ok_or_else(|| DbError::NotFound {
                task_id: self.id.clone(),
            })?;

        // Handle already todo case (no-op)
        if task.status == Status::Todo {
            return Ok(TriageResult {
                id,
                already_todo: true,
            });
        }

        // Validate the status transition using centralized validation
        db.tasks()
            .validate_status_transition(&id, &task.status, &Status::Todo)?;

        // Update status to todo
        let updates = TaskUpdate::new().with_status(Status::Todo);
        db.tasks().update(&id, &updates).await?;

        Ok(TriageResult {
            id,
            already_todo: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::path::PathBuf;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-triage-test-{}-{:?}-{}",
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

    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn test_triage_command_debug() {
        let cmd = TriageCommand {
            id: "abc123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("abc123"));
    }

    #[test]
    fn test_triage_result_display_normal() {
        let result = TriageResult {
            id: "abc123".to_string(),
            already_todo: false,
        };
        assert_eq!(result.to_string(), "Triaged task: abc123");
    }

    #[test]
    fn test_triage_result_display_already_todo() {
        let result = TriageResult {
            id: "abc123".to_string(),
            already_todo: true,
        };
        assert_eq!(result.to_string(), "Task 'abc123' is already in todo");
    }

    #[tokio::test]
    async fn test_triage_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = TriageCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::NotFound { task_id }) => {
                assert_eq!(task_id, "nonexistent");
            }
            Err(other) => panic!("Expected NotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_triage_backlog_task() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task in backlog status
        create_task(&db, "task1", "Test Task", "task", "backlog").await;

        let cmd = TriageCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await.unwrap();
        assert!(!result.already_todo);
        assert_eq!(result.id, "task1");

        // Verify status was updated
        let updated = db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(updated.status, Status::Todo);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_triage_already_todo() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task already in todo status
        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = TriageCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await.unwrap();
        assert!(result.already_todo);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_triage_in_progress_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task in in_progress status
        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        let cmd = TriageCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition {
                from_status,
                to_status,
                ..
            }) => {
                assert_eq!(from_status, "in_progress");
                assert_eq!(to_status, "todo");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_triage_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task
        create_task(&db, "task1", "Test Task", "task", "backlog").await;

        let cmd = TriageCommand {
            id: "TASK1".to_string(),
        };

        let result = cmd.execute(&db).await.unwrap();
        assert!(!result.already_todo);

        cleanup(&temp_dir);
    }
}
