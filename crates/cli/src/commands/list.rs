//! List command for displaying tasks
//!
//! Implements the `vtb list` command to display tasks with filtering options.

use clap::Args;
use serde::Serialize;
use vertebrae_core::{Level, Priority, Task, TaskFilter};
use vertebrae_core::{ServiceError, VertebraeServices};

/// A summary of a task for display in the list
#[derive(Debug, Clone, Serialize)]
pub struct TaskSummary {
    /// The task ID (extracted from SurrealDB Thing)
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level
    pub level: String,
    /// Workflow name (if assigned)
    pub workflow_name: Option<String>,
    /// Current step name (if assigned)
    pub step_name: Option<String>,
    /// Active TaskRun lifecycle state, from runControls.activeRun.status.
    pub run_state: Option<String>,
    /// Active TaskRun ID, if a run is active.
    pub active_task_run_id: Option<String>,
    /// Latest step execution ID for the active TaskRun, if available.
    pub latest_step_execution_id: Option<String>,
    /// Optional priority
    pub priority: Option<String>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Whether this task is archived
    pub archived: bool,
    /// Parent task ID (if any)
    pub parent_id: Option<String>,
}

/// List tasks with optional filters
#[derive(Debug, Args)]
pub struct ListCommand {
    /// Filter by level (can be specified multiple times)
    #[arg(short, long = "level", value_parser = parse_level)]
    pub levels: Vec<Level>,

    /// Filter by workflow step name (can be specified multiple times)
    #[arg(short, long = "status")]
    pub statuses: Vec<String>,

    /// Filter by priority (can be specified multiple times)
    #[arg(short, long = "priority", value_parser = parse_priority)]
    pub priorities: Vec<Priority>,

    /// Filter by tag (can be specified multiple times)
    #[arg(short, long = "tag")]
    pub tags: Vec<String>,

    /// Filter by workflow ID or short ID (tasks assigned to a specific workflow)
    #[arg(short = 'w', long = "workflow", value_parser = crate::commands::parse_uuid("workflow ID"))]
    pub workflow: Option<String>,

    /// Filter by current step UUID or short ID (tasks whose current_step_id matches)
    #[arg(long = "step", value_parser = crate::commands::parse_uuid("step ID"))]
    pub step: Option<String>,

    /// Show only root items (no parent)
    #[arg(long)]
    pub root: bool,

    /// Show children of a specific parent task ID or short ID
    #[arg(long, value_parser = crate::commands::parse_uuid("parent ID"))]
    pub parent: Option<String>,

    /// Include archived items (excluded by default)
    #[arg(long)]
    pub include_archived: bool,

    /// Search text in title and description (case-insensitive)
    #[arg(long)]
    pub search: Option<String>,

    /// Display tasks as a flat table (tree is default)
    #[arg(long)]
    pub flat: bool,
}

/// Parse a level string into a Level enum
fn parse_level(s: &str) -> Result<Level, String> {
    match s.to_lowercase().as_str() {
        "epic" => Ok(Level::Epic),
        "ticket" => Ok(Level::Ticket),
        "task" => Ok(Level::Task),
        _ => Err(format!(
            "invalid level '{}'. Valid values: epic, ticket, task",
            s
        )),
    }
}

/// Parse a priority string into a Priority enum
fn parse_priority(s: &str) -> Result<Priority, String> {
    match s.to_lowercase().as_str() {
        "low" => Ok(Priority::Low),
        "medium" => Ok(Priority::Medium),
        "high" => Ok(Priority::High),
        "critical" => Ok(Priority::Critical),
        _ => Err(format!(
            "invalid priority '{}'. Valid values: low, medium, high, critical",
            s
        )),
    }
}

/// Convert a core Task to CLI TaskSummary.
impl From<&Task> for TaskSummary {
    fn from(task: &Task) -> Self {
        let (run_state, active_task_run_id, latest_step_execution_id) = task
            .run_controls
            .as_ref()
            .and_then(|controls| controls.active_run.as_ref())
            .map(|run| {
                (
                    Some(run.status.to_string()),
                    Some(run.id.clone()),
                    run.latest_step_execution_id.clone(),
                )
            })
            .unwrap_or((None, None, None));
        TaskSummary {
            id: task.id.clone(),
            title: task.title.clone(),
            level: task.level.as_str().to_string(),
            workflow_name: task.workflow_name.clone(),
            step_name: task.step_name.clone(),
            run_state,
            active_task_run_id,
            latest_step_execution_id,
            priority: task.priority.as_ref().map(|p| p.as_str().to_string()),
            tags: task.tags.clone(),
            archived: task.archived,
            parent_id: task.parent_id.clone(),
        }
    }
}

impl From<Task> for TaskSummary {
    fn from(task: Task) -> Self {
        Self::from(&task)
    }
}

impl ListCommand {
    /// Execute the list command.
    ///
    /// Queries tasks from the service layer with the specified filters and returns
    /// a list of task summaries. Uses the service layer to ensure mutations are
    /// properly handled and cache invalidation is triggered.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - Service query fails
    /// - Search query is empty or whitespace-only
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<Vec<TaskSummary>, ServiceError> {
        // Validate search query is not empty
        if let Some(ref search) = self.search
            && search.trim().is_empty()
        {
            return Err(ServiceError::validation_failed(
                "Search query cannot be empty",
            ));
        }

        // Build the TaskFilter from command options
        let filter = self.build_filter();

        // Use the service layer to execute the query
        let results = services.tasks().list_tasks(&filter).await?;

        // Convert service TaskSummary to CLI TaskSummary
        Ok(results.into_iter().map(TaskSummary::from).collect())
    }

    /// Build a TaskFilter from the command options.
    ///
    /// Converts the CLI arguments into a TaskFilter that can be passed
    /// to the service layer.
    fn build_filter(&self) -> TaskFilter {
        let mut filter = TaskFilter::new();

        // Add level filters
        if !self.levels.is_empty() {
            filter = filter.with_levels(self.levels.clone());
        }

        // Add status filters
        if !self.statuses.is_empty() {
            filter = filter.with_step_names(self.statuses.clone());
        }

        // Add priority filters
        if !self.priorities.is_empty() {
            filter = filter.with_priorities(self.priorities.clone());
        }

        // Add tag filters
        if !self.tags.is_empty() {
            filter = filter.with_tags(self.tags.clone());
        }

        // Add workflow filter
        if let Some(ref workflow_id) = self.workflow {
            filter = filter.with_workflow_id(workflow_id);
        }

        // Add step filter (by UUID, forwards to TaskFilter.step_id)
        if let Some(ref step_id) = self.step {
            filter = filter.with_step_id(step_id);
        }

        // Set structural filters
        if self.root {
            filter = filter.root_only();
        }

        if let Some(ref parent_id) = self.parent {
            filter = filter.children_of(parent_id);
        }

        // Include archived items if --include-archived is specified
        if self.include_archived {
            filter = filter.include_archived();
        }

        // Add search filter
        if let Some(ref search) = self.search {
            filter = filter.with_search(search);
        }

        filter
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_summary_serializes_to_json() {
        let summary = TaskSummary {
            id: "abc12345-0000-4000-8000-000000000001".to_string(),
            title: "Test task".to_string(),
            level: "ticket".to_string(),
            workflow_name: Some("Implementation".to_string()),
            step_name: Some("todo".to_string()),
            run_state: Some("executing".to_string()),
            active_task_run_id: Some("run-1".to_string()),
            latest_step_execution_id: Some("exec-1".to_string()),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string()],
            archived: false,
            parent_id: Some("parent-0000-4000-8000-000000000001".to_string()),
        };

        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["id"], "abc12345-0000-4000-8000-000000000001");
        assert_eq!(json["title"], "Test task");
        assert_eq!(json["level"], "ticket");
        assert_eq!(json["workflow_name"], "Implementation");
        assert_eq!(json["step_name"], "todo");
        assert_eq!(json["run_state"], "executing");
        assert_eq!(json["active_task_run_id"], "run-1");
        assert_eq!(json["latest_step_execution_id"], "exec-1");
        assert_eq!(json["priority"], "high");
        assert_eq!(json["tags"][0], "backend");
        assert_eq!(json["archived"], false);
        assert_eq!(json["parent_id"], "parent-0000-4000-8000-000000000001");
    }

    #[test]
    fn test_task_summary_list_serializes_to_json_array() {
        let tasks = vec![
            TaskSummary {
                id: "task1".to_string(),
                title: "First".to_string(),
                level: "epic".to_string(),
                workflow_name: None,
                step_name: None,
                run_state: None,
                active_task_run_id: None,
                latest_step_execution_id: None,
                priority: None,
                tags: vec![],
                archived: false,
                parent_id: None,
            },
            TaskSummary {
                id: "task2".to_string(),
                title: "Second".to_string(),
                level: "task".to_string(),
                workflow_name: None,
                step_name: None,
                run_state: None,
                active_task_run_id: None,
                latest_step_execution_id: None,
                priority: None,
                tags: vec![],
                archived: false,
                parent_id: None,
            },
        ];

        let json = serde_json::to_value(&tasks).unwrap();
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], "task1");
        assert_eq!(arr[1]["id"], "task2");
    }

    #[test]
    fn test_task_summary_with_null_optional_fields() {
        let summary = TaskSummary {
            id: "task1".to_string(),
            title: "Minimal task".to_string(),
            level: "task".to_string(),
            workflow_name: None,
            step_name: None,
            run_state: None,
            active_task_run_id: None,
            latest_step_execution_id: None,
            priority: None,
            tags: vec![],
            archived: false,
            parent_id: None,
        };

        let json = serde_json::to_value(&summary).unwrap();
        assert!(json["workflow_name"].is_null());
        assert!(json["step_name"].is_null());
        assert!(json["run_state"].is_null());
        assert!(json["active_task_run_id"].is_null());
        assert!(json["latest_step_execution_id"].is_null());
        assert!(json["priority"].is_null());
        assert!(json["parent_id"].is_null());
        assert!(json["tags"].as_array().unwrap().is_empty());
    }
}
