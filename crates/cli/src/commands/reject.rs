//! Reject command for transitioning tasks to rejected status
//!
//! Implements the `vtb reject` command to mark a task as rejected with an optional reason.
//! The rejection reason is stored as a constraint section for persistent documentation.

use clap::Args;
use vertebrae_db::{Database, DbError, Status};

/// Mark a task as rejected (transition from todo to rejected)
#[derive(Debug, Args)]
pub struct RejectCommand {
    /// Task ID to reject (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Optional reason for rejection
    #[arg(short, long)]
    pub reason: Option<String>,
}

/// Result of the reject command execution
#[derive(Debug)]
pub struct RejectResult {
    /// The task ID that was rejected
    pub id: String,
    /// Whether the task was already rejected
    pub already_rejected: bool,
    /// The reason provided (if any)
    pub reason: Option<String>,
}

impl std::fmt::Display for RejectResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.already_rejected {
            write!(f, "Task '{}' is already rejected", self.id)?;
            if let Some(reason) = &self.reason {
                write!(f, " (added reason: {})", reason)?;
            }
        } else {
            write!(f, "Rejected task: {}", self.id)?;
            if let Some(reason) = &self.reason {
                write!(f, "\nReason: {}", reason)?;
            }
        }
        Ok(())
    }
}

impl RejectCommand {
    /// Execute the reject command.
    ///
    /// Transitions a task from `todo` to `rejected` status.
    /// Optionally adds a constraint section with the rejection reason.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The status transition is invalid
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<RejectResult, DbError> {
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

        // Check if already rejected
        let already_rejected = task.status == Status::Rejected;

        // If reason provided, add constraint section (even if already rejected - reasons accumulate)
        if let Some(reason) = &self.reason {
            self.add_constraint_section(db, &id, reason).await?;
        }

        // Update status to rejected (if not already rejected)
        if !already_rejected {
            // Use repository to update status (validation will occur there)
            db.tasks().update_status(&id, Status::Rejected).await?;
        } else {
            // Still update timestamp even if already rejected
            self.update_timestamp(db, &id).await?;
        }

        Ok(RejectResult {
            id,
            already_rejected,
            reason: self.reason.clone(),
        })
    }

    /// Add a constraint section with the rejection reason.
    ///
    /// Appends a new constraint section to the task's sections array.
    /// Multiple rejection reasons accumulate (add, not replace).
    async fn add_constraint_section(
        &self,
        db: &Database,
        id: &str,
        reason: &str,
    ) -> Result<(), DbError> {
        // Create the constraint content with REJECTED prefix
        let content = format!("REJECTED: {}", reason);

        // Use array::concat to properly append the new section object
        // This preserves existing sections and adds the new constraint
        let query = format!(
            r#"UPDATE task:{} SET sections = array::concat(sections, [{{ type: "constraint", content: "{}" }}])"#,
            id,
            content.replace('"', "\\\"")
        );
        db.client().query(&query).await?;
        Ok(())
    }

    /// Update only the timestamp (for already rejected tasks).
    async fn update_timestamp(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
        db.client().query(&query).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-reject-test-{}-{:?}-{}",
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

    /// Helper to check if updated_at was set
    async fn has_updated_at(db: &Database, id: &str) -> bool {
        db.tasks()
            .get(id)
            .await
            .unwrap()
            .map(|t| t.updated_at.is_some())
            .unwrap_or(false)
    }

    /// Helper to get constraint sections from a task
    async fn get_constraint_sections(db: &Database, id: &str) -> Vec<String> {
        #[derive(Deserialize)]
        struct SectionRow {
            #[serde(rename = "type", default)]
            section_type: Option<String>,
            #[serde(default)]
            content: Option<String>,
        }

        #[derive(Deserialize)]
        struct TaskRow {
            #[serde(default)]
            sections: Vec<SectionRow>,
        }

        let query = format!("SELECT sections FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let row: Option<TaskRow> = result.take(0).unwrap();

        row.map(|r| {
            r.sections
                .into_iter()
                .filter_map(|s| {
                    if s.section_type.as_deref() == Some("constraint") {
                        s.content
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_reject_todo_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = RejectCommand {
            id: "task1".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Reject failed: {:?}", result.err());

        let reject_result = result.unwrap();
        assert_eq!(reject_result.id, "task1");
        assert!(!reject_result.already_rejected);
        assert!(reject_result.reason.is_none());

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "rejected");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_reject_in_progress_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "In Progress Task", "task", "in_progress").await;

        let cmd = RejectCommand {
            id: "task1".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        // Should fail - in_progress -> rejected is not a valid transition
        match result {
            Err(DbError::InvalidStatusTransition { .. }) => {
                // Expected
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        // Status should remain in_progress
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_reject_already_rejected() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Rejected Task", "task", "rejected").await;

        let cmd = RejectCommand {
            id: "task1".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Reject should succeed with info message");

        let reject_result = result.unwrap();
        assert!(reject_result.already_rejected);

        // Status should remain rejected
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "rejected");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_reject_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = RejectCommand {
            id: "nonexistent".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::NotFound { task_id }) => {
                assert_eq!(
                    task_id, "nonexistent",
                    "Expected task_id 'nonexistent', got: {}",
                    task_id
                );
            }
            Err(other) => panic!("Expected NotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_reject_with_reason() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = RejectCommand {
            id: "task1".to_string(),
            reason: Some("Out of scope".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Reject with reason failed: {:?}",
            result.err()
        );

        let reject_result = result.unwrap();
        assert_eq!(reject_result.reason, Some("Out of scope".to_string()));

        // Verify constraint section was added
        let constraints = get_constraint_sections(&db, "task1").await;
        assert_eq!(constraints.len(), 1);
        assert_eq!(constraints[0], "REJECTED: Out of scope");

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "rejected");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_reject_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = RejectCommand {
            id: "task1".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify updated_at was set
        assert!(has_updated_at(&db, "task1").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_reject_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = RejectCommand {
            id: "TASK1".to_string(), // Uppercase
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "rejected");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_reject_result_display_normal() {
        let result = RejectResult {
            id: "task1".to_string(),
            already_rejected: false,
            reason: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Rejected task: task1");
    }

    #[test]
    fn test_reject_result_display_with_reason() {
        let result = RejectResult {
            id: "task1".to_string(),
            already_rejected: false,
            reason: Some("Out of scope".to_string()),
        };

        let output = format!("{}", result);
        assert_eq!(output, "Rejected task: task1\nReason: Out of scope");
    }

    #[test]
    fn test_reject_result_display_already_rejected() {
        let result = RejectResult {
            id: "task1".to_string(),
            already_rejected: true,
            reason: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Task 'task1' is already rejected");
    }

    #[test]
    fn test_reject_command_debug() {
        let cmd = RejectCommand {
            id: "test".to_string(),
            reason: Some("reason".to_string()),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("RejectCommand")
                && debug_str.contains("id: \"test\"")
                && debug_str.contains("reason: Some(\"reason\")"),
            "Debug output should contain RejectCommand and its fields"
        );
    }
}
