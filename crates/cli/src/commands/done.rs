//! Done command for backwards compatibility
//!
//! Implements the `vtb done` command as an alias for workflow advance operations.
//! This maintains backwards compatibility with the traditional status-based commands.

use clap::Args;
use vertebrae_db::{Database, DbError, Status};

/// Complete a task (transition from pending_review to done)
///
/// This command is provided for backwards compatibility and operates on the task's
/// workflow assignment. It advances the task from the 'pending_review' step to the 'done' step.
#[derive(Debug, Args)]
pub struct DoneCommand {
    /// Task ID to complete (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Result of the done command execution
#[derive(Debug)]
pub struct DoneResult {
    /// The task ID that was completed
    pub id: String,
    /// Whether the task was already done
    pub already_done: bool,
    /// List of tasks that are now unblocked
    pub unblocked_tasks: Vec<(String, String)>, // (id, title)
}

impl std::fmt::Display for DoneResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Main result message
        if self.already_done {
            write!(f, "Task '{}' is already done", self.id)?;
        } else {
            write!(f, "Completed task: {}", self.id)?;
        }

        // Show unblocked tasks if any
        if !self.unblocked_tasks.is_empty() {
            writeln!(f)?;
            writeln!(f)?;
            writeln!(f, "Unblocked tasks:")?;
            for (id, title) in &self.unblocked_tasks {
                writeln!(f, "  - {} ({})", id, title)?;
            }
        }

        Ok(())
    }
}

impl DoneCommand {
    /// Execute the done command.
    ///
    /// Transitions a task from pending_review to done status, advancing it in the workflow.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The status transition is invalid (not in pending_review status)
    /// - The task has incomplete children
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<DoneResult, DbError> {
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

        // Check if already done
        if task.status == Status::Done {
            return Ok(DoneResult {
                id,
                already_done: true,
                unblocked_tasks: vec![],
            });
        }

        // Validate the status transition
        db.tasks()
            .validate_status_transition(&id, &task.status, &Status::Done)?;

        // Check for incomplete descendants (hard enforcement - error if any exist)
        let incomplete_descendants = db.graph().get_incomplete_descendants(&id).await?;

        if !incomplete_descendants.is_empty() {
            return Err(DbError::IncompleteChildren {
                task_id: id,
                children: incomplete_descendants,
            });
        }

        // Find tasks that depend on this one and will become unblocked
        let unblocked_tasks = db.graph().get_unblocked_tasks(&id).await?;

        // Mark task as done
        db.tasks().mark_done(&id).await?;

        // If task has a workflow assignment, advance the workflow step
        if task.workflow_id.is_some() {
            // Advance to step 4 (done)
            db.tasks().update_current_step(&id, 4).await?;
        }

        Ok(DoneResult {
            id,
            already_done: false,
            unblocked_tasks,
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

    /// Helper to create a child_of relationship
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
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
    async fn test_done_from_pending_review() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done failed: {:?}", result.err());

        let done_result = result.unwrap();
        assert_eq!(done_result.id, "task1");
        assert!(!done_result.already_done);
        assert!(done_result.unblocked_tasks.is_empty());

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");
    }

    #[tokio::test]
    async fn test_done_from_in_progress_fails() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        let cmd = DoneCommand {
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
                assert_eq!(to_status, "done");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");
    }

    #[tokio::test]
    async fn test_done_already_done() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "task", "done").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let done_result = result.unwrap();
        assert!(done_result.already_done);
    }

    #[tokio::test]
    async fn test_done_with_incomplete_children_fails() {
        let db = setup_test_db().await;
        create_task(&db, "parent", "Parent Task", "ticket", "pending_review").await;
        create_task(&db, "child1", "Child Task", "task", "todo").await;
        create_child_of(&db, "child1", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::IncompleteChildren { task_id, children }) => {
                assert_eq!(task_id, "parent");
                assert_eq!(children.len(), 1);
                assert_eq!(children[0].id, "child1");
            }
            Err(other) => panic!("Expected IncompleteChildren error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        let status = get_task_status(&db, "parent").await;
        assert_eq!(status, "pending_review");
    }

    #[tokio::test]
    async fn test_done_unblocks_dependent_tasks() {
        let db = setup_test_db().await;
        create_task(&db, "blocker", "Blocker Task", "task", "pending_review").await;
        create_task(&db, "dependent", "Dependent Task", "task", "backlog").await;
        create_depends_on(&db, "dependent", "blocker").await;

        let cmd = DoneCommand {
            id: "blocker".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done failed: {:?}", result.err());

        let done_result = result.unwrap();
        assert!(!done_result.unblocked_tasks.is_empty());
        assert_eq!(done_result.unblocked_tasks.len(), 1);

        let (unblocked_id, unblocked_title) = &done_result.unblocked_tasks[0];
        assert_eq!(unblocked_id, "dependent");
        assert_eq!(unblocked_title, "Dependent Task");
    }

    #[tokio::test]
    async fn test_done_nonexistent_task_fails() {
        let db = setup_test_db().await;

        let cmd = DoneCommand {
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
    async fn test_done_case_insensitive() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        let cmd = DoneCommand {
            id: "TASK1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");
    }

    #[test]
    fn test_done_result_display() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: false,
            unblocked_tasks: vec![],
        };

        let output = format!("{}", result);
        assert_eq!(output, "Completed task: task1");
    }

    #[test]
    fn test_done_result_display_already_done() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: true,
            unblocked_tasks: vec![],
        };

        let output = format!("{}", result);
        assert!(output.contains("Task 'task1' is already done"));
    }

    #[test]
    fn test_done_result_display_with_unblocked() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: false,
            unblocked_tasks: vec![("dep1".to_string(), "Dependent Task".to_string())],
        };

        let output = format!("{}", result);
        assert!(output.contains("Completed task: task1"));
        assert!(output.contains("Unblocked tasks:"));
        assert!(output.contains("dep1"));
        assert!(output.contains("Dependent Task"));
    }
}
