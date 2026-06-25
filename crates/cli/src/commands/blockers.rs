//! Blockers command for displaying blocking tasks
//!
//! Implements the `vtb blockers` command to show all tasks blocking a given task,
//! recursively traversing the dependency graph.

use clap::Args;
use serde::Serialize;
use vertebrae_core::{ServiceError, Task, VertebraeServices};

/// Show all tasks blocking a given task
#[derive(Debug, Args)]
pub struct BlockersCommand {
    /// Task ID to show blockers for (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Maximum depth to traverse (default: unlimited)
    #[arg(long, short = 'd')]
    pub depth: Option<usize>,

    /// Include blockers whose current workflow step is done
    #[arg(long, short = 'a')]
    pub all: bool,
}

/// A node in the blocker tree
#[derive(Debug, Clone, Serialize)]
pub struct BlockerNode {
    /// Task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level
    pub level: String,
    /// Current step name (if assigned to workflow)
    pub step_name: Option<String>,
    /// Child blockers (tasks that this task depends on)
    pub children: Vec<BlockerNode>,
}

/// Result of the blockers command execution
#[derive(Debug, Serialize)]
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

impl BlockersCommand {
    /// Execute the blockers command.
    ///
    /// Recursively traverses the dependency graph to find all tasks
    /// blocking the specified task.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Service operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<BlockersResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch the target task to verify it exists and get its title
        let task = services.tasks().get_task(&id).await?;

        // Build the blocker tree
        let blockers = self.build_blocker_tree(services, &task, 0).await?;

        // Count total blockers
        let total_count = count_nodes(&blockers);

        Ok(BlockersResult {
            task_id: id,
            task_title: task.title,
            blockers,
            total_count,
        })
    }

    /// Build the blocker tree recursively.
    ///
    /// Uses depth tracking to build the tree structure while respecting
    /// the optional depth limit.
    async fn build_blocker_tree(
        &self,
        services: &VertebraeServices,
        task: &Task,
        current_depth: usize,
    ) -> Result<Vec<BlockerNode>, ServiceError> {
        // Check depth limit
        if let Some(max_depth) = self.depth
            && current_depth >= max_depth
        {
            return Ok(vec![]);
        }

        // At the root, reuse the blockers embedded in the task fetched by execute().
        // Deeper nodes fetch their own task so transitive blockers are materialized.
        let direct_blockers = if current_depth == 0 {
            self.visible_blockers(task.blockers.clone())
        } else {
            self.fetch_direct_blockers(services, &task.id).await?
        };

        // Build nodes for each direct blocker
        let mut nodes = Vec::new();
        for blocker in direct_blockers {
            let blocker_id = blocker.id.clone();

            // Recursively get children (blockers of this blocker)
            let children =
                Box::pin(self.build_blocker_tree(services, &blocker, current_depth + 1)).await?;

            nodes.push(BlockerNode {
                id: blocker_id,
                title: blocker.title,
                level: blocker.level.to_string(),
                step_name: Some(
                    blocker
                        .step_name
                        .clone()
                        .unwrap_or_else(|| "backlog".to_string()),
                ),
                children,
            });
        }

        Ok(nodes)
    }

    /// Fetch direct blockers for a task (tasks it depends on).
    ///
    /// By default, hides blockers that have a completion timestamp.
    /// When `--all` is set, returns blockers regardless of completion status.
    async fn fetch_direct_blockers(
        &self,
        services: &VertebraeServices,
        task_id: &str,
    ) -> Result<Vec<vertebrae_core::Task>, ServiceError> {
        // Get the task to access its embedded blockers.
        let task = services.tasks().get_task(task_id).await?;
        Ok(self.visible_blockers(task.blockers))
    }

    fn visible_blockers(&self, blockers: Vec<Task>) -> Vec<Task> {
        blockers
            .into_iter()
            .filter(|blocker| self.all || blocker.completed_at.is_none())
            .collect()
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
    let status_display = format!("{:12}", node.step_name.as_deref().unwrap_or("unassigned"));

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

    fn blocker(id: &str, step_name: &str, completed: bool) -> Task {
        let mut task = Task::new(format!("Blocker {id}"), vertebrae_core::Level::Task);
        task.id = id.to_string();
        task.step_name = Some(step_name.to_string());
        if completed {
            task.completed_at = Some(chrono::Utc::now());
        }
        task
    }

    #[test]
    fn visible_blockers_filters_by_completed_at_not_step_name() {
        let command = BlockersCommand {
            id: "target".to_string(),
            depth: None,
            all: false,
        };
        let blockers = vec![
            blocker("completed-review", "review", true),
            blocker("open-done-step", "done", false),
            blocker("open-review", "review", false),
        ];

        let visible = command.visible_blockers(blockers);

        let ids: Vec<_> = visible.into_iter().map(|task| task.id).collect();
        assert_eq!(ids, vec!["open-done-step", "open-review"]);
    }

    #[test]
    fn visible_blockers_all_keeps_completed_blockers_for_display() {
        let command = BlockersCommand {
            id: "target".to_string(),
            depth: None,
            all: true,
        };
        let blockers = vec![blocker("completed-review", "review", true)];

        let visible = command.visible_blockers(blockers);

        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "completed-review");
        assert_eq!(visible[0].step_name.as_deref(), Some("review"));
    }

    #[test]
    fn test_blockers_result_serializes_to_json() {
        let result = BlockersResult {
            task_id: "abc12345".to_string(),
            task_title: "Main task".to_string(),
            blockers: vec![BlockerNode {
                id: "blocker1".to_string(),
                title: "Blocker one".to_string(),
                level: "ticket".to_string(),
                step_name: Some("in_progress".to_string()),
                children: vec![BlockerNode {
                    id: "blocker2".to_string(),
                    title: "Nested blocker".to_string(),
                    level: "task".to_string(),
                    step_name: None,
                    children: vec![],
                }],
            }],
            total_count: 2,
        };

        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["task_id"], "abc12345");
        assert_eq!(json["task_title"], "Main task");
        assert_eq!(json["total_count"], 2);

        let blockers = json["blockers"].as_array().unwrap();
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0]["id"], "blocker1");
        assert_eq!(blockers[0]["step_name"], "in_progress");

        let nested = blockers[0]["children"].as_array().unwrap();
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0]["id"], "blocker2");
        assert!(nested[0]["step_name"].is_null());
    }

    #[test]
    fn test_empty_blockers_result_serializes() {
        let result = BlockersResult {
            task_id: "abc12345".to_string(),
            task_title: "No blockers".to_string(),
            blockers: vec![],
            total_count: 0,
        };

        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["total_count"], 0);
        assert!(json["blockers"].as_array().unwrap().is_empty());
    }
}
