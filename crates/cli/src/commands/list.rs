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
    /// Derived status (workflow:step if available, else raw status)
    pub status: String,
    /// Optional priority
    pub priority: Option<String>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
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
    #[arg(short = 'w', long = "workflow")]
    pub workflow: Option<String>,

    /// Filter by current step name within the workflow
    #[arg(long = "step")]
    pub step: Option<String>,

    /// Show only root items (no parent)
    #[arg(long)]
    pub root: bool,

    /// Show children of a specific parent task
    #[arg(long)]
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

/// Compute the derived status from workflow and step names with IDs
///
/// Returns `workflow_name:step_name (workflow:id, step:id)` if all are present,
/// otherwise falls back to the raw status string.
fn compute_derived_status(
    status: &str,
    workflow_name: Option<&str>,
    step_name: Option<&str>,
    workflow_id: Option<&str>,
    step_id: Option<&str>,
) -> String {
    match (workflow_name, step_name) {
        (Some(wf), Some(step)) => {
            let ids_suffix = match (workflow_id, step_id) {
                (Some(wf_id), Some(s_id)) => format!(" (workflow:{}, step:{})", wf_id, s_id),
                (Some(wf_id), None) => format!(" (workflow:{})", wf_id),
                _ => String::new(),
            };
            format!("{}:{}{}", wf, step, ids_suffix)
        }
        _ => status.to_string(),
    }
}

/// Convert repository TaskSummary to CLI TaskSummary
impl From<vertebrae_core::TaskSummary> for TaskSummary {
    fn from(summary: vertebrae_core::TaskSummary) -> Self {
        let derived_status = compute_derived_status(
            &summary.status,
            summary.workflow_name.as_deref(),
            summary.step_name.as_deref(),
            summary.workflow_id.as_deref(),
            summary.current_step_id.as_deref(),
        );

        TaskSummary {
            id: summary.id,
            title: summary.title,
            level: summary.level.as_str().to_string(),
            status: derived_status,
            priority: summary.priority.map(|p| p.as_str().to_string()),
            tags: summary.tags,
            needs_human_review: summary.needs_human_review,
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
            filter = filter.with_statuses(self.statuses.clone());
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

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::{CreateTaskOptions, Database, VertebraeServices};

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> VertebraeServices {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    /// Helper to create a task via the service layer
    async fn create_task(
        services: &VertebraeServices,
        id: &str,
        title: &str,
        level: Level,
        status: &str,
        priority: Option<Priority>,
        tags: &[&str],
    ) {
        let mut options = CreateTaskOptions::new(title)
            .with_id(id)
            .with_level(level)
            .with_status(status);

        if let Some(p) = priority {
            options = options.with_priority(p);
        }

        for tag in tags {
            options = options.with_tag(*tag);
        }

        services.tasks().create_task(options).await.unwrap();
    }

    /// Helper to create a child_of relationship via the service layer
    async fn create_child_of(services: &VertebraeServices, child_id: &str, parent_id: &str) {
        services
            .tasks()
            .set_parent(child_id, parent_id)
            .await
            .unwrap();
    }

    // ========================================
    // Parser tests
    // ========================================

    #[test]
    fn test_parse_level_valid() {
        assert_eq!(parse_level("epic").unwrap(), Level::Epic);
        assert_eq!(parse_level("ticket").unwrap(), Level::Ticket);
        assert_eq!(parse_level("task").unwrap(), Level::Task);
    }

    #[test]
    fn test_parse_level_case_insensitive() {
        assert_eq!(parse_level("EPIC").unwrap(), Level::Epic);
        assert_eq!(parse_level("Epic").unwrap(), Level::Epic);
        assert_eq!(parse_level("TICKET").unwrap(), Level::Ticket);
    }

    #[test]
    fn test_parse_level_invalid() {
        let result = parse_level("invalid");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid level"));
    }

    #[test]
    fn test_parse_priority_valid() {
        assert_eq!(parse_priority("low").unwrap(), Priority::Low);
        assert_eq!(parse_priority("medium").unwrap(), Priority::Medium);
        assert_eq!(parse_priority("high").unwrap(), Priority::High);
        assert_eq!(parse_priority("critical").unwrap(), Priority::Critical);
    }

    #[test]
    fn test_parse_priority_case_insensitive() {
        assert_eq!(parse_priority("LOW").unwrap(), Priority::Low);
        assert_eq!(parse_priority("High").unwrap(), Priority::High);
        assert_eq!(parse_priority("CRITICAL").unwrap(), Priority::Critical);
    }

    #[test]
    fn test_parse_priority_invalid() {
        let result = parse_priority("wrong");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid priority"));
    }

    // ========================================
    // compute_derived_status tests
    // ========================================

    #[test]
    fn test_compute_derived_status_with_workflow_and_step() {
        let result = compute_derived_status(
            "in_progress",
            Some("Default Workflow"),
            Some("active"),
            Some("wf123"),
            Some("step456"),
        );
        assert_eq!(
            result,
            "Default Workflow:active (workflow:wf123, step:step456)"
        );
    }

    #[test]
    fn test_compute_derived_status_with_workflow_id_only() {
        let result = compute_derived_status(
            "in_progress",
            Some("Default Workflow"),
            Some("active"),
            Some("wf123"),
            None,
        );
        assert_eq!(result, "Default Workflow:active (workflow:wf123)");
    }

    #[test]
    fn test_compute_derived_status_no_ids() {
        let result = compute_derived_status(
            "in_progress",
            Some("Default Workflow"),
            Some("active"),
            None,
            None,
        );
        assert_eq!(result, "Default Workflow:active");
    }

    #[test]
    fn test_compute_derived_status_no_workflow() {
        let result = compute_derived_status("backlog", None, None, None, None);
        assert_eq!(result, "backlog");
    }

    #[test]
    fn test_compute_derived_status_partial_workflow_info() {
        let result = compute_derived_status("in_progress", Some("Workflow"), None, None, None);
        assert_eq!(result, "in_progress");
    }

    // ========================================
    // TaskSummary conversion tests
    // ========================================

    #[test]
    fn test_task_summary_from_core_summary() {
        let core_summary = vertebrae_core::TaskSummary {
            id: "abc123".to_string(),
            title: "Test Task".to_string(),
            level: Level::Ticket,
            status: "in_progress".to_string(),
            priority: Some(Priority::Medium),
            tags: vec!["test".to_string()],
            needs_human_review: Some(true),
            created_at: chrono::Utc::now(),
            workflow_id: None,
            current_step_id: None,
            workflow_name: None,
            step_name: None,
        };

        let summary = TaskSummary::from(core_summary);

        assert_eq!(summary.id, "abc123");
        assert_eq!(summary.title, "Test Task");
        assert_eq!(summary.level, "ticket");
        assert_eq!(summary.status, "in_progress");
        assert_eq!(summary.priority, Some("medium".to_string()));
        assert_eq!(summary.tags, vec!["test".to_string()]);
        assert_eq!(summary.needs_human_review, Some(true));
    }

    #[test]
    fn test_task_summary_from_core_summary_with_workflow() {
        let core_summary = vertebrae_core::TaskSummary {
            id: "abc123".to_string(),
            title: "Test Task".to_string(),
            level: Level::Ticket,
            status: "in_progress".to_string(),
            priority: Some(Priority::Medium),
            tags: vec!["test".to_string()],
            needs_human_review: Some(true),
            created_at: chrono::Utc::now(),
            workflow_id: Some("wf123".to_string()),
            current_step_id: Some("wf123_active".to_string()),
            workflow_name: Some("Default Workflow".to_string()),
            step_name: Some("active".to_string()),
        };

        let summary = TaskSummary::from(core_summary);

        assert_eq!(
            summary.status,
            "Default Workflow:active (workflow:wf123, step:wf123_active)"
        );
    }

    #[test]
    fn test_task_summary_clone() {
        let summary = TaskSummary {
            id: "123".to_string(),
            title: "Test".to_string(),
            level: "task".to_string(),
            status: "in_progress".to_string(),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string(), "urgent".to_string()],
            needs_human_review: Some(true),
        };

        let cloned = summary.clone();
        assert_eq!(summary.id, cloned.id);
        assert_eq!(summary.title, cloned.title);
        assert_eq!(summary.level, cloned.level);
        assert_eq!(summary.status, cloned.status);
        assert_eq!(summary.priority, cloned.priority);
        assert_eq!(summary.tags, cloned.tags);
        assert_eq!(summary.needs_human_review, cloned.needs_human_review);
    }

    #[test]
    fn test_task_summary_debug() {
        let summary = TaskSummary {
            id: "abc123".to_string(),
            title: "Test Task".to_string(),
            level: "ticket".to_string(),
            status: "in_progress".to_string(),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string()],
            needs_human_review: Some(true),
        };

        let debug_str = format!("{:?}", summary);
        assert!(debug_str.contains("TaskSummary"));
        assert!(debug_str.contains("abc123"));
        assert!(debug_str.contains("Test Task"));
    }

    // ========================================
    // build_filter tests
    // ========================================

    #[test]
    fn test_build_filter_empty() {
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let filter = cmd.build_filter();

        assert!(filter.levels.is_empty());
        assert!(filter.statuses.is_empty());
        assert!(filter.priorities.is_empty());
        assert!(filter.tags.is_empty());
        assert!(!filter.root_only);
        assert!(filter.children_of.is_none());
        assert!(!filter.include_done);
        assert!(filter.search.is_none());
    }

    #[test]
    fn test_build_filter_with_all_options() {
        let cmd = ListCommand {
            levels: vec![Level::Epic, Level::Ticket],
            statuses: vec!["in_progress".to_string()],
            priorities: vec![Priority::High],
            tags: vec!["backend".to_string(), "api".to_string()],
            workflow: Some("wf123".to_string()),
            step: Some("review".to_string()),
            root: true,
            parent: None,
            all: true,
            search: Some("test query".to_string()),
            flat: false,
        };

        let filter = cmd.build_filter();

        assert_eq!(filter.levels.len(), 2);
        assert_eq!(filter.statuses.len(), 1);
        assert_eq!(filter.priorities.len(), 1);
        assert_eq!(filter.tags.len(), 2);
        assert!(filter.root_only);
        assert!(filter.children_of.is_none());
        assert!(filter.include_done);
        assert_eq!(filter.search, Some("test query".to_string()));
    }

    #[test]
    fn test_build_filter_with_parent() {
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: Some("parent123".to_string()),
            all: false,
            search: None,
            flat: false,
        };

        let filter = cmd.build_filter();

        assert!(!filter.root_only);
        assert_eq!(filter.children_of, Some("parent123".to_string()));
        assert!(!filter.include_done);
    }

    #[test]
    fn test_list_command_debug() {
        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec!["in_progress".to_string()],
            priorities: vec![Priority::High],
            tags: vec!["backend".to_string()],
            workflow: None,
            step: None,
            root: true,
            parent: Some("parent123".to_string()),
            all: true,
            search: Some("test query".to_string()),
            flat: false,
        };

        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("ListCommand"));
        assert!(debug_str.contains("Epic"));
        assert!(debug_str.contains("in_progress"));
    }

    // ========================================
    // Async execution tests
    // ========================================

    #[tokio::test]
    async fn test_list_empty_database() {
        let services = setup_test_service().await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_list_excludes_done_by_default() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "task2",
            "Task 2",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(&services, "task3", "Task 3", Level::Task, "done", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 2);

        let ids: std::collections::HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));
        assert!(!ids.contains("task3"));
    }

    #[tokio::test]
    async fn test_list_includes_done_with_all_flag() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(&services, "task2", "Task 2", Level::Task, "done", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: true,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 2);
    }

    #[tokio::test]
    async fn test_list_filter_by_level() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "epic1",
            "Epic 1",
            Level::Epic,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "ticket1",
            "Ticket 1",
            Level::Ticket,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].level, "epic");
    }

    #[tokio::test]
    async fn test_list_filter_by_multiple_levels() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "epic1",
            "Epic 1",
            Level::Epic,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "ticket1",
            "Ticket 1",
            Level::Ticket,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![Level::Epic, Level::Ticket],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 2);
        assert!(
            result
                .iter()
                .all(|t| t.level == "epic" || t.level == "ticket")
        );
    }

    #[tokio::test]
    async fn test_list_filter_by_priority() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Task,
            "in_progress",
            Some(Priority::High),
            &[],
        )
        .await;
        create_task(
            &services,
            "task2",
            "Task 2",
            Level::Task,
            "in_progress",
            Some(Priority::Low),
            &[],
        )
        .await;
        create_task(
            &services,
            "task3",
            "Task 3",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![Priority::High],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].priority, Some("high".to_string()));
    }

    #[tokio::test]
    async fn test_list_filter_by_tag() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Task,
            "in_progress",
            None,
            &["backend"],
        )
        .await;
        create_task(
            &services,
            "task2",
            "Task 2",
            Level::Task,
            "in_progress",
            None,
            &["frontend"],
        )
        .await;
        create_task(
            &services,
            "task3",
            "Task 3",
            Level::Task,
            "in_progress",
            None,
            &["backend", "api"],
        )
        .await;
        create_task(
            &services,
            "task4",
            "Task 4",
            Level::Task,
            "in_progress",
            None,
            &["other"],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec!["backend".to_string(), "frontend".to_string()],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 3);

        let ids: std::collections::HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));
        assert!(ids.contains("task3"));
        assert!(!ids.contains("task4"));
    }

    #[tokio::test]
    async fn test_list_root_tasks() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "parent1",
            "Parent",
            Level::Epic,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "child1",
            "Child",
            Level::Ticket,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "orphan1",
            "Orphan",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        create_child_of(&services, "child1", "parent1").await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: true,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|t| t.id == "parent1"));
        assert!(result.iter().any(|t| t.id == "orphan1"));
        assert!(!result.iter().any(|t| t.id == "child1"));
    }

    #[tokio::test]
    async fn test_list_children_of_task() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "parent1",
            "Parent",
            Level::Epic,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "child1",
            "Child 1",
            Level::Ticket,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "child2",
            "Child 2",
            Level::Ticket,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "other1",
            "Other",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        create_child_of(&services, "child1", "parent1").await;
        create_child_of(&services, "child2", "parent1").await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: Some("parent1".to_string()),
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|t| t.id == "child1"));
        assert!(result.iter().any(|t| t.id == "child2"));
    }

    #[tokio::test]
    async fn test_list_children_nonexistent_parent() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: Some("nonexistent".to_string()),
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_list_combined_filters() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Epic,
            "in_progress",
            Some(Priority::High),
            &["backend"],
        )
        .await;
        create_task(
            &services,
            "task2",
            "Task 2",
            Level::Epic,
            "in_progress",
            Some(Priority::Low),
            &["backend"],
        )
        .await;
        create_task(
            &services,
            "task3",
            "Task 3",
            Level::Ticket,
            "in_progress",
            Some(Priority::High),
            &["backend"],
        )
        .await;
        create_task(
            &services,
            "task4",
            "Task 4",
            Level::Epic,
            "done",
            Some(Priority::High),
            &["backend"],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![],
            priorities: vec![Priority::High],
            tags: vec!["backend".to_string()],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");
    }

    #[tokio::test]
    async fn test_list_search_by_title() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Authentication feature",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "task2",
            "Database migration",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: Some("auth".to_string()),
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");
    }

    #[tokio::test]
    async fn test_list_search_no_matches() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Task A",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: Some("nonexistent".to_string()),
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_list_search_empty_string_returns_error() {
        let services = setup_test_service().await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: Some("".to_string()),
            flat: false,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_search_whitespace_only_returns_error() {
        let services = setup_test_service().await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: Some("   ".to_string()),
            flat: false,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_search_combined_with_level_filter() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "epic1",
            "Auth epic",
            Level::Epic,
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "task1",
            "Auth task",
            Level::Task,
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: Some("auth".to_string()),
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "epic1");
    }

    #[tokio::test]
    async fn test_list_tag_or_semantics() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "Task 1",
            Level::Task,
            "in_progress",
            None,
            &["backend"],
        )
        .await;
        create_task(
            &services,
            "task2",
            "Task 2",
            Level::Task,
            "in_progress",
            None,
            &["frontend"],
        )
        .await;
        create_task(
            &services,
            "task3",
            "Task 3",
            Level::Task,
            "in_progress",
            None,
            &["backend", "api"],
        )
        .await;
        create_task(
            &services,
            "task4",
            "Task 4",
            Level::Task,
            "in_progress",
            None,
            &["other"],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec!["backend".to_string(), "frontend".to_string()],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            all: false,
            search: None,
            flat: false,
        };

        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.len(), 3);

        let ids: std::collections::HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));
        assert!(ids.contains("task3"));
        assert!(!ids.contains("task4"));
    }
}
