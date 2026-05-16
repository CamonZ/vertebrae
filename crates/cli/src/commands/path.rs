//! Path command for finding dependency paths between tasks
//!
//! Implements the `vtb path` command to find the shortest dependency path
//! between two tasks using BFS traversal of the dependency graph.

use clap::Args;
use serde::Serialize;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Find the dependency path between two tasks
#[derive(Debug, Args)]
pub struct PathCommand {
    /// Source task ID (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("from task ID"))]
    pub from_id: String,

    /// Target task ID (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("to task ID"))]
    pub to_id: String,
}

/// A task summary for path display
#[derive(Debug, Clone, Serialize)]
pub struct TaskSummary {
    /// Task ID
    pub id: String,
    /// Task title
    pub title: String,
}

/// Result of the path command execution
#[derive(Debug, Serialize)]
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
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - Either task does not exist
    /// - Database operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<PathResult, ServiceError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let from_id = self.from_id.to_lowercase();
        let to_id = self.to_id.to_lowercase();

        // Validate both tasks exist using the service
        let from_task = services.tasks().get_task(&from_id).await?;
        let _to_task = services.tasks().get_task(&to_id).await?;

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

        // Find the path using the service
        let path_ids = services.tasks().find_path(&from_id, &to_id).await?;

        // Convert path IDs to TaskSummary with titles
        let path = match path_ids {
            Some(ids) => {
                let mut summaries = Vec::new();
                for id in ids {
                    let task = services.tasks().get_task(&id).await?;
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
