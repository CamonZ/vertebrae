//! Path command for finding dependency paths between tasks
//!
//! Implements the `vtb path` command to find the shortest dependency path
//! between two tasks using BFS traversal of the dependency graph.

use crate::db::{Database, DbError};
use clap::Args;
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};

/// Find the dependency path between two tasks
#[derive(Debug, Args)]
pub struct PathCommand {
    /// Source task ID (case-insensitive)
    #[arg(required = true)]
    pub from_id: String,

    /// Target task ID (case-insensitive)
    #[arg(required = true)]
    pub to_id: String,
}

/// A task summary for path display
#[derive(Debug, Clone)]
pub struct TaskSummary {
    /// Task ID
    pub id: String,
    /// Task title
    pub title: String,
}

/// Result of the path command execution
#[derive(Debug)]
pub struct PathResult {
    /// The source task ID
    pub from_id: String,
    /// The target task ID
    pub to_id: String,
    /// The path from source to target (None if no path exists)
    pub path: Option<Vec<TaskSummary>>,
}

/// Result from querying a task
#[derive(Debug, Deserialize)]
struct TaskRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    title: String,
}

impl PathCommand {
    /// Execute the path command.
    ///
    /// Finds the shortest dependency path from `from_id` to `to_id`
    /// by traversing the `depends_on` edges using BFS.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - Either task does not exist
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<PathResult, DbError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let from_id = self.from_id.to_lowercase();
        let to_id = self.to_id.to_lowercase();

        // Validate both tasks exist
        let from_task = self.fetch_task(db, &from_id).await?;
        let _to_task = self.fetch_task(db, &to_id).await?;

        // Handle same task case
        if from_id == to_id {
            return Ok(PathResult {
                from_id: from_id.clone(),
                to_id,
                path: Some(vec![TaskSummary {
                    id: from_id,
                    title: from_task.title,
                }]),
            });
        }

        // Find the path using BFS
        let path = self.find_path_bfs(db, &from_id, &to_id).await?;

        Ok(PathResult {
            from_id,
            to_id,
            path,
        })
    }

    /// Fetch a task by ID.
    async fn fetch_task(&self, db: &Database, id: &str) -> Result<TaskRow, DbError> {
        let query = format!("SELECT id, title FROM task:{}", id);

        let mut result = db.client().query(&query).await?;
        let task: Option<TaskRow> = result.take(0)?;

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(id),
            reason: format!("Task '{}' not found", id),
        })
    }

    /// Find the shortest path from source to target using BFS.
    ///
    /// Traverses the dependency graph following `depends_on` edges.
    /// Returns None if no path exists.
    async fn find_path_bfs(
        &self,
        db: &Database,
        from_id: &str,
        to_id: &str,
    ) -> Result<Option<Vec<TaskSummary>>, DbError> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut parent_map: HashMap<String, String> = HashMap::new();
        let mut task_titles: HashMap<String, String> = HashMap::new();

        // Get the title for the source task
        let from_task = self.fetch_task(db, from_id).await?;
        task_titles.insert(from_id.to_string(), from_task.title);

        // Start BFS from the source
        queue.push_back(from_id.to_string());
        visited.insert(from_id.to_string());

        while let Some(current) = queue.pop_front() {
            // Get all tasks that the current task depends on
            let query = format!("SELECT VALUE out FROM task:{}->depends_on", current);
            let mut result = db.client().query(&query).await?;
            let deps: Vec<surrealdb::sql::Thing> = result.take(0)?;

            for dep in deps {
                let dep_id = dep.id.to_string();

                // If we haven't visited this task yet
                if visited.insert(dep_id.clone()) {
                    // Record the parent for path reconstruction
                    parent_map.insert(dep_id.clone(), current.clone());

                    // Fetch and store the task title
                    if let Ok(task) = self.fetch_task(db, &dep_id).await {
                        task_titles.insert(dep_id.clone(), task.title);
                    }

                    // If we found the target, reconstruct the path
                    if dep_id == to_id {
                        return Ok(Some(self.reconstruct_path(
                            from_id,
                            to_id,
                            &parent_map,
                            &task_titles,
                        )));
                    }

                    queue.push_back(dep_id);
                }
            }
        }

        // No path found
        Ok(None)
    }

    /// Reconstruct the path from source to target using the parent map.
    fn reconstruct_path(
        &self,
        from_id: &str,
        to_id: &str,
        parent_map: &HashMap<String, String>,
        task_titles: &HashMap<String, String>,
    ) -> Vec<TaskSummary> {
        let mut path = Vec::new();

        // Build path from target to source
        let mut current = to_id.to_string();
        while current != from_id {
            let title = task_titles
                .get(&current)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string());
            path.push(TaskSummary {
                id: current.clone(),
                title,
            });

            if let Some(parent) = parent_map.get(&current) {
                current = parent.clone();
            } else {
                break;
            }
        }

        // Add the source task
        let from_title = task_titles
            .get(from_id)
            .cloned()
            .unwrap_or_else(|| "Unknown".to_string());
        path.push(TaskSummary {
            id: from_id.to_string(),
            title: from_title,
        });

        // Reverse to get path from source to target
        path.reverse();
        path
    }
}

impl std::fmt::Display for PathResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.path {
            None => {
                writeln!(
                    f,
                    "No dependency path from {} to {}",
                    self.from_id, self.to_id
                )
            }
            Some(path) if path.len() == 1 => {
                // Same task case
                writeln!(f, "Same task: {} \"{}\"", path[0].id, path[0].title)
            }
            Some(path) => {
                writeln!(f, "Path from {} to {}:", self.from_id, self.to_id)?;
                writeln!(f)?;

                for (i, task) in path.iter().enumerate() {
                    writeln!(f, "{:<8}  \"{}\"", task.id, task.title)?;

                    if i < path.len() - 1 {
                        writeln!(f, "   \u{2193} depends on")?;
                    }
                }

                writeln!(f)?;
                writeln!(
                    f,
                    "{} task{} in path",
                    path.len(),
                    if path.len() == 1 { "" } else { "s" }
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-path-test-{}-{:?}-{}",
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

    /// Helper to create a depends_on relationship
    async fn create_depends_on(db: &Database, task_id: &str, blocker_id: &str) {
        let query = format!(
            "RELATE task:{} -> depends_on -> task:{}",
            task_id, blocker_id
        );
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_path_same_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taska".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Path command failed: {:?}", result.err());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.as_ref().unwrap();
        assert_eq!(path.len(), 1);
        assert_eq!(path[0].id, "taska");

        let output = format!("{}", path_result);
        let first_line = output.lines().next().unwrap();
        assert_eq!(first_line, "Same task: taska \"Task A\"");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_path_direct_dependency() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_depends_on(&db, "taska", "taskb").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taskb".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.unwrap();
        assert_eq!(path.len(), 2);

        // Verify all fields of each TaskSummary in the path
        assert_eq!(path[0].id, "taska");
        assert_eq!(path[0].title, "Task A");
        assert_eq!(path[1].id, "taskb");
        assert_eq!(path[1].title, "Task B");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_path_transitive_dependency() {
        let (db, temp_dir) = setup_test_db().await;

        // Create chain: A -> B -> C
        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_task(&db, "taskc", "Task C").await;
        create_depends_on(&db, "taska", "taskb").await;
        create_depends_on(&db, "taskb", "taskc").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taskc".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.unwrap();
        assert_eq!(path.len(), 3);
        assert_eq!(path[0].id, "taska");
        assert_eq!(path[1].id, "taskb");
        assert_eq!(path[2].id, "taskc");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_path_no_path() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        // No dependency between them

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taskb".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_none());

        let output = format!("{}", path_result);
        let first_line = output.lines().next().unwrap();
        assert_eq!(first_line, "No dependency path from taska to taskb");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_path_wrong_direction() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_depends_on(&db, "taska", "taskb").await;

        // Try to find path in reverse direction (should not exist)
        let cmd = PathCommand {
            from_id: "taskb".to_string(),
            to_id: "taska".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_path_nonexistent_from_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taskb", "Task B").await;

        let cmd = PathCommand {
            from_id: "nonexistent".to_string(),
            to_id: "taskb".to_string(),
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
    async fn test_path_nonexistent_to_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "nonexistent".to_string(),
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
    async fn test_path_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_depends_on(&db, "taska", "taskb").await;

        let cmd = PathCommand {
            from_id: "TASKA".to_string(),
            to_id: "TASKB".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_path_shortest_path() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a diamond: A -> B -> D and A -> C -> D
        // Both paths have equal length, BFS should find one of them
        create_task(&db, "taska", "Task A").await;
        create_task(&db, "taskb", "Task B").await;
        create_task(&db, "taskc", "Task C").await;
        create_task(&db, "taskd", "Task D").await;

        create_depends_on(&db, "taska", "taskb").await;
        create_depends_on(&db, "taska", "taskc").await;
        create_depends_on(&db, "taskb", "taskd").await;
        create_depends_on(&db, "taskc", "taskd").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taskd".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.unwrap();
        // Should be length 3 (A -> B/C -> D)
        assert_eq!(path.len(), 3);
        assert_eq!(path[0].id, "taska");
        assert_eq!(path[2].id, "taskd");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_path_long_chain() {
        let (db, temp_dir) = setup_test_db().await;

        // Create chain: a -> b -> c -> d -> e
        for c in ['a', 'b', 'c', 'd', 'e'] {
            let id = format!("task{}", c);
            create_task(&db, &id, &format!("Task {}", c.to_uppercase())).await;
        }

        for (from, to) in [
            ("taska", "taskb"),
            ("taskb", "taskc"),
            ("taskc", "taskd"),
            ("taskd", "taske"),
        ] {
            create_depends_on(&db, from, to).await;
        }

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taske".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.unwrap();
        assert_eq!(path.len(), 5);

        // Verify the order
        let ids: Vec<&str> = path.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["taska", "taskb", "taskc", "taskd", "taske"]);

        cleanup(&temp_dir);
    }

    #[test]
    fn test_path_result_display_no_path() {
        let result = PathResult {
            from_id: "taska".to_string(),
            to_id: "taskb".to_string(),
            path: None,
        };

        let output = format!("{}", result);
        let first_line = output.lines().next().unwrap();
        assert_eq!(first_line, "No dependency path from taska to taskb");
    }

    #[test]
    fn test_path_result_display_same_task() {
        let result = PathResult {
            from_id: "taska".to_string(),
            to_id: "taska".to_string(),
            path: Some(vec![TaskSummary {
                id: "taska".to_string(),
                title: "Task A".to_string(),
            }]),
        };

        let output = format!("{}", result);
        let first_line = output.lines().next().unwrap();
        assert_eq!(first_line, "Same task: taska \"Task A\"");
    }

    #[test]
    fn test_path_result_display_with_path() {
        let result = PathResult {
            from_id: "taska".to_string(),
            to_id: "taskc".to_string(),
            path: Some(vec![
                TaskSummary {
                    id: "taska".to_string(),
                    title: "Task A".to_string(),
                },
                TaskSummary {
                    id: "taskb".to_string(),
                    title: "Task B".to_string(),
                },
                TaskSummary {
                    id: "taskc".to_string(),
                    title: "Task C".to_string(),
                },
            ]),
        };

        let output = format!("{}", result);
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines[0], "Path from taska to taskc:");
        // Line 1 is blank
        // Lines 2-6 contain the path with arrows
        assert!(
            lines[2].contains("taska") && lines[2].contains("Task A"),
            "First task line should contain taska and Task A"
        );
        assert!(
            lines[3].contains("depends on"),
            "Arrow line should contain 'depends on'"
        );
        assert!(
            lines[4].contains("taskb") && lines[4].contains("Task B"),
            "Second task line should contain taskb and Task B"
        );
        assert!(
            lines[6].contains("taskc") && lines[6].contains("Task C"),
            "Third task line should contain taskc and Task C"
        );
        assert_eq!(lines[lines.len() - 1], "3 tasks in path");
    }

    #[test]
    fn test_path_command_debug() {
        let cmd = PathCommand {
            from_id: "test1".to_string(),
            to_id: "test2".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("PathCommand")
                && debug_str.contains("from_id: \"test1\"")
                && debug_str.contains("to_id: \"test2\""),
            "Debug output should contain PathCommand and both ID fields"
        );
    }

    #[test]
    fn test_task_summary_debug() {
        let summary = TaskSummary {
            id: "test".to_string(),
            title: "Test Task".to_string(),
        };
        let debug_str = format!("{:?}", summary);
        assert!(
            debug_str.contains("TaskSummary")
                && debug_str.contains("id: \"test\"")
                && debug_str.contains("title: \"Test Task\""),
            "Debug output should contain TaskSummary and its fields"
        );
    }

    #[test]
    fn test_path_result_debug() {
        let result = PathResult {
            from_id: "a".to_string(),
            to_id: "b".to_string(),
            path: None,
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("PathResult")
                && debug_str.contains("from_id: \"a\"")
                && debug_str.contains("to_id: \"b\""),
            "Debug output should contain PathResult and its fields"
        );
    }
}
