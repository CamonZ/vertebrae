//! Step-done command for marking steps as complete
//!
//! Implements the `vtb step-done` command to mark individual steps within a task as done.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError};

/// Mark a step as done within a task
#[derive(Debug, Args)]
pub struct StepDoneCommand {
    /// Task ID containing the step (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Step index (1-based) to mark as done
    #[arg(required = true)]
    pub index: usize,
}

/// Result of executing the step-done command
#[derive(Debug)]
pub struct StepDoneResult {
    /// The task ID
    pub task_id: String,
    /// The step index that was marked done
    pub step_index: usize,
    /// The content of the step that was marked done
    pub step_content: String,
}

impl std::fmt::Display for StepDoneResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Marked step {} as done in {}: {}",
            self.step_index, self.task_id, self.step_content
        )
    }
}

/// Section row from database
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct SectionRow {
    #[serde(rename = "type", default)]
    section_type: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    order: Option<u32>,
    #[serde(default)]
    done: Option<bool>,
    #[serde(default)]
    done_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl StepDoneCommand {
    /// Execute the step-done command.
    ///
    /// Marks the specified step as done within the task.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task does not exist
    /// - The step index is out of bounds
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<StepDoneResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate index is positive
        if self.index == 0 {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: "Step index must be 1 or greater".to_string(),
            });
        }

        // Fetch current sections
        let sections = self.fetch_sections(db, &id).await?;

        // Filter to only step sections and sort by order
        let mut steps: Vec<(usize, SectionRow)> = sections
            .into_iter()
            .enumerate()
            .filter(|(_, s)| s.section_type.as_deref() == Some("step"))
            .collect();
        steps.sort_by_key(|(_, s)| s.order.unwrap_or(u32::MAX));

        // Find the step by index (1-based)
        let step_idx = self.index - 1;
        if step_idx >= steps.len() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!(
                    "Step {} not found. Task has {} step(s).",
                    self.index,
                    steps.len()
                ),
            });
        }

        let (original_idx, step) = &steps[step_idx];
        let step_content = step.content.clone().unwrap_or_default();

        // Update the step in place by rebuilding sections array
        self.update_step_done(db, &id, *original_idx).await?;

        // Update the task's updated_at timestamp
        self.update_timestamp(db, &id).await?;

        Ok(StepDoneResult {
            task_id: id,
            step_index: self.index,
            step_content,
        })
    }

    /// Fetch sections from a task.
    async fn fetch_sections(&self, db: &Database, id: &str) -> Result<Vec<SectionRow>, DbError> {
        #[derive(Debug, Deserialize)]
        struct TaskRow {
            #[serde(default)]
            sections: Vec<SectionRow>,
        }

        let query = format!("SELECT sections FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskRow> = result.take(0)?;

        match task {
            Some(t) => Ok(t.sections),
            None => Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("Task '{}' not found", self.id),
            }),
        }
    }

    /// Update a specific step's done field to true and set done_at timestamp.
    async fn update_step_done(
        &self,
        db: &Database,
        id: &str,
        section_index: usize,
    ) -> Result<(), DbError> {
        // Use SurrealDB array update syntax to set both done and done_at
        let query = format!(
            "UPDATE task:{} SET sections[{}].done = true, sections[{}].done_at = time::now()",
            id, section_index, section_index
        );
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
            "vtb-step-done-test-{}-{:?}-{}",
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

    /// Helper to create a task with steps
    async fn create_task_with_steps(db: &Database, id: &str, steps: &[&str]) {
        let sections: Vec<String> = steps
            .iter()
            .enumerate()
            .map(|(i, content)| {
                format!(
                    r#"{{ type: "step", content: "{}", order: {} }}"#,
                    content,
                    i + 1
                )
            })
            .collect();

        let query = format!(
            r#"CREATE task:{} SET
                title = "Test Task",
                level = "task",
                status = "todo",
                sections = [{}]"#,
            id,
            sections.join(", ")
        );

        db.client().query(&query).await.unwrap();
    }

    /// Helper struct for section status
    #[derive(Debug, Clone, Deserialize)]
    struct SectionStatus {
        #[serde(default)]
        done: Option<bool>,
        #[serde(default)]
        done_at: Option<chrono::DateTime<chrono::Utc>>,
    }

    /// Helper to get step done status
    async fn get_step_done(db: &Database, id: &str, step_index: usize) -> Option<bool> {
        get_step_status(db, id, step_index)
            .await
            .and_then(|s| s.done)
    }

    /// Helper to get full step status including done_at
    async fn get_step_status(db: &Database, id: &str, step_index: usize) -> Option<SectionStatus> {
        #[derive(Debug, Deserialize)]
        struct TaskRow {
            #[serde(default)]
            sections: Vec<SectionStatus>,
        }

        let query = format!("SELECT sections FROM task:{}", id);
        let mut result = db.client().query(&query).await.ok()?;
        let task: Option<TaskRow> = result.take(0).ok()?;
        task.and_then(|t| t.sections.get(step_index).cloned())
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_step_done_marks_step() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_steps(&db, "abc123", &["First step", "Second step"]).await;

        let cmd = StepDoneCommand {
            id: "abc123".to_string(),
            index: 1,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "step-done failed: {:?}", result.err());

        let result = result.unwrap();
        assert_eq!(result.task_id, "abc123");
        assert_eq!(result.step_index, 1);
        assert_eq!(result.step_content, "First step");

        // Verify step is marked as done
        let done = get_step_done(&db, "abc123", 0).await;
        assert_eq!(done, Some(true));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_step_done_sets_done_at_timestamp() {
        use chrono::Utc;

        let (db, temp_dir) = setup_test_db().await;
        let before = Utc::now();

        create_task_with_steps(&db, "abc123", &["Step with timestamp"]).await;

        let cmd = StepDoneCommand {
            id: "abc123".to_string(),
            index: 1,
        };

        let result = cmd.execute(&db).await;
        let after = Utc::now();
        assert!(result.is_ok(), "step-done failed: {:?}", result.err());

        // Verify done_at is set
        let status = get_step_status(&db, "abc123", 0).await;
        assert!(status.is_some(), "Section status should be present");
        let status = status.unwrap();

        assert_eq!(status.done, Some(true), "done should be true");
        assert!(
            status.done_at.is_some(),
            "done_at should be set when step is marked done"
        );

        let done_at = status.done_at.unwrap();
        assert!(
            done_at >= before && done_at <= after,
            "done_at ({}) should be within test execution time (before: {}, after: {})",
            done_at,
            before,
            after
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_step_done_second_step() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_steps(&db, "abc123", &["First step", "Second step"]).await;

        let cmd = StepDoneCommand {
            id: "abc123".to_string(),
            index: 2,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let result = result.unwrap();
        assert_eq!(result.step_index, 2);
        assert_eq!(result.step_content, "Second step");

        // Verify correct step is marked as done
        let done_first = get_step_done(&db, "abc123", 0).await;
        let done_second = get_step_done(&db, "abc123", 1).await;
        assert!(done_first.is_none() || done_first == Some(false));
        assert_eq!(done_second, Some(true));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_step_done_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = StepDoneCommand {
            id: "nonexistent".to_string(),
            index: 1,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(reason.contains("not found"));
            }
            _ => panic!("Expected InvalidPath error"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_step_done_invalid_index_zero() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_steps(&db, "abc123", &["First step"]).await;

        let cmd = StepDoneCommand {
            id: "abc123".to_string(),
            index: 0,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(reason.contains("1 or greater"));
            }
            _ => panic!("Expected InvalidPath error"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_step_done_index_out_of_bounds() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_steps(&db, "abc123", &["First step"]).await;

        let cmd = StepDoneCommand {
            id: "abc123".to_string(),
            index: 5,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(reason.contains("Step 5 not found"));
                assert!(reason.contains("1 step(s)"));
            }
            _ => panic!("Expected InvalidPath error"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_step_done_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_steps(&db, "abc123", &["First step"]).await;

        let cmd = StepDoneCommand {
            id: "ABC123".to_string(),
            index: 1,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup failed");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_step_done_result_display() {
        let result = StepDoneResult {
            task_id: "abc123".to_string(),
            step_index: 1,
            step_content: "First step".to_string(),
        };

        let display = format!("{}", result);
        assert!(display.contains("Marked step 1 as done"));
        assert!(display.contains("abc123"));
        assert!(display.contains("First step"));
    }

    #[test]
    fn test_step_done_command_debug() {
        let cmd = StepDoneCommand {
            id: "abc123".to_string(),
            index: 1,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("StepDoneCommand"));
        assert!(debug_str.contains("abc123"));
    }

    #[test]
    fn test_step_done_result_debug() {
        let result = StepDoneResult {
            task_id: "abc123".to_string(),
            step_index: 1,
            step_content: "Test step".to_string(),
        };
        let debug_str = format!("{:?}", result);
        assert!(debug_str.contains("StepDoneResult"));
        assert!(debug_str.contains("abc123"));
    }
}
