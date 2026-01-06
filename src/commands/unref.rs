//! Unref command for removing code references from tasks
//!
//! Implements the `vtb unref` command to remove code references from tasks.
//! Supports removing by file path or removing all references.

use crate::db::{Database, DbError};
use clap::Args;
use serde::Deserialize;

/// Remove code references from a task
#[derive(Debug, Args)]
pub struct UnrefCommand {
    /// Task ID to remove references from (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// File path to remove references for (removes all refs to that file)
    #[arg(required_unless_present = "all")]
    pub file: Option<String>,

    /// Remove all references from the task
    #[arg(long, conflicts_with = "file")]
    pub all: bool,
}

/// Result of the unref command execution
#[derive(Debug)]
pub struct UnrefResult {
    /// The task ID that was updated
    pub id: String,
    /// The file path that was removed (if specified)
    pub file: Option<String>,
    /// Whether --all was used
    pub removed_all: bool,
    /// Number of references removed
    pub removed_count: usize,
}

impl std::fmt::Display for UnrefResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.removed_all {
            if self.removed_count == 0 {
                write!(f, "No references to remove from task: {}", self.id)
            } else {
                write!(
                    f,
                    "Removed all {} reference(s) from task: {}",
                    self.removed_count, self.id
                )
            }
        } else if let Some(ref file) = self.file {
            if self.removed_count == 0 {
                write!(f, "Warning: No references to {} in task: {}", file, self.id)
            } else {
                write!(
                    f,
                    "Removed {} reference(s) to {} from task: {}",
                    self.removed_count, file, self.id
                )
            }
        } else {
            write!(f, "No references removed from task: {}", self.id)
        }
    }
}

/// Result from querying a task's refs
#[derive(Debug, Deserialize)]
struct TaskRefsRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    #[serde(default, rename = "refs")]
    code_refs: Vec<CodeRefRow>,
}

/// Code reference row from database
#[derive(Debug, Deserialize, Clone)]
struct CodeRefRow {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line_start: Option<u32>,
    #[serde(default)]
    line_end: Option<u32>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

impl UnrefCommand {
    /// Execute the unref command.
    ///
    /// Removes code references from a task based on file path or --all flag.
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
    pub async fn execute(&self, db: &Database) -> Result<UnrefResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = self.fetch_task_refs(db, &id).await?;

        let original_count = task.code_refs.len();

        if self.all {
            // Remove all references
            self.clear_refs(db, &id).await?;

            if original_count > 0 {
                self.update_timestamp(db, &id).await?;
            }

            Ok(UnrefResult {
                id,
                file: None,
                removed_all: true,
                removed_count: original_count,
            })
        } else if let Some(ref file) = self.file {
            // Remove references matching the file path
            let remaining_refs: Vec<&CodeRefRow> = task
                .code_refs
                .iter()
                .filter(|r| r.path.as_deref() != Some(file.as_str()))
                .collect();

            let removed_count = original_count - remaining_refs.len();

            if removed_count > 0 {
                // Update refs to only include remaining ones
                self.replace_refs(db, &id, &remaining_refs).await?;
                self.update_timestamp(db, &id).await?;
            }

            Ok(UnrefResult {
                id,
                file: Some(file.clone()),
                removed_all: false,
                removed_count,
            })
        } else {
            // Should not reach here due to clap validation
            Ok(UnrefResult {
                id,
                file: None,
                removed_all: false,
                removed_count: 0,
            })
        }
    }

    /// Fetch the task by ID and return its refs (mainly to verify task exists).
    async fn fetch_task_refs(&self, db: &Database, id: &str) -> Result<TaskRefsRow, DbError> {
        let query = format!("SELECT id, refs FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskRefsRow> = result.take(0)?;

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.id),
            reason: format!("Task '{}' not found", self.id),
        })
    }

    /// Clear all refs from a task.
    async fn clear_refs(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET refs = []", id);
        db.client().query(&query).await?;
        Ok(())
    }

    /// Replace refs with a filtered set.
    async fn replace_refs(
        &self,
        db: &Database,
        id: &str,
        refs: &[&CodeRefRow],
    ) -> Result<(), DbError> {
        // Build the refs array
        let refs_json: Vec<String> = refs
            .iter()
            .map(|r| {
                let mut parts = Vec::new();

                if let Some(ref path) = r.path {
                    let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
                    parts.push(format!(r#""path": "{}""#, escaped));
                }

                if let Some(start) = r.line_start {
                    parts.push(format!(r#""line_start": {}"#, start));
                }

                if let Some(end) = r.line_end {
                    parts.push(format!(r#""line_end": {}"#, end));
                }

                if let Some(ref name) = r.name {
                    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
                    parts.push(format!(r#""name": "{}""#, escaped));
                }

                if let Some(ref desc) = r.description {
                    let escaped = desc.replace('\\', "\\\\").replace('"', "\\\"");
                    parts.push(format!(r#""description": "{}""#, escaped));
                }

                format!("{{ {} }}", parts.join(", "))
            })
            .collect();

        let refs_array = format!("[{}]", refs_json.join(", "));
        let query = format!("UPDATE task:{} SET refs = {}", id, refs_array);
        db.client().query(&query).await?;

        Ok(())
    }

    /// Update the task's updated_at timestamp.
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
            "vtb-unref-test-{}-{:?}-{}",
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
    async fn create_task(db: &Database, id: &str, title: &str) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "task",
                status = "todo",
                tags = [],
                sections = [],
                refs = []"#,
            id, title
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to add a code reference to a task
    async fn add_ref(
        db: &Database,
        id: &str,
        path: &str,
        line_start: Option<u32>,
        line_end: Option<u32>,
        name: Option<&str>,
        description: Option<&str>,
    ) {
        let escaped_path = path.replace('\\', "\\\\").replace('"', "\\\"");
        let mut ref_parts = vec![format!(r#""path": "{}""#, escaped_path)];

        if let Some(start) = line_start {
            ref_parts.push(format!(r#""line_start": {}"#, start));
        }

        if let Some(end) = line_end {
            ref_parts.push(format!(r#""line_end": {}"#, end));
        }

        if let Some(n) = name {
            let escaped_name = n.replace('\\', "\\\\").replace('"', "\\\"");
            ref_parts.push(format!(r#""name": "{}""#, escaped_name));
        }

        if let Some(d) = description {
            let escaped_desc = d.replace('\\', "\\\\").replace('"', "\\\"");
            ref_parts.push(format!(r#""description": "{}""#, escaped_desc));
        }

        let ref_obj = format!("{{ {} }}", ref_parts.join(", "));

        let query = format!(
            "UPDATE task:{} SET refs = array::append(refs, {})",
            id, ref_obj
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to get refs from a task
    async fn get_refs(db: &Database, id: &str) -> Vec<CodeRefRow> {
        let query = format!("SELECT refs FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();

        #[derive(Deserialize)]
        struct Row {
            #[serde(default, rename = "refs")]
            code_refs: Vec<CodeRefRow>,
        }

        let row: Option<Row> = result.take(0).unwrap();
        row.map(|r| r.code_refs).unwrap_or_default()
    }

    /// Helper to get updated_at timestamp
    async fn get_updated_at(db: &Database, id: &str) -> surrealdb::sql::Datetime {
        #[derive(Deserialize)]
        struct TimestampRow {
            updated_at: surrealdb::sql::Datetime,
        }

        let query = format!("SELECT updated_at FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let row: Option<TimestampRow> = result.take(0).unwrap();
        row.unwrap().updated_at
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    // ==================== UnrefCommand integration tests ====================

    #[tokio::test]
    async fn test_unref_removes_refs_by_file() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/auth.ex", Some(10), None, None, None).await;
        add_ref(
            &db,
            "task1",
            "src/auth.ex",
            Some(50),
            Some(60),
            Some("fn"),
            None,
        )
        .await;
        add_ref(&db, "task1", "src/other.ex", Some(20), None, None, None).await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: Some("src/auth.ex".to_string()),
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Unref failed: {:?}", result.err());

        let unref_result = result.unwrap();
        assert_eq!(unref_result.id, "task1");
        assert_eq!(unref_result.file, Some("src/auth.ex".to_string()));
        assert!(!unref_result.removed_all);
        assert_eq!(unref_result.removed_count, 2);

        // Verify refs
        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].path.as_deref(), Some("src/other.ex"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_multiple_refs_to_same_file() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/auth.ex", Some(10), None, None, None).await;
        add_ref(&db, "task1", "src/auth.ex", Some(50), None, None, None).await;
        add_ref(&db, "task1", "src/auth.ex", Some(100), None, None, None).await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: Some("src/auth.ex".to_string()),
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let unref_result = result.unwrap();
        assert_eq!(unref_result.removed_count, 3);

        // Verify all refs removed
        let refs = get_refs(&db, "task1").await;
        assert!(refs.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_all_removes_all_refs() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/auth.ex", Some(10), None, None, None).await;
        add_ref(&db, "task1", "src/other.ex", Some(20), None, None, None).await;
        add_ref(&db, "task1", "config/app.ex", None, None, None, None).await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: None,
            all: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let unref_result = result.unwrap();
        assert!(unref_result.removed_all);
        assert_eq!(unref_result.removed_count, 3);

        // Verify all refs removed
        let refs = get_refs(&db, "task1").await;
        assert!(refs.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_nonexistent_file_warns() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/auth.ex", Some(10), None, None, None).await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: Some("src/nonexistent.ex".to_string()),
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Should not fail for non-existent file ref");

        let unref_result = result.unwrap();
        assert_eq!(unref_result.removed_count, 0);

        // Original ref should still exist
        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);

        // Check display shows warning
        let display = format!("{}", unref_result);
        assert_eq!(
            display,
            "Warning: No references to src/nonexistent.ex in task: task1"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/auth.ex", Some(10), None, None, None).await;

        // Get initial timestamp
        let initial_ts = get_updated_at(&db, "task1").await;

        // Wait a bit
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: Some("src/auth.ex".to_string()),
            all: false,
        };

        cmd.execute(&db).await.unwrap();

        // Verify timestamp was updated
        let new_ts = get_updated_at(&db, "task1").await;
        assert!(
            new_ts > initial_ts,
            "updated_at should be refreshed: {:?} > {:?}",
            new_ts,
            initial_ts
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_nonexistent_does_not_update_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/auth.ex", Some(10), None, None, None).await;

        // Get initial timestamp
        let initial_ts = get_updated_at(&db, "task1").await;

        // Wait a bit
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: Some("src/nonexistent.ex".to_string()),
            all: false,
        };

        cmd.execute(&db).await.unwrap();

        // Verify timestamp was NOT updated (no changes made)
        let new_ts = get_updated_at(&db, "task1").await;
        assert_eq!(
            new_ts, initial_ts,
            "Timestamp should not change when no refs removed"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = UnrefCommand {
            id: "nonexistent".to_string(),
            file: Some("src/auth.ex".to_string()),
            all: false,
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
    async fn test_unref_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/auth.ex", Some(10), None, None, None).await;

        let cmd = UnrefCommand {
            id: "TASK1".to_string(),
            file: Some("src/auth.ex".to_string()),
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let refs = get_refs(&db, "task1").await;
        assert!(refs.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_preserves_remaining_refs() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(
            &db,
            "task1",
            "src/auth.ex",
            Some(10),
            Some(20),
            Some("fn1"),
            Some("desc1"),
        )
        .await;
        add_ref(
            &db,
            "task1",
            "src/other.ex",
            Some(30),
            Some(40),
            Some("fn2"),
            Some("desc2"),
        )
        .await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: Some("src/auth.ex".to_string()),
            all: false,
        };

        cmd.execute(&db).await.unwrap();

        // Verify remaining ref preserves all fields
        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].path.as_deref(), Some("src/other.ex"));
        assert_eq!(refs[0].line_start, Some(30));
        assert_eq!(refs[0].line_end, Some(40));
        assert_eq!(refs[0].name.as_deref(), Some("fn2"));
        assert_eq!(refs[0].description.as_deref(), Some("desc2"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_idempotent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/auth.ex", Some(10), None, None, None).await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: Some("src/auth.ex".to_string()),
            all: false,
        };

        // First removal
        let result1 = cmd.execute(&db).await.unwrap();
        assert_eq!(result1.removed_count, 1);

        // Second removal - should be idempotent
        let result2 = cmd.execute(&db).await.unwrap();
        assert_eq!(result2.removed_count, 0);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_all_empty_refs() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: None,
            all: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let unref_result = result.unwrap();
        assert_eq!(unref_result.removed_count, 0);

        let display = format!("{}", unref_result);
        assert_eq!(display, "No references to remove from task: task1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unref_all_does_not_update_timestamp_when_empty() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        // Get initial timestamp
        let initial_ts = get_updated_at(&db, "task1").await;

        // Wait a bit
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let cmd = UnrefCommand {
            id: "task1".to_string(),
            file: None,
            all: true,
        };

        cmd.execute(&db).await.unwrap();

        // Verify timestamp was NOT updated (no changes made)
        let new_ts = get_updated_at(&db, "task1").await;
        assert_eq!(
            new_ts, initial_ts,
            "Timestamp should not change when no refs to remove"
        );

        cleanup(&temp_dir);
    }

    // ==================== Display tests ====================

    #[test]
    fn test_unref_result_display_file_removed() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: Some("src/auth.ex".to_string()),
            removed_all: false,
            removed_count: 2,
        };

        let output = format!("{}", result);
        assert_eq!(
            output,
            "Removed 2 reference(s) to src/auth.ex from task: task1"
        );
    }

    #[test]
    fn test_unref_result_display_file_warning() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: Some("src/nonexistent.ex".to_string()),
            removed_all: false,
            removed_count: 0,
        };

        let output = format!("{}", result);
        assert_eq!(
            output,
            "Warning: No references to src/nonexistent.ex in task: task1"
        );
    }

    #[test]
    fn test_unref_result_display_all_removed() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: None,
            removed_all: true,
            removed_count: 5,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Removed all 5 reference(s) from task: task1");
    }

    #[test]
    fn test_unref_result_display_all_empty() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: None,
            removed_all: true,
            removed_count: 0,
        };

        let output = format!("{}", result);
        assert_eq!(output, "No references to remove from task: task1");
    }

    #[test]
    fn test_unref_command_debug() {
        let cmd = UnrefCommand {
            id: "test".to_string(),
            file: Some("src/main.rs".to_string()),
            all: false,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("UnrefCommand")
                && debug_str.contains("id: \"test\"")
                && debug_str.contains("file: Some(\"src/main.rs\")"),
            "Debug output should contain UnrefCommand and its fields"
        );
    }

    #[test]
    fn test_unref_result_debug() {
        let result = UnrefResult {
            id: "task1".to_string(),
            file: None,
            removed_all: true,
            removed_count: 0,
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("UnrefResult")
                && debug_str.contains("id: \"task1\"")
                && debug_str.contains("removed_all: true"),
            "Debug output should contain UnrefResult and its fields"
        );
    }
}
