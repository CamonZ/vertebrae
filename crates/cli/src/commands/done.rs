//! Done command for transitioning tasks to done status
//!
//! Implements the `vtb done` command to mark a task as complete.
//! Enforces parent completion validation - tasks with incomplete children cannot be marked done.
//! Reports tasks that were blocked by this one and are now unblocked.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError, Status};

/// Mark a task as complete (transition to done)
#[derive(Debug, Args)]
pub struct DoneCommand {
    /// Task ID to complete (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Result from querying a task's status
#[derive(Debug, Deserialize)]
struct TaskStatusRow {
    status: String,
}

/// Unblocked task info (tasks that depended on the completed task)
#[derive(Debug, Deserialize)]
struct UnblockedTask {
    id: surrealdb::sql::Thing,
    title: String,
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
    /// Transitions a task to `done` status from any status.
    /// Enforces parent completion validation - returns an error if the task has
    /// incomplete descendants (children, grandchildren, etc.).
    /// Reports tasks that were blocked by this one and are now unblocked.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The task has incomplete descendants (IncompleteChildren error)
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<DoneResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = self.fetch_task(db, &id).await?;

        // Parse the current status
        let current_status = parse_status(&task.status);

        // Handle already done case
        if current_status == Status::Done {
            return Ok(DoneResult {
                id,
                already_done: true,
                unblocked_tasks: vec![],
            });
        }

        // Check for incomplete descendants (hard enforcement - error if any exist)
        let incomplete_descendants = db.graph().get_incomplete_descendants(&id).await?;

        if !incomplete_descendants.is_empty() {
            return Err(DbError::IncompleteChildren {
                task_id: id,
                children: incomplete_descendants,
            });
        }

        // Find tasks that depend on this one and will become unblocked
        let unblocked_tasks = self.find_unblocked_tasks(db, &id).await?;

        // Update status to done and timestamp
        self.update_status(db, &id).await?;

        Ok(DoneResult {
            id,
            already_done: false,
            unblocked_tasks: unblocked_tasks
                .into_iter()
                .map(|task| (task.id.id.to_string(), task.title))
                .collect(),
        })
    }

    /// Fetch the task by ID and return its status.
    async fn fetch_task(&self, db: &Database, id: &str) -> Result<TaskStatusRow, DbError> {
        db.tasks()
            .get(id)
            .await?
            .ok_or_else(|| DbError::NotFound {
                task_id: self.id.clone(),
            })
            .map(|task| TaskStatusRow {
                status: task.status.as_str().to_string(),
            })
    }

    /// Find tasks that depend on the completed task and will become unblocked.
    ///
    /// A task becomes unblocked when ALL its dependencies are done.
    async fn find_unblocked_tasks(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<Vec<UnblockedTask>, DbError> {
        // Use the graph repository to find unblocked tasks
        let unblocked_tuples = db.graph().get_unblocked_tasks(id).await?;

        // Convert from (String, String) tuples to UnblockedTask structs
        let unblocked = unblocked_tuples
            .into_iter()
            .map(|(task_id, title)| {
                let thing = surrealdb::sql::thing(&format!("task:{}", task_id))
                    .expect("Valid task thing format");
                UnblockedTask { id: thing, title }
            })
            .collect();

        Ok(unblocked)
    }

    /// Update the task status to done and refresh updated_at and completed_at.
    async fn update_status(&self, db: &Database, id: &str) -> Result<(), DbError> {
        // Use TaskRepository to mark the task as done
        db.tasks().mark_done(id).await?;

        // Verify the update actually persisted
        let task_status: Option<TaskStatusRow> =
            db.tasks().get(id).await?.map(|task| TaskStatusRow {
                status: task.status.as_str().to_string(),
            });

        match task_status {
            Some(row) if row.status == "done" => Ok(()),
            Some(row) => Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(id),
                reason: format!(
                    "Failed to update task '{}': status is '{}', expected 'done'",
                    id, row.status
                ),
            }),
            None => Err(DbError::NotFound {
                task_id: id.to_string(),
            }),
        }
    }
}

/// Parse a status string into Status enum
fn parse_status(s: &str) -> Status {
    Status::parse(s).unwrap_or(Status::Todo)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-done-test-{}-{:?}-{}",
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

    /// Helper to create a child_of relationship (child -> parent)
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a depends_on relationship (dependent -> dependency)
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

    /// Helper to check if updated_at was set
    async fn has_updated_at(db: &Database, id: &str) -> bool {
        db.tasks()
            .get(id)
            .await
            .unwrap()
            .map(|task| task.updated_at.is_some())
            .unwrap_or(false)
    }

    /// Helper to get completed_at timestamp
    async fn get_completed_at(db: &Database, id: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        db.tasks()
            .get(id)
            .await
            .unwrap()
            .and_then(|task| task.completed_at)
    }

    /// Helper to get started_at timestamp
    async fn get_started_at(db: &Database, id: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        db.tasks()
            .get(id)
            .await
            .unwrap()
            .and_then(|task| task.started_at)
    }

    /// Helper to set started_at timestamp for a task
    async fn set_started_at(db: &Database, id: &str) {
        let query = format!("UPDATE task:{} SET started_at = time::now()", id);
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn test_parse_status() {
        assert_eq!(parse_status("backlog"), Status::Backlog);
        assert_eq!(parse_status("todo"), Status::Todo);
        assert_eq!(parse_status("in_progress"), Status::InProgress);
        assert_eq!(parse_status("pending_review"), Status::PendingReview);
        assert_eq!(parse_status("done"), Status::Done);
        assert_eq!(parse_status("rejected"), Status::Rejected);
        // Unknown defaults to Todo
        assert_eq!(parse_status("unknown"), Status::Todo);
    }

    #[tokio::test]
    async fn test_done_pending_review_task() {
        let (db, temp_dir) = setup_test_db().await;

        // Done can only be reached from pending_review
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

        // Verify status changed
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_todo_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        // todo -> done is not a valid transition
        create_task(&db, "task1", "Todo Task", "task", "todo").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition { message, .. }) => {
                assert!(
                    message.contains("todo"),
                    "Error should mention todo status: {}",
                    message
                );
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        // Status should remain todo
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "todo");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_in_progress_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        // in_progress -> done is not a valid transition (must go through pending_review)
        create_task(&db, "task1", "In Progress Task", "task", "in_progress").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition { message, .. }) => {
                assert!(
                    message.contains("in_progress"),
                    "Error should mention in_progress status: {}",
                    message
                );
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
    async fn test_done_backlog_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        // backlog -> done is not a valid transition
        create_task(&db, "task1", "Backlog Task", "task", "backlog").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition { message, .. }) => {
                assert!(
                    message.contains("backlog"),
                    "Error should mention backlog status: {}",
                    message
                );
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        // Status should remain backlog
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "backlog");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_already_done() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Done Task", "task", "done").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed with info message");

        let done_result = result.unwrap();
        assert!(done_result.already_done);

        // Status should remain done
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = DoneCommand {
            id: "nonexistent".to_string(),
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
    async fn test_done_with_incomplete_children_fails() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task (in pending_review - only valid source for done)
        create_task(&db, "parent", "Parent Task", "ticket", "pending_review").await;
        // Create child task (not done)
        create_task(&db, "child1", "Child Task 1", "task", "todo").await;
        // Create child relationship
        create_child_of(&db, "child1", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;

        // Should fail with IncompleteChildren error
        match result {
            Err(DbError::IncompleteChildren { task_id, children }) => {
                assert_eq!(task_id, "parent");
                assert_eq!(children.len(), 1);
                assert_eq!(children[0].id, "child1");
                assert_eq!(children[0].status, "todo");
            }
            Err(other) => panic!("Expected IncompleteChildren error, got {:?}", other),
            Ok(_) => panic!("Expected error, but got success"),
        }

        // Task should NOT be marked done
        let status = get_task_status(&db, "parent").await;
        assert_eq!(status, "pending_review");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_with_complete_children_succeeds() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task (in pending_review - only valid source for done)
        create_task(&db, "parent", "Parent Task", "ticket", "pending_review").await;
        // Create child task (done)
        create_task(&db, "child1", "Child Task 1", "task", "done").await;
        // Create child relationship
        create_child_of(&db, "child1", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Should succeed when all children are done: {:?}",
            result.err()
        );

        let done_result = result.unwrap();
        assert!(!done_result.already_done);

        // Parent should be marked done
        let status = get_task_status(&db, "parent").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_with_multiple_incomplete_children_fails() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task (in pending_review)
        create_task(&db, "parent", "Parent Task", "epic", "pending_review").await;
        // Create multiple child tasks
        create_task(&db, "child1", "Child 1", "ticket", "todo").await;
        create_task(&db, "child2", "Child 2", "ticket", "backlog").await;
        create_task(&db, "child3", "Child 3", "ticket", "done").await;
        // Create child relationships
        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;
        create_child_of(&db, "child3", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;

        // Should fail with IncompleteChildren error
        match result {
            Err(DbError::IncompleteChildren { task_id, children }) => {
                assert_eq!(task_id, "parent");
                // Only child1 and child2 are incomplete (child3 is done)
                assert_eq!(children.len(), 2);

                // Verify specific incomplete children
                use std::collections::HashSet;
                let incomplete_ids: HashSet<_> = children.iter().map(|c| c.id.as_str()).collect();
                assert!(
                    incomplete_ids.contains("child1"),
                    "Should contain child1 (status=todo)"
                );
                assert!(
                    incomplete_ids.contains("child2"),
                    "Should contain child2 (status=backlog)"
                );
                assert!(
                    !incomplete_ids.contains("child3"),
                    "Should not contain child3 (status=done)"
                );
            }
            Err(other) => panic!("Expected IncompleteChildren error, got {:?}", other),
            Ok(_) => panic!("Expected error, but got success"),
        }

        // Task should NOT be marked done
        let status = get_task_status(&db, "parent").await;
        assert_eq!(status, "pending_review");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_with_nested_incomplete_descendants_fails() {
        let (db, temp_dir) = setup_test_db().await;

        // Create epic -> ticket -> task (nested hierarchy)
        create_task(&db, "epic", "Epic", "epic", "pending_review").await;
        create_task(&db, "ticket", "Ticket", "ticket", "done").await;
        create_task(&db, "task1", "Task 1", "task", "todo").await; // incomplete grandchild

        create_child_of(&db, "ticket", "epic").await;
        create_child_of(&db, "task1", "ticket").await;

        let cmd = DoneCommand {
            id: "epic".to_string(),
        };

        let result = cmd.execute(&db).await;

        // Should fail because task1 (grandchild) is incomplete
        match result {
            Err(DbError::IncompleteChildren { task_id, children }) => {
                assert_eq!(task_id, "epic");
                // task1 should be in the incomplete list (recursive check)
                let incomplete_ids: Vec<_> = children.iter().map(|c| c.id.as_str()).collect();
                assert!(
                    incomplete_ids.contains(&"task1"),
                    "Should contain nested incomplete grandchild task1"
                );
            }
            Err(other) => panic!("Expected IncompleteChildren error, got {:?}", other),
            Ok(_) => panic!("Expected error, but got success"),
        }

        // Epic should NOT be marked done
        let status = get_task_status(&db, "epic").await;
        assert_eq!(status, "pending_review");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_with_all_nested_descendants_complete_succeeds() {
        let (db, temp_dir) = setup_test_db().await;

        // Create epic -> ticket -> task (nested hierarchy, all complete)
        create_task(&db, "epic", "Epic", "epic", "pending_review").await;
        create_task(&db, "ticket", "Ticket", "ticket", "done").await;
        create_task(&db, "task1", "Task 1", "task", "done").await;

        create_child_of(&db, "ticket", "epic").await;
        create_child_of(&db, "task1", "ticket").await;

        let cmd = DoneCommand {
            id: "epic".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Should succeed when all descendants are done: {:?}",
            result.err()
        );

        // Epic should be marked done
        let status = get_task_status(&db, "epic").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_unblocks_dependent_task() {
        let (db, temp_dir) = setup_test_db().await;

        // Create blocker task (in pending_review - only valid source for done)
        create_task(&db, "blocker", "Blocker Task", "task", "pending_review").await;
        // Create dependent task
        create_task(&db, "dependent", "Dependent Task", "task", "backlog").await;
        // Create dependency relationship
        create_depends_on(&db, "dependent", "blocker").await;

        let cmd = DoneCommand {
            id: "blocker".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        let done_result = result.unwrap();
        assert!(!done_result.unblocked_tasks.is_empty());
        assert_eq!(done_result.unblocked_tasks.len(), 1);

        // Verify both fields of the unblocked task tuple (id, title)
        let (unblocked_id, unblocked_title) = &done_result.unblocked_tasks[0];
        assert_eq!(unblocked_id, "dependent");
        assert_eq!(unblocked_title, "Dependent Task");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_does_not_unblock_with_other_deps() {
        let (db, temp_dir) = setup_test_db().await;

        // Create two blocker tasks
        create_task(&db, "blocker1", "Blocker 1", "task", "pending_review").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "todo").await;
        // Create dependent task with two dependencies
        create_task(&db, "dependent", "Dependent Task", "task", "backlog").await;
        create_depends_on(&db, "dependent", "blocker1").await;
        create_depends_on(&db, "dependent", "blocker2").await;

        // Complete blocker1 - dependent should NOT be unblocked (blocker2 still incomplete)
        let cmd = DoneCommand {
            id: "blocker1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        let done_result = result.unwrap();
        // Dependent should NOT be in unblocked list since blocker2 is still incomplete
        assert!(done_result.unblocked_tasks.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_unblocks_when_all_deps_done() {
        let (db, temp_dir) = setup_test_db().await;

        // Create two blocker tasks, one already done
        create_task(&db, "blocker1", "Blocker 1", "task", "done").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "pending_review").await;
        // Create dependent task with two dependencies
        create_task(&db, "dependent", "Dependent Task", "task", "backlog").await;
        create_depends_on(&db, "dependent", "blocker1").await;
        create_depends_on(&db, "dependent", "blocker2").await;

        // Complete blocker2 - dependent SHOULD be unblocked (both deps now done)
        let cmd = DoneCommand {
            id: "blocker2".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        let done_result = result.unwrap();
        assert_eq!(done_result.unblocked_tasks.len(), 1);
        assert_eq!(done_result.unblocked_tasks[0].0, "dependent");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_unblocks_multiple_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        // Create blocker task (in pending_review - only valid source for done)
        create_task(&db, "blocker", "Blocker Task", "task", "pending_review").await;
        // Create multiple dependent tasks
        create_task(&db, "dep1", "Dependent 1", "task", "backlog").await;
        create_task(&db, "dep2", "Dependent 2", "task", "todo").await;
        create_depends_on(&db, "dep1", "blocker").await;
        create_depends_on(&db, "dep2", "blocker").await;

        let cmd = DoneCommand {
            id: "blocker".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        let done_result = result.unwrap();
        assert_eq!(done_result.unblocked_tasks.len(), 2);

        // Verify all fields of each unblocked task tuple (id, title)
        use std::collections::HashMap;
        let unblocked_map: HashMap<_, _> = done_result
            .unblocked_tasks
            .iter()
            .map(|(id, title)| (id.as_str(), title.as_str()))
            .collect();

        assert!(
            unblocked_map.contains_key("dep1"),
            "Should contain dep1 as unblocked"
        );
        assert_eq!(unblocked_map.get("dep1"), Some(&"Dependent 1"));

        assert!(
            unblocked_map.contains_key("dep2"),
            "Should contain dep2 as unblocked"
        );
        assert_eq!(unblocked_map.get("dep2"), Some(&"Dependent 2"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        // Use pending_review - only valid source for done
        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        // Verify updated_at was set
        assert!(has_updated_at(&db, "task1").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        // Use pending_review - only valid source for done
        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        let cmd = DoneCommand {
            id: "TASK1".to_string(), // Uppercase
        };

        let result = cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Case-insensitive lookup should work: {:?}",
            result.err()
        );

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_done_result_display_normal() {
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
        assert!(output.contains("already done"));
    }

    #[test]
    fn test_done_result_display_with_unblocked() {
        let result = DoneResult {
            id: "task1".to_string(),
            already_done: false,
            unblocked_tasks: vec![
                ("dep1".to_string(), "Dependent 1".to_string()),
                ("dep2".to_string(), "Dependent 2".to_string()),
            ],
        };

        let output = format!("{}", result);
        assert!(output.contains("Completed task: task1"));
        assert!(output.contains("Unblocked tasks:"));
        assert!(output.contains("dep1"));
        assert!(output.contains("Dependent 1"));
        assert!(output.contains("dep2"));
        assert!(output.contains("Dependent 2"));
    }

    #[test]
    fn test_done_command_debug() {
        let cmd = DoneCommand {
            id: "test123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("DoneCommand") && debug_str.contains("id: \"test123\""),
            "Debug output should contain DoneCommand and id field value"
        );
    }

    #[tokio::test]
    async fn test_done_sets_completed_at() {
        let (db, temp_dir) = setup_test_db().await;

        // Use pending_review - only valid source for done
        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        // Record time before execution
        let before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        // Record time after execution
        let after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Verify completed_at was set
        let completed_at = get_completed_at(&db, "task1").await;
        assert!(
            completed_at.is_some(),
            "completed_at should be set after vtb done"
        );

        // Verify completed_at is within 1 second of command execution
        let completed_timestamp = completed_at.unwrap().timestamp() as u64;
        assert!(
            completed_timestamp >= before && completed_timestamp <= after + 1,
            "completed_at ({}) should be within execution window ({} - {})",
            completed_timestamp,
            before,
            after + 1
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_already_done_does_not_update_completed_at() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task that's already done with a completed_at timestamp
        let query = r#"CREATE task:task1 SET
            title = "Already Done Task",
            level = "task",
            status = "done",
            tags = [],
            sections = [],
            refs = [],
            completed_at = d'2025-01-01T00:00:00Z'"#;
        db.client().query(query).await.unwrap();

        // Get the original completed_at
        let original_completed_at = get_completed_at(&db, "task1").await;
        assert!(
            original_completed_at.is_some(),
            "Task should have completed_at set"
        );

        // Try to mark the task as done again
        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert!(
            result.unwrap().already_done,
            "Task should be reported as already done"
        );

        // Verify completed_at was NOT updated
        let new_completed_at = get_completed_at(&db, "task1").await;
        assert_eq!(
            original_completed_at, new_completed_at,
            "completed_at should not be updated when task is already done"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_with_incomplete_children_does_not_set_completed_at() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task (in pending_review - only valid source for done)
        create_task(&db, "parent", "Parent Task", "ticket", "pending_review").await;
        // Create incomplete child task
        create_task(&db, "child1", "Child Task", "task", "todo").await;
        create_child_of(&db, "child1", "parent").await;

        let cmd = DoneCommand {
            id: "parent".to_string(),
        };

        let result = cmd.execute(&db).await;

        // Should fail with IncompleteChildren error
        assert!(
            matches!(result, Err(DbError::IncompleteChildren { .. })),
            "Should fail with IncompleteChildren error"
        );

        // completed_at should NOT be set (hard enforcement - task not completed)
        let completed_at = get_completed_at(&db, "parent").await;
        assert!(
            completed_at.is_none(),
            "completed_at should NOT be set when task has incomplete children"
        );

        // Status should remain unchanged
        let status = get_task_status(&db, "parent").await;
        assert_eq!(
            status, "pending_review",
            "Status should remain pending_review"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_completed_at_after_started_at() {
        let (db, temp_dir) = setup_test_db().await;

        // Use pending_review - only valid source for done
        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        // Set started_at before marking done
        set_started_at(&db, "task1").await;

        // Small delay to ensure time difference
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        let started_at = get_started_at(&db, "task1").await;
        let completed_at = get_completed_at(&db, "task1").await;

        assert!(started_at.is_some(), "started_at should be set");
        assert!(completed_at.is_some(), "completed_at should be set");

        let started_timestamp = started_at.unwrap().timestamp();
        let completed_timestamp = completed_at.unwrap().timestamp();

        assert!(
            completed_timestamp >= started_timestamp,
            "completed_at ({}) should be >= started_at ({})",
            completed_timestamp,
            started_timestamp
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_done_completed_at_persists_in_database() {
        let (db, temp_dir) = setup_test_db().await;

        // Use pending_review - only valid source for done
        create_task(&db, "task1", "Persist Test", "task", "pending_review").await;

        let cmd = DoneCommand {
            id: "task1".to_string(),
        };
        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Done should succeed: {:?}", result.err());

        // Verify completed_at is persisted in database (query it fresh)
        let completed_at = get_completed_at(&db, "task1").await;
        assert!(
            completed_at.is_some(),
            "completed_at should persist in database"
        );

        // Verify status is persisted
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done", "status should persist in database");

        // Verify the value survives multiple queries (testing persistence)
        let completed_at_again = get_completed_at(&db, "task1").await;
        assert_eq!(
            completed_at, completed_at_again,
            "completed_at should remain consistent across queries"
        );

        cleanup(&temp_dir);
    }
}
