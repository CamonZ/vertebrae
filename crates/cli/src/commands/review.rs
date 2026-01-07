//! Review command for toggling the needs_human_review flag
//!
//! Implements the `vtb review` command to toggle the needs_human_review flag on tasks.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError};

/// Toggle the needs_human_review flag on a task
#[derive(Debug, Args)]
pub struct ReviewCommand {
    /// Task ID to toggle review flag (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Set the flag to a specific value instead of toggling
    #[arg(long)]
    pub set: Option<bool>,
}

/// Result from querying a task's review flag
#[derive(Debug, Deserialize)]
struct ReviewFlagRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    #[serde(default)]
    needs_human_review: bool,
}

impl ReviewCommand {
    /// Execute the review command.
    ///
    /// Toggles the needs_human_review flag on the specified task,
    /// or sets it to a specific value if --set is provided.
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

        // Fetch current flag value
        let current = self.get_current_flag(db, &id).await?;

        // Determine new value
        let new_value = match self.set {
            Some(value) => value,
            None => !current, // Toggle
        };

        // Update the flag
        self.update_flag(db, &id, new_value).await?;

        // Update timestamp
        self.update_timestamp(db, &id).await?;

        let action = if new_value {
            "marked as needing review"
        } else {
            "marked as not needing review"
        };

        Ok(format!("Task {} {}", id, action))
    }

    /// Get the current needs_human_review flag value.
    async fn get_current_flag(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        let query = format!("SELECT id, needs_human_review FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let row: Option<ReviewFlagRow> = result.take(0)?;

        match row {
            Some(r) => Ok(r.needs_human_review),
            None => Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("Task '{}' not found", self.id),
            }),
        }
    }

    /// Update the needs_human_review flag.
    async fn update_flag(&self, db: &Database, id: &str, value: bool) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET needs_human_review = {}", id, value);
        db.client().query(&query).await?;
        Ok(())
    }

    /// Update the updated_at timestamp.
    async fn update_timestamp(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
        db.client().query(&query).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-review-test-{}-{:?}-{}",
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
    async fn create_task(db: &Database, id: &str, needs_review: bool) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "Test Task",
                level = "task",
                status = "todo",
                needs_human_review = {}"#,
            id, needs_review
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to get the needs_human_review flag
    async fn get_review_flag(db: &Database, id: &str) -> bool {
        let query = format!("SELECT needs_human_review FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();

        #[derive(Debug, Deserialize)]
        struct FlagRow {
            #[serde(default)]
            needs_human_review: bool,
        }

        let row: Option<FlagRow> = result.take(0).unwrap();
        row.map(|r| r.needs_human_review).unwrap_or(false)
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_review_toggle_false_to_true() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", false).await;

        let cmd = ReviewCommand {
            id: "abc123".to_string(),
            set: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert!(result.unwrap().contains("marked as needing review"));

        let flag = get_review_flag(&db, "abc123").await;
        assert!(flag, "Flag should be true after toggle");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_review_toggle_true_to_false() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", true).await;

        let cmd = ReviewCommand {
            id: "abc123".to_string(),
            set: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert!(result.unwrap().contains("marked as not needing review"));

        let flag = get_review_flag(&db, "abc123").await;
        assert!(!flag, "Flag should be false after toggle");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_review_set_true() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", false).await;

        let cmd = ReviewCommand {
            id: "abc123".to_string(),
            set: Some(true),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let flag = get_review_flag(&db, "abc123").await;
        assert!(flag, "Flag should be true after set");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_review_set_false() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", true).await;

        let cmd = ReviewCommand {
            id: "abc123".to_string(),
            set: Some(false),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let flag = get_review_flag(&db, "abc123").await;
        assert!(!flag, "Flag should be false after set");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_review_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = ReviewCommand {
            id: "nonexistent".to_string(),
            set: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("not found"),
                    "Expected 'not found' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_review_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", false).await;

        let cmd = ReviewCommand {
            id: "ABC123".to_string(),
            set: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_review_command_debug() {
        let cmd = ReviewCommand {
            id: "test123".to_string(),
            set: Some(true),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("ReviewCommand") && debug_str.contains("test123"),
            "Debug output should contain ReviewCommand and id field value"
        );
    }
}
