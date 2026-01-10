//! Submit command for backwards compatibility
//!
//! Implements the `vtb submit` command as an alias for workflow advance operations.
//! This maintains backwards compatibility with the traditional status-based commands.

use clap::Args;
use vertebrae_db::{Database, DbError, Status, TaskUpdate};

/// Submit a task for review (transition from in_progress to pending_review)
///
/// This command is provided for backwards compatibility and operates on the task's
/// workflow assignment. It advances the task from the 'in_progress' step to the 'pending_review' step.
#[derive(Debug, Args)]
pub struct SubmitCommand {
    /// Task ID to submit (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Result of the submit command execution
#[derive(Debug)]
pub struct SubmitResult {
    /// The task ID that was submitted
    pub id: String,
    /// Whether the task was already pending review
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
    /// Transitions a task from in_progress to pending_review status, advancing it in the workflow.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The status transition is invalid (not in in_progress status)
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<SubmitResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = db
            .tasks()
            .get(&id)
            .await?
            .ok_or_else(|| DbError::TaskNotFound {
                task_id: self.id.clone(),
            })?;

        // Check if already pending review
        if task.status == Status::PendingReview {
            return Ok(SubmitResult {
                id,
                already_pending: true,
            });
        }

        // Validate the status transition
        db.tasks()
            .validate_status_transition(&id, &task.status, &Status::PendingReview)?;

        // Update status to pending_review
        let updates = TaskUpdate::new().with_status(Status::PendingReview);
        db.tasks().update(&id, &updates).await?;

        // If task has a workflow assignment, advance the workflow step
        if task.workflow_id.is_some() {
            // Advance to step 3 (pending_review)
            db.tasks().update_current_step(&id, 3).await?;
        }

        Ok(SubmitResult {
            id,
            already_pending: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Database {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        db
    }

    /// Helper to create a task in the database
    async fn create_task(db: &Database, id: &str, title: &str, status: &str) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "task",
                status = "{}",
                tags = [],
                sections = [],
                refs = []"#,
            id, title, status
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to get task status from database
    async fn get_task_status(db: &Database, id: &str) -> String {
        db.tasks()
            .get(id)
            .await
            .unwrap()
            .unwrap()
            .status
            .as_str()
            .to_string()
    }

    #[tokio::test]
    async fn test_submit_from_in_progress() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "in_progress").await;

        let cmd = SubmitCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Submit failed: {:?}", result.err());

        let submit_result = result.unwrap();
        assert_eq!(submit_result.id, "task1");
        assert!(!submit_result.already_pending);

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "pending_review");
    }

    #[tokio::test]
    async fn test_submit_from_todo_fails() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "todo").await;

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

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "todo");
    }

    #[tokio::test]
    async fn test_submit_already_pending_review() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "pending_review").await;

        let cmd = SubmitCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let submit_result = result.unwrap();
        assert!(submit_result.already_pending);
    }

    #[tokio::test]
    async fn test_submit_nonexistent_task_fails() {
        let db = setup_test_db().await;

        let cmd = SubmitCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::TaskNotFound { task_id }) => {
                assert_eq!(task_id, "nonexistent");
            }
            Err(other) => panic!("Expected TaskNotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_submit_case_insensitive() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "in_progress").await;

        let cmd = SubmitCommand {
            id: "TASK1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "pending_review");
    }

    #[test]
    fn test_submit_result_display() {
        let result = SubmitResult {
            id: "task1".to_string(),
            already_pending: false,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Submitted task for review: task1");
    }

    #[test]
    fn test_submit_result_display_already_pending() {
        let result = SubmitResult {
            id: "task1".to_string(),
            already_pending: true,
        };

        let output = format!("{}", result);
        assert!(output.contains("Task 'task1' is already pending review"));
    }
}
