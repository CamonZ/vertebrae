//! List command for displaying tasks
//!
//! Implements the `vtb list` command to display tasks with filtering options.

use clap::Args;
use vertebrae_core::{Level, Priority, TaskFilter};
use vertebrae_core::{ServiceError, VertebraeServices};

/// A summary of a task for display in the list
#[derive(Debug, Clone)]
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
    /// Optional priority
    pub priority: Option<String>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
    /// Parent task ID (if any)
    pub parent_id: Option<String>,
}

/// List tasks with optional filters
#[derive(Debug, Args)]
pub struct ListCommand {
    /// Filter by level (can be specified multiple times)
    #[arg(short, long = "level", value_parser = parse_level)]
    pub levels: Vec<Level>,

    /// Filter by status (can be specified multiple times)
    #[arg(short, long = "status")]
    pub statuses: Vec<String>,

    /// Filter by priority (can be specified multiple times)
    #[arg(short, long = "priority", value_parser = parse_priority)]
    pub priorities: Vec<Priority>,

    /// Filter by tag (can be specified multiple times)
    #[arg(short, long = "tag")]
    pub tags: Vec<String>,

    /// Filter by workflow ID (tasks assigned to a specific workflow)
    #[arg(short = 'w', long = "workflow", value_parser = crate::commands::parse_uuid("workflow ID"))]
    pub workflow: Option<String>,

    /// Filter by current step name within the workflow
    #[arg(long = "step")]
    pub step: Option<String>,

    /// Show only root items (no parent)
    #[arg(long)]
    pub root: bool,

    /// Show children of a specific parent task
    #[arg(long, value_parser = crate::commands::parse_uuid("parent ID"))]
    pub parent: Option<String>,

    /// Include done items (excluded by default)
    #[arg(long)]
    pub all: bool,

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

/// Convert core Task to CLI TaskSummary
impl From<vertebrae_core::Task> for TaskSummary {
    fn from(task: vertebrae_core::Task) -> Self {
        TaskSummary {
            id: task.id,
            title: task.title,
            level: task.level.as_str().to_string(),
            workflow_name: task.workflow_name,
            step_name: task.step_name,
            priority: task.priority.map(|p| p.as_str().to_string()),
            tags: task.tags,
            needs_human_review: task.needs_human_review,
            parent_id: task.parent_id,
        }
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
    /// - Invalid filter values are provided
    /// - Search query is empty
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

        // Add step filter
        if let Some(ref step_name) = self.step {
            filter = filter.with_current_step(step_name);
        }

        // Set structural filters
        if self.root {
            filter = filter.root_only();
        }

        if let Some(ref parent_id) = self.parent {
            filter = filter.children_of(parent_id);
        }

        // Include done items if --all is specified
        if self.all {
            filter = filter.include_done();
        }

        // Add search filter
        if let Some(ref search) = self.search {
            filter = filter.with_search(search);
        }

        filter
    }
}
