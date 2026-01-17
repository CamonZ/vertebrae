//! Path command for finding dependency paths between tasks
//!
//! Implements the `vtb path` command to find the shortest dependency path
//! between two tasks using BFS traversal of the dependency graph.

use clap::Args;
use vertebrae_core::{ServiceError, TaskService};

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

impl PathCommand {
    /// Execute the path command.
    ///
    /// Finds the shortest dependency path from `from_id` to `to_id`
    /// by traversing the `depends_on` edges using BFS.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - Either task does not exist
    /// - Database operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<PathResult, ServiceError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let from_id = self.from_id.to_lowercase();
        let to_id = self.to_id.to_lowercase();

        // Validate both tasks exist using the service
        let from_task = service.get_task(&from_id).await?;
        let _to_task = service.get_task(&to_id).await?;

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

        // Find the path using the graph repository
        let db = service.database();
        let path_ids = db.graph().find_path(&from_id, &to_id).await?;

        // Convert path IDs to TaskSummary with titles
        let path = match path_ids {
            Some(ids) => {
                let mut summaries = Vec::new();
                for id in ids {
                    let task = service.get_task(&id).await?;
                    summaries.push(TaskSummary {
                        id,
                        title: task.title,
                    });
                }
                Some(summaries)
            }
            None => None,
        };

        Ok(PathResult {
            from_id,
            to_id,
            path,
        })
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
    use vertebrae_core::DefaultTaskService;
    use vertebrae_db::{Database, Status};

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> DefaultTaskService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultTaskService::new(db)
    }

    /// Helper to create a task in the database
    async fn create_task(service: &DefaultTaskService, id: &str, title: &str) {
        let db = service.database();
        let task =
            vertebrae_db::Task::new(title, vertebrae_db::Level::Task).with_status(Status::Todo);
        db.tasks().create(id, &task).await.unwrap();
    }

    /// Helper to create a depends_on relationship
    async fn create_depends_on(service: &DefaultTaskService, task_id: &str, blocker_id: &str) {
        let db = service.database();
        db.relationships()
            .create_depends_on(task_id, blocker_id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_path_same_task() {
        let service = setup_test_service().await;

        create_task(&service, "taska", "Task A").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taska".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Path command failed: {:?}", result.err());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.as_ref().unwrap();
        assert_eq!(path.len(), 1);
        assert_eq!(path[0].id, "taska");

        let output = format!("{}", path_result);
        let first_line = output.lines().next().unwrap();
        assert_eq!(first_line, "Same task: taska \"Task A\"");
    }

    #[tokio::test]
    async fn test_path_direct_dependency() {
        let service = setup_test_service().await;

        create_task(&service, "taska", "Task A").await;
        create_task(&service, "taskb", "Task B").await;
        create_depends_on(&service, "taska", "taskb").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taskb".to_string(),
        };

        let result = cmd.execute(&service).await;
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
    }

    #[tokio::test]
    async fn test_path_transitive_dependency() {
        let service = setup_test_service().await;

        // Create chain: A -> B -> C
        create_task(&service, "taska", "Task A").await;
        create_task(&service, "taskb", "Task B").await;
        create_task(&service, "taskc", "Task C").await;
        create_depends_on(&service, "taska", "taskb").await;
        create_depends_on(&service, "taskb", "taskc").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taskc".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.unwrap();
        assert_eq!(path.len(), 3);
        assert_eq!(path[0].id, "taska");
        assert_eq!(path[1].id, "taskb");
        assert_eq!(path[2].id, "taskc");
    }

    #[tokio::test]
    async fn test_path_no_path() {
        let service = setup_test_service().await;

        create_task(&service, "taska", "Task A").await;
        create_task(&service, "taskb", "Task B").await;
        // No dependency between them

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taskb".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_none());

        let output = format!("{}", path_result);
        let first_line = output.lines().next().unwrap();
        assert_eq!(first_line, "No dependency path from taska to taskb");
    }

    #[tokio::test]
    async fn test_path_wrong_direction() {
        let service = setup_test_service().await;

        create_task(&service, "taska", "Task A").await;
        create_task(&service, "taskb", "Task B").await;
        create_depends_on(&service, "taska", "taskb").await;

        // Try to find path in reverse direction (should not exist)
        let cmd = PathCommand {
            from_id: "taskb".to_string(),
            to_id: "taska".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_none());
    }

    #[tokio::test]
    async fn test_path_nonexistent_from_task() {
        let service = setup_test_service().await;

        create_task(&service, "taskb", "Task B").await;

        let cmd = PathCommand {
            from_id: "nonexistent".to_string(),
            to_id: "taskb".to_string(),
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::TaskNotFound { task_id }) => {
                assert_eq!(
                    task_id, "nonexistent",
                    "Expected task_id 'nonexistent', got: {}",
                    task_id
                );
            }
            Err(other) => panic!("Expected TaskNotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_path_nonexistent_to_task() {
        let service = setup_test_service().await;

        create_task(&service, "taska", "Task A").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::TaskNotFound { task_id }) => {
                assert_eq!(
                    task_id, "nonexistent",
                    "Expected task_id 'nonexistent', got: {}",
                    task_id
                );
            }
            Err(other) => panic!("Expected TaskNotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_path_case_insensitive() {
        let service = setup_test_service().await;

        create_task(&service, "taska", "Task A").await;
        create_task(&service, "taskb", "Task B").await;
        create_depends_on(&service, "taska", "taskb").await;

        let cmd = PathCommand {
            from_id: "TASKA".to_string(),
            to_id: "TASKB".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
    }

    #[tokio::test]
    async fn test_path_shortest_path() {
        let service = setup_test_service().await;

        // Create a diamond: A -> B -> D and A -> C -> D
        // Both paths have equal length, BFS should find one of them
        create_task(&service, "taska", "Task A").await;
        create_task(&service, "taskb", "Task B").await;
        create_task(&service, "taskc", "Task C").await;
        create_task(&service, "taskd", "Task D").await;

        create_depends_on(&service, "taska", "taskb").await;
        create_depends_on(&service, "taska", "taskc").await;
        create_depends_on(&service, "taskb", "taskd").await;
        create_depends_on(&service, "taskc", "taskd").await;

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taskd".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.unwrap();
        // Should be length 3 (A -> B/C -> D)
        assert_eq!(path.len(), 3);
        assert_eq!(path[0].id, "taska");
        assert_eq!(path[2].id, "taskd");
    }

    #[tokio::test]
    async fn test_path_long_chain() {
        let service = setup_test_service().await;

        // Create chain: a -> b -> c -> d -> e
        for c in ['a', 'b', 'c', 'd', 'e'] {
            let id = format!("task{}", c);
            create_task(&service, &id, &format!("Task {}", c.to_uppercase())).await;
        }

        for (from, to) in [
            ("taska", "taskb"),
            ("taskb", "taskc"),
            ("taskc", "taskd"),
            ("taskd", "taske"),
        ] {
            create_depends_on(&service, from, to).await;
        }

        let cmd = PathCommand {
            from_id: "taska".to_string(),
            to_id: "taske".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let path_result = result.unwrap();
        assert!(path_result.path.is_some());
        let path = path_result.path.unwrap();
        assert_eq!(path.len(), 5);

        // Verify the order
        let ids: Vec<&str> = path.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["taska", "taskb", "taskc", "taskd", "taske"]);
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
