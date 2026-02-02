//! Blockers command for displaying blocking tasks
//!
//! Implements the `vtb blockers` command to show all tasks blocking a given task,
//! recursively traversing the dependency graph.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Show all tasks blocking a given task
#[derive(Debug, Args)]
pub struct BlockersCommand {
    /// Task ID to find blockers for (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Maximum depth to traverse (default: unlimited)
    #[arg(long, short = 'd')]
    pub depth: Option<usize>,

    /// Include completed blockers (status = done) in output
    #[arg(long, short = 'a')]
    pub all: bool,
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
        let blockers = self.build_blocker_tree(services, &id, 0).await?;

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
        task_id: &str,
        current_depth: usize,
    ) -> Result<Vec<BlockerNode>, ServiceError> {
        // Check depth limit
        if let Some(max_depth) = self.depth
            && current_depth >= max_depth
        {
            return Ok(vec![]);
        }

        // Get direct blockers (tasks that this task depends on)
        let direct_blockers = self.fetch_direct_blockers(services, task_id).await?;

        // Build nodes for each direct blocker
        let mut nodes = Vec::new();
        for blocker in direct_blockers {
            let blocker_id = blocker.id.clone();

            // Recursively get children (blockers of this blocker)
            let children =
                Box::pin(self.build_blocker_tree(services, &blocker_id, current_depth + 1)).await?;

            nodes.push(BlockerNode {
                id: blocker_id,
                title: blocker.title,
                level: blocker.level.to_string(),
                status: blocker.status.to_string(),
                children,
            });
        }

        Ok(nodes)
    }

    /// Fetch direct blockers for a task (tasks it depends on).
    ///
    /// By default, only returns incomplete blockers (status != done).
    /// When `--all` flag is set, returns all blockers including completed ones.
    async fn fetch_direct_blockers(
        &self,
        services: &VertebraeServices,
        task_id: &str,
    ) -> Result<Vec<vertebrae_core::Task>, ServiceError> {
        // Get tasks that this task depends on via the depends_on relationship
        // Using service layer method that returns full task details
        let blockers = services.tasks().get_dependencies(task_id).await?;

        // Fetch full task details for each blocker
        let mut result = Vec::new();
        for blocker_id in blockers {
            // Get the blocker task
            if let Ok(mut task) = services.tasks().get_task(&blocker_id).await {
                // Get step name and workflow name using WorkflowService
                let (step_name, workflow_name) = if let (Some(step_id), Some(wf_id)) =
                    (&task.current_step_id, &task.workflow_id)
                {
                    // Use WorkflowService.get_workflow_info() instead of direct database calls
                    let workflow_info = services
                        .workflows()
                        .get_workflow_info(wf_id, Some(step_id.as_str()))
                        .await
                        .ok();
                    (
                        workflow_info
                            .as_ref()
                            .map(|info| info.current_step_name.clone())
                            .unwrap_or_else(|| "backlog".to_string()),
                        workflow_info.map(|info| info.name),
                    )
                } else {
                    ("backlog".to_string(), None)
                };

                // By default, filter out completed blockers (step = done)
                if !self.all && step_name == "done" {
                    continue;
                }

                task.status = step_name.clone();
                task.workflow_name = workflow_name;
                task.step_name = Some(step_name);
                result.push(task);
            }
        }

        Ok(result)
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
