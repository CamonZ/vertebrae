//! Block command for transitioning tasks to blocked status
//!
//! Implements the `vtb block` command to mark a task as blocked with an optional reason.
//! The blocking reason is stored as a constraint section for persistent documentation.

use crate::db::{Database, DbError, Status};
use clap::Args;
use serde::Deserialize;

/// Mark a task as blocked (transition to blocked)
#[derive(Debug, Args)]
pub struct BlockCommand {
    /// Task ID to block (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Optional reason for blocking
    #[arg(short, long)]
    pub reason: Option<String>,
}

/// Result from querying a task's status
#[derive(Debug, Deserialize)]
struct TaskStatusRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    status: String,
}

/// Result of the block command execution
#[derive(Debug)]
pub struct BlockResult {
    /// The task ID that was blocked
    pub id: String,
    /// Whether the task was already blocked
    pub already_blocked: bool,
    /// The reason provided (if any)
    pub reason: Option<String>,
}

impl std::fmt::Display for BlockResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.already_blocked {
            write!(f, "Task '{}' is already blocked", self.id)?;
            if let Some(reason) = &self.reason {
                write!(f, " (added reason: {})", reason)?;
            }
        } else {
            write!(f, "Blocked task: {}", self.id)?;
            if let Some(reason) = &self.reason {
                write!(f, "\nReason: {}", reason)?;
            }
        }
        Ok(())
    }
}

impl BlockCommand {
    /// Execute the block command.
    ///
    /// Transitions a task to `blocked` status from any status.
    /// Optionally adds a constraint section with the blocking reason.
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
    pub async fn execute(&self, db: &Database) -> Result<BlockResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = self.fetch_task(db, &id).await?;

        // Parse the current status
        let current_status = parse_status(&task.status);

        // Check if already blocked
        let already_blocked = current_status == Status::Blocked;

        // If reason provided, add constraint section (even if already blocked - reasons accumulate)
        if let Some(reason) = &self.reason {
            self.add_constraint_section(db, &id, reason).await?;
        }

        // Update status to blocked and timestamp (if not already blocked)
        if !already_blocked {
            self.update_status(db, &id).await?;
        } else {
            // Still update timestamp even if already blocked
            self.update_timestamp(db, &id).await?;
        }

        Ok(BlockResult {
            id,
            already_blocked,
            reason: self.reason.clone(),
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

    /// Add a constraint section with the blocking reason.
    ///
    /// Appends a new constraint section to the task's sections array.
    /// Multiple block reasons accumulate (add, not replace).
    async fn add_constraint_section(
        &self,
        db: &Database,
        id: &str,
        reason: &str,
    ) -> Result<(), DbError> {
        // Create the constraint content with BLOCKED prefix
        let content = format!("BLOCKED: {}", reason);

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

    /// Update the task status to blocked and refresh updated_at.
    async fn update_status(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!(
            "UPDATE task:{} SET status = 'blocked', updated_at = time::now()",
            id
        );
        db.client().query(&query).await?;
        Ok(())
    }

    /// Update only the timestamp (for already blocked tasks).
    async fn update_timestamp(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
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
    use serde::Deserialize;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-block-test-{}-{:?}-{}",
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
    async fn test_block_todo_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = BlockCommand {
            id: "task1".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Block failed: {:?}", result.err());

        let block_result = result.unwrap();
        assert_eq!(block_result.id, "task1");
        assert!(!block_result.already_blocked);
        assert!(block_result.reason.is_none());

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "blocked");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_in_progress_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "In Progress Task", "task", "in_progress").await;

        let cmd = BlockCommand {
            id: "task1".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Block failed: {:?}", result.err());

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "blocked");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_done_task() {
        let (db, temp_dir) = setup_test_db().await;

        // Done task can be blocked (reopening edge case)
        create_task(&db, "task1", "Done Task", "task", "done").await;

        let cmd = BlockCommand {
            id: "task1".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Block failed: {:?}", result.err());

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "blocked");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_already_blocked() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Blocked Task", "task", "blocked").await;

        let cmd = BlockCommand {
            id: "task1".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Block should succeed with info message");

        let block_result = result.unwrap();
        assert!(block_result.already_blocked);

        // Status should remain blocked
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "blocked");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = BlockCommand {
            id: "nonexistent".to_string(),
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());

        let err = result.unwrap_err().to_string();
        assert_eq!(
            err,
            "Invalid database path: nonexistent - Task 'nonexistent' not found"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_with_reason() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = BlockCommand {
            id: "task1".to_string(),
            reason: Some("Waiting for API".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Block with reason failed: {:?}",
            result.err()
        );

        let block_result = result.unwrap();
        assert_eq!(block_result.reason, Some("Waiting for API".to_string()));

        // Verify constraint section was added
        let constraints = get_constraint_sections(&db, "task1").await;
        assert_eq!(constraints.len(), 1);
        assert_eq!(constraints[0], "BLOCKED: Waiting for API");

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "blocked");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_accumulates_reasons() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        // First block with reason
        let cmd1 = BlockCommand {
            id: "task1".to_string(),
            reason: Some("Waiting for API".to_string()),
        };
        cmd1.execute(&db).await.unwrap();

        // Second block with different reason (already blocked)
        let cmd2 = BlockCommand {
            id: "task1".to_string(),
            reason: Some("Also need design review".to_string()),
        };
        let result = cmd2.execute(&db).await;
        assert!(result.is_ok());
        assert!(result.unwrap().already_blocked);

        // Verify both constraint sections exist (reasons accumulate)
        let constraints = get_constraint_sections(&db, "task1").await;
        assert_eq!(constraints.len(), 2);
        assert!(constraints.contains(&"BLOCKED: Waiting for API".to_string()));
        assert!(constraints.contains(&"BLOCKED: Also need design review".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = BlockCommand {
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
    async fn test_block_already_blocked_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Blocked Task", "task", "blocked").await;

        let cmd = BlockCommand {
            id: "task1".to_string(),
            reason: Some("New reason".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify updated_at was set even for already blocked task
        assert!(has_updated_at(&db, "task1").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = BlockCommand {
            id: "TASK1".to_string(), // Uppercase
            reason: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "blocked");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_block_with_special_characters_in_reason() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = BlockCommand {
            id: "task1".to_string(),
            reason: Some("Waiting for \"external\" API (v2.0)".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Block with special chars failed: {:?}",
            result.err()
        );

        // Verify constraint section was added with special characters intact
        let constraints = get_constraint_sections(&db, "task1").await;
        assert_eq!(constraints.len(), 1);
        // Verify the full content was stored correctly with special characters
        assert_eq!(
            constraints[0],
            "BLOCKED: Waiting for \"external\" API (v2.0)"
        );

        cleanup(&temp_dir);
    }

    #[test]
    fn test_block_result_display_normal() {
        let result = BlockResult {
            id: "task1".to_string(),
            already_blocked: false,
            reason: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Blocked task: task1");
    }

    #[test]
    fn test_block_result_display_with_reason() {
        let result = BlockResult {
            id: "task1".to_string(),
            already_blocked: false,
            reason: Some("Waiting for API".to_string()),
        };

        let output = format!("{}", result);
        assert_eq!(output, "Blocked task: task1\nReason: Waiting for API");
    }

    #[test]
    fn test_block_result_display_already_blocked() {
        let result = BlockResult {
            id: "task1".to_string(),
            already_blocked: true,
            reason: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Task 'task1' is already blocked");
    }

    #[test]
    fn test_block_result_display_already_blocked_with_reason() {
        let result = BlockResult {
            id: "task1".to_string(),
            already_blocked: true,
            reason: Some("New reason".to_string()),
        };

        let output = format!("{}", result);
        assert_eq!(
            output,
            "Task 'task1' is already blocked (added reason: New reason)"
        );
    }

    #[test]
    fn test_block_command_debug() {
        let cmd = BlockCommand {
            id: "test".to_string(),
            reason: Some("reason".to_string()),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("BlockCommand")
                && debug_str.contains("id: \"test\"")
                && debug_str.contains("reason: Some(\"reason\")"),
            "Debug output should contain BlockCommand and its fields"
        );
    }
}
