//! Blockers command for displaying blocking tasks
//!
//! Implements the `vtb blockers` command to show all tasks blocking a given task,
//! recursively traversing the dependency graph.

use crate::db::{Database, DbError};
use clap::Args;
use serde::Deserialize;

/// Show all tasks blocking a given task
#[derive(Debug, Args)]
pub struct BlockersCommand {
    /// Task ID to find blockers for (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Maximum depth to traverse (default: unlimited)
    #[arg(long, short = 'd')]
    pub depth: Option<usize>,
}

/// A node in the blocker tree
#[derive(Debug, Clone)]
pub struct BlockerNode {
    /// Task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level
    pub level: String,
    /// Current status
    pub status: String,
    /// Child blockers (tasks that this task depends on)
    pub children: Vec<BlockerNode>,
}

/// Result of the blockers command execution
#[derive(Debug)]
pub struct BlockersResult {
    /// The target task ID
    pub task_id: String,
    /// The target task title
    pub task_title: String,
    /// Root blocker nodes (direct dependencies)
    pub blockers: Vec<BlockerNode>,
    /// Total count of all blocking items
    pub total_count: usize,
}

/// Result from querying a task
#[derive(Debug, Deserialize)]
struct TaskRow {
    id: surrealdb::sql::Thing,
    title: String,
    level: String,
    status: String,
}

impl BlockersCommand {
    /// Execute the blockers command.
    ///
    /// Recursively traverses the dependency graph to find all tasks
    /// blocking the specified task.
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
    pub async fn execute(&self, db: &Database) -> Result<BlockersResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch the target task to verify it exists and get its title
        let task = self.fetch_task(db, &id).await?;

        // Build the blocker tree
        let blockers = self.build_blocker_tree(db, &id, 0).await?;

        // Count total blockers
        let total_count = count_nodes(&blockers);

        Ok(BlockersResult {
            task_id: id,
            task_title: task.title,
            blockers,
            total_count,
        })
    }

    /// Fetch a task by ID.
    async fn fetch_task(&self, db: &Database, id: &str) -> Result<TaskRow, DbError> {
        let query = format!("SELECT id, title, level, status FROM task:{}", id);

        let mut result = db.client().query(&query).await?;
        let task: Option<TaskRow> = result.take(0)?;

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.id),
            reason: format!("Task '{}' not found", self.id),
        })
    }

    /// Build the blocker tree recursively.
    ///
    /// Uses BFS with depth tracking to build the tree structure while respecting
    /// the optional depth limit.
    async fn build_blocker_tree(
        &self,
        db: &Database,
        task_id: &str,
        current_depth: usize,
    ) -> Result<Vec<BlockerNode>, DbError> {
        // Check depth limit
        if let Some(max_depth) = self.depth
            && current_depth >= max_depth
        {
            return Ok(vec![]);
        }

        // Get direct blockers (tasks that this task depends on)
        let direct_blockers = self.fetch_direct_blockers(db, task_id).await?;

        // Build nodes for each direct blocker
        let mut nodes = Vec::new();
        for blocker in direct_blockers {
            let blocker_id = blocker.id.id.to_string();

            // Recursively get children (blockers of this blocker)
            let children =
                Box::pin(self.build_blocker_tree(db, &blocker_id, current_depth + 1)).await?;

            nodes.push(BlockerNode {
                id: blocker_id,
                title: blocker.title,
                level: blocker.level,
                status: blocker.status,
                children,
            });
        }

        Ok(nodes)
    }

    /// Fetch direct blockers for a task (tasks it depends on).
    async fn fetch_direct_blockers(
        &self,
        db: &Database,
        task_id: &str,
    ) -> Result<Vec<TaskRow>, DbError> {
        // Get tasks that this task depends on via the depends_on edge
        let query = format!(
            "SELECT id, title, level, status FROM task WHERE <-depends_on<-task CONTAINS task:{}",
            task_id
        );

        let mut result = db.client().query(&query).await?;
        let blockers: Vec<TaskRow> = result.take(0)?;

        Ok(blockers)
    }
}

/// Count total nodes in the blocker tree
fn count_nodes(nodes: &[BlockerNode]) -> usize {
    nodes.iter().map(|n| 1 + count_nodes(&n.children)).sum()
}

impl std::fmt::Display for BlockersResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.blockers.is_empty() {
            return writeln!(f, "No blockers");
        }

        // Header
        writeln!(f, "Blockers for: {} \"{}\"", self.task_id, self.task_title)?;
        writeln!(f, "{}", "=".repeat(50))?;
        writeln!(f)?;

        // Print the tree
        for (i, node) in self.blockers.iter().enumerate() {
            let is_last = i == self.blockers.len() - 1;
            print_node(f, node, "", is_last)?;
        }

        writeln!(f)?;
        writeln!(
            f,
            "Total: {} blocking item{}",
            self.total_count,
            if self.total_count == 1 { "" } else { "s" }
        )?;

        Ok(())
    }
}

/// Print a node in the tree with proper indentation
fn print_node(
    f: &mut std::fmt::Formatter<'_>,
    node: &BlockerNode,
    prefix: &str,
    is_last: bool,
) -> std::fmt::Result {
    // Determine the connector
    let connector = if prefix.is_empty() {
        ""
    } else if is_last {
        "`-- "
    } else {
        "|-- "
    };

    // Format fields with fixed width for alignment
    let level_display = format!("{:8}", node.level);
    let status_display = format!("{:12}", node.status);

    writeln!(
        f,
        "{}{}{:<8} {} {} {}",
        prefix, connector, node.id, level_display, status_display, node.title
    )?;

    // Calculate prefix for children
    let child_prefix = if prefix.is_empty() {
        "".to_string()
    } else if is_last {
        format!("{}    ", prefix)
    } else {
        format!("{}|   ", prefix)
    };

    // Add indent for root-level children
    let actual_prefix = if prefix.is_empty() {
        "    ".to_string()
    } else {
        child_prefix
    };

    // Print children
    for (i, child) in node.children.iter().enumerate() {
        let child_is_last = i == node.children.len() - 1;
        print_node(f, child, &actual_prefix, child_is_last)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-blockers-test-{}-{:?}-{}",
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
    async fn test_blockers_no_blockers() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Independent Task", "task", "todo").await;

        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Blockers failed: {:?}", result.err());

        let blockers_result = result.unwrap();
        assert!(blockers_result.blockers.is_empty());
        assert_eq!(blockers_result.total_count, 0);

        let output = format!("{}", blockers_result);
        assert_eq!(output, "No blockers\n");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_blockers_single_blocker() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "blocker1", "Blocker Task", "task", "todo").await;
        create_task(&db, "task1", "Blocked Task", "task", "blocked").await;
        create_depends_on(&db, "task1", "blocker1").await;

        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let blockers_result = result.unwrap();
        assert_eq!(blockers_result.blockers.len(), 1);
        assert_eq!(blockers_result.blockers[0].id, "blocker1");
        assert_eq!(blockers_result.total_count, 1);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_blockers_transitive() {
        let (db, temp_dir) = setup_test_db().await;

        // Create chain: task1 -> blocker1 -> blocker2
        create_task(&db, "blocker2", "Root Blocker", "task", "todo").await;
        create_task(&db, "blocker1", "Intermediate Blocker", "task", "todo").await;
        create_task(&db, "task1", "Final Task", "task", "blocked").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "blocker1", "blocker2").await;

        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let blockers_result = result.unwrap();
        assert_eq!(blockers_result.blockers.len(), 1);
        assert_eq!(blockers_result.blockers[0].id, "blocker1");
        assert_eq!(blockers_result.blockers[0].children.len(), 1);
        assert_eq!(blockers_result.blockers[0].children[0].id, "blocker2");
        assert_eq!(blockers_result.total_count, 2);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_blockers_multiple_direct() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "blocker1", "Blocker 1", "task", "todo").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "in_progress").await;
        create_task(&db, "task1", "Blocked Task", "task", "blocked").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "task1", "blocker2").await;

        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let blockers_result = result.unwrap();
        assert_eq!(blockers_result.blockers.len(), 2);
        assert_eq!(blockers_result.total_count, 2);

        // Verify specific blockers are present
        use std::collections::HashSet;
        let blocker_ids: HashSet<_> = blockers_result
            .blockers
            .iter()
            .map(|b| b.id.as_str())
            .collect();
        assert!(blocker_ids.contains("blocker1"), "Should contain blocker1");
        assert!(blocker_ids.contains("blocker2"), "Should contain blocker2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_blockers_depth_limit() {
        let (db, temp_dir) = setup_test_db().await;

        // Create chain: task1 -> blocker1 -> blocker2 -> blocker3
        create_task(&db, "blocker3", "Deep Blocker", "task", "todo").await;
        create_task(&db, "blocker2", "Mid Blocker", "task", "todo").await;
        create_task(&db, "blocker1", "Direct Blocker", "task", "todo").await;
        create_task(&db, "task1", "Main Task", "task", "blocked").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "blocker1", "blocker2").await;
        create_depends_on(&db, "blocker2", "blocker3").await;

        // Test with depth 1 - should only show direct blocker
        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: Some(1),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let blockers_result = result.unwrap();
        assert_eq!(blockers_result.blockers.len(), 1);
        assert_eq!(blockers_result.blockers[0].id, "blocker1");
        assert!(blockers_result.blockers[0].children.is_empty());
        assert_eq!(blockers_result.total_count, 1);

        // Test with depth 2 - should show two levels
        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: Some(2),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let blockers_result = result.unwrap();
        assert_eq!(blockers_result.blockers[0].children.len(), 1);
        assert_eq!(blockers_result.blockers[0].children[0].id, "blocker2");
        assert!(blockers_result.blockers[0].children[0].children.is_empty());
        assert_eq!(blockers_result.total_count, 2);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_blockers_depth_zero() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "blocker1", "Blocker", "task", "todo").await;
        create_task(&db, "task1", "Main Task", "task", "blocked").await;
        create_depends_on(&db, "task1", "blocker1").await;

        // Depth 0 should show no blockers
        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: Some(0),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let blockers_result = result.unwrap();
        assert!(blockers_result.blockers.is_empty());
        assert_eq!(blockers_result.total_count, 0);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_blockers_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = BlockersCommand {
            id: "nonexistent".to_string(),
            depth: None,
        };

        let result = cmd.execute(&db).await;
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
    async fn test_blockers_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = BlockersCommand {
            id: "TASK1".to_string(),
            depth: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_blockers_diamond_structure() {
        let (db, temp_dir) = setup_test_db().await;

        // Diamond: task1 -> (blocker1, blocker2) -> shared_blocker
        create_task(&db, "shared", "Shared Blocker", "task", "todo").await;
        create_task(&db, "blocker1", "Blocker 1", "task", "todo").await;
        create_task(&db, "blocker2", "Blocker 2", "task", "todo").await;
        create_task(&db, "task1", "Main Task", "task", "blocked").await;

        create_depends_on(&db, "task1", "blocker1").await;
        create_depends_on(&db, "task1", "blocker2").await;
        create_depends_on(&db, "blocker1", "shared").await;
        create_depends_on(&db, "blocker2", "shared").await;

        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let blockers_result = result.unwrap();
        assert_eq!(blockers_result.blockers.len(), 2);
        // Each path shows the shared blocker
        assert_eq!(blockers_result.total_count, 4); // blocker1, blocker2, and shared appears twice

        // Verify the direct blockers are blocker1 and blocker2
        use std::collections::HashSet;
        let blocker_ids: HashSet<_> = blockers_result
            .blockers
            .iter()
            .map(|b| b.id.as_str())
            .collect();
        assert!(blocker_ids.contains("blocker1"), "Should contain blocker1");
        assert!(blocker_ids.contains("blocker2"), "Should contain blocker2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_blockers_shows_status() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "done_blocker", "Done Blocker", "ticket", "done").await;
        create_task(&db, "todo_blocker", "Todo Blocker", "task", "todo").await;
        create_task(&db, "task1", "Main Task", "task", "blocked").await;

        create_depends_on(&db, "task1", "done_blocker").await;
        create_depends_on(&db, "task1", "todo_blocker").await;

        let cmd = BlockersCommand {
            id: "task1".to_string(),
            depth: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let blockers_result = result.unwrap();
        assert_eq!(blockers_result.blockers.len(), 2);

        // Verify all fields of each BlockerNode
        let done_blocker = blockers_result
            .blockers
            .iter()
            .find(|b| b.id == "done_blocker")
            .expect("Should find done_blocker");
        assert_eq!(done_blocker.title, "Done Blocker");
        assert_eq!(done_blocker.level, "ticket");
        assert_eq!(done_blocker.status, "done");
        assert!(done_blocker.children.is_empty());

        let todo_blocker = blockers_result
            .blockers
            .iter()
            .find(|b| b.id == "todo_blocker")
            .expect("Should find todo_blocker");
        assert_eq!(todo_blocker.title, "Todo Blocker");
        assert_eq!(todo_blocker.level, "task");
        assert_eq!(todo_blocker.status, "todo");
        assert!(todo_blocker.children.is_empty());

        // Check output contains status info by verifying blockers have the expected statuses
        let output = format!("{}", blockers_result);
        // The output should contain the status values from the blockers
        let has_done = output.lines().any(|line| line.contains("done"));
        let has_todo = output.lines().any(|line| line.contains("todo"));
        assert!(
            has_done && has_todo,
            "Output should contain both 'done' and 'todo' status values"
        );

        cleanup(&temp_dir);
    }

    #[test]
    fn test_count_nodes() {
        let tree = vec![
            BlockerNode {
                id: "a".to_string(),
                title: "A".to_string(),
                level: "task".to_string(),
                status: "todo".to_string(),
                children: vec![BlockerNode {
                    id: "b".to_string(),
                    title: "B".to_string(),
                    level: "task".to_string(),
                    status: "todo".to_string(),
                    children: vec![],
                }],
            },
            BlockerNode {
                id: "c".to_string(),
                title: "C".to_string(),
                level: "task".to_string(),
                status: "todo".to_string(),
                children: vec![],
            },
        ];

        assert_eq!(count_nodes(&tree), 3);
    }

    #[test]
    fn test_blockers_result_display_empty() {
        let result = BlockersResult {
            task_id: "task1".to_string(),
            task_title: "Test Task".to_string(),
            blockers: vec![],
            total_count: 0,
        };

        let output = format!("{}", result);
        assert_eq!(output, "No blockers\n");
    }

    #[test]
    fn test_blockers_result_display_with_blockers() {
        let result = BlockersResult {
            task_id: "task1".to_string(),
            task_title: "Test Task".to_string(),
            blockers: vec![BlockerNode {
                id: "blocker1".to_string(),
                title: "Blocker Task".to_string(),
                level: "ticket".to_string(),
                status: "todo".to_string(),
                children: vec![],
            }],
            total_count: 1,
        };

        let output = format!("{}", result);
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines[0], "Blockers for: task1 \"Test Task\"");
        assert!(lines[1].starts_with("="), "Second line should be separator");
        // Third line is blank
        // Fourth line has the blocker info
        assert!(
            lines[3].contains("blocker1") && lines[3].contains("Blocker Task"),
            "Blocker line should contain blocker1 and Blocker Task"
        );
        assert_eq!(lines[lines.len() - 1], "Total: 1 blocking item");
    }

    #[test]
    fn test_blockers_result_display_plural() {
        let result = BlockersResult {
            task_id: "task1".to_string(),
            task_title: "Test Task".to_string(),
            blockers: vec![
                BlockerNode {
                    id: "blocker1".to_string(),
                    title: "Blocker 1".to_string(),
                    level: "task".to_string(),
                    status: "todo".to_string(),
                    children: vec![],
                },
                BlockerNode {
                    id: "blocker2".to_string(),
                    title: "Blocker 2".to_string(),
                    level: "task".to_string(),
                    status: "todo".to_string(),
                    children: vec![],
                },
            ],
            total_count: 2,
        };

        let output = format!("{}", result);
        let last_line = output.lines().last().unwrap();
        assert_eq!(last_line, "Total: 2 blocking items");
    }

    #[test]
    fn test_blockers_command_debug() {
        let cmd = BlockersCommand {
            id: "test".to_string(),
            depth: Some(5),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("BlockersCommand") && debug_str.contains("depth: Some(5)"),
            "Debug output should contain BlockersCommand and depth info"
        );
    }

    #[test]
    fn test_blocker_node_debug() {
        let node = BlockerNode {
            id: "test".to_string(),
            title: "Test".to_string(),
            level: "task".to_string(),
            status: "todo".to_string(),
            children: vec![],
        };
        let debug_str = format!("{:?}", node);
        assert!(
            debug_str.contains("BlockerNode") && debug_str.contains("id: \"test\""),
            "Debug output should contain BlockerNode and id field"
        );
    }

    #[test]
    fn test_blockers_result_debug() {
        let result = BlockersResult {
            task_id: "test".to_string(),
            task_title: "Test".to_string(),
            blockers: vec![],
            total_count: 0,
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("BlockersResult") && debug_str.contains("task_id: \"test\""),
            "Debug output should contain BlockersResult and task_id field"
        );
    }
}
