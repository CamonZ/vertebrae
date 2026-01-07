//! List command for displaying tasks
//!
//! Implements the `vtb list` command to display tasks with filtering options.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError, Level, Priority, Status};

/// A summary of a task for display in the list
#[derive(Debug, Clone, Deserialize)]
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
    #[serde(default)]
    pub tags: Vec<String>,
    /// Whether this task needs human review
    #[serde(default)]
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
    match s.to_lowercase().as_str() {
        "todo" => Ok(Status::Todo),
        "in_progress" => Ok(Status::InProgress),
        "done" => Ok(Status::Done),
        "blocked" => Ok(Status::Blocked),
        _ => Err(format!(
            "invalid status '{}'. Valid values: todo, in_progress, done, blocked",
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

/// Result from querying tasks - handles SurrealDB Thing id format
#[derive(Debug, Deserialize)]
struct TaskRow {
    id: surrealdb::sql::Thing,
    title: String,
    level: String,
    status: String,
    priority: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    needs_human_review: Option<bool>,
}

impl From<TaskRow> for TaskSummary {
    fn from(row: TaskRow) -> Self {
        TaskSummary {
            id: row.id.id.to_string(),
            title: row.title,
            level: row.level,
            status: row.status,
            priority: row.priority,
            tags: row.tags,
            needs_human_review: row.needs_human_review,
        }
    }
}

impl ListCommand {
    /// Execute the list command.
    ///
    /// Queries tasks from the database with the specified filters and returns
    /// a list of task summaries.
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
    pub async fn execute(&self, db: &Database) -> Result<Vec<TaskSummary>, DbError> {
        // Handle --children filter separately (uses graph traversal)
        if let Some(parent_id) = &self.children {
            return self.query_children(db, parent_id).await;
        }

        // Handle --root filter separately
        if self.root {
            return self.query_root_tasks(db).await;
        }

        // Build and execute the standard query
        self.query_tasks(db).await
    }

    /// Query tasks with standard filters
    async fn query_tasks(&self, db: &Database) -> Result<Vec<TaskSummary>, DbError> {
        let mut conditions: Vec<String> = Vec::new();

        // Default: exclude done status unless --all is specified
        if !self.all && self.statuses.is_empty() {
            conditions.push("status != \"done\"".to_string());
        }

        // Level filter (OR within type)
        if !self.levels.is_empty() {
            let level_conditions: Vec<String> = self
                .levels
                .iter()
                .map(|l| format!("level = \"{}\"", l.as_str()))
                .collect();
            conditions.push(format!("({})", level_conditions.join(" OR ")));
        }

        // Status filter (OR within type)
        if !self.statuses.is_empty() {
            let status_conditions: Vec<String> = self
                .statuses
                .iter()
                .map(|s| format!("status = \"{}\"", s.as_str()))
                .collect();
            conditions.push(format!("({})", status_conditions.join(" OR ")));
        }

        // Priority filter (OR within type)
        if !self.priorities.is_empty() {
            let priority_conditions: Vec<String> = self
                .priorities
                .iter()
                .map(|p| format!("priority = \"{}\"", p.as_str()))
                .collect();
            conditions.push(format!("({})", priority_conditions.join(" OR ")));
        }

        // Tag filter (OR within type - task must have at least one matching tag)
        if !self.tags.is_empty() {
            let tag_conditions: Vec<String> = self
                .tags
                .iter()
                .map(|t| format!("\"{}\" IN tags", t.replace('\"', "\\\"")))
                .collect();
            conditions.push(format!("({})", tag_conditions.join(" OR ")));
        }

        // Build the query
        let query = if conditions.is_empty() {
            "SELECT id, title, level, status, priority, tags, needs_human_review FROM task"
                .to_string()
        } else {
            format!(
                "SELECT id, title, level, status, priority, tags, needs_human_review FROM task WHERE {}",
                conditions.join(" AND ")
            )
        };

        let mut result = db.client().query(&query).await?;
        let rows: Vec<TaskRow> = result.take(0)?;

        Ok(rows.into_iter().map(TaskSummary::from).collect())
    }

    /// Query children of a specific task using graph traversal
    async fn query_children(
        &self,
        db: &Database,
        parent_id: &str,
    ) -> Result<Vec<TaskSummary>, DbError> {
        // Use graph traversal to find children
        // SELECT <-child_of<-task.* FROM task:parent_id gets all tasks that are children of parent_id
        let query = format!(
            "SELECT id, title, level, status, priority, tags, needs_human_review FROM task WHERE ->child_of->task CONTAINS task:{}",
            parent_id
        );

        let mut result = db.client().query(&query).await?;
        let rows: Vec<TaskRow> = result.take(0)?;

        let mut tasks: Vec<TaskSummary> = rows.into_iter().map(TaskSummary::from).collect();

        // Apply additional filters if specified
        tasks = self.apply_post_filters(tasks);

        Ok(tasks)
    }

    /// Query root tasks (tasks with no parent)
    async fn query_root_tasks(&self, db: &Database) -> Result<Vec<TaskSummary>, DbError> {
        // Root tasks are those that have no outgoing child_of edges
        // (i.e., they are not children of any other task)
        let mut conditions: Vec<String> = vec!["array::len(->child_of->task) = 0".to_string()];

        // Default: exclude done status unless --all is specified
        if !self.all && self.statuses.is_empty() {
            conditions.push("status != \"done\"".to_string());
        }

        // Level filter
        if !self.levels.is_empty() {
            let level_conditions: Vec<String> = self
                .levels
                .iter()
                .map(|l| format!("level = \"{}\"", l.as_str()))
                .collect();
            conditions.push(format!("({})", level_conditions.join(" OR ")));
        }

        // Status filter
        if !self.statuses.is_empty() {
            let status_conditions: Vec<String> = self
                .statuses
                .iter()
                .map(|s| format!("status = \"{}\"", s.as_str()))
                .collect();
            conditions.push(format!("({})", status_conditions.join(" OR ")));
        }

        // Priority filter
        if !self.priorities.is_empty() {
            let priority_conditions: Vec<String> = self
                .priorities
                .iter()
                .map(|p| format!("priority = \"{}\"", p.as_str()))
                .collect();
            conditions.push(format!("({})", priority_conditions.join(" OR ")));
        }

        // Tag filter
        if !self.tags.is_empty() {
            let tag_conditions: Vec<String> = self
                .tags
                .iter()
                .map(|t| format!("\"{}\" IN tags", t.replace('\"', "\\\"")))
                .collect();
            conditions.push(format!("({})", tag_conditions.join(" OR ")));
        }

        let query = format!(
            "SELECT id, title, level, status, priority, tags, needs_human_review FROM task WHERE {}",
            conditions.join(" AND ")
        );

        let mut result = db.client().query(&query).await?;
        let rows: Vec<TaskRow> = result.take(0)?;

        Ok(rows.into_iter().map(TaskSummary::from).collect())
    }

    /// Apply post-query filters (used for children query)
    fn apply_post_filters(&self, tasks: Vec<TaskSummary>) -> Vec<TaskSummary> {
        tasks
            .into_iter()
            .filter(|task| {
                // Filter by done status unless --all
                if !self.all && self.statuses.is_empty() && task.status == "done" {
                    return false;
                }

                // Filter by level if specified
                if !self.levels.is_empty() && !self.levels.iter().any(|l| l.as_str() == task.level)
                {
                    return false;
                }

                // Filter by status if specified
                if !self.statuses.is_empty()
                    && !self.statuses.iter().any(|s| s.as_str() == task.status)
                {
                    return false;
                }

                // Filter by priority if specified
                if !self.priorities.is_empty() {
                    match &task.priority {
                        Some(p) => {
                            if !self.priorities.iter().any(|pr| pr.as_str() == p) {
                                return false;
                            }
                        }
                        None => return false,
                    }
                }

                // Filter by tags if specified
                if !self.tags.is_empty() && !self.tags.iter().any(|t| task.tags.contains(t)) {
                    return false;
                }

                true
            })
            .collect()
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
        assert_eq!(parse_status("todo").unwrap(), Status::Todo);
        assert_eq!(parse_status("in_progress").unwrap(), Status::InProgress);
        assert_eq!(parse_status("done").unwrap(), Status::Done);
        assert_eq!(parse_status("blocked").unwrap(), Status::Blocked);
    }

    #[test]
    fn test_parse_status_case_insensitive() {
        assert_eq!(parse_status("TODO").unwrap(), Status::Todo);
        assert_eq!(parse_status("In_Progress").unwrap(), Status::InProgress);
        assert_eq!(parse_status("DONE").unwrap(), Status::Done);
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
        create_task(&db, "task2", "Task 2", "task", "blocked", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "in_progress", None, &[]).await;

        let cmd = ListCommand {
            levels: vec![],
            statuses: vec![Status::Blocked],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, "blocked");

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
        };

        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].level, "epic");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_apply_post_filters() {
        let tasks = vec![
            TaskSummary {
                id: "1".to_string(),
                title: "Task 1".to_string(),
                level: "epic".to_string(),
                status: "todo".to_string(),
                priority: Some("high".to_string()),
                tags: vec!["backend".to_string()],
                needs_human_review: None,
            },
            TaskSummary {
                id: "2".to_string(),
                title: "Task 2".to_string(),
                level: "ticket".to_string(),
                status: "done".to_string(),
                priority: Some("low".to_string()),
                tags: vec!["frontend".to_string()],
                needs_human_review: None,
            },
        ];

        let cmd = ListCommand {
            levels: vec![Level::Epic],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            root: false,
            children: None,
            all: false,
        };

        let filtered = cmd.apply_post_filters(tasks);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].level, "epic");
    }

    #[tokio::test]
    async fn test_task_summary_from_task_row() {
        let row = TaskRow {
            id: surrealdb::sql::Thing::from(("task", "abc123")),
            title: "Test Task".to_string(),
            level: "ticket".to_string(),
            status: "in_progress".to_string(),
            priority: Some("medium".to_string()),
            tags: vec!["test".to_string()],
            needs_human_review: Some(true),
        };

        let summary = TaskSummary::from(row);

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
                && debug_str.contains("all: true"),
            "Debug output should contain ListCommand and all field values"
        );
    }
}
