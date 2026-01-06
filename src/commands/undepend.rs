//! Undepend command for removing task dependencies
//!
//! Implements the `vtb undepend` command to remove dependency relationships between tasks.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError};

/// Remove a dependency relationship between tasks
#[derive(Debug, Args)]
pub struct UndependCommand {
    /// Task ID that depends on another task (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Task ID of the blocker to remove (case-insensitive)
    #[arg(long = "on", required = true)]
    pub blocker_id: String,
}

/// Result from querying a task's existence
#[derive(Debug, Deserialize)]
struct TaskExistsRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
}

/// Result from querying dependency edges
#[derive(Debug, Deserialize)]
struct DependencyEdge {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
}

/// Result of the undepend command execution
#[derive(Debug)]
pub struct UndependResult {
    /// The task ID that no longer depends on the blocker
    pub task_id: String,
    /// The blocker task ID that was removed
    pub blocker_id: String,
    /// Whether the dependency existed before removal
    pub existed: bool,
}

impl std::fmt::Display for UndependResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.existed {
            write!(
                f,
                "Removed dependency: {} no longer depends on {}",
                self.task_id, self.blocker_id
            )
        } else {
            write!(
                f,
                "Warning: No dependency from {} to {} exists",
                self.task_id, self.blocker_id
            )
        }
    }
}

impl UndependCommand {
    /// Execute the undepend command.
    ///
    /// Removes a dependency relationship where the task identified by `id`
    /// depends on (is blocked by) the task identified by `blocker_id`.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The source task does not exist
    /// - Database operations fail
    ///
    /// Note: Non-existent dependency is handled gracefully with a warning.
    pub async fn execute(&self, db: &Database) -> Result<UndependResult, DbError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let task_id = self.id.to_lowercase();
        let blocker_id = self.blocker_id.to_lowercase();

        // Validate source task exists
        if !self.task_exists(db, &task_id).await? {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("Task '{}' not found", self.id),
            });
        }

        // Check if dependency exists
        let existed = self.dependency_exists(db, &task_id, &blocker_id).await?;

        if existed {
            // Delete the dependency edge
            self.delete_dependency_edge(db, &task_id, &blocker_id)
                .await?;

            // Update timestamp
            self.update_timestamp(db, &task_id).await?;
        }

        Ok(UndependResult {
            task_id,
            blocker_id,
            existed,
        })
    }

    /// Check if a task with the given ID exists.
    async fn task_exists(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        let query = format!("SELECT id FROM task:{} LIMIT 1", id);
        let mut result = db.client().query(&query).await?;
        let tasks: Vec<TaskExistsRow> = result.take(0)?;
        Ok(!tasks.is_empty())
    }

    /// Check if a dependency edge exists between two tasks.
    async fn dependency_exists(
        &self,
        db: &Database,
        task_id: &str,
        blocker_id: &str,
    ) -> Result<bool, DbError> {
        let query = format!(
            "SELECT id FROM depends_on WHERE in = task:{} AND out = task:{}",
            task_id, blocker_id
        );
        let mut result = db.client().query(&query).await?;
        let edges: Vec<DependencyEdge> = result.take(0)?;
        Ok(!edges.is_empty())
    }

    /// Delete a dependency edge between tasks.
    async fn delete_dependency_edge(
        &self,
        db: &Database,
        task_id: &str,
        blocker_id: &str,
    ) -> Result<(), DbError> {
        let query = format!(
            "DELETE depends_on WHERE in = task:{} AND out = task:{}",
            task_id, blocker_id
        );
        db.client().query(&query).await?;
        Ok(())
    }

    /// Update the updated_at timestamp for a task.
    async fn update_timestamp(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
        db.client().query(&query).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::DependCommand;
    use serde::Deserialize;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-undepend-test-{}-{:?}-{}",
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

    /// Helper to check if a dependency exists
    async fn dependency_exists(db: &Database, task_id: &str, blocker_id: &str) -> bool {
        #[derive(Deserialize)]
        struct EdgeRow {
            #[allow(dead_code)]
            id: surrealdb::sql::Thing,
        }

        let query = format!(
            "SELECT id FROM depends_on WHERE in = task:{} AND out = task:{}",
            task_id, blocker_id
        );
        let mut result = db.client().query(&query).await.unwrap();
        let edges: Vec<EdgeRow> = result.take(0).unwrap();
        !edges.is_empty()
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

    #[tokio::test]
    async fn test_remove_dependency() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        // Create dependency first
        let depend_cmd = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };
        depend_cmd.execute(&db).await.unwrap();

        // Verify dependency exists
        assert!(dependency_exists(&db, "taskb", "taska").await);

        // Remove dependency
        let undepend_cmd = UndependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };

        let result = undepend_cmd.execute(&db).await;
        assert!(result.is_ok(), "Undepend failed: {:?}", result.err());

        let undepend_result = result.unwrap();
        assert_eq!(undepend_result.task_id, "taskb");
        assert_eq!(undepend_result.blocker_id, "taska");
        assert!(undepend_result.existed);

        // Verify dependency was removed
        assert!(!dependency_exists(&db, "taskb", "taska").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_dependency_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        // Create dependency
        let depend_cmd = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };
        depend_cmd.execute(&db).await.unwrap();

        // Remove dependency
        let undepend_cmd = UndependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };
        undepend_cmd.execute(&db).await.unwrap();

        // Verify updated_at was set
        assert!(has_updated_at(&db, "taskb").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_dependency_warns() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        // Try to remove non-existent dependency
        let undepend_cmd = UndependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };

        let result = undepend_cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Should not fail for non-existent dependency"
        );

        let undepend_result = result.unwrap();
        // Verify all fields of UndependResult
        assert_eq!(undepend_result.task_id, "taskb");
        assert_eq!(undepend_result.blocker_id, "taska");
        assert!(!undepend_result.existed);

        // Verify display message shows warning
        let display = format!("{}", undepend_result);
        assert_eq!(display, "Warning: No dependency from taskb to taska exists");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_dependency_idempotent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        // Create dependency
        let depend_cmd = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };
        depend_cmd.execute(&db).await.unwrap();

        let undepend_cmd = UndependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };

        // Remove dependency first time
        let result1 = undepend_cmd.execute(&db).await;
        assert!(result1.is_ok());
        let undepend_result1 = result1.unwrap();
        // Verify all fields of UndependResult
        assert_eq!(undepend_result1.task_id, "taskb");
        assert_eq!(undepend_result1.blocker_id, "taska");
        assert!(undepend_result1.existed);

        // Remove dependency second time - should be idempotent (warn but not fail)
        let result2 = undepend_cmd.execute(&db).await;
        assert!(result2.is_ok());
        let undepend_result2 = result2.unwrap();
        // Verify all fields of UndependResult
        assert_eq!(undepend_result2.task_id, "taskb");
        assert_eq!(undepend_result2.blocker_id, "taska");
        assert!(!undepend_result2.existed);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_source_task_must_exist() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;

        let undepend_cmd = UndependCommand {
            id: "nonexistent".to_string(),
            blocker_id: "taska".to_string(),
        };

        let result = undepend_cmd.execute(&db).await;
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
    async fn test_target_task_nonexistence_ok() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;

        // Target task doesn't exist - this is OK for edge cleanup
        let undepend_cmd = UndependCommand {
            id: "taska".to_string(),
            blocker_id: "nonexistent".to_string(),
        };

        let result = undepend_cmd.execute(&db).await;
        assert!(result.is_ok(), "Should not fail when target doesn't exist");
        let undepend_result = result.unwrap();
        // Verify all fields of UndependResult
        assert_eq!(undepend_result.task_id, "taska");
        assert_eq!(undepend_result.blocker_id, "nonexistent");
        assert!(!undepend_result.existed);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_case_insensitive_ids() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        // Create dependency with lowercase
        let depend_cmd = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };
        depend_cmd.execute(&db).await.unwrap();

        // Remove with uppercase
        let undepend_cmd = UndependCommand {
            id: "TASKB".to_string(),
            blocker_id: "TASKA".to_string(),
        };

        let result = undepend_cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive removal should work");
        assert!(result.unwrap().existed);

        // Verify dependency was removed
        assert!(!dependency_exists(&db, "taskb", "taska").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_only_specified_dependency() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_task(&db, "taskc", "Task C").await;

        // C depends on both A and B
        DependCommand {
            id: "taskc".to_string(),
            blocker_id: "taska".to_string(),
        }
        .execute(&db)
        .await
        .unwrap();

        DependCommand {
            id: "taskc".to_string(),
            blocker_id: "taskb".to_string(),
        }
        .execute(&db)
        .await
        .unwrap();

        // Remove only C -> A dependency
        let undepend_cmd = UndependCommand {
            id: "taskc".to_string(),
            blocker_id: "taska".to_string(),
        };
        undepend_cmd.execute(&db).await.unwrap();

        // Verify only C -> A was removed, C -> B still exists
        assert!(!dependency_exists(&db, "taskc", "taska").await);
        assert!(dependency_exists(&db, "taskc", "taskb").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_nonexistent_does_not_update_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        // Get initial timestamp
        #[derive(Deserialize)]
        struct TimestampRow {
            updated_at: surrealdb::sql::Datetime,
        }

        let query = "SELECT updated_at FROM task:taskb";
        let mut result = db.client().query(query).await.unwrap();
        let row1: Option<TimestampRow> = result.take(0).unwrap();
        let ts1 = row1.unwrap().updated_at;

        // Wait a tiny bit to ensure timestamp would differ if updated
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

        // Try to remove non-existent dependency
        let undepend_cmd = UndependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };
        undepend_cmd.execute(&db).await.unwrap();

        // Get timestamp after operation
        let mut result = db.client().query(query).await.unwrap();
        let row2: Option<TimestampRow> = result.take(0).unwrap();
        let ts2 = row2.unwrap().updated_at;

        // Timestamp should remain unchanged since no dependency was removed
        assert_eq!(
            ts1, ts2,
            "Timestamp should not be updated when no dependency was removed"
        );

        cleanup(&temp_dir);
    }

    #[test]
    fn test_undepend_result_display_removed() {
        let result = UndependResult {
            task_id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
            existed: true,
        };

        let output = format!("{}", result);
        assert_eq!(
            output,
            "Removed dependency: taskb no longer depends on taska"
        );
    }

    #[test]
    fn test_undepend_result_display_warning() {
        let result = UndependResult {
            task_id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
            existed: false,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Warning: No dependency from taskb to taska exists");
    }

    #[test]
    fn test_undepend_command_debug() {
        let cmd = UndependCommand {
            id: "test123".to_string(),
            blocker_id: "blocker456".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("UndependCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("blocker_id: \"blocker456\""),
            "Debug output should contain UndependCommand and both id field values"
        );
    }
}
