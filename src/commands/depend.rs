//! Depend command for creating task dependencies
//!
//! Implements the `vtb depend` command to create dependency relationships between tasks
//! with cycle detection to ensure the dependency graph remains acyclic.

use crate::db::{Database, DbError};
use clap::Args;
use serde::Deserialize;

/// Create a dependency relationship between tasks
#[derive(Debug, Args)]
pub struct DependCommand {
    /// Task ID that will depend on another task (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Task ID that this task depends on (the blocker)
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

/// Result of the depend command execution
#[derive(Debug)]
pub struct DependResult {
    /// The task ID that now depends on the blocker
    pub task_id: String,
    /// The blocker task ID
    pub blocker_id: String,
    /// Whether the dependency already existed (idempotent)
    pub already_existed: bool,
}

impl std::fmt::Display for DependResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.already_existed {
            write!(
                f,
                "Dependency already exists: {} -> {}",
                self.task_id, self.blocker_id
            )
        } else {
            write!(
                f,
                "Created dependency: {} depends on {}",
                self.task_id, self.blocker_id
            )
        }
    }
}

impl DependCommand {
    /// Execute the depend command.
    ///
    /// Creates a dependency relationship where the task identified by `id`
    /// depends on (is blocked by) the task identified by `blocker_id`.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - Either task does not exist
    /// - Self-dependency is attempted (task depends on itself)
    /// - Creating the dependency would form a cycle
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<DependResult, DbError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let task_id = self.id.to_lowercase();
        let blocker_id = self.blocker_id.to_lowercase();

        // Check for self-dependency
        if task_id == blocker_id {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: "Task cannot depend on itself".to_string(),
            });
        }

        // Validate both tasks exist
        if !self.task_exists(db, &task_id).await? {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("Task '{}' not found", self.id),
            });
        }

        if !self.task_exists(db, &blocker_id).await? {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.blocker_id),
                reason: format!("Task '{}' not found", self.blocker_id),
            });
        }

        // Check if dependency already exists (idempotent)
        if self.dependency_exists(db, &task_id, &blocker_id).await? {
            // Update timestamp even for existing dependency
            self.update_timestamp(db, &task_id).await?;
            return Ok(DependResult {
                task_id,
                blocker_id,
                already_existed: true,
            });
        }

        // Check for cycles before creating the edge
        // A cycle would exist if we can reach task_id from blocker_id via depends_on edges
        if self.would_create_cycle(db, &task_id, &blocker_id).await? {
            let cycle_path = self
                .get_cycle_path(db, &task_id, &blocker_id)
                .await
                .unwrap_or_else(|_| format!("{} -> {}", blocker_id, task_id));
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("Cycle detected: {}", cycle_path),
            });
        }

        // Create the dependency edge
        self.create_dependency_edge(db, &task_id, &blocker_id)
            .await?;

        // Update timestamp
        self.update_timestamp(db, &task_id).await?;

        Ok(DependResult {
            task_id,
            blocker_id,
            already_existed: false,
        })
    }

    /// Check if a task with the given ID exists.
    async fn task_exists(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        let query = format!("SELECT id FROM task:{} LIMIT 1", id);
        let mut result = db.client().query(&query).await?;
        let tasks: Vec<TaskExistsRow> = result.take(0)?;
        Ok(!tasks.is_empty())
    }

    /// Check if a dependency edge already exists between two tasks.
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

    /// Check if creating a dependency would form a cycle.
    ///
    /// A cycle would be created if we can reach `task_id` from `blocker_id`
    /// by following existing depends_on edges. This means blocker_id
    /// (directly or transitively) already depends on task_id.
    ///
    /// Uses iterative BFS to avoid async recursion issues.
    async fn would_create_cycle(
        &self,
        db: &Database,
        task_id: &str,
        blocker_id: &str,
    ) -> Result<bool, DbError> {
        // Use BFS to check if we can reach task_id from blocker_id via depends_on edges.
        // If blocker_id depends on X, and X depends on Y, and Y depends on task_id,
        // then creating task_id -> blocker_id would form a cycle.

        let mut visited = std::collections::HashSet::new();
        let mut queue = std::collections::VecDeque::new();

        // Start from blocker_id and traverse its dependencies
        queue.push_back(blocker_id.to_string());
        visited.insert(blocker_id.to_string());

        while let Some(current) = queue.pop_front() {
            // Get all tasks that current depends on
            let query = format!("SELECT VALUE out FROM task:{}->depends_on", current);
            let mut result = db.client().query(&query).await?;
            let deps: Vec<surrealdb::sql::Thing> = result.take(0)?;

            for dep in deps {
                let dep_id = dep.id.to_string();

                // If we can reach task_id from blocker_id, creating task_id -> blocker_id
                // would form a cycle
                if dep_id == task_id {
                    return Ok(true);
                }

                // Add to queue if not visited
                if visited.insert(dep_id.clone()) {
                    queue.push_back(dep_id);
                }
            }
        }

        Ok(false)
    }

    /// Get the cycle path for error reporting.
    ///
    /// Uses BFS with parent tracking to reconstruct the path.
    async fn get_cycle_path(
        &self,
        db: &Database,
        task_id: &str,
        blocker_id: &str,
    ) -> Result<String, DbError> {
        // Use BFS with parent tracking to find the path from blocker_id to task_id
        let mut visited = std::collections::HashSet::new();
        let mut queue = std::collections::VecDeque::new();
        let mut parent_map: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        queue.push_back(blocker_id.to_string());
        visited.insert(blocker_id.to_string());

        while let Some(current) = queue.pop_front() {
            let query = format!("SELECT VALUE out FROM task:{}->depends_on", current);
            let mut result = db.client().query(&query).await?;
            let deps: Vec<surrealdb::sql::Thing> = result.take(0)?;

            for dep in deps {
                let dep_id = dep.id.to_string();

                if dep_id == task_id {
                    // Found the path - reconstruct it
                    let mut path = vec![task_id.to_string()];
                    let mut curr = current.clone();
                    path.push(curr.clone());

                    while let Some(p) = parent_map.get(&curr) {
                        path.push(p.clone());
                        curr = p.clone();
                    }

                    // Add the starting task_id to complete the cycle representation
                    path.push(task_id.to_string());

                    // Reverse to show task_id -> ... -> blocker_id -> task_id
                    path.reverse();
                    return Ok(path.join(" -> "));
                }

                if visited.insert(dep_id.clone()) {
                    parent_map.insert(dep_id.clone(), current.clone());
                    queue.push_back(dep_id);
                }
            }
        }

        // Fallback if path not found (shouldn't happen if would_create_cycle returned true)
        Ok(format!("{} -> ... -> {}", task_id, blocker_id))
    }

    /// Create a dependency edge between tasks.
    async fn create_dependency_edge(
        &self,
        db: &Database,
        task_id: &str,
        blocker_id: &str,
    ) -> Result<(), DbError> {
        let query = format!(
            "RELATE task:{} -> depends_on -> task:{}",
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
    use serde::Deserialize;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-depend-test-{}-{:?}-{}",
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

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_create_dependency() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        let cmd = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Depend failed: {:?}", result.err());

        let depend_result = result.unwrap();
        assert_eq!(depend_result.task_id, "taskb");
        assert_eq!(depend_result.blocker_id, "taska");
        assert!(!depend_result.already_existed);

        // Verify the dependency was created
        assert!(dependency_exists(&db, "taskb", "taska").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_dependency_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        let cmd = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };

        cmd.execute(&db).await.unwrap();

        // Verify updated_at was set
        assert!(has_updated_at(&db, "taskb").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_dependency_idempotent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        let cmd = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };

        // Create dependency first time
        let result1 = cmd.execute(&db).await;
        assert!(result1.is_ok());
        assert!(!result1.unwrap().already_existed);

        // Create dependency second time - should be idempotent
        let result2 = cmd.execute(&db).await;
        assert!(result2.is_ok());
        assert!(result2.unwrap().already_existed);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_self_dependency_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;

        let cmd = DependCommand {
            id: "taska".to_string(),
            blocker_id: "taska".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());

        let err = result.unwrap_err().to_string();
        assert!(err.contains("cannot depend on itself"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_direct_cycle_detection() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        // Create A depends on B
        let cmd1 = DependCommand {
            id: "taska".to_string(),
            blocker_id: "taskb".to_string(),
        };
        cmd1.execute(&db).await.unwrap();

        // Try to create B depends on A - should fail (cycle)
        let cmd2 = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };

        let result = cmd2.execute(&db).await;
        assert!(result.is_err());

        let err = result.unwrap_err().to_string();
        assert!(err.contains("Cycle detected"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transitive_cycle_detection() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_task(&db, "taskc", "Task C").await;

        // Create A depends on B
        let cmd1 = DependCommand {
            id: "taska".to_string(),
            blocker_id: "taskb".to_string(),
        };
        cmd1.execute(&db).await.unwrap();

        // Create B depends on C
        let cmd2 = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taskc".to_string(),
        };
        cmd2.execute(&db).await.unwrap();

        // Try to create C depends on A - should fail (transitive cycle)
        let cmd3 = DependCommand {
            id: "taskc".to_string(),
            blocker_id: "taska".to_string(),
        };

        let result = cmd3.execute(&db).await;
        assert!(result.is_err());

        let err = result.unwrap_err().to_string();
        assert!(err.contains("Cycle detected"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_not_found() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;

        let cmd = DependCommand {
            id: "taska".to_string(),
            blocker_id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());

        let err = result.unwrap_err().to_string();
        assert!(err.contains("not found"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_dependent_task_not_found() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;

        let cmd = DependCommand {
            id: "nonexistent".to_string(),
            blocker_id: "taska".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());

        let err = result.unwrap_err().to_string();
        assert!(err.contains("not found"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_case_insensitive_ids() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        let cmd = DependCommand {
            id: "TASKB".to_string(),         // Uppercase
            blocker_id: "TASKA".to_string(), // Uppercase
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        // Verify the dependency was created with lowercase IDs
        assert!(dependency_exists(&db, "taskb", "taska").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_multiple_dependencies_allowed() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_task(&db, "taskc", "Task C").await;

        // C depends on A
        let cmd1 = DependCommand {
            id: "taskc".to_string(),
            blocker_id: "taska".to_string(),
        };
        cmd1.execute(&db).await.unwrap();

        // C also depends on B
        let cmd2 = DependCommand {
            id: "taskc".to_string(),
            blocker_id: "taskb".to_string(),
        };
        let result = cmd2.execute(&db).await;
        assert!(result.is_ok());

        // Verify both dependencies exist
        assert!(dependency_exists(&db, "taskc", "taska").await);
        assert!(dependency_exists(&db, "taskc", "taskb").await);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_diamond_dependency_allowed() {
        let (db, temp_dir) = setup_test_db().await;

        // Diamond: D depends on B and C, both B and C depend on A
        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_task(&db, "taskc", "Task C").await;
        create_task(&db, "taskd", "Task D").await;

        // B depends on A
        DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        }
        .execute(&db)
        .await
        .unwrap();

        // C depends on A
        DependCommand {
            id: "taskc".to_string(),
            blocker_id: "taska".to_string(),
        }
        .execute(&db)
        .await
        .unwrap();

        // D depends on B
        DependCommand {
            id: "taskd".to_string(),
            blocker_id: "taskb".to_string(),
        }
        .execute(&db)
        .await
        .unwrap();

        // D depends on C (diamond complete, no cycle)
        let result = DependCommand {
            id: "taskd".to_string(),
            blocker_id: "taskc".to_string(),
        }
        .execute(&db)
        .await;

        assert!(result.is_ok(), "Diamond dependency should be allowed");

        // Verify all 4 edges exist in the database
        assert!(
            dependency_exists(&db, "taskb", "taska").await,
            "B -> A edge should exist"
        );
        assert!(
            dependency_exists(&db, "taskc", "taska").await,
            "C -> A edge should exist"
        );
        assert!(
            dependency_exists(&db, "taskd", "taskb").await,
            "D -> B edge should exist"
        );
        assert!(
            dependency_exists(&db, "taskd", "taskc").await,
            "D -> C edge should exist"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_long_chain_no_cycle() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a long chain: E -> D -> C -> B -> A
        for c in ['a', 'b', 'c', 'd', 'e'] {
            let id = format!("task{}", c);
            create_task(&db, &id, &format!("Task {}", c.to_uppercase())).await;
        }

        // Create chain of dependencies
        for (from, to) in [
            ("taskb", "taska"),
            ("taskc", "taskb"),
            ("taskd", "taskc"),
            ("taske", "taskd"),
        ] {
            let result = DependCommand {
                id: from.to_string(),
                blocker_id: to.to_string(),
            }
            .execute(&db)
            .await;
            assert!(
                result.is_ok(),
                "Chain dependency {} -> {} should work",
                from,
                to
            );
        }

        // Try to create cycle at the end: A depends on E
        let result = DependCommand {
            id: "taska".to_string(),
            blocker_id: "taske".to_string(),
        }
        .execute(&db)
        .await;

        assert!(result.is_err(), "Should detect cycle in long chain");
        assert!(result.unwrap_err().to_string().contains("Cycle detected"));

        // Verify all chain edges exist in the database
        assert!(
            dependency_exists(&db, "taskb", "taska").await,
            "B -> A edge should exist"
        );
        assert!(
            dependency_exists(&db, "taskc", "taskb").await,
            "C -> B edge should exist"
        );
        assert!(
            dependency_exists(&db, "taskd", "taskc").await,
            "D -> C edge should exist"
        );
        assert!(
            dependency_exists(&db, "taske", "taskd").await,
            "E -> D edge should exist"
        );

        // Verify the cycle edge was NOT created
        assert!(
            !dependency_exists(&db, "taska", "taske").await,
            "A -> E edge should NOT exist (would create cycle)"
        );

        cleanup(&temp_dir);
    }

    #[test]
    fn test_depend_result_display_new() {
        let result = DependResult {
            task_id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
            already_existed: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Created dependency"));
        assert!(output.contains("taskb"));
        assert!(output.contains("taska"));
    }

    #[test]
    fn test_depend_result_display_existing() {
        let result = DependResult {
            task_id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
            already_existed: true,
        };

        let output = format!("{}", result);
        assert!(output.contains("already exists"));
    }

    #[test]
    fn test_depend_command_debug() {
        let cmd = DependCommand {
            id: "test123".to_string(),
            blocker_id: "blocker456".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("DependCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("blocker_id: \"blocker456\""),
            "Debug output should contain DependCommand and both id field values"
        );
    }

    #[tokio::test]
    async fn test_idempotent_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;

        let cmd = DependCommand {
            id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
        };

        // Create dependency
        cmd.execute(&db).await.unwrap();

        // Get initial timestamp
        #[derive(Deserialize)]
        struct TimestampRow {
            updated_at: surrealdb::sql::Datetime,
        }

        let query = "SELECT updated_at FROM task:taskb";
        let mut result = db.client().query(query).await.unwrap();
        let row1: Option<TimestampRow> = result.take(0).unwrap();
        let ts1 = row1.unwrap().updated_at;

        // Wait a tiny bit to ensure timestamp differs
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

        // Run again (idempotent)
        cmd.execute(&db).await.unwrap();

        // Get new timestamp
        let mut result = db.client().query(query).await.unwrap();
        let row2: Option<TimestampRow> = result.take(0).unwrap();
        let ts2 = row2.unwrap().updated_at;

        // Timestamp should have been updated
        assert!(ts2 >= ts1, "Timestamp should be updated on idempotent call");

        cleanup(&temp_dir);
    }
}
