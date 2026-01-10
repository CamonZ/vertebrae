//! Start command for backwards compatibility
//!
//! Implements the `vtb start` command as an alias for workflow advance operations.
//! This maintains backwards compatibility with the traditional status-based commands.

use clap::Args;
use vertebrae_db::{Database, DbError, Status, TaskUpdate};

/// Start a task (transition from todo to in_progress)
///
/// This command is provided for backwards compatibility and operates on the task's
/// workflow assignment. It advances the task from the 'todo' step to the 'in_progress' step.
#[derive(Debug, Args)]
pub struct StartCommand {
    /// Task ID to start (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Result of the start command execution
#[derive(Debug)]
pub struct StartResult {
    /// The task ID that was started
    pub id: String,
    /// Whether the task was already in progress
    pub already_started: bool,
    /// List of incomplete dependencies (warnings)
    pub incomplete_deps: Vec<(String, String, String)>, // (id, title, status)
}

impl std::fmt::Display for StartResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Show warnings for incomplete deps
        if !self.incomplete_deps.is_empty() {
            writeln!(f, "Warning: Task depends on incomplete tasks:")?;
            for (id, title, status) in &self.incomplete_deps {
                writeln!(f, "  - {} ({}) [{}]", id, title, status)?;
            }
            writeln!(f)?;
        }

        // Main result message
        if self.already_started {
            write!(f, "Warning: Task '{}' is already in progress", self.id)
        } else {
            write!(f, "Started task: {}", self.id)
        }
    }
}

impl StartCommand {
    /// Execute the start command.
    ///
    /// Transitions a task from todo to in_progress status, advancing it in the workflow.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The status transition is invalid (not in todo status)
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<StartResult, DbError> {
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

        // Check if already in progress
        if task.status == Status::InProgress {
            return Ok(StartResult {
                id,
                already_started: true,
                incomplete_deps: vec![],
            });
        }

        // Validate the status transition
        db.tasks()
            .validate_status_transition(&id, &task.status, &Status::InProgress)?;

        // Check for incomplete dependencies (soft enforcement - warn only)
        let incomplete_deps = db.graph().get_incomplete_dependencies_info(&id).await?;

        // Update status to in_progress and set started_at if not already set
        let updates = TaskUpdate::new()
            .with_status(Status::InProgress)
            .set_started_at_if_null();
        db.tasks().update(&id, &updates).await?;

        // If task has a workflow assignment, advance the workflow step
        if task.workflow_id.is_some() {
            // Advance to step 2 (in_progress)
            db.tasks().update_current_step(&id, 2).await?;
        }

        Ok(StartResult {
            id,
            already_started: false,
            incomplete_deps,
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

    /// Helper to create a depends_on relationship
    async fn create_depends_on(db: &Database, dependent_id: &str, dependency_id: &str) {
        let query = format!(
            "RELATE task:{} -> depends_on -> task:{}",
            dependent_id, dependency_id
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
    async fn test_start_from_todo() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "todo").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start failed: {:?}", result.err());

        let start_result = result.unwrap();
        assert_eq!(start_result.id, "task1");
        assert!(!start_result.already_started);
        assert!(start_result.incomplete_deps.is_empty());

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");
    }

    #[tokio::test]
    async fn test_start_from_pending_review() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "pending_review").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start failed: {:?}", result.err());

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");
    }

    #[tokio::test]
    async fn test_start_from_backlog_fails() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "backlog").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition {
                from_status,
                to_status,
                ..
            }) => {
                assert_eq!(from_status, "backlog");
                assert_eq!(to_status, "in_progress");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "backlog");
    }

    #[tokio::test]
    async fn test_start_already_in_progress() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "in_progress").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let start_result = result.unwrap();
        assert!(start_result.already_started);
    }

    #[tokio::test]
    async fn test_start_with_incomplete_deps_warns() {
        let db = setup_test_db().await;
        create_task(&db, "dep1", "Dependency Task", "todo").await;
        create_task(&db, "task1", "Main Task", "todo").await;
        create_depends_on(&db, "task1", "dep1").await;

        let cmd = StartCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start should succeed with warnings");

        let start_result = result.unwrap();
        assert!(!start_result.incomplete_deps.is_empty());
        assert_eq!(start_result.incomplete_deps.len(), 1);

        let (dep_id, _, _) = &start_result.incomplete_deps[0];
        assert_eq!(dep_id, "dep1");

        // Task should still be started
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");
    }

    #[tokio::test]
    async fn test_start_nonexistent_task_fails() {
        let db = setup_test_db().await;

        let cmd = StartCommand {
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
    async fn test_start_case_insensitive() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "todo").await;

        let cmd = StartCommand {
            id: "TASK1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");
    }

    #[test]
    fn test_start_result_display() {
        let result = StartResult {
            id: "task1".to_string(),
            already_started: false,
            incomplete_deps: vec![],
        };

        let output = format!("{}", result);
        assert_eq!(output, "Started task: task1");
    }

    #[test]
    fn test_start_result_display_already_started() {
        let result = StartResult {
            id: "task1".to_string(),
            already_started: true,
            incomplete_deps: vec![],
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning: Task 'task1' is already in progress"));
    }

    #[test]
    fn test_start_result_display_with_deps() {
        let result = StartResult {
            id: "task1".to_string(),
            already_started: false,
            incomplete_deps: vec![(
                "dep1".to_string(),
                "Dependency".to_string(),
                "todo".to_string(),
            )],
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning: Task depends on incomplete tasks"));
        assert!(output.contains("dep1"));
        assert!(output.contains("Dependency"));
        assert!(output.contains("todo"));
        assert!(output.contains("Started task: task1"));
    }
}
