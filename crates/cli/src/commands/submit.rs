//! Submit command for transitioning tasks to pending_review status
//!
//! Implements the `vtb submit` command to mark a task as ready for review.

use clap::Args;
use vertebrae_db::{Database, DbError, Status, TaskUpdate};

/// Submit a task for review (transition to pending_review)
#[derive(Debug, Args)]
pub struct SubmitCommand {
    /// Task ID to submit for review (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Result of the submit command execution
#[derive(Debug)]
pub struct SubmitResult {
    /// The task ID that was submitted
    pub id: String,
    /// Whether the task was already in pending_review
    pub already_pending: bool,
}

impl std::fmt::Display for SubmitResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.already_pending {
            write!(f, "Task '{}' is already pending review", self.id)
        } else {
            write!(f, "Submitted task for review: {}", self.id)
        }
    }
}

impl SubmitCommand {
    /// Execute the submit command.
    ///
    /// Transitions a task from `in_progress` to `pending_review`.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The task is not in `in_progress` status
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<SubmitResult, DbError> {
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

        // Handle already pending_review case (no-op)
        if task.status == Status::PendingReview {
            return Ok(SubmitResult {
                id,
                already_pending: true,
            });
        }

        // Validate the status transition using centralized validation
        db.tasks()
            .validate_status_transition(&id, &task.status, &Status::PendingReview)?;

        // Update status to pending_review
        let updates = TaskUpdate::new().with_status(Status::PendingReview);
        db.tasks().update(&id, &updates).await?;

        Ok(SubmitResult {
            id,
            already_pending: false,
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
            "vtb-submit-test-{}-{:?}-{}",
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
    fn test_submit_command_debug() {
        let cmd = SubmitCommand {
            id: "abc123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("abc123"));
    }

    #[test]
    fn test_submit_result_display_normal() {
        let result = SubmitResult {
            id: "abc123".to_string(),
            already_pending: false,
        };
        assert_eq!(result.to_string(), "Submitted task for review: abc123");
    }

    #[test]
    fn test_submit_result_display_already_pending() {
        let result = SubmitResult {
            id: "abc123".to_string(),
            already_pending: true,
        };
        assert_eq!(
            result.to_string(),
            "Task 'abc123' is already pending review"
        );
    }

    #[tokio::test]
    async fn test_submit_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = SubmitCommand {
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
    async fn test_submit_in_progress_task() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task in in_progress status
        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        let cmd = SubmitCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await.unwrap();
        assert!(!result.already_pending);
        assert_eq!(result.id, "task1");

        // Verify status was updated
        let updated = db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(updated.status, Status::PendingReview);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_submit_already_pending_review() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task already in pending_review status
        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        let cmd = SubmitCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await.unwrap();
        assert!(result.already_pending);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_submit_todo_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task in todo status
        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = SubmitCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition {
                from_status,
                to_status,
                ..
            }) => {
                assert_eq!(from_status, "todo");
                assert_eq!(to_status, "pending_review");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_submit_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task
        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        let cmd = SubmitCommand {
            id: "TASK1".to_string(),
        };

        let result = cmd.execute(&db).await.unwrap();
        assert!(!result.already_pending);

        cleanup(&temp_dir);
    }
}
