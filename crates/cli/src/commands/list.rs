//! List command for displaying tasks
//!
//! Implements the `vtb list` command to display tasks with filtering options.

use clap::Args;
use vertebrae_db::{Database, DbError, Level, Priority, Status, TaskFilter};

/// A summary of a task for display in the list
#[derive(Debug, Clone)]
pub struct TaskSummary {
    /// The task ID (extracted from SurrealDB Thing)
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level
    pub level: String,
    /// Current status
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
    #[arg(short, long = "status", value_parser = parse_status)]
    pub statuses: Vec<Status>,

    /// Filter by priority (can be specified multiple times)
    #[arg(short, long = "priority", value_parser = parse_priority)]
    pub priorities: Vec<Priority>,

    /// Filter by tag (can be specified multiple times)
    #[arg(short, long = "tag")]
    pub tags: Vec<String>,

    /// Show only root items (no parent)
    #[arg(long)]
    pub root: bool,

    /// Show children of a specific task
    #[arg(long)]
    pub children: Option<String>,

    /// Include done items (excluded by default)
    #[arg(long)]
    pub all: bool,

    /// Search text in title and description (case-insensitive)
    #[arg(long)]
    pub search: Option<String>,
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

/// Parse a status string into a Status enum
fn parse_status(s: &str) -> Result<Status, String> {
    Status::parse(&s.to_lowercase()).ok_or_else(|| {
        format!(
            "invalid status '{}'. Valid values: backlog, todo, in_progress, pending_review, done, rejected",
            s
        )
    })
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

/// Convert repository TaskSummary to CLI TaskSummary
impl From<vertebrae_db::TaskSummary> for TaskSummary {
    fn from(summary: vertebrae_db::TaskSummary) -> Self {
        TaskSummary {
            id: summary.id,
            title: summary.title,
            level: summary.level.as_str().to_string(),
            status: summary.status.as_str().to_string(),
            priority: summary.priority.map(|p| p.as_str().to_string()),
            tags: summary.tags,
            needs_human_review: summary.needs_human_review,
        }
    }
}

impl ListCommand {
    /// Execute the list command.
    ///
    /// Queries tasks from the database with the specified filters and returns
    /// a list of task summaries. Uses the repository pattern to delegate
    /// query building to the database layer.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - Database query fails
    /// - Invalid filter values are provided
    /// - Search query is empty
    pub async fn execute(&self, db: &Database) -> Result<Vec<TaskSummary>, DbError> {
        // Validate search query is not empty
        if let Some(ref search) = self.search
            && search.trim().is_empty()
        {
            return Err(DbError::ValidationError {
                message: "Search query cannot be empty".to_string(),
            });
        }

        // Build the TaskFilter from command options
        let filter = self.build_filter();

        // Use the repository to execute the query
        let results = db.list_tasks().list(&filter).await?;

        // Convert repository TaskSummary to CLI TaskSummary
        Ok(results.into_iter().map(TaskSummary::from).collect())
    }

    /// Build a TaskFilter from the command options.
    ///
    /// Converts the CLI arguments into a TaskFilter that can be passed
    /// to the repository layer.
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

        // Set structural filters
        if self.root {
            filter = filter.root_only();
        }

        if let Some(ref parent_id) = self.children {
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
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-list-test-{}-{:?}-{}",
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
    async fn create_task(
        db: &Database,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
        priority: Option<&str>,
        tags: &[&str],
    ) {
        let priority_str = match priority {
            Some(p) => format!("\"{}\"", p),
            None => "NONE".to_string(),
        };

        let tags_str = if tags.is_empty() {
            "[]".to_string()
        } else {
            format!(
                "[{}]",
                tags.iter()
                    .map(|t| format!("\"{}\"", t))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                status = "{}",
                priority = {},
                tags = {}"#,
            id, title, level, status, priority_str, tags_str
        );

        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a child_of relationship
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

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
    fn test_parse_status_valid() {
        assert_eq!(parse_status("backlog").unwrap(), Status::Backlog);
        assert_eq!(parse_status("todo").unwrap(), Status::Todo);
        assert_eq!(parse_status("in_progress").unwrap(), Status::InProgress);
        assert_eq!(
            parse_status("pending_review").unwrap(),
            Status::PendingReview
        );
        assert_eq!(parse_status("done").unwrap(), Status::Done);
        assert_eq!(parse_status("rejected").unwrap(), Status::Rejected);
    }

    #[test]
    fn test_parse_status_case_insensitive() {
        assert_eq!(parse_status("TODO").unwrap(), Status::Todo);
        assert_eq!(parse_status("In_Progress").unwrap(), Status::InProgress);
        assert_eq!(parse_status("DONE").unwrap(), Status::Done);
        assert_eq!(
            parse_status("PENDING_REVIEW").unwrap(),
            Status::PendingReview
        );
    }

    #[test]
    fn test_parse_status_invalid() {
        let result = parse_status("unknown");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid status"));
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

    #[tokio::test]
    async fn test_list_all_tasks_excludes_done_by_default() {
        let (db, temp_dir) = setup_test_db().await;

        // Create some tasks
        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "in_progress", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "done", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should have 2 tasks (excluding done)
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|t| t.status != "done"));

        // Verify specific tasks are included
        use std::collections::HashSet;
        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"), "Should contain task1");
        assert!(ids.contains("task2"), "Should contain task2");
        assert!(!ids.contains("task3"), "Should not contain done task");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_all_includes_done_with_flag() {
        let (db, temp_dir) = setup_test_db().await;

        // Create some tasks
        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "done", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: true,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should have all 2 tasks
        assert_eq!(result.len(), 2);

        // Verify specific tasks are included (including done task)
        use std::collections::HashSet;
        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"), "Should contain task1");
        assert!(
            ids.contains("task2"),
            "Should contain done task2 with --all flag"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_level() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "epic1", "Epic 1", "epic", "todo", None, &[]).await;
        create_task(&db, "ticket1", "Ticket 1", "ticket", "todo", None, &[]).await;
        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].level, "epic");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_multiple_levels() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "epic1", "Epic 1", "epic", "todo", None, &[]).await;
        create_task(&db, "ticket1", "Ticket 1", "ticket", "todo", None, &[]).await;
        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![Level::Epic, Level::Ticket],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(
            result
                .iter()
                .all(|t| t.level == "epic" || t.level == "ticket")
        );

        // Verify specific tasks are included
        use std::collections::HashSet;
        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("epic1"), "Should contain epic1");
        assert!(ids.contains("ticket1"), "Should contain ticket1");
        assert!(
            !ids.contains("task1"),
            "Should not contain task1 (level=task)"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_status() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "backlog", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "in_progress", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![Status::Backlog],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, "backlog");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_priority() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", Some("high"), &[]).await;
        create_task(&db, "task2", "Task 2", "task", "todo", Some("low"), &[]).await;
        create_task(&db, "task3", "Task 3", "task", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![Priority::High],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].priority, Some("high".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_tag() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &["backend"]).await;
        create_task(&db, "task2", "Task 2", "task", "todo", None, &["frontend"]).await;
        create_task(
            &db,
            "task3",
            "Task 3",
            "task",
            "todo",
            None,
            &["backend", "api"],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec!["backend".to_string()],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(
            result
                .iter()
                .all(|t| t.tags.contains(&"backend".to_string()))
        );

        // Verify specific tasks are included
        use std::collections::HashSet;
        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(
            ids.contains("task1"),
            "Should contain task1 (has backend tag)"
        );
        assert!(
            ids.contains("task3"),
            "Should contain task3 (has backend tag)"
        );
        assert!(
            !ids.contains("task2"),
            "Should not contain task2 (only has frontend tag)"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_root_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent and child tasks
        create_task(&db, "parent1", "Parent Epic", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child Ticket", "ticket", "todo", None, &[]).await;
        create_task(&db, "orphan1", "Orphan Task", "task", "todo", None, &[]).await;

        // Create parent-child relationship
        create_child_of(&db, "child1", "parent1").await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: true,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should have 2 root tasks (parent1 and orphan1, but not child1)
        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|t| t.id == "parent1"));
        assert!(result.iter().any(|t| t.id == "orphan1"));
        assert!(!result.iter().any(|t| t.id == "child1"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_of_task() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent and child tasks
        create_task(&db, "parent1", "Parent Epic", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child 1", "ticket", "todo", None, &[]).await;
        create_task(&db, "child2", "Child 2", "ticket", "todo", None, &[]).await;
        create_task(&db, "other1", "Other Task", "task", "todo", None, &[]).await;

        // Create parent-child relationships
        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: Some("parent1".to_string()),
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should have 2 children
        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|t| t.id == "child1"));
        assert!(result.iter().any(|t| t.id == "child2"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_nonexistent_parent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: Some("nonexistent".to_string()),
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should return empty list
        assert!(result.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_empty_database() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        assert!(result.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_combined_filters() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "task1",
            "Task 1",
            "epic",
            "todo",
            Some("high"),
            &["backend"],
        )
        .await;
        create_task(
            &db,
            "task2",
            "Task 2",
            "epic",
            "todo",
            Some("low"),
            &["backend"],
        )
        .await;
        create_task(
            &db,
            "task3",
            "Task 3",
            "ticket",
            "todo",
            Some("high"),
            &["backend"],
        )
        .await;
        create_task(
            &db,
            "task4",
            "Task 4",
            "epic",
            "done",
            Some("high"),
            &["backend"],
        )
        .await;

        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![],
            priorities: vec![Priority::High],
            tags: vec!["backend".to_string()],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should match task1 only (epic + high priority + backend tag + not done)
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_root_with_level_filter() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "epic1", "Epic", "epic", "todo", None, &[]).await;
        create_task(&db, "ticket1", "Ticket", "ticket", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: true,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].level, "epic");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_build_filter_with_all_options() {
        let cmd = ListCommand {
            levels: vec![Level::Epic, Level::Ticket],
            statuses: vec![Status::Todo, Status::InProgress],
            priorities: vec![Priority::High],
            tags: vec!["backend".to_string(), "api".to_string()],
            root: true,
            children: None,
            all: true,
            search: Some("test query".to_string()),
        };

        let filter = cmd.build_filter();

        assert_eq!(filter.levels.len(), 2);
        assert_eq!(filter.statuses.len(), 2);
        assert_eq!(filter.priorities.len(), 1);
        assert_eq!(filter.tags.len(), 2);
        assert!(filter.root_only);
        assert!(filter.children_of.is_none());
        assert!(filter.include_done);
        assert_eq!(filter.search, Some("test query".to_string()));
    }

    #[test]
    fn test_build_filter_with_children() {
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: Some("parent123".to_string()),
            all: false,
            search: None,
        };

        let filter = cmd.build_filter();

        assert!(!filter.root_only);
        assert_eq!(filter.children_of, Some("parent123".to_string()));
        assert!(!filter.include_done);
        assert!(filter.search.is_none());
    }

    #[test]
    fn test_build_filter_empty() {
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: None,
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
    fn test_task_summary_from_db_task_summary() {
        // Test conversion from repository TaskSummary to CLI TaskSummary
        let db_summary = vertebrae_db::TaskSummary {
            id: "abc123".to_string(),
            title: "Test Task".to_string(),
            level: Level::Ticket,
            status: Status::InProgress,
            priority: Some(Priority::Medium),
            tags: vec!["test".to_string()],
            needs_human_review: Some(true),
        };

        let summary = TaskSummary::from(db_summary);

        assert_eq!(summary.id, "abc123");
        assert_eq!(summary.title, "Test Task");
        assert_eq!(summary.level, "ticket");
        assert_eq!(summary.status, "in_progress");
        assert_eq!(summary.priority, Some("medium".to_string()));
        assert_eq!(summary.tags, vec!["test".to_string()]);
        assert_eq!(summary.needs_human_review, Some(true));
    }

    #[test]
    fn test_task_summary_clone() {
        let summary = TaskSummary {
            id: "123".to_string(),
            title: "Test".to_string(),
            level: "task".to_string(),
            status: "todo".to_string(),
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
        assert!(
            debug_str.contains("TaskSummary")
                && debug_str.contains("id: \"abc123\"")
                && debug_str.contains("title: \"Test Task\"")
                && debug_str.contains("level: \"ticket\"")
                && debug_str.contains("status: \"in_progress\"")
                && debug_str.contains("high")
                && debug_str.contains("backend")
                && debug_str.contains("needs_human_review"),
            "Debug output should contain TaskSummary and all field values"
        );
    }

    #[test]
    fn test_list_command_debug() {
        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![Status::Todo],
            priorities: vec![Priority::High],
            tags: vec!["backend".to_string()],
            root: true,
            children: Some("parent123".to_string()),
            all: true,
            search: Some("test query".to_string()),
        };

        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("ListCommand")
                && debug_str.contains("Epic")
                && debug_str.contains("Todo")
                && debug_str.contains("High")
                && debug_str.contains("backend")
                && debug_str.contains("root: true")
                && debug_str.contains("parent123")
                && debug_str.contains("all: true")
                && debug_str.contains("search")
                && debug_str.contains("test query"),
            "Debug output should contain ListCommand and all field values"
        );
    }

    // ========================================
    // Search functionality tests
    // ========================================
    // Note: Unit tests for escape_search_string and build_search_condition
    // have been moved to the repository layer (crates/db/src/repository/filter.rs)
    // since the search SQL building is now handled there.

    /// Helper to create a task with description
    async fn create_task_with_description(
        db: &Database,
        id: &str,
        title: &str,
        description: &str,
        level: &str,
        status: &str,
    ) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                description = "{}",
                level = "{}",
                status = "{}",
                priority = NONE,
                tags = []"#,
            id, title, description, level, status
        );
        db.client().query(&query).await.unwrap();
    }

    #[tokio::test]
    async fn test_search_finds_task_by_title() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "task1",
            "Authentication feature",
            "task",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(
            &db,
            "task2",
            "Database migration",
            "task",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(&db, "task3", "API endpoint", "task", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("auth".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");
        assert_eq!(result[0].title, "Authentication feature");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_finds_task_by_description() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_description(
            &db,
            "task1",
            "Feature A",
            "Implement user authentication system",
            "task",
            "todo",
        )
        .await;
        create_task_with_description(
            &db,
            "task2",
            "Feature B",
            "Add database caching",
            "task",
            "todo",
        )
        .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("authentication".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_is_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "task1",
            "AUTHENTICATION Feature",
            "task",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(&db, "task2", "Other task", "task", "todo", None, &[]).await;

        // Search with lowercase should find uppercase title
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("authentication".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");

        // Search with uppercase should also find
        let cmd2 = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("AUTHENTICATION".to_string()),
        };

        let result2 = cmd2.execute(&db).await.unwrap();

        assert_eq!(result2.len(), 1);
        assert_eq!(result2[0].id, "task1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_with_no_matches_returns_empty() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task A", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Task B", "task", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("nonexistent".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        assert!(result.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_combined_with_status_filter() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Auth task todo", "task", "todo", None, &[]).await;
        create_task(
            &db,
            "task2",
            "Auth task in_progress",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(&db, "task3", "Other task", "task", "todo", None, &[]).await;

        // Search for "auth" but only in_progress status
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![Status::InProgress],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("auth".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_combined_with_level_filter() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "epic1", "Auth epic", "epic", "todo", None, &[]).await;
        create_task(&db, "task1", "Auth task", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Other task", "task", "todo", None, &[]).await;

        // Search for "auth" but only epic level
        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("auth".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "epic1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_empty_string_returns_error() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("".to_string()),
        };

        let result = cmd.execute(&db).await;

        assert!(result.is_err());
        match result {
            Err(DbError::ValidationError { message }) => {
                assert_eq!(message, "Search query cannot be empty");
            }
            _ => panic!("Expected ValidationError"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_whitespace_only_returns_error() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("   ".to_string()),
        };

        let result = cmd.execute(&db).await;

        assert!(result.is_err());
        match result {
            Err(DbError::ValidationError { message }) => {
                assert_eq!(message, "Search query cannot be empty");
            }
            _ => panic!("Expected ValidationError"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_with_root_flag() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Auth Parent", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Auth Child", "task", "todo", None, &[]).await;
        create_task(&db, "other1", "Other Parent", "epic", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;

        // Search for "auth" with root flag - should only return root task
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: true,
            children: None,
            all: false,
            search: Some("auth".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "parent1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_with_children_flag() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Auth Child", "task", "todo", None, &[]).await;
        create_task(&db, "child2", "Other Child", "task", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;

        // Search for "auth" among children of parent1
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: Some("parent1".to_string()),
            all: false,
            search: Some("auth".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "child1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_with_special_characters() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test task", "task", "todo", None, &[]).await;

        // Search with quotes - should not cause SQL injection
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("test\" OR 1=1 --".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should return empty (no SQL injection)
        assert!(result.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_search_with_null_description() {
        let (db, temp_dir) = setup_test_db().await;

        // Create task without description
        create_task(&db, "task1", "Auth Feature", "task", "todo", None, &[]).await;
        // Create task with description
        create_task_with_description(&db, "task2", "Other", "auth in description", "task", "todo")
            .await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
            search: Some("auth".to_string()),
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should find both tasks (one in title, one in description)
        assert_eq!(result.len(), 2);

        let ids: std::collections::HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_tag_or_semantics_preserved() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &["backend"]).await;
        create_task(&db, "task2", "Task 2", "task", "todo", None, &["frontend"]).await;
        create_task(
            &db,
            "task3",
            "Task 3",
            "task",
            "todo",
            None,
            &["backend", "api"],
        )
        .await;
        create_task(&db, "task4", "Task 4", "task", "todo", None, &["other"]).await;

        // Filter by multiple tags (OR semantics)
        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec!["backend".to_string(), "frontend".to_string()],
            root: false,
            children: None,
            all: false,
            search: None,
        };

        let result = cmd.execute(&db).await.unwrap();

        // Should find 3 tasks (task1, task2, task3 - any with backend OR frontend)
        assert_eq!(result.len(), 3);

        let ids: std::collections::HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));
        assert!(ids.contains("task3"));
        assert!(!ids.contains("task4"));

        cleanup(&temp_dir);
    }
}
