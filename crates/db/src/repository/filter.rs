//! Task filtering and listing queries
//!
//! Provides a builder-pattern TaskFilter and TaskLister for querying
//! tasks with complex filter combinations.

use crate::error::DbResult;
use crate::models::{Level, Priority, Status};
use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;

/// A summary of a task for display in listings
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSummary {
    /// The task ID (extracted from SurrealDB Thing)
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level
    pub level: Level,
    /// Current status
    pub status: Status,
    /// Optional priority
    pub priority: Option<Priority>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
}

/// Internal row type for deserializing from SurrealDB
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
    /// Created timestamp - used by SQL ORDER BY for sorting, must be selected to match query
    #[allow(dead_code)]
    created_at: surrealdb::sql::Datetime,
}

impl TaskRow {
    /// Convert a TaskRow to a TaskSummary
    fn into_summary(self) -> TaskSummary {
        TaskSummary {
            id: self.id.id.to_string(),
            title: self.title,
            level: parse_level(&self.level),
            status: parse_status(&self.status),
            priority: self.priority.as_deref().map(parse_priority),
            tags: self.tags,
            needs_human_review: self.needs_human_review,
        }
    }
}

/// Parse a level string into a Level enum
fn parse_level(s: &str) -> Level {
    match s {
        "epic" => Level::Epic,
        "ticket" => Level::Ticket,
        _ => Level::Task,
    }
}

/// Parse a status string into a Status enum
fn parse_status(s: &str) -> Status {
    Status::parse(s).unwrap_or(Status::Todo)
}

/// Parse a priority string into a Priority enum
fn parse_priority(s: &str) -> Priority {
    match s {
        "low" => Priority::Low,
        "medium" => Priority::Medium,
        "high" => Priority::High,
        "critical" => Priority::Critical,
        _ => Priority::Medium,
    }
}

/// Filter criteria for listing tasks
///
/// Supports filtering by level, status, priority, tags, and structural
/// relationships (root-only or children of a specific parent).
///
/// All filter criteria use OR semantics within the same type
/// (e.g., multiple statuses means "match any of these statuses")
/// and AND semantics across different types.
#[derive(Debug, Clone, Default)]
pub struct TaskFilter {
    /// Filter by levels (OR semantics)
    pub levels: Vec<Level>,
    /// Filter by statuses (OR semantics)
    pub statuses: Vec<Status>,
    /// Filter by priorities (OR semantics)
    pub priorities: Vec<Priority>,
    /// Filter by tags (OR semantics - task must have at least one matching tag)
    pub tags: Vec<String>,
    /// Show only root items (no parent)
    pub root_only: bool,
    /// Show only children of a specific task
    pub children_of: Option<String>,
    /// Include done items (excluded by default)
    pub include_done: bool,
    /// Search text in title and description (case-insensitive)
    pub search: Option<String>,
}

impl TaskFilter {
    /// Create a new empty filter
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a level to filter by
    pub fn with_level(mut self, level: Level) -> Self {
        self.levels.push(level);
        self
    }

    /// Add multiple levels to filter by
    pub fn with_levels(mut self, levels: impl IntoIterator<Item = Level>) -> Self {
        self.levels.extend(levels);
        self
    }

    /// Add a status to filter by
    pub fn with_status(mut self, status: Status) -> Self {
        self.statuses.push(status);
        self
    }

    /// Add multiple statuses to filter by
    pub fn with_statuses(mut self, statuses: impl IntoIterator<Item = Status>) -> Self {
        self.statuses.extend(statuses);
        self
    }

    /// Add a priority to filter by
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priorities.push(priority);
        self
    }

    /// Add multiple priorities to filter by
    pub fn with_priorities(mut self, priorities: impl IntoIterator<Item = Priority>) -> Self {
        self.priorities.extend(priorities);
        self
    }

    /// Add a tag to filter by
    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    /// Add multiple tags to filter by
    pub fn with_tags(mut self, tags: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.tags.extend(tags.into_iter().map(|t| t.into()));
        self
    }

    /// Filter to only root items (no parent)
    pub fn root_only(mut self) -> Self {
        self.root_only = true;
        self
    }

    /// Filter to children of a specific task
    pub fn children_of(mut self, parent_id: impl Into<String>) -> Self {
        self.children_of = Some(parent_id.into());
        self
    }

    /// Include done items (excluded by default)
    pub fn include_done(mut self) -> Self {
        self.include_done = true;
        self
    }

    /// Set search text (case-insensitive search in title and description)
    pub fn with_search(mut self, search: impl Into<String>) -> Self {
        self.search = Some(search.into());
        self
    }

    /// Check if this filter has any structural constraints (root or children_of)
    #[allow(dead_code)] // Useful for future optimizations and tests
    fn has_structural_filter(&self) -> bool {
        self.root_only || self.children_of.is_some()
    }
}

/// Repository for listing tasks with filters
///
/// Provides methods to query tasks from the database with various
/// filter criteria applied.
pub struct TaskLister<'a> {
    client: &'a Surreal<Db>,
}

impl<'a> TaskLister<'a> {
    /// Create a new TaskLister with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// List tasks matching the given filter
    ///
    /// # Arguments
    ///
    /// * `filter` - The filter criteria to apply
    ///
    /// # Returns
    ///
    /// A vector of task summaries matching the filter.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database query fails.
    pub async fn list(&self, filter: &TaskFilter) -> DbResult<Vec<TaskSummary>> {
        // Handle children_of filter separately (uses graph traversal)
        if let Some(parent_id) = &filter.children_of {
            return self.query_children(parent_id, filter).await;
        }

        // Handle root filter separately
        if filter.root_only {
            return self.query_root_tasks(filter).await;
        }

        // Build and execute the standard query
        self.query_tasks(filter).await
    }

    /// Query tasks with standard filters
    async fn query_tasks(&self, filter: &TaskFilter) -> DbResult<Vec<TaskSummary>> {
        let conditions = self.build_filter_conditions(filter);

        let query = if conditions.is_empty() {
            "SELECT id, title, level, status, priority, tags, needs_human_review, created_at FROM task ORDER BY created_at DESC"
                .to_string()
        } else {
            format!(
                "SELECT id, title, level, status, priority, tags, needs_human_review, created_at FROM task WHERE {} ORDER BY created_at DESC",
                conditions.join(" AND ")
            )
        };

        let mut result = self.client.query(&query).await?;
        let rows: Vec<TaskRow> = result.take(0)?;

        Ok(rows.into_iter().map(|r| r.into_summary()).collect())
    }

    /// Query children of a specific task using graph traversal
    async fn query_children(
        &self,
        parent_id: &str,
        filter: &TaskFilter,
    ) -> DbResult<Vec<TaskSummary>> {
        // Build query with graph traversal condition plus search filter at SQL level
        let mut conditions = vec![format!("->child_of->task CONTAINS task:{}", parent_id)];

        // Add search filter at SQL level (since description is not in TaskSummary)
        if let Some(ref search) = filter.search {
            conditions.push(Self::build_search_condition(search));
        }

        let query = format!(
            "SELECT id, title, level, status, priority, tags, needs_human_review, created_at FROM task WHERE {} ORDER BY created_at DESC",
            conditions.join(" AND ")
        );

        let mut result = self.client.query(&query).await?;
        let rows: Vec<TaskRow> = result.take(0)?;

        let tasks: Vec<TaskSummary> = rows.into_iter().map(|r| r.into_summary()).collect();

        // Apply post-filters for other criteria (preserves sort order from SQL)
        Ok(self.apply_post_filters(tasks, filter))
    }

    /// Query root tasks (tasks with no parent)
    async fn query_root_tasks(&self, filter: &TaskFilter) -> DbResult<Vec<TaskSummary>> {
        let mut conditions = vec!["array::len(->child_of->task) = 0".to_string()];

        // Add other filter conditions
        conditions.extend(self.build_filter_conditions(filter));

        let query = format!(
            "SELECT id, title, level, status, priority, tags, needs_human_review, created_at FROM task WHERE {} ORDER BY created_at DESC",
            conditions.join(" AND ")
        );

        let mut result = self.client.query(&query).await?;
        let rows: Vec<TaskRow> = result.take(0)?;

        Ok(rows.into_iter().map(|r| r.into_summary()).collect())
    }

    /// Build filter condition strings for the WHERE clause
    fn build_filter_conditions(&self, filter: &TaskFilter) -> Vec<String> {
        let mut conditions: Vec<String> = Vec::new();

        // Default: exclude done status unless include_done is set or statuses are specified
        if !filter.include_done && filter.statuses.is_empty() {
            conditions.push("status != \"done\"".to_string());
        }

        // Level filter (OR within type)
        if !filter.levels.is_empty() {
            let level_conditions: Vec<String> = filter
                .levels
                .iter()
                .map(|l| format!("level = \"{}\"", l.as_str()))
                .collect();
            conditions.push(format!("({})", level_conditions.join(" OR ")));
        }

        // Status filter (OR within type)
        if !filter.statuses.is_empty() {
            let status_conditions: Vec<String> = filter
                .statuses
                .iter()
                .map(|s| format!("status = \"{}\"", s.as_str()))
                .collect();
            conditions.push(format!("({})", status_conditions.join(" OR ")));
        }

        // Priority filter (OR within type)
        if !filter.priorities.is_empty() {
            let priority_conditions: Vec<String> = filter
                .priorities
                .iter()
                .map(|p| format!("priority = \"{}\"", p.as_str()))
                .collect();
            conditions.push(format!("({})", priority_conditions.join(" OR ")));
        }

        // Tag filter (OR within type - task must have at least one matching tag)
        if !filter.tags.is_empty() {
            let tag_conditions: Vec<String> = filter
                .tags
                .iter()
                .map(|t| format!("\"{}\" IN tags", t.replace('\"', "\\\"")))
                .collect();
            conditions.push(format!("({})", tag_conditions.join(" OR ")));
        }

        // Search filter (case-insensitive, searches title and description)
        if let Some(ref search) = filter.search {
            conditions.push(Self::build_search_condition(search));
        }

        conditions
    }

    /// Escape special characters in search string for safe SQL inclusion.
    ///
    /// Escapes characters that could be used for SQL injection or break string literals.
    fn escape_search_string(s: &str) -> String {
        s.replace('\\', "\\\\") // Escape backslashes first
            .replace('"', "\\\"") // Escape double quotes
            .replace('\'', "\\'") // Escape single quotes
    }

    /// Build search condition for case-insensitive title and description search.
    ///
    /// Returns a condition that matches if the search query appears in either
    /// the title or description (case-insensitive). Description can be null,
    /// so we handle that case by defaulting to empty string.
    fn build_search_condition(search: &str) -> String {
        let escaped = Self::escape_search_string(search);
        let lower_search = escaped.to_lowercase();
        // Use string::lowercase for case-insensitive matching
        // Handle null description by using IFNULL (or description ?? "" in SurrealQL)
        format!(
            "(string::lowercase(title) CONTAINS \"{}\" OR string::lowercase(description ?? \"\") CONTAINS \"{}\")",
            lower_search, lower_search
        )
    }

    /// Apply post-query filters (used for children query where we can't use all SQL filters)
    fn apply_post_filters(&self, tasks: Vec<TaskSummary>, filter: &TaskFilter) -> Vec<TaskSummary> {
        tasks
            .into_iter()
            .filter(|task| {
                // Filter by done status unless include_done or statuses specified
                if !filter.include_done && filter.statuses.is_empty() && task.status == Status::Done
                {
                    return false;
                }

                // Filter by level if specified
                if !filter.levels.is_empty() && !filter.levels.contains(&task.level) {
                    return false;
                }

                // Filter by status if specified
                if !filter.statuses.is_empty() && !filter.statuses.contains(&task.status) {
                    return false;
                }

                // Filter by priority if specified
                if !filter.priorities.is_empty() {
                    match &task.priority {
                        Some(p) => {
                            if !filter.priorities.contains(p) {
                                return false;
                            }
                        }
                        None => return false,
                    }
                }

                // Filter by tags if specified
                if !filter.tags.is_empty() && !filter.tags.iter().any(|t| task.tags.contains(t)) {
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
    use crate::Database;
    use std::collections::HashSet;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-filter-test-{}-{:?}-{}",
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

    // ========================================
    // TaskFilter builder tests
    // ========================================

    #[test]
    fn test_task_filter_default() {
        let filter = TaskFilter::default();
        assert!(filter.levels.is_empty());
        assert!(filter.statuses.is_empty());
        assert!(filter.priorities.is_empty());
        assert!(filter.tags.is_empty());
        assert!(!filter.root_only);
        assert!(filter.children_of.is_none());
        assert!(!filter.include_done);
    }

    #[test]
    fn test_task_filter_new() {
        let filter = TaskFilter::new();
        assert!(filter.levels.is_empty());
        assert!(!filter.include_done);
    }

    #[test]
    fn test_task_filter_with_level() {
        let filter = TaskFilter::new().with_level(Level::Epic);
        assert_eq!(filter.levels, vec![Level::Epic]);
    }

    #[test]
    fn test_task_filter_with_levels() {
        let filter = TaskFilter::new().with_levels([Level::Epic, Level::Ticket]);
        assert_eq!(filter.levels, vec![Level::Epic, Level::Ticket]);
    }

    #[test]
    fn test_task_filter_with_status() {
        let filter = TaskFilter::new().with_status(Status::Todo);
        assert_eq!(filter.statuses, vec![Status::Todo]);
    }

    #[test]
    fn test_task_filter_with_statuses() {
        let filter = TaskFilter::new().with_statuses([Status::Todo, Status::InProgress]);
        assert_eq!(filter.statuses, vec![Status::Todo, Status::InProgress]);
    }

    #[test]
    fn test_task_filter_with_priority() {
        let filter = TaskFilter::new().with_priority(Priority::High);
        assert_eq!(filter.priorities, vec![Priority::High]);
    }

    #[test]
    fn test_task_filter_with_priorities() {
        let filter = TaskFilter::new().with_priorities([Priority::High, Priority::Critical]);
        assert_eq!(filter.priorities, vec![Priority::High, Priority::Critical]);
    }

    #[test]
    fn test_task_filter_with_tag() {
        let filter = TaskFilter::new().with_tag("backend");
        assert_eq!(filter.tags, vec!["backend"]);
    }

    #[test]
    fn test_task_filter_with_tags() {
        let filter = TaskFilter::new().with_tags(["backend", "api"]);
        assert_eq!(filter.tags, vec!["backend", "api"]);
    }

    #[test]
    fn test_task_filter_root_only() {
        let filter = TaskFilter::new().root_only();
        assert!(filter.root_only);
    }

    #[test]
    fn test_task_filter_children_of() {
        let filter = TaskFilter::new().children_of("parent123");
        assert_eq!(filter.children_of, Some("parent123".to_string()));
    }

    #[test]
    fn test_task_filter_include_done() {
        let filter = TaskFilter::new().include_done();
        assert!(filter.include_done);
    }

    #[test]
    fn test_task_filter_builder_chain() {
        let filter = TaskFilter::new()
            .with_level(Level::Epic)
            .with_status(Status::InProgress)
            .with_priority(Priority::High)
            .with_tag("urgent")
            .include_done();

        assert_eq!(filter.levels, vec![Level::Epic]);
        assert_eq!(filter.statuses, vec![Status::InProgress]);
        assert_eq!(filter.priorities, vec![Priority::High]);
        assert_eq!(filter.tags, vec!["urgent"]);
        assert!(filter.include_done);
    }

    #[test]
    fn test_task_filter_has_structural_filter() {
        let filter = TaskFilter::new();
        assert!(!filter.has_structural_filter());

        let filter = TaskFilter::new().root_only();
        assert!(filter.has_structural_filter());

        let filter = TaskFilter::new().children_of("parent");
        assert!(filter.has_structural_filter());
    }

    #[test]
    fn test_task_filter_clone() {
        let filter = TaskFilter::new()
            .with_level(Level::Epic)
            .with_tag("test")
            .root_only();

        let cloned = filter.clone();
        assert_eq!(filter.levels, cloned.levels);
        assert_eq!(filter.tags, cloned.tags);
        assert_eq!(filter.root_only, cloned.root_only);
    }

    #[test]
    fn test_task_filter_debug() {
        let filter = TaskFilter::new()
            .with_level(Level::Epic)
            .with_status(Status::Todo)
            .root_only();

        let debug_str = format!("{:?}", filter);
        assert!(debug_str.contains("TaskFilter"));
        assert!(debug_str.contains("Epic"));
        assert!(debug_str.contains("Todo"));
        assert!(debug_str.contains("root_only: true"));
    }

    // ========================================
    // TaskSummary tests
    // ========================================

    #[test]
    fn test_task_summary_clone() {
        let summary = TaskSummary {
            id: "123".to_string(),
            title: "Test".to_string(),
            level: Level::Task,
            status: Status::Todo,
            priority: Some(Priority::High),
            tags: vec!["backend".to_string()],
            needs_human_review: Some(true),
        };

        let cloned = summary.clone();
        assert_eq!(summary, cloned);
    }

    #[test]
    fn test_task_summary_debug() {
        let summary = TaskSummary {
            id: "abc123".to_string(),
            title: "Test Task".to_string(),
            level: Level::Ticket,
            status: Status::InProgress,
            priority: Some(Priority::High),
            tags: vec!["backend".to_string()],
            needs_human_review: None,
        };

        let debug_str = format!("{:?}", summary);
        assert!(debug_str.contains("TaskSummary"));
        assert!(debug_str.contains("abc123"));
        assert!(debug_str.contains("Test Task"));
    }

    #[test]
    fn test_task_summary_eq() {
        let summary1 = TaskSummary {
            id: "123".to_string(),
            title: "Test".to_string(),
            level: Level::Task,
            status: Status::Todo,
            priority: None,
            tags: vec![],
            needs_human_review: None,
        };

        let summary2 = TaskSummary {
            id: "123".to_string(),
            title: "Test".to_string(),
            level: Level::Task,
            status: Status::Todo,
            priority: None,
            tags: vec![],
            needs_human_review: None,
        };

        assert_eq!(summary1, summary2);
    }

    // ========================================
    // Parse function tests
    // ========================================

    #[test]
    fn test_parse_level() {
        assert_eq!(parse_level("epic"), Level::Epic);
        assert_eq!(parse_level("ticket"), Level::Ticket);
        assert_eq!(parse_level("task"), Level::Task);
        assert_eq!(parse_level("unknown"), Level::Task); // default
    }

    #[test]
    fn test_parse_status() {
        assert_eq!(parse_status("backlog"), Status::Backlog);
        assert_eq!(parse_status("todo"), Status::Todo);
        assert_eq!(parse_status("in_progress"), Status::InProgress);
        assert_eq!(parse_status("pending_review"), Status::PendingReview);
        assert_eq!(parse_status("done"), Status::Done);
        assert_eq!(parse_status("rejected"), Status::Rejected);
        assert_eq!(parse_status("unknown"), Status::Todo); // default
    }

    #[test]
    fn test_parse_priority() {
        assert_eq!(parse_priority("low"), Priority::Low);
        assert_eq!(parse_priority("medium"), Priority::Medium);
        assert_eq!(parse_priority("high"), Priority::High);
        assert_eq!(parse_priority("critical"), Priority::Critical);
        assert_eq!(parse_priority("unknown"), Priority::Medium); // default
    }

    // ========================================
    // TaskLister integration tests
    // ========================================

    #[tokio::test]
    async fn test_list_all_tasks_excludes_done_by_default() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "in_progress", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "done", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|t| t.status != Status::Done));

        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));
        assert!(!ids.contains("task3"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_includes_done_with_flag() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "done", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().include_done();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 2);

        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_level() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "epic1", "Epic 1", "epic", "todo", None, &[]).await;
        create_task(&db, "ticket1", "Ticket 1", "ticket", "todo", None, &[]).await;
        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_level(Level::Epic);
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].level, Level::Epic);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_multiple_levels() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "epic1", "Epic 1", "epic", "todo", None, &[]).await;
        create_task(&db, "ticket1", "Ticket 1", "ticket", "todo", None, &[]).await;
        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_levels([Level::Epic, Level::Ticket]);
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(
            result
                .iter()
                .all(|t| t.level == Level::Epic || t.level == Level::Ticket)
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_status() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "backlog", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "in_progress", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_status(Status::Backlog);
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, Status::Backlog);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_priority() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", Some("high"), &[]).await;
        create_task(&db, "task2", "Task 2", "task", "todo", Some("low"), &[]).await;
        create_task(&db, "task3", "Task 3", "task", "todo", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_priority(Priority::High);
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].priority, Some(Priority::High));

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

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_tag("backend");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(
            result
                .iter()
                .all(|t| t.tags.contains(&"backend".to_string()))
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_root_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent Epic", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child Ticket", "ticket", "todo", None, &[]).await;
        create_task(&db, "orphan1", "Orphan Task", "task", "todo", None, &[]).await;

        create_child_of(&db, "child1", "parent1").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().root_only();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|t| t.id == "parent1"));
        assert!(result.iter().any(|t| t.id == "orphan1"));
        assert!(!result.iter().any(|t| t.id == "child1"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_of_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent Epic", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child 1", "ticket", "todo", None, &[]).await;
        create_task(&db, "child2", "Child 2", "ticket", "todo", None, &[]).await;
        create_task(&db, "other1", "Other Task", "task", "todo", None, &[]).await;

        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().children_of("parent1");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|t| t.id == "child1"));
        assert!(result.iter().any(|t| t.id == "child2"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_nonexistent_parent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "todo", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().children_of("nonexistent");
        let result = lister.list(&filter).await.unwrap();

        assert!(result.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_empty_database() {
        let (db, temp_dir) = setup_test_db().await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();
        let result = lister.list(&filter).await.unwrap();

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

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new()
            .with_level(Level::Epic)
            .with_priority(Priority::High)
            .with_tag("backend");
        let result = lister.list(&filter).await.unwrap();

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

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_level(Level::Epic).root_only();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].level, Level::Epic);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_with_status_filter() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child 1", "ticket", "todo", None, &[]).await;
        create_task(&db, "child2", "Child 2", "ticket", "done", None, &[]).await;
        create_task(&db, "child3", "Child 3", "ticket", "in_progress", None, &[]).await;

        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;
        create_child_of(&db, "child3", "parent1").await;

        let lister = TaskLister::new(db.client());

        // Without include_done, should get 2 children
        let filter = TaskFilter::new().children_of("parent1");
        let result = lister.list(&filter).await.unwrap();
        assert_eq!(result.len(), 2);

        // With include_done, should get all 3 children
        let filter = TaskFilter::new().children_of("parent1").include_done();
        let result = lister.list(&filter).await.unwrap();
        assert_eq!(result.len(), 3);

        // With status filter, only done
        let filter = TaskFilter::new()
            .children_of("parent1")
            .with_status(Status::Done);
        let result = lister.list(&filter).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "child2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_with_priority_filter() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent", "epic", "todo", None, &[]).await;
        create_task(
            &db,
            "child1",
            "Child 1",
            "ticket",
            "todo",
            Some("high"),
            &[],
        )
        .await;
        create_task(&db, "child2", "Child 2", "ticket", "todo", Some("low"), &[]).await;
        create_task(&db, "child3", "Child 3", "ticket", "todo", None, &[]).await;

        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;
        create_child_of(&db, "child3", "parent1").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new()
            .children_of("parent1")
            .with_priority(Priority::High);
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "child1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_with_tag_filter() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent", "epic", "todo", None, &[]).await;
        create_task(
            &db,
            "child1",
            "Child 1",
            "ticket",
            "todo",
            None,
            &["backend"],
        )
        .await;
        create_task(
            &db,
            "child2",
            "Child 2",
            "ticket",
            "todo",
            None,
            &["frontend"],
        )
        .await;

        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().children_of("parent1").with_tag("backend");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "child1");

        cleanup(&temp_dir);
    }

    // ========================================
    // Search functionality tests
    // ========================================

    #[test]
    fn test_escape_search_string_plain_text() {
        let result = TaskLister::escape_search_string("simple text");
        assert_eq!(result, "simple text");
    }

    #[test]
    fn test_escape_search_string_with_quotes() {
        let result = TaskLister::escape_search_string("text with \"quotes\"");
        assert_eq!(result, "text with \\\"quotes\\\"");
    }

    #[test]
    fn test_escape_search_string_with_backslash() {
        let result = TaskLister::escape_search_string("path\\to\\file");
        assert_eq!(result, "path\\\\to\\\\file");
    }

    #[test]
    fn test_escape_search_string_with_single_quotes() {
        let result = TaskLister::escape_search_string("it's a test");
        assert_eq!(result, "it\\'s a test");
    }

    #[test]
    fn test_escape_search_string_mixed_special_chars() {
        let result = TaskLister::escape_search_string("\"test\" \\ 'value'");
        assert_eq!(result, "\\\"test\\\" \\\\ \\'value\\'");
    }

    #[test]
    fn test_build_search_condition_lowercase() {
        let condition = TaskLister::build_search_condition("Test");
        // The search term should be lowercased
        assert!(condition.contains("test"));
        assert!(!condition.contains("Test"));
    }

    #[test]
    fn test_build_search_condition_escapes_special_chars() {
        let condition = TaskLister::build_search_condition("test\"query");
        assert!(condition.contains("test\\\"query"));
    }

    #[test]
    fn test_build_search_condition_checks_title_and_description() {
        let condition = TaskLister::build_search_condition("search");
        assert!(condition.contains("string::lowercase(title)"));
        assert!(condition.contains("string::lowercase(description ?? \"\")"));
    }

    #[test]
    fn test_task_filter_with_search() {
        let filter = TaskFilter::new().with_search("test query");
        assert_eq!(filter.search, Some("test query".to_string()));
    }

    #[test]
    fn test_task_filter_with_search_string() {
        let search = String::from("another query");
        let filter = TaskFilter::new().with_search(search);
        assert_eq!(filter.search, Some("another query".to_string()));
    }

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
    async fn test_list_with_search_finds_by_title() {
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

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_search("auth");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_search_finds_by_description() {
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

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_search("authentication");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_search_is_case_insensitive() {
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

        let lister = TaskLister::new(db.client());

        // Search with lowercase should find uppercase title
        let filter = TaskFilter::new().with_search("authentication");
        let result = lister.list(&filter).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "task1");

        // Search with uppercase should also find
        let filter2 = TaskFilter::new().with_search("AUTHENTICATION");
        let result2 = lister.list(&filter2).await.unwrap();
        assert_eq!(result2.len(), 1);
        assert_eq!(result2[0].id, "task1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_search_combined_with_level() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "epic1", "Auth epic", "epic", "todo", None, &[]).await;
        create_task(&db, "task1", "Auth task", "task", "todo", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new()
            .with_search("auth")
            .with_level(Level::Epic);
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "epic1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_search_and_root_only() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Auth Parent", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Auth Child", "task", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_search("auth").root_only();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "parent1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_search_and_children_of() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Auth Child", "task", "todo", None, &[]).await;
        create_task(&db, "child2", "Other Child", "task", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_search("auth").children_of("parent1");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "child1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_search_no_matches() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task A", "task", "todo", None, &[]).await;
        create_task(&db, "task2", "Task B", "task", "todo", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_search("nonexistent");
        let result = lister.list(&filter).await.unwrap();

        assert!(result.is_empty());

        cleanup(&temp_dir);
    }

    // ========================================
    // Sorting tests - tasks returned in reverse creation order (newest first)
    // ========================================

    /// Helper to create a task with a specific created_at timestamp
    async fn create_task_with_timestamp(
        db: &Database,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
        timestamp: &str,
    ) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                status = "{}",
                priority = NONE,
                tags = [],
                created_at = d'{}'"#,
            id, title, level, status, timestamp
        );
        db.client().query(&query).await.unwrap();
    }

    #[tokio::test]
    async fn test_list_standard_query_returns_newest_first() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks with explicit timestamps (oldest first)
        create_task_with_timestamp(
            &db,
            "task_oldest",
            "Oldest Task",
            "task",
            "todo",
            "2024-01-01T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "task_middle",
            "Middle Task",
            "task",
            "todo",
            "2024-01-02T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "task_newest",
            "Newest Task",
            "task",
            "todo",
            "2024-01-03T00:00:00Z",
        )
        .await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();
        let result = lister.list(&filter).await.unwrap();

        // Assert exact order: newest first
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].id, "task_newest", "First task should be newest");
        assert_eq!(result[1].id, "task_middle", "Second task should be middle");
        assert_eq!(result[2].id, "task_oldest", "Third task should be oldest");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_root_query_returns_newest_first() {
        let (db, temp_dir) = setup_test_db().await;

        // Create root tasks (no parent) with explicit timestamps
        create_task_with_timestamp(
            &db,
            "root_oldest",
            "Oldest Root",
            "epic",
            "todo",
            "2024-01-01T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "root_middle",
            "Middle Root",
            "epic",
            "todo",
            "2024-01-02T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "root_newest",
            "Newest Root",
            "epic",
            "todo",
            "2024-01-03T00:00:00Z",
        )
        .await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().root_only();
        let result = lister.list(&filter).await.unwrap();

        // Assert exact order: newest first
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].id, "root_newest", "First root should be newest");
        assert_eq!(result[1].id, "root_middle", "Second root should be middle");
        assert_eq!(result[2].id, "root_oldest", "Third root should be oldest");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_query_returns_newest_first() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent task
        create_task_with_timestamp(
            &db,
            "parent",
            "Parent Epic",
            "epic",
            "todo",
            "2024-01-01T00:00:00Z",
        )
        .await;

        // Create child tasks with explicit timestamps
        create_task_with_timestamp(
            &db,
            "child_oldest",
            "Oldest Child",
            "ticket",
            "todo",
            "2024-01-02T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "child_middle",
            "Middle Child",
            "ticket",
            "todo",
            "2024-01-03T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "child_newest",
            "Newest Child",
            "ticket",
            "todo",
            "2024-01-04T00:00:00Z",
        )
        .await;

        // Create parent-child relationships
        create_child_of(&db, "child_oldest", "parent").await;
        create_child_of(&db, "child_middle", "parent").await;
        create_child_of(&db, "child_newest", "parent").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().children_of("parent");
        let result = lister.list(&filter).await.unwrap();

        // Assert exact order: newest first
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].id, "child_newest", "First child should be newest");
        assert_eq!(
            result[1].id, "child_middle",
            "Second child should be middle"
        );
        assert_eq!(result[2].id, "child_oldest", "Third child should be oldest");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_filter_maintains_newest_first_order() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks with different statuses and timestamps
        create_task_with_timestamp(
            &db,
            "task_old_todo",
            "Old Todo",
            "task",
            "todo",
            "2024-01-01T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "task_new_todo",
            "New Todo",
            "task",
            "todo",
            "2024-01-03T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "task_in_progress",
            "In Progress",
            "task",
            "in_progress",
            "2024-01-02T00:00:00Z",
        )
        .await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_status(Status::Todo);
        let result = lister.list(&filter).await.unwrap();

        // Assert exact order: newest todo first
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "task_new_todo", "Newer todo should be first");
        assert_eq!(result[1].id, "task_old_todo", "Older todo should be second");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_empty_result_returns_empty_without_error() {
        let (db, temp_dir) = setup_test_db().await;

        // No tasks created - database is empty
        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();
        let result = lister.list(&filter).await.unwrap();

        assert!(result.is_empty(), "Empty database should return empty list");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_single_task_returns_without_error() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_timestamp(
            &db,
            "only_task",
            "Only Task",
            "task",
            "todo",
            "2024-01-01T00:00:00Z",
        )
        .await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "only_task");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_tasks_with_identical_timestamps_stable_ordering() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks with identical timestamps
        let same_time = "2024-01-01T12:00:00Z";
        create_task_with_timestamp(&db, "task_a", "Task A", "task", "todo", same_time).await;
        create_task_with_timestamp(&db, "task_b", "Task B", "task", "todo", same_time).await;
        create_task_with_timestamp(&db, "task_c", "Task C", "task", "todo", same_time).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();

        // Run multiple times to verify stable ordering
        let result1 = lister.list(&filter).await.unwrap();
        let result2 = lister.list(&filter).await.unwrap();

        assert_eq!(result1.len(), 3);
        assert_eq!(result2.len(), 3);

        // Verify order is stable across calls
        assert_eq!(result1[0].id, result2[0].id, "Order should be stable");
        assert_eq!(result1[1].id, result2[1].id, "Order should be stable");
        assert_eq!(result1[2].id, result2[2].id, "Order should be stable");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_with_filter_maintains_order() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent
        create_task_with_timestamp(
            &db,
            "parent",
            "Parent",
            "epic",
            "todo",
            "2024-01-01T00:00:00Z",
        )
        .await;

        // Create children with different levels and timestamps
        create_task_with_timestamp(
            &db,
            "child_ticket_old",
            "Old Ticket",
            "ticket",
            "todo",
            "2024-01-02T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "child_ticket_new",
            "New Ticket",
            "ticket",
            "todo",
            "2024-01-04T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "child_task",
            "Task Child",
            "task",
            "todo",
            "2024-01-03T00:00:00Z",
        )
        .await;

        create_child_of(&db, "child_ticket_old", "parent").await;
        create_child_of(&db, "child_ticket_new", "parent").await;
        create_child_of(&db, "child_task", "parent").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new()
            .children_of("parent")
            .with_level(Level::Ticket);
        let result = lister.list(&filter).await.unwrap();

        // Should only return tickets, newest first
        assert_eq!(result.len(), 2);
        assert_eq!(
            result[0].id, "child_ticket_new",
            "Newer ticket should be first"
        );
        assert_eq!(
            result[1].id, "child_ticket_old",
            "Older ticket should be second"
        );

        cleanup(&temp_dir);
    }
}
