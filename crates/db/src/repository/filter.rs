//! Task filtering and listing queries
//!
//! Provides a builder-pattern TaskFilter and TaskLister for querying
//! tasks with complex filter combinations.

use crate::error::DbResult;
use crate::models::{Level, Priority};
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
    /// Current status (derived from workflow step name)
    pub status: String,
    /// Optional priority
    pub priority: Option<Priority>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
    /// When the task was created
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Workflow name (if task is assigned to a workflow)
    pub workflow_name: Option<String>,
    /// Current step name (if task has a current step in workflow)
    pub step_name: Option<String>,
}

/// Task data with all related information for constructing full task objects
#[derive(Debug, Clone)]
pub struct TaskWithRelationsData {
    /// The task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level
    pub level: Level,
    /// Current status (derived from workflow step name)
    pub status: String,
    /// Optional priority
    pub priority: Option<Priority>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
    /// Task description
    pub description: Option<String>,
    /// Sections (stored as raw JSON for flexibility)
    pub sections: Vec<serde_json::Value>,
    /// Code references (stored as raw JSON for flexibility)
    pub refs: Vec<serde_json::Value>,
    /// When the task was created
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Parent task ID (if any)
    pub parent_id: Option<String>,
    /// Child task IDs
    pub children_ids: Vec<String>,
    /// Task IDs this task depends on
    pub depends_on_ids: Vec<String>,
    /// Task IDs that depend on this task
    pub dependent_ids: Vec<String>,
    /// Workflow ID (if any)
    pub workflow_id: Option<String>,
    /// Current step ID in workflow (if any) - preferred for positioning
    pub current_step_id: Option<String>,
}

/// Internal row type for deserializing from SurrealDB
#[derive(Debug, Deserialize)]
struct TaskRow {
    id: surrealdb::sql::Thing,
    title: String,
    level: String,
    priority: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    needs_human_review: Option<bool>,
    /// Created timestamp - used by SQL ORDER BY for sorting and display
    created_at: surrealdb::sql::Datetime,
    /// Workflow name (fetched via workflow_id.name)
    #[serde(default)]
    workflow_name: Option<String>,
    /// Step name (fetched via current_step_id.name)
    #[serde(default)]
    step_name: Option<String>,
}

impl TaskRow {
    /// Convert a TaskRow to a TaskSummary
    /// Status is derived from step_name (which comes from workflow)
    fn into_summary(self) -> TaskSummary {
        // Status is derived from step_name - if no step_name, default to "backlog"
        let status = self
            .step_name
            .clone()
            .unwrap_or_else(|| "backlog".to_string());
        TaskSummary {
            id: self.id.id.to_raw(),
            title: self.title,
            level: parse_level(&self.level),
            status,
            priority: self.priority.as_deref().map(parse_priority),
            tags: self.tags,
            needs_human_review: self.needs_human_review,
            created_at: self.created_at.0,
            workflow_name: self.workflow_name,
            step_name: self.step_name,
        }
    }
}

/// Internal row type for deserializing full task data with relationships from SurrealDB
#[derive(Debug, Deserialize)]
struct TaskWithRelationsRow {
    id: surrealdb::sql::Thing,
    title: String,
    level: String,
    priority: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    needs_human_review: Option<bool>,
    created_at: surrealdb::sql::Datetime,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    sections: Vec<serde_json::Value>,
    #[serde(default)]
    refs: Vec<serde_json::Value>,
    #[serde(default)]
    parent_id: Option<surrealdb::sql::Thing>,
    #[serde(default)]
    children_ids: Vec<surrealdb::sql::Thing>,
    #[serde(default)]
    depends_on_ids: Vec<surrealdb::sql::Thing>,
    #[serde(default)]
    dependent_ids: Vec<surrealdb::sql::Thing>,
    #[serde(default)]
    workflow_id: Option<surrealdb::sql::Thing>,
    #[serde(default)]
    current_step_id: Option<surrealdb::sql::Thing>,
    /// Step name (fetched via current_step_id.name for deriving status)
    #[serde(default)]
    step_name: Option<String>,
}

/// Parse a level string into a Level enum
fn parse_level(s: &str) -> Level {
    match s {
        "epic" => Level::Epic,
        "ticket" => Level::Ticket,
        _ => Level::Task,
    }
}

/// Convert a status string to lowercase for consistency
fn normalize_status(s: &str) -> String {
    s.to_lowercase()
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
    /// Filter by statuses (OR semantics) - workflow step names
    pub statuses: Vec<String>,
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
    /// Filter by workflow_id (tasks assigned to a specific workflow)
    pub workflow_id: Option<String>,
    /// Filter by current step name (requires workflow_id to be set or uses current workflow)
    pub current_step: Option<String>,
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
    pub fn with_status(mut self, status: impl Into<String>) -> Self {
        self.statuses.push(status.into());
        self
    }

    /// Add multiple statuses to filter by
    pub fn with_statuses(mut self, statuses: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.statuses.extend(statuses.into_iter().map(|s| s.into()));
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

    /// Filter by workflow_id (tasks assigned to a specific workflow)
    pub fn with_workflow_id(mut self, workflow_id: impl Into<String>) -> Self {
        self.workflow_id = Some(workflow_id.into());
        self
    }

    /// Filter by current step name (requires workflow_id to be set for best results)
    pub fn with_current_step(mut self, step_name: impl Into<String>) -> Self {
        self.current_step = Some(step_name.into());
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

    /// List tasks matching a filter, including all relationships (parent, children, dependencies)
    /// in a single optimized query using graph traversal.
    ///
    /// This is significantly more efficient than calling `list()` and then fetching
    /// relationships separately for each task.
    ///
    /// # Arguments
    ///
    /// * `filter` - The filter criteria to apply
    ///
    /// # Returns
    ///
    /// A vector of tasks with full relationship data, sorted by creation time (newest first).
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database query fails.
    pub async fn list_with_relations(
        &self,
        filter: &TaskFilter,
    ) -> DbResult<Vec<TaskWithRelationsData>> {
        let conditions = self.build_filter_conditions(filter);

        let query = if conditions.is_empty() {
            r#"SELECT
                id, title, level, status, priority, tags, needs_human_review,
                created_at, description, sections, refs, workflow_id, current_step_id,
                (->child_of->task)[0].id AS parent_id,
                <-child_of<-task.id AS children_ids,
                ->depends_on->task.id AS depends_on_ids,
                <-depends_on<-task.id AS dependent_ids
            FROM task
            ORDER BY created_at DESC"#
                .to_string()
        } else {
            format!(
                r#"SELECT
                    id, title, level, status, priority, tags, needs_human_review,
                    created_at, description, sections, refs, workflow_id, current_step_id,
                    (->child_of->task)[0].id AS parent_id,
                    <-child_of<-task.id AS children_ids,
                    ->depends_on->task.id AS depends_on_ids,
                    <-depends_on<-task.id AS dependent_ids
                FROM task
                WHERE {}
                ORDER BY created_at DESC"#,
                conditions.join(" AND ")
            )
        };

        let mut result = self.client.query(&query).await?;
        let rows: Vec<TaskWithRelationsRow> = result.take(0)?;

        Ok(rows
            .into_iter()
            .map(|row| {
                // Status is derived from step_name - if no step_name, default to "backlog"
                let status = row
                    .step_name
                    .clone()
                    .unwrap_or_else(|| "backlog".to_string());
                TaskWithRelationsData {
                    id: row.id.id.to_raw(),
                    title: row.title,
                    level: parse_level(&row.level),
                    status,
                    priority: row.priority.as_deref().map(parse_priority),
                    tags: row.tags,
                    needs_human_review: row.needs_human_review,
                    description: row.description,
                    sections: row.sections,
                    refs: row.refs,
                    created_at: row.created_at.0,
                    parent_id: row.parent_id.map(|t| t.id.to_raw()),
                    children_ids: row
                        .children_ids
                        .into_iter()
                        .map(|t| t.id.to_raw())
                        .collect(),
                    depends_on_ids: row
                        .depends_on_ids
                        .into_iter()
                        .map(|t| t.id.to_raw())
                        .collect(),
                    dependent_ids: row
                        .dependent_ids
                        .into_iter()
                        .map(|t| t.id.to_raw())
                        .collect(),
                    workflow_id: row.workflow_id.map(|t| t.id.to_raw()),
                    current_step_id: row.current_step_id.map(|t| t.id.to_raw()),
                }
            })
            .collect())
    }

    /// Query tasks with standard filters
    async fn query_tasks(&self, filter: &TaskFilter) -> DbResult<Vec<TaskSummary>> {
        let conditions = self.build_filter_conditions(filter);

        // Use conditional expression to get step_name from current_step_id.name if available,
        // otherwise fall back to extracting from workflow_id.steps[current_step].name for legacy tasks
        let step_name_expr = "IF current_step_id != NONE THEN current_step_id.name ELSE IF workflow_id != NONE AND current_step != NONE THEN workflow_id.steps[current_step].name END";
        let query = if conditions.is_empty() {
            format!(
                "SELECT id, title, level, priority, tags, needs_human_review, created_at, workflow_id.name AS workflow_name, {} AS step_name FROM task ORDER BY created_at DESC",
                step_name_expr
            )
        } else {
            format!(
                "SELECT id, title, level, priority, tags, needs_human_review, created_at, workflow_id.name AS workflow_name, {} AS step_name FROM task WHERE {} ORDER BY created_at DESC",
                step_name_expr,
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

        // Use conditional expression to get step_name from current_step_id.name if available,
        // otherwise fall back to extracting from workflow_id.steps[current_step].name for legacy tasks
        let step_name_expr = "IF current_step_id != NONE THEN current_step_id.name ELSE IF workflow_id != NONE AND current_step != NONE THEN workflow_id.steps[current_step].name END";
        let query = format!(
            "SELECT id, title, level, priority, tags, needs_human_review, created_at, workflow_id.name AS workflow_name, {} AS step_name FROM task WHERE {} ORDER BY created_at DESC",
            step_name_expr,
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

        // Use conditional expression to get step_name from current_step_id.name if available,
        // otherwise fall back to extracting from workflow_id.steps[current_step].name for legacy tasks
        let step_name_expr = "IF current_step_id != NONE THEN current_step_id.name ELSE IF workflow_id != NONE AND current_step != NONE THEN workflow_id.steps[current_step].name END";
        let query = format!(
            "SELECT id, title, level, priority, tags, needs_human_review, created_at, workflow_id.name AS workflow_name, {} AS step_name FROM task WHERE {} ORDER BY created_at DESC",
            step_name_expr,
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
        // Status is now derived from current_step_id.name, null means "backlog"
        if !filter.include_done && filter.statuses.is_empty() {
            conditions
                .push("(current_step_id IS NONE OR current_step_id.name != \"done\")".to_string());
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

        // Status filter (OR within type) - now filters by step name
        // Special case: "backlog" means current_step_id is null
        if !filter.statuses.is_empty() {
            let status_conditions: Vec<String> = filter
                .statuses
                .iter()
                .map(|s| {
                    if s == "backlog" {
                        "current_step_id IS NONE".to_string()
                    } else {
                        format!("current_step_id.name = \"{}\"", s)
                    }
                })
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

        // Workflow ID filter
        // workflow_id field is a record<workflow>, so compare to workflow:<id>
        if let Some(ref workflow_id) = filter.workflow_id {
            conditions.push(format!(
                "workflow_id = workflow:{}",
                workflow_id.replace('\"', "\\\"")
            ));
        }

        // Current step filter - filters by step name
        // current_step_id is a record<step>, so we need to check the step's name field
        if let Some(ref step_name) = filter.current_step {
            conditions.push(format!(
                "current_step_id.name = \"{}\"",
                step_name.replace('\"', "\\\"")
            ));
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

    /// Build search condition for case-insensitive title, description, and ID search.
    ///
    /// Returns a condition that matches if the search query appears in the title,
    /// description, or task ID (case-insensitive). Description can be null,
    /// so we handle that case by defaulting to empty string.
    /// The ID is stored as a SurrealDB Thing, so we use meta::id() to extract
    /// the string portion for matching.
    fn build_search_condition(search: &str) -> String {
        let escaped = Self::escape_search_string(search);
        let lower_search = escaped.to_lowercase();
        // Use string::lowercase for case-insensitive matching
        // Handle null description by using IFNULL (or description ?? "" in SurrealQL)
        // Use meta::id() to extract the ID string portion for matching
        format!(
            "(string::lowercase(title) CONTAINS \"{}\" OR string::lowercase(description ?? \"\") CONTAINS \"{}\" OR string::lowercase(meta::id(id)) CONTAINS \"{}\")",
            lower_search, lower_search, lower_search
        )
    }

    /// List ready items for work or triage at a given status.
    ///
    /// Returns highest-level unblocked items that:
    /// 1. Have the specified status (todo or backlog)
    /// 2. Are not blocked by incomplete dependencies
    /// 3. Have no work started (no children in in_progress/pending_review/done)
    /// 4. Have no parent in the same status (show only highest entry point)
    ///
    /// For items with hierarchies, only shows the highest-level entry point.
    ///
    /// # Arguments
    ///
    /// * `status` - The status to filter by (typically Todo or Backlog)
    ///
    /// # Returns
    ///
    /// A vector of task summaries representing entry points for work/triage.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let lister = TaskLister::new(db.client());
    /// let todo_ready = lister.list_ready("todo").await?;
    /// let backlog_ready = lister.list_ready("backlog").await?;
    /// ```
    pub async fn list_ready(&self, status: impl AsRef<str>) -> DbResult<Vec<TaskSummary>> {
        let status_str = status.as_ref();

        // OPTIMIZED: Batch fetch all data in 3 queries instead of N*M queries
        //
        // Query 1: All tasks with id, status, parent info
        // Query 2: All child_of relationships (for building hierarchy)
        // Query 3: All incomplete blockers
        //
        // Then filter entirely in Rust using in-memory data structures

        // Query 1: Get ALL tasks with their parent info in one query
        // Status is derived from current_step_id.name, defaulting to "backlog" if null
        let all_tasks_query = r#"
            SELECT
                id,
                title,
                level,
                IF current_step_id != NONE THEN current_step_id.name ELSE "backlog" END AS status,
                priority,
                tags,
                needs_human_review,
                created_at,
                (->child_of->task)[0].id AS parent_id,
                IF (->child_of->task)[0].current_step_id != NONE THEN (->child_of->task)[0].current_step_id.name ELSE "backlog" END AS parent_status
            FROM task
            ORDER BY created_at DESC
        "#;

        #[derive(Debug, Deserialize)]
        struct TaskWithParent {
            id: surrealdb::sql::Thing,
            title: String,
            level: String,
            status: String,
            priority: Option<String>,
            #[serde(default)]
            tags: Vec<String>,
            #[serde(default)]
            needs_human_review: Option<bool>,
            #[allow(dead_code)]
            created_at: surrealdb::sql::Datetime,
            parent_id: Option<surrealdb::sql::Thing>,
            parent_status: Option<String>,
        }

        let mut result = self.client.query(all_tasks_query).await?;
        let all_tasks: Vec<TaskWithParent> = result.take(0)?;

        // Query 2: Get all child_of relationships to build parent->children map
        let children_query = "SELECT in.id AS child_id, out.id AS parent_id FROM child_of";

        #[derive(Debug, Deserialize)]
        struct ChildOfRow {
            child_id: surrealdb::sql::Thing,
            parent_id: surrealdb::sql::Thing,
        }

        let mut result = self.client.query(children_query).await?;
        let child_of_rows: Vec<ChildOfRow> = result.take(0)?;

        // Query 3: Get all incomplete blockers (depends_on where blocker is not done)
        // Status is derived from current_step_id.name, defaulting to "backlog" if null
        let blockers_query = r#"
            SELECT in.id AS dependent_id, out.id AS blocker_id
            FROM depends_on
            WHERE (IF out.current_step_id != NONE THEN out.current_step_id.name ELSE "backlog" END) != "done"
        "#;

        #[derive(Debug, Deserialize)]
        struct BlockerRow {
            dependent_id: surrealdb::sql::Thing,
            #[allow(dead_code)]
            blocker_id: surrealdb::sql::Thing,
        }

        let mut result = self.client.query(blockers_query).await?;
        let blocker_rows: Vec<BlockerRow> = result.take(0)?;

        // Build in-memory data structures
        use std::collections::{HashMap, HashSet};

        // Set of tasks that have incomplete blockers
        let blocked_tasks: HashSet<String> = blocker_rows
            .iter()
            .map(|r| r.dependent_id.id.to_raw())
            .collect();

        // Map of parent_id -> [child_ids]
        let mut children_map: HashMap<String, Vec<String>> = HashMap::new();
        for row in &child_of_rows {
            let parent_id = row.parent_id.id.to_raw();
            let child_id = row.child_id.id.to_raw();
            children_map.entry(parent_id).or_default().push(child_id);
        }

        // Map of task_id -> status (for checking work started)
        let task_statuses: HashMap<String, String> = all_tasks
            .iter()
            .map(|t| (t.id.id.to_raw(), t.status.clone()))
            .collect();

        // Helper: Check if any descendant has work started (BFS in memory)
        let has_work_started_in_descendants = |task_id: &str| -> bool {
            let work_started_statuses = ["in_progress", "pending_review", "done"];
            let mut to_check = vec![task_id.to_string()];
            let mut checked = HashSet::new();

            while let Some(current) = to_check.pop() {
                if checked.contains(&current) {
                    continue;
                }
                checked.insert(current.clone());

                if let Some(children) = children_map.get(&current) {
                    for child_id in children {
                        if let Some(child_status) = task_statuses.get(child_id)
                            && work_started_statuses.contains(&child_status.as_str())
                        {
                            return true;
                        }
                        to_check.push(child_id.clone());
                    }
                }
            }
            false
        };

        // Helper: Check if task is entry point
        let is_entry_point = |task: &TaskWithParent| -> bool {
            match (&task.parent_id, &task.parent_status) {
                (None, _) | (_, None) => true, // No parent = entry point
                (Some(parent_id), Some(parent_status)) => {
                    if parent_status != status_str {
                        // Parent has different status = this is an entry point
                        true
                    } else {
                        // Parent has same status - check if parent has work started
                        // If parent has work started, it's not a valid entry point,
                        // so this child becomes an entry point
                        let parent_id_str = parent_id.id.to_raw();
                        has_work_started_in_descendants(&parent_id_str)
                    }
                }
            }
        };

        // Filter tasks
        let mut ready_tasks: Vec<TaskSummary> = all_tasks
            .into_iter()
            .filter(|task| {
                let task_id = task.id.id.to_raw();

                // Must have target status
                if task.status != status_str {
                    return false;
                }

                // Check 1: Must be entry point
                if !is_entry_point(task) {
                    return false;
                }

                // Check 2: No incomplete blockers
                if blocked_tasks.contains(&task_id) {
                    return false;
                }

                // Check 3: No work started in descendants
                if has_work_started_in_descendants(&task_id) {
                    return false;
                }

                true
            })
            .map(|task| TaskSummary {
                id: task.id.id.to_raw(),
                title: task.title,
                level: parse_level(&task.level),
                status: normalize_status(&task.status),
                priority: task.priority.map(|p| parse_priority(&p)),
                tags: task.tags,
                needs_human_review: task.needs_human_review,
                created_at: task.created_at.0,
                // list_ready doesn't fetch workflow info - would require additional queries
                workflow_name: None,
                step_name: None,
            })
            .collect();

        // Sort by level priority: epic > ticket > task
        ready_tasks.sort_by(|a, b| {
            let level_priority = |level: &Level| -> u8 {
                match level {
                    Level::Epic => 0,
                    Level::Ticket => 1,
                    Level::Task => 2,
                }
            };
            level_priority(&a.level).cmp(&level_priority(&b.level))
        });

        Ok(ready_tasks)
    }

    /// Apply post-query filters (used for children query where we can't use all SQL filters)
    fn apply_post_filters(&self, tasks: Vec<TaskSummary>, filter: &TaskFilter) -> Vec<TaskSummary> {
        tasks
            .into_iter()
            .filter(|task| {
                // Filter by done status unless include_done or statuses specified
                if !filter.include_done && filter.statuses.is_empty() && task.status == "done" {
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
    /// Status is derived from current_step_id - we set current_step_id to the appropriate step
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

        // Set current_step_id for non-backlog statuses
        // The test database init creates steps with IDs like "default_<status>"
        let step_id_clause = if status == "backlog" {
            "NONE".to_string()
        } else {
            format!("step:default_{}", status)
        };

        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                current_step_id = {},
                priority = {},
                tags = {}"#,
            id, title, level, step_id_clause, priority_str, tags_str
        );

        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a child_of relationship
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a depends_on relationship
    async fn create_depends_on(db: &Database, dependent_id: &str, blocker_id: &str) {
        let query = format!(
            "RELATE task:{} -> depends_on -> task:{}",
            dependent_id, blocker_id
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to assign a workflow to a task
    async fn assign_workflow(db: &Database, task_id: &str, workflow_id: &str) {
        let query = format!(
            "UPDATE task:{} SET workflow_id = workflow:{}",
            task_id, workflow_id
        );
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
        let filter = TaskFilter::new().with_status("in_progress");
        assert_eq!(filter.statuses, vec!["in_progress"]);
    }

    #[test]
    fn test_task_filter_with_statuses() {
        let filter = TaskFilter::new().with_statuses(["in_progress", "pending_review"]);
        assert_eq!(filter.statuses, vec!["in_progress", "pending_review"]);
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
            .with_status("in_progress")
            .with_priority(Priority::High)
            .with_tag("urgent")
            .include_done();

        assert_eq!(filter.levels, vec![Level::Epic]);
        assert_eq!(filter.statuses, vec!["in_progress"]);
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
            .with_status("in_progress")
            .root_only();

        let debug_str = format!("{:?}", filter);
        assert!(debug_str.contains("TaskFilter"));
        assert!(debug_str.contains("Epic"));
        assert!(debug_str.contains("in_progress"));
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
            status: "in_progress".to_string(),
            priority: Some(Priority::High),
            tags: vec!["backend".to_string()],
            needs_human_review: Some(true),
            created_at: chrono::Utc::now(),
            workflow_name: Some("Default Workflow".to_string()),
            step_name: Some("in_progress".to_string()),
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
            status: "in_progress".to_string(),
            priority: Some(Priority::High),
            tags: vec!["backend".to_string()],
            needs_human_review: None,
            created_at: chrono::Utc::now(),
            workflow_name: None,
            step_name: None,
        };

        let debug_str = format!("{:?}", summary);
        assert!(debug_str.contains("TaskSummary"));
        assert!(debug_str.contains("abc123"));
        assert!(debug_str.contains("Test Task"));
    }

    #[test]
    fn test_task_summary_eq() {
        let now = chrono::Utc::now();
        let summary1 = TaskSummary {
            id: "123".to_string(),
            title: "Test".to_string(),
            level: Level::Task,
            status: "in_progress".to_string(),
            priority: None,
            tags: vec![],
            needs_human_review: None,
            created_at: now,
            workflow_name: None,
            step_name: None,
        };

        let summary2 = TaskSummary {
            id: "123".to_string(),
            title: "Test".to_string(),
            level: Level::Task,
            status: "in_progress".to_string(),
            priority: None,
            tags: vec![],
            needs_human_review: None,
            created_at: now,
            workflow_name: None,
            step_name: None,
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
    fn test_normalize_status() {
        assert_eq!(normalize_status("backlog"), "backlog");
        assert_eq!(normalize_status("BACKLOG"), "backlog");
        assert_eq!(normalize_status("in_progress"), "in_progress");
        assert_eq!(normalize_status("IN_PROGRESS"), "in_progress");
        assert_eq!(normalize_status("Unknown"), "unknown");
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

        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "in_progress", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "done", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|t| t.status != "done"));

        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));
        assert!(!ids.contains("task3"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_includes_done_with_flag() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;
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

        create_task(&db, "epic1", "Epic 1", "epic", "in_progress", None, &[]).await;
        create_task(
            &db,
            "ticket1",
            "Ticket 1",
            "ticket",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;

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

        create_task(&db, "epic1", "Epic 1", "epic", "in_progress", None, &[]).await;
        create_task(
            &db,
            "ticket1",
            "Ticket 1",
            "ticket",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;

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

        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "backlog", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "in_progress", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_status("backlog");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, "backlog");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_filter_by_priority() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "task1",
            "Task 1",
            "task",
            "in_progress",
            Some("high"),
            &[],
        )
        .await;
        create_task(
            &db,
            "task2",
            "Task 2",
            "task",
            "in_progress",
            Some("low"),
            &[],
        )
        .await;
        create_task(&db, "task3", "Task 3", "task", "in_progress", None, &[]).await;

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

        create_task(
            &db,
            "task1",
            "Task 1",
            "task",
            "in_progress",
            None,
            &["backend"],
        )
        .await;
        create_task(
            &db,
            "task2",
            "Task 2",
            "task",
            "in_progress",
            None,
            &["frontend"],
        )
        .await;
        create_task(
            &db,
            "task3",
            "Task 3",
            "task",
            "in_progress",
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

        create_task(
            &db,
            "parent1",
            "Parent Epic",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &db,
            "child1",
            "Child Ticket",
            "ticket",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &db,
            "orphan1",
            "Orphan Task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

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

        create_task(
            &db,
            "parent1",
            "Parent Epic",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(&db, "child1", "Child 1", "ticket", "in_progress", None, &[]).await;
        create_task(&db, "child2", "Child 2", "ticket", "in_progress", None, &[]).await;
        create_task(
            &db,
            "other1",
            "Other Task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

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

        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;

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
            "in_progress",
            Some("high"),
            &["backend"],
        )
        .await;
        create_task(
            &db,
            "task2",
            "Task 2",
            "epic",
            "in_progress",
            Some("low"),
            &["backend"],
        )
        .await;
        create_task(
            &db,
            "task3",
            "Task 3",
            "ticket",
            "in_progress",
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

        create_task(&db, "epic1", "Epic", "epic", "in_progress", None, &[]).await;
        create_task(&db, "ticket1", "Ticket", "ticket", "in_progress", None, &[]).await;

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

        create_task(&db, "parent1", "Parent", "epic", "in_progress", None, &[]).await;
        create_task(&db, "child1", "Child 1", "ticket", "in_progress", None, &[]).await;
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
        let filter = TaskFilter::new().children_of("parent1").with_status("done");
        let result = lister.list(&filter).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "child2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_children_with_priority_filter() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent", "epic", "in_progress", None, &[]).await;
        create_task(
            &db,
            "child1",
            "Child 1",
            "ticket",
            "in_progress",
            Some("high"),
            &[],
        )
        .await;
        create_task(
            &db,
            "child2",
            "Child 2",
            "ticket",
            "in_progress",
            Some("low"),
            &[],
        )
        .await;
        create_task(&db, "child3", "Child 3", "ticket", "in_progress", None, &[]).await;

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

        create_task(&db, "parent1", "Parent", "epic", "in_progress", None, &[]).await;
        create_task(
            &db,
            "child1",
            "Child 1",
            "ticket",
            "in_progress",
            None,
            &["backend"],
        )
        .await;
        create_task(
            &db,
            "child2",
            "Child 2",
            "ticket",
            "in_progress",
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
    fn test_build_search_condition_checks_title_description_and_id() {
        let condition = TaskLister::build_search_condition("search");
        assert!(condition.contains("string::lowercase(title)"));
        assert!(condition.contains("string::lowercase(description ?? \"\")"));
        assert!(condition.contains("string::lowercase(meta::id(id))"));
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
    /// Status is derived from current_step_id
    async fn create_task_with_description(
        db: &Database,
        id: &str,
        title: &str,
        description: &str,
        level: &str,
        status: &str,
    ) {
        // Set current_step_id for non-backlog statuses
        let step_id_clause = if status == "backlog" {
            "NONE".to_string()
        } else {
            format!("step:default_{}", status)
        };

        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                description = "{}",
                level = "{}",
                current_step_id = {},
                priority = NONE,
                tags = []"#,
            id, title, description, level, step_id_clause
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
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &db,
            "task2",
            "Database migration",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &db,
            "task3",
            "API endpoint",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

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
            "in_progress",
        )
        .await;
        create_task_with_description(
            &db,
            "task2",
            "Feature B",
            "Add database caching",
            "task",
            "in_progress",
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
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(&db, "task2", "Other task", "task", "in_progress", None, &[]).await;

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

        create_task(&db, "epic1", "Auth epic", "epic", "in_progress", None, &[]).await;
        create_task(&db, "task1", "Auth task", "task", "in_progress", None, &[]).await;

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

        create_task(
            &db,
            "parent1",
            "Auth Parent",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &db,
            "child1",
            "Auth Child",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
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

        create_task(&db, "parent1", "Parent", "epic", "in_progress", None, &[]).await;
        create_task(
            &db,
            "child1",
            "Auth Child",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &db,
            "child2",
            "Other Child",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
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

        create_task(&db, "task1", "Task A", "task", "in_progress", None, &[]).await;
        create_task(&db, "task2", "Task B", "task", "in_progress", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().with_search("nonexistent");
        let result = lister.list(&filter).await.unwrap();

        assert!(result.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_search_finds_by_task_id() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks with specific IDs
        create_task(&db, "abc123", "Task One", "task", "in_progress", None, &[]).await;
        create_task(&db, "xyz789", "Task Two", "task", "in_progress", None, &[]).await;
        create_task(
            &db,
            "def456",
            "Task Three",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let lister = TaskLister::new(db.client());

        // Search by partial task ID
        let filter = TaskFilter::new().with_search("abc");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "abc123");

        // Search by different partial ID
        let filter2 = TaskFilter::new().with_search("xyz");
        let result2 = lister.list(&filter2).await.unwrap();

        assert_eq!(result2.len(), 1);
        assert_eq!(result2[0].id, "xyz789");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_search_by_id_is_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        // Create task with mixed case ID
        create_task(&db, "AbCdEf", "Task One", "task", "in_progress", None, &[]).await;

        let lister = TaskLister::new(db.client());

        // Search with lowercase should find uppercase ID
        let filter = TaskFilter::new().with_search("abcdef");
        let result = lister.list(&filter).await.unwrap();
        assert_eq!(result.len(), 1);

        // Search with uppercase should also find
        let filter2 = TaskFilter::new().with_search("ABCDEF");
        let result2 = lister.list(&filter2).await.unwrap();
        assert_eq!(result2.len(), 1);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_empty_search_returns_all_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Task A", "task", "in_progress", None, &[]).await;
        create_task(&db, "task2", "Task B", "task", "in_progress", None, &[]).await;
        create_task(&db, "task3", "Task C", "task", "in_progress", None, &[]).await;

        let lister = TaskLister::new(db.client());

        // Empty search should return all tasks (no filter applied)
        let filter = TaskFilter::new();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 3);

        cleanup(&temp_dir);
    }

    // ========================================
    // Sorting tests - tasks returned in reverse creation order (newest first)
    // ========================================

    /// Helper to create a task with a specific created_at timestamp
    /// Status is derived from current_step_id
    async fn create_task_with_timestamp(
        db: &Database,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
        timestamp: &str,
    ) {
        // Set current_step_id for non-backlog statuses
        let step_id_clause = if status == "backlog" {
            "NONE".to_string()
        } else {
            format!("step:default_{}", status)
        };

        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                current_step_id = {},
                priority = NONE,
                tags = [],
                created_at = d'{}'"#,
            id, title, level, step_id_clause, timestamp
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
            "in_progress",
            "2024-01-01T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "task_middle",
            "Middle Task",
            "task",
            "in_progress",
            "2024-01-02T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "task_newest",
            "Newest Task",
            "task",
            "in_progress",
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
            "in_progress",
            "2024-01-01T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "root_middle",
            "Middle Root",
            "epic",
            "in_progress",
            "2024-01-02T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "root_newest",
            "Newest Root",
            "epic",
            "in_progress",
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
            "in_progress",
            "2024-01-01T00:00:00Z",
        )
        .await;

        // Create child tasks with explicit timestamps
        create_task_with_timestamp(
            &db,
            "child_oldest",
            "Oldest Child",
            "ticket",
            "in_progress",
            "2024-01-02T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "child_middle",
            "Middle Child",
            "ticket",
            "in_progress",
            "2024-01-03T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "child_newest",
            "Newest Child",
            "ticket",
            "in_progress",
            "2024-01-04T00:00:00Z",
        )
        .await;

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
            "task_old_backlog",
            "Old Backlog",
            "task",
            "backlog",
            "2024-01-01T00:00:00Z",
        )
        .await;
        create_task_with_timestamp(
            &db,
            "task_new_backlog",
            "New Backlog",
            "task",
            "backlog",
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
        let filter = TaskFilter::new().with_status("backlog");
        let result = lister.list(&filter).await.unwrap();

        // Assert exact order: newest backlog first
        assert_eq!(result.len(), 2);
        assert_eq!(
            result[0].id, "task_new_backlog",
            "Newer backlog should be first"
        );
        assert_eq!(
            result[1].id, "task_old_backlog",
            "Older backlog should be second"
        );

        cleanup(&temp_dir);
    }

    // ========================================
    // list_with_relations tests
    // ========================================

    #[tokio::test]
    async fn test_list_with_relations_basic() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks
        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "in_progress", None, &[]).await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().include_done();
        let result = lister.list_with_relations(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(result.iter().any(|t| t.id == "task1"));
        assert!(result.iter().any(|t| t.id == "task2"));

        // Verify all tasks have no relationships
        for task in &result {
            assert!(task.parent_id.is_none());
            assert!(task.children_ids.is_empty());
            assert!(task.depends_on_ids.is_empty());
            assert!(task.dependent_ids.is_empty());
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_relations_with_workflow_id_filter() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks
        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "in_progress", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "in_progress", None, &[]).await;

        // Assign tasks to workflows
        assign_workflow(&db, "task1", "workflow1").await;
        assign_workflow(&db, "task2", "workflow1").await;
        assign_workflow(&db, "task3", "workflow2").await;

        let lister = TaskLister::new(db.client());

        // Query tasks for workflow1
        let filter = TaskFilter::new()
            .include_done()
            .with_workflow_id("workflow1");
        let result = lister.list_with_relations(&filter).await.unwrap();

        // Should only get 2 tasks from workflow1
        assert_eq!(result.len(), 2);
        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task1"));
        assert!(ids.contains("task2"));
        assert!(!ids.contains("task3"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_relations_includes_parent() {
        let (db, temp_dir) = setup_test_db().await;

        // Create parent and child tasks
        create_task(
            &db,
            "parent",
            "Parent Task",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(&db, "child", "Child Task", "task", "in_progress", None, &[]).await;

        // Create parent-child relationship
        create_child_of(&db, "child", "parent").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().include_done();
        let result = lister.list_with_relations(&filter).await.unwrap();

        // Verify parent ID
        let parent = result.iter().find(|t| t.id == "parent").unwrap();
        assert_eq!(parent.id, "parent");
        assert!(parent.children_ids.contains(&"child".to_string()));

        // Verify child's parent_id is clean
        let child = result.iter().find(|t| t.id == "child").unwrap();
        assert_eq!(child.id, "child");
        assert_eq!(child.parent_id, Some("parent".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_relations_includes_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks
        create_task(&db, "task1", "Task 1", "task", "in_progress", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "in_progress", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "in_progress", None, &[]).await;

        // Create dependency: task2 depends on task1
        create_depends_on(&db, "task2", "task1").await;
        // Create dependency: task3 depends on task1
        create_depends_on(&db, "task3", "task1").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().include_done();
        let result = lister.list_with_relations(&filter).await.unwrap();

        assert_eq!(result.len(), 3);

        // Task 1 has dependents (task2 and task3 depend on it)
        let task1 = result.iter().find(|t| t.id == "task1").unwrap();
        assert!(task1.depends_on_ids.is_empty());
        assert_eq!(task1.dependent_ids.len(), 2);
        assert!(task1.dependent_ids.contains(&"task2".to_string()));
        assert!(task1.dependent_ids.contains(&"task3".to_string()));

        // Task 2 depends on task1
        let task2 = result.iter().find(|t| t.id == "task2").unwrap();
        assert_eq!(task2.depends_on_ids.len(), 1);
        assert_eq!(task2.depends_on_ids[0], "task1");
        assert!(task2.dependent_ids.is_empty());

        // Task 3 depends on task1
        let task3 = result.iter().find(|t| t.id == "task3").unwrap();
        assert_eq!(task3.depends_on_ids.len(), 1);
        assert_eq!(task3.depends_on_ids[0], "task1");
        assert!(task3.dependent_ids.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_relations_combined_workflow_and_relationships() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks
        create_task(&db, "parent", "Parent", "epic", "in_progress", None, &[]).await;
        create_task(&db, "child1", "Child 1", "task", "in_progress", None, &[]).await;
        create_task(&db, "child2", "Child 2", "task", "in_progress", None, &[]).await;
        create_task(&db, "other", "Other Task", "task", "in_progress", None, &[]).await;

        // Create relationships
        create_child_of(&db, "child1", "parent").await;
        create_child_of(&db, "child2", "parent").await;
        create_depends_on(&db, "child2", "child1").await;

        // Assign to workflows
        assign_workflow(&db, "parent", "workflow1").await;
        assign_workflow(&db, "child1", "workflow1").await;
        assign_workflow(&db, "child2", "workflow1").await;
        assign_workflow(&db, "other", "workflow2").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new()
            .include_done()
            .with_workflow_id("workflow1");
        let result = lister.list_with_relations(&filter).await.unwrap();

        // Should get 3 tasks from workflow1
        assert_eq!(result.len(), 3);
        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("parent"));
        assert!(ids.contains("child1"));
        assert!(ids.contains("child2"));
        assert!(!ids.contains("other"));

        // Verify relationships are preserved
        let parent = result.iter().find(|t| t.id == "parent").unwrap();
        assert_eq!(parent.children_ids.len(), 2);
        assert!(parent.children_ids.contains(&"child1".to_string()));
        assert!(parent.children_ids.contains(&"child2".to_string()));

        let child2 = result.iter().find(|t| t.id == "child2").unwrap();
        assert_eq!(child2.parent_id, Some("parent".to_string()));
        assert_eq!(child2.depends_on_ids.len(), 1);
        assert_eq!(child2.depends_on_ids[0], "child1");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_all_numeric_task_id_has_no_backticks() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task with an all-numeric ID
        // This tests that the ID is returned without backticks, angle brackets, or parentheses
        create_task(
            &db,
            "123456",
            "Numeric ID Task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        // The ID should be exactly "123456" without any backticks, angle brackets, or parentheses
        assert_eq!(result[0].id, "123456");
        // Verify no escape characters
        assert!(!result[0].id.contains('`'));
        assert!(!result[0].id.contains('('));
        assert!(!result[0].id.contains(')'));
        assert!(!result[0].id.contains('<'));
        assert!(!result[0].id.contains('>'));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_all_numeric_id_with_relations() {
        let (db, temp_dir) = setup_test_db().await;

        // Create tasks with all-numeric IDs
        create_task(
            &db,
            "111111",
            "Parent Task",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &db,
            "222222",
            "Child Task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        // Create parent-child relationship
        create_child_of(&db, "222222", "111111").await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new();
        let result = lister.list_with_relations(&filter).await.unwrap();

        // Verify parent ID
        let parent = result.iter().find(|t| t.id == "111111").unwrap();
        assert_eq!(parent.id, "111111");
        assert!(parent.children_ids.contains(&"222222".to_string()));

        // Verify child's parent_id is clean
        let child = result.iter().find(|t| t.id == "222222").unwrap();
        assert_eq!(child.id, "222222");
        assert_eq!(child.parent_id, Some("111111".to_string()));

        cleanup(&temp_dir);
    }

    /// Helper to create a workflow with steps
    async fn create_workflow_with_steps(db: &Database, workflow_id: &str, steps: &[&str]) {
        // Create workflow
        let query = format!(
            r#"CREATE workflow:{} SET name = "{}""#,
            workflow_id, workflow_id
        );
        db.client().query(&query).await.unwrap();

        // Create steps
        for (order, step_name) in steps.iter().enumerate() {
            let step_id = format!("{}_{}", workflow_id, step_name);
            let query = format!(
                r#"CREATE step:{} SET name = "{}", workflow_id = workflow:{}, order = {}"#,
                step_id, step_name, workflow_id, order
            );
            db.client().query(&query).await.unwrap();
        }
    }

    /// Helper to assign a task to a workflow step
    async fn assign_workflow_step(
        db: &Database,
        task_id: &str,
        workflow_id: &str,
        step_name: &str,
    ) {
        let step_id = format!("{}_{}", workflow_id, step_name);
        let query = format!(
            "UPDATE task:{} SET workflow_id = workflow:{}, current_step_id = step:{}",
            task_id, workflow_id, step_id
        );
        db.client().query(&query).await.unwrap();
    }

    #[tokio::test]
    async fn test_list_with_current_step_filter() {
        let (db, temp_dir) = setup_test_db().await;

        // Create workflow with steps
        create_workflow_with_steps(&db, "dev_workflow", &["backlog", "in_progress", "done"]).await;

        // Create tasks
        create_task(&db, "task1", "Task 1", "task", "backlog", None, &[]).await;
        create_task(&db, "task2", "Task 2", "task", "in_progress", None, &[]).await;
        create_task(&db, "task3", "Task 3", "task", "in_progress", None, &[]).await;
        create_task(&db, "task4", "Task 4", "task", "done", None, &[]).await;

        // Assign tasks to workflow steps
        assign_workflow_step(&db, "task1", "dev_workflow", "backlog").await;
        assign_workflow_step(&db, "task2", "dev_workflow", "in_progress").await;
        assign_workflow_step(&db, "task3", "dev_workflow", "in_progress").await;
        assign_workflow_step(&db, "task4", "dev_workflow", "done").await;

        let lister = TaskLister::new(db.client());

        // Filter by step name "in_progress" - should get task2 and task3
        let filter = TaskFilter::new()
            .include_done()
            .with_current_step("in_progress");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(
            result.len(),
            2,
            "Should return exactly 2 tasks with step 'in_progress'"
        );
        let ids: HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains("task2"), "task2 should be in results");
        assert!(ids.contains("task3"), "task3 should be in results");
        assert!(
            !ids.contains("task1"),
            "task1 (backlog) should NOT be in results"
        );
        assert!(
            !ids.contains("task4"),
            "task4 (done) should NOT be in results"
        );

        // Filter by step name "backlog" - should get only task1
        let filter = TaskFilter::new()
            .include_done()
            .with_current_step("backlog");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(
            result.len(),
            1,
            "Should return exactly 1 task with step 'backlog'"
        );
        assert_eq!(result[0].id, "task1", "The task should be task1");

        // Filter by step name "done" - should get only task4
        let filter = TaskFilter::new().include_done().with_current_step("done");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(
            result.len(),
            1,
            "Should return exactly 1 task with step 'done'"
        );
        assert_eq!(result[0].id, "task4", "The task should be task4");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_with_workflow_and_step_filter_combined() {
        let (db, temp_dir) = setup_test_db().await;

        // Create two workflows with same step names
        create_workflow_with_steps(&db, "wfcombined1", &["backlog", "in_progress", "done"]).await;
        create_workflow_with_steps(&db, "wfcombined2", &["backlog", "in_progress", "done"]).await;

        // Create tasks with standard status values
        create_task(&db, "combined1", "Task 1", "task", "backlog", None, &[]).await;
        create_task(&db, "combined2", "Task 2", "task", "in_progress", None, &[]).await;
        create_task(&db, "combined3", "Task 3", "task", "backlog", None, &[]).await;
        create_task(&db, "combined4", "Task 4", "task", "in_progress", None, &[]).await;

        // Assign tasks 1-2 to wfcombined1, tasks 3-4 to wfcombined2
        assign_workflow_step(&db, "combined1", "wfcombined1", "backlog").await;
        assign_workflow_step(&db, "combined2", "wfcombined1", "in_progress").await;
        assign_workflow_step(&db, "combined3", "wfcombined2", "backlog").await;
        assign_workflow_step(&db, "combined4", "wfcombined2", "in_progress").await;

        let lister = TaskLister::new(db.client());

        // Verify all tasks exist
        let all_filter = TaskFilter::new().include_done();
        let all_tasks = lister.list(&all_filter).await.unwrap();
        assert_eq!(all_tasks.len(), 4, "Should have 4 tasks total");

        // Verify workflow filtering alone works
        let wf_filter = TaskFilter::new()
            .include_done()
            .with_workflow_id("wfcombined1");
        let wf_tasks = lister.list(&wf_filter).await.unwrap();
        assert_eq!(wf_tasks.len(), 2, "Should return 2 tasks from wfcombined1");

        // Verify step filtering alone works
        let step_filter = TaskFilter::new()
            .include_done()
            .with_current_step("in_progress");
        let step_tasks = lister.list(&step_filter).await.unwrap();
        assert_eq!(
            step_tasks.len(),
            2,
            "Should return 2 tasks with step 'in_progress'"
        );

        // Combined filter: wfcombined1 AND step "in_progress" - should get only combined2
        let filter = TaskFilter::new()
            .include_done()
            .with_workflow_id("wfcombined1")
            .with_current_step("in_progress");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1, "Should return exactly 1 task");
        assert_eq!(
            result[0].id, "combined2",
            "Should be combined2 (wfcombined1 + in_progress)"
        );

        // Combined filter: wfcombined2 AND step "backlog" - should get only combined3
        let filter = TaskFilter::new()
            .include_done()
            .with_workflow_id("wfcombined2")
            .with_current_step("backlog");
        let result = lister.list(&filter).await.unwrap();

        assert_eq!(result.len(), 1, "Should return exactly 1 task");
        assert_eq!(
            result[0].id, "combined3",
            "Should be combined3 (wfcombined2 + backlog)"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_summary_includes_workflow_and_step_names() {
        let (db, temp_dir) = setup_test_db().await;

        // Create workflow with a named step
        let workflow_name = "My Test Workflow";
        let step_name = "reviewing";
        db.client()
            .query(format!(
                r#"CREATE workflow:named_wf SET name = "{}""#,
                workflow_name
            ))
            .await
            .unwrap();
        db.client()
            .query(format!(
                r#"CREATE step:named_step SET name = "{}", workflow_id = workflow:named_wf, order = 0"#,
                step_name
            ))
            .await
            .unwrap();

        // Create task and assign to workflow step
        create_task(
            &db,
            "named_task",
            "Named Task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        db.client()
            .query("UPDATE task:named_task SET workflow_id = workflow:named_wf, current_step_id = step:named_step")
            .await
            .unwrap();

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().include_done();
        let result = lister.list(&filter).await.unwrap();

        let task = result.iter().find(|t| t.id == "named_task").unwrap();

        // Verify workflow_name and step_name are populated
        assert_eq!(
            task.workflow_name,
            Some(workflow_name.to_string()),
            "workflow_name should be populated with the workflow's name"
        );
        assert_eq!(
            task.step_name,
            Some(step_name.to_string()),
            "step_name should be populated with the step's name"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_summary_without_workflow_has_none_names() {
        let (db, temp_dir) = setup_test_db().await;

        // Create task in backlog status (no current_step_id set)
        // This represents a task that hasn't been assigned to any workflow or step
        create_task(
            &db,
            "plain_task",
            "Plain Task",
            "task",
            "backlog",
            None,
            &[],
        )
        .await;

        let lister = TaskLister::new(db.client());
        let filter = TaskFilter::new().include_done();
        let result = lister.list(&filter).await.unwrap();

        let task = result.iter().find(|t| t.id == "plain_task").unwrap();

        // Verify workflow_name is None (no workflow assigned)
        // step_name is also None since current_step_id is None for backlog tasks
        assert_eq!(
            task.workflow_name, None,
            "workflow_name should be None for tasks without workflow"
        );
        assert_eq!(
            task.step_name, None,
            "step_name should be None for backlog tasks without step assignment"
        );

        cleanup(&temp_dir);
    }
}
