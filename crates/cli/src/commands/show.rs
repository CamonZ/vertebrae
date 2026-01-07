//! Show command for displaying full task details
//!
//! Implements the `vtb show` command to display complete task information
//! including sections, relationships, and code references.

use crate::commands::list::TaskSummary;
use clap::Args;
use serde::Deserialize;
use vertebrae_db::{CodeRef, Database, DbError, Section, SectionType};

/// Show full details of a task
#[derive(Debug, Args)]
pub struct ShowCommand {
    /// Task ID to show (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Detailed view of a task with all relationships
#[derive(Debug)]
pub struct TaskDetail {
    /// The task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Optional description
    pub description: Option<String>,
    /// Hierarchy level
    pub level: String,
    /// Current status
    pub status: String,
    /// Optional priority
    pub priority: Option<String>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Creation timestamp
    pub created_at: Option<String>,
    /// Last update timestamp
    pub updated_at: Option<String>,
    /// Completed timestamp
    pub completed_at: Option<String>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
    /// Embedded sections
    pub sections: Vec<Section>,
    /// Embedded code references
    pub code_refs: Vec<CodeRef>,
    /// Parent task (if any)
    pub parent: Option<TaskSummary>,
    /// Children tasks
    pub children: Vec<TaskSummary>,
    /// Tasks this task is blocked by (depends on)
    pub blocked_by: Vec<TaskSummary>,
    /// Tasks that are blocked by this task
    pub blocks: Vec<TaskSummary>,
}

/// Result from querying a task - handles SurrealDB Thing id format
#[derive(Debug, Deserialize)]
struct TaskRow {
    id: surrealdb::sql::Thing,
    title: String,
    #[serde(default)]
    description: Option<String>,
    level: String,
    status: String,
    priority: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    created_at: Option<surrealdb::sql::Datetime>,
    #[serde(default)]
    updated_at: Option<surrealdb::sql::Datetime>,
    #[serde(default)]
    completed_at: Option<surrealdb::sql::Datetime>,
    #[serde(default)]
    needs_human_review: Option<bool>,
    #[serde(default)]
    sections: Vec<SectionRow>,
    #[serde(default, rename = "refs")]
    code_refs: Vec<CodeRefRow>,
}

/// Section row from database
#[derive(Debug, Deserialize)]
struct SectionRow {
    #[serde(rename = "type", default)]
    section_type: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    order: Option<u32>,
}

/// Code reference row from database
#[derive(Debug, Deserialize)]
struct CodeRefRow {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line_start: Option<u32>,
    #[serde(default)]
    line_end: Option<u32>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

/// Related task row from graph queries
#[derive(Debug, Deserialize)]
struct RelatedTaskRow {
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

impl From<RelatedTaskRow> for TaskSummary {
    fn from(row: RelatedTaskRow) -> Self {
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

impl ShowCommand {
    /// Execute the show command.
    ///
    /// Fetches the task with the given ID along with all its relationships
    /// and returns detailed task information.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<TaskDetail, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch the main task
        let task = self.fetch_task(db, &id).await?;

        // Fetch related data in parallel-ish manner
        let parent = self.fetch_parent(db, &id).await?;
        let children = self.fetch_children(db, &id).await?;
        let blocked_by = self.fetch_blocked_by(db, &id).await?;
        let blocks = self.fetch_blocks(db, &id).await?;

        // Convert sections - filter out any without required fields
        let sections: Vec<Section> = task
            .sections
            .into_iter()
            .filter_map(|s| {
                let section_type_str = s.section_type?;
                let content = s.content?;
                let section_type = parse_section_type(&section_type_str);
                Some(if let Some(order) = s.order {
                    Section::with_order(section_type, content, order)
                } else {
                    Section::new(section_type, content)
                })
            })
            .collect();

        // Convert code refs - filter out any without required fields
        let code_refs: Vec<CodeRef> = task
            .code_refs
            .into_iter()
            .filter_map(|r| {
                let path = r.path?;
                let mut code_ref = if let (Some(start), Some(end)) = (r.line_start, r.line_end) {
                    CodeRef::range(path, start, end)
                } else if let Some(line) = r.line_start {
                    CodeRef::line(path, line)
                } else {
                    CodeRef::file(path)
                };
                if let Some(name) = r.name {
                    code_ref = code_ref.with_name(name);
                }
                if let Some(desc) = r.description {
                    code_ref = code_ref.with_description(desc);
                }
                Some(code_ref)
            })
            .collect();

        Ok(TaskDetail {
            id: task.id.id.to_string(),
            title: task.title,
            description: task.description,
            level: task.level,
            status: task.status,
            priority: task.priority,
            tags: task.tags,
            created_at: task.created_at.map(|dt| dt.to_string()),
            updated_at: task.updated_at.map(|dt| dt.to_string()),
            completed_at: task.completed_at.map(|dt| dt.to_string()),
            needs_human_review: task.needs_human_review,
            sections,
            code_refs,
            parent,
            children,
            blocked_by,
            blocks,
        })
    }

    /// Fetch the main task by ID.
    async fn fetch_task(&self, db: &Database, id: &str) -> Result<TaskRow, DbError> {
        let task: Option<TaskRow> = db
            .client()
            .select(("task", id))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.id),
            reason: format!("Task '{}' not found", self.id),
        })
    }

    /// Fetch the parent task (if any) using graph traversal.
    async fn fetch_parent(&self, db: &Database, id: &str) -> Result<Option<TaskSummary>, DbError> {
        // SELECT ->child_of->task.* FROM task:<id> gets the parent
        let query = format!(
            "SELECT id, title, level, status, priority, tags, needs_human_review \
             FROM task WHERE <-child_of<-task CONTAINS task:{}",
            id
        );

        let mut result = db.client().query(&query).await?;
        let parents: Vec<RelatedTaskRow> = result.take(0)?;

        Ok(parents.into_iter().next().map(TaskSummary::from))
    }

    /// Fetch children tasks using graph traversal.
    async fn fetch_children(&self, db: &Database, id: &str) -> Result<Vec<TaskSummary>, DbError> {
        // SELECT <-child_of<-task.* FROM task:<id> gets children
        let query = format!(
            "SELECT id, title, level, status, priority, tags, needs_human_review \
             FROM task WHERE ->child_of->task CONTAINS task:{}",
            id
        );

        let mut result = db.client().query(&query).await?;
        let children: Vec<RelatedTaskRow> = result.take(0)?;

        Ok(children.into_iter().map(TaskSummary::from).collect())
    }

    /// Fetch tasks that this task depends on (blocked by).
    async fn fetch_blocked_by(&self, db: &Database, id: &str) -> Result<Vec<TaskSummary>, DbError> {
        // SELECT ->depends_on->task.* FROM task:<id> gets dependencies
        let query = format!(
            "SELECT id, title, level, status, priority, tags, needs_human_review \
             FROM task WHERE <-depends_on<-task CONTAINS task:{}",
            id
        );

        let mut result = db.client().query(&query).await?;
        let deps: Vec<RelatedTaskRow> = result.take(0)?;

        Ok(deps.into_iter().map(TaskSummary::from).collect())
    }

    /// Fetch tasks that are blocked by this task.
    async fn fetch_blocks(&self, db: &Database, id: &str) -> Result<Vec<TaskSummary>, DbError> {
        // SELECT <-depends_on<-task.* FROM task:<id> gets tasks that depend on this
        let query = format!(
            "SELECT id, title, level, status, priority, tags, needs_human_review \
             FROM task WHERE ->depends_on->task CONTAINS task:{}",
            id
        );

        let mut result = db.client().query(&query).await?;
        let blocking: Vec<RelatedTaskRow> = result.take(0)?;

        Ok(blocking.into_iter().map(TaskSummary::from).collect())
    }
}

/// Parse a section type string into SectionType enum
fn parse_section_type(s: &str) -> SectionType {
    match s {
        "goal" => SectionType::Goal,
        "context" => SectionType::Context,
        "current_behavior" => SectionType::CurrentBehavior,
        "desired_behavior" => SectionType::DesiredBehavior,
        "step" => SectionType::Step,
        "testing_criterion" => SectionType::TestingCriterion,
        "anti_pattern" => SectionType::AntiPattern,
        "failure_test" => SectionType::FailureTest,
        "constraint" => SectionType::Constraint,
        // Default to Goal if unknown (should not happen with schema validation)
        _ => SectionType::Goal,
    }
}

/// Format a TaskDetail for display
impl std::fmt::Display for TaskDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Header with task ID and title
        writeln!(f, "Task: {} - {}", self.id, self.title)?;
        writeln!(f, "{}", "=".repeat(60))?;
        writeln!(f)?;

        // Metadata section
        writeln!(f, "Metadata")?;
        writeln!(f, "{}", "-".repeat(40))?;
        writeln!(f, "Level:    {}", self.level)?;
        writeln!(f, "Status:   {}", self.status)?;
        writeln!(
            f,
            "Priority: {}",
            self.priority.as_deref().unwrap_or("(none)")
        )?;
        writeln!(
            f,
            "Tags:     {}\n",
            if self.tags.is_empty() {
                "(none)".to_string()
            } else {
                self.tags.join(", ")
            }
        )?;
        let review_status = match self.needs_human_review {
            Some(true) => "True",
            Some(false) => "False",
            None => "False",
        };
        writeln!(f, "Human Review: {}\n\n", review_status)?;

        // Timestamps
        writeln!(
            f,
            "Started At:   {}",
            format_timestamp(self.created_at.as_deref())
        )?;
        writeln!(
            f,
            "Updated At:   {}",
            format_timestamp(self.updated_at.as_deref())
        )?;
        writeln!(
            f,
            "Completed At: {}",
            format_timestamp(self.completed_at.as_deref())
        )?;
        writeln!(f)?;

        // Description section (if present)
        if let Some(ref description) = self.description {
            writeln!(f, "Description")?;
            writeln!(f, "{}", "-".repeat(40))?;
            writeln!(f, "{}", description)?;
            writeln!(f)?;
        }

        // Desired Behavior sections
        let positive_sections: Vec<&Section> = self
            .sections
            .iter()
            .filter(|s| is_positive_space(&s.section_type))
            .collect();

        if !positive_sections.is_empty() {
            writeln!(f, "Desired Behavior")?;
            writeln!(f, "{}", "-".repeat(40))?;

            // Group by section type for display
            format_section_group(f, &positive_sections, SectionType::Goal, "Goal")?;
            format_section_group(f, &positive_sections, SectionType::Context, "Context")?;
            format_section_group(
                f,
                &positive_sections,
                SectionType::CurrentBehavior,
                "Current Behavior",
            )?;
            format_section_group(
                f,
                &positive_sections,
                SectionType::DesiredBehavior,
                "Desired Behavior",
            )?;
            format_section_group(f, &positive_sections, SectionType::Step, "Steps")?;
            format_section_group(
                f,
                &positive_sections,
                SectionType::TestingCriterion,
                "Testing Criteria",
            )?;

            writeln!(f)?;
        }

        // Undesired Behavior sections
        let negative_sections: Vec<&Section> = self
            .sections
            .iter()
            .filter(|s| !is_positive_space(&s.section_type))
            .collect();

        if !negative_sections.is_empty() {
            writeln!(f, "Undesired Behavior")?;
            writeln!(f, "{}", "-".repeat(40))?;

            format_section_group(
                f,
                &negative_sections,
                SectionType::AntiPattern,
                "Anti-Patterns",
            )?;
            format_section_group(
                f,
                &negative_sections,
                SectionType::FailureTest,
                "Failure Tests",
            )?;
            format_section_group(
                f,
                &negative_sections,
                SectionType::Constraint,
                "Constraints",
            )?;

            writeln!(f)?;
        }

        // Relationships section
        let has_relationships = self.parent.is_some()
            || !self.children.is_empty()
            || !self.blocked_by.is_empty()
            || !self.blocks.is_empty();

        if has_relationships {
            writeln!(f, "Relationships")?;
            writeln!(f, "{}", "-".repeat(40))?;

            if let Some(ref parent) = self.parent {
                writeln!(f, "Parent: {} - {}", parent.id, parent.title)?;
            }

            if !self.children.is_empty() {
                writeln!(f, "Children:")?;
                for child in &self.children {
                    writeln!(f, "  - {} - {}", child.id, child.title)?;
                }
            }

            if !self.blocked_by.is_empty() {
                writeln!(f, "Blocked by:")?;
                for dep in &self.blocked_by {
                    writeln!(f, "  - {} - {}", dep.id, dep.title)?;
                }
            }

            if !self.blocks.is_empty() {
                writeln!(f, "Blocks:")?;
                for blocking in &self.blocks {
                    writeln!(f, "  - {} - {}", blocking.id, blocking.title)?;
                }
            }

            writeln!(f)?;
        }

        // Code references section
        if !self.code_refs.is_empty() {
            writeln!(f, "Code References")?;
            writeln!(f, "{}", "-".repeat(40))?;

            for code_ref in &self.code_refs {
                let location = format_code_ref_location(code_ref);
                let name_part = code_ref
                    .name
                    .as_ref()
                    .map(|n| format!(" [{}]", n))
                    .unwrap_or_default();
                let desc_part = code_ref
                    .description
                    .as_ref()
                    .map(|d| format!(" ({})", d))
                    .unwrap_or_default();
                writeln!(f, "  - {}{}{}", location, name_part, desc_part)?;
            }
        }

        Ok(())
    }
}

/// Check if a section type belongs to positive space
fn is_positive_space(section_type: &SectionType) -> bool {
    matches!(
        section_type,
        SectionType::Goal
            | SectionType::Context
            | SectionType::CurrentBehavior
            | SectionType::DesiredBehavior
            | SectionType::Step
            | SectionType::TestingCriterion
    )
}

/// Format a group of sections by type
fn format_section_group(
    f: &mut std::fmt::Formatter<'_>,
    sections: &[&Section],
    section_type: SectionType,
    label: &str,
) -> std::fmt::Result {
    let matching: Vec<&&Section> = sections
        .iter()
        .filter(|s| s.section_type == section_type)
        .collect();

    if matching.is_empty() {
        return Ok(());
    }

    // Sort by order if available
    let mut sorted: Vec<_> = matching.into_iter().collect();
    sorted.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    // For steps, show with checkboxes
    let is_step = section_type == SectionType::Step;

    if sorted.len() == 1 {
        if is_step {
            let checkbox = if sorted[0].done.unwrap_or(false) {
                "[x]"
            } else {
                "[ ]"
            };
            writeln!(f, "{}: {} {}", label, checkbox, sorted[0].content)?;
        } else {
            writeln!(f, "{}: {}", label, sorted[0].content)?;
        }
    } else {
        writeln!(f, "{}:", label)?;
        for (i, section) in sorted.iter().enumerate() {
            if is_step {
                let checkbox = if section.done.unwrap_or(false) {
                    "[x]"
                } else {
                    "[ ]"
                };
                writeln!(f, "  {}. {} {}", i + 1, checkbox, section.content)?;
            } else {
                writeln!(f, "  {}. {}", i + 1, section.content)?;
            }
        }
    }

    Ok(())
}

/// Format a timestamp for readable display
fn format_timestamp(ts: Option<&str>) -> String {
    match ts {
        Some(s) => {
            // Try to parse and format nicely, otherwise return as-is
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                dt.format("%Y-%m-%d %H:%M").to_string()
            } else {
                // Try parsing SurrealDB format
                s.replace('T', " ").replace('Z', "")
            }
        }
        None => String::new(),
    }
}

/// Format a code reference location in file:line format
fn format_code_ref_location(code_ref: &CodeRef) -> String {
    match (code_ref.line_start, code_ref.line_end) {
        (Some(start), Some(end)) => format!("{}:{}-{}", code_ref.path, start, end),
        (Some(line), None) => format!("{}:{}", code_ref.path, line),
        _ => code_ref.path.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-show-test-{}-{:?}-{}",
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

    /// Helper to create a depends_on relationship
    async fn create_depends_on(db: &Database, task_id: &str, dep_id: &str) {
        let query = format!("RELATE task:{} -> depends_on -> task:{}", task_id, dep_id);
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_show_simple_task() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "abc123",
            "Test Task",
            "task",
            "todo",
            Some("high"),
            &[],
        )
        .await;

        let cmd = ShowCommand {
            id: "abc123".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Show failed: {:?}", result.err());

        let detail = result.unwrap();
        // Verify all main fields
        assert_eq!(detail.id, "abc123");
        assert_eq!(detail.title, "Test Task");
        assert_eq!(detail.level, "task");
        assert_eq!(detail.status, "todo");
        assert_eq!(detail.priority, Some("high".to_string()));
        assert!(detail.tags.is_empty(), "Tags should be empty");

        // Verify all optional/collection fields are None/empty for a simple task
        assert!(detail.parent.is_none(), "Parent should be None");
        assert!(detail.children.is_empty(), "Children should be empty");
        assert!(detail.blocked_by.is_empty(), "Blocked_by should be empty");
        assert!(detail.blocks.is_empty(), "Blocks should be empty");
        assert!(detail.sections.is_empty(), "Sections should be empty");
        assert!(detail.code_refs.is_empty(), "Code_refs should be empty");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_show_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = ShowCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("not found"),
                    "Expected 'not found' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("nonexistent"),
                    "Expected task ID 'nonexistent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_show_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test Task", "task", "todo", None, &[]).await;

        let cmd = ShowCommand {
            id: "ABC123".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup failed");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_show_with_parent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "parent1",
            "Parent Epic",
            "epic",
            "in_progress",
            Some("high"),
            &["backend", "core"],
        )
        .await;
        create_task(&db, "child1", "Child Task", "task", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;

        let cmd = ShowCommand {
            id: "child1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        assert!(detail.parent.is_some());
        let parent = detail.parent.unwrap();
        assert_eq!(parent.id, "parent1");
        assert_eq!(parent.title, "Parent Epic");
        assert_eq!(parent.level, "epic");
        assert_eq!(parent.status, "in_progress");
        assert_eq!(parent.priority, Some("high".to_string()));
        assert_eq!(parent.tags, vec!["backend", "core"]);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_show_with_children() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent Epic", "epic", "todo", None, &[]).await;
        create_task(
            &db,
            "child1",
            "Child 1",
            "ticket",
            "in_progress",
            Some("high"),
            &["frontend"],
        )
        .await;
        create_task(
            &db,
            "child2",
            "Child 2",
            "ticket",
            "blocked",
            Some("medium"),
            &["backend"],
        )
        .await;
        create_child_of(&db, "child1", "parent1").await;
        create_child_of(&db, "child2", "parent1").await;

        let cmd = ShowCommand {
            id: "parent1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        assert_eq!(detail.children.len(), 2);

        // Find and verify each child by ID
        let child1 = detail.children.iter().find(|c| c.id == "child1").unwrap();
        assert_eq!(child1.title, "Child 1");
        assert_eq!(child1.level, "ticket");
        assert_eq!(child1.status, "in_progress");
        assert_eq!(child1.priority, Some("high".to_string()));
        assert_eq!(child1.tags, vec!["frontend"]);

        let child2 = detail.children.iter().find(|c| c.id == "child2").unwrap();
        assert_eq!(child2.title, "Child 2");
        assert_eq!(child2.level, "ticket");
        assert_eq!(child2.status, "blocked");
        assert_eq!(child2.priority, Some("medium".to_string()));
        assert_eq!(child2.tags, vec!["backend"]);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_show_with_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "dep1",
            "Dependency Task",
            "task",
            "done",
            Some("critical"),
            &["blocker", "core"],
        )
        .await;
        create_task(&db, "task1", "Main Task", "task", "blocked", None, &[]).await;
        create_depends_on(&db, "task1", "dep1").await;

        let cmd = ShowCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        assert_eq!(detail.blocked_by.len(), 1);

        let dep = &detail.blocked_by[0];
        assert_eq!(dep.id, "dep1");
        assert_eq!(dep.title, "Dependency Task");
        assert_eq!(dep.level, "task");
        assert_eq!(dep.status, "done");
        assert_eq!(dep.priority, Some("critical".to_string()));
        assert_eq!(dep.tags, vec!["blocker", "core"]);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_show_with_blocks() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "blocker", "Blocker Task", "task", "todo", None, &[]).await;
        create_task(&db, "blocked", "Blocked Task", "task", "blocked", None, &[]).await;
        create_depends_on(&db, "blocked", "blocker").await;

        let cmd = ShowCommand {
            id: "blocker".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        assert_eq!(detail.blocks.len(), 1);
        assert_eq!(detail.blocks[0].id, "blocked");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_show_with_empty_sections_and_refs() {
        // Note: Due to SurrealDB SCHEMAFULL behavior with array<object>,
        // nested object fields are not preserved unless explicitly defined.
        // This test verifies that the show command handles empty sections/refs gracefully.
        let (db, temp_dir) = setup_test_db().await;

        // Create a task with sections array (even though fields won't be preserved)
        let query = r#"CREATE task:withdata SET
            title = "Task with Data",
            level = "ticket",
            status = "todo",
            sections = [],
            refs = []"#;
        db.client().query(query).await.unwrap();

        let cmd = ShowCommand {
            id: "withdata".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Show with empty sections/refs failed: {:?}",
            result.err()
        );

        let detail = result.unwrap();
        // Empty sections and refs should work fine
        assert!(detail.sections.is_empty());
        assert!(detail.code_refs.is_empty());

        cleanup(&temp_dir);
    }

    #[test]
    fn test_section_conversion() {
        // Test section conversion logic directly
        let section_rows = vec![
            SectionRow {
                section_type: Some("goal".to_string()),
                content: Some("The goal".to_string()),
                order: None,
            },
            SectionRow {
                section_type: Some("step".to_string()),
                content: Some("Step 1".to_string()),
                order: Some(1),
            },
            // Invalid row without required fields - should be filtered out
            SectionRow {
                section_type: None,
                content: Some("No type".to_string()),
                order: None,
            },
        ];

        let sections: Vec<Section> = section_rows
            .into_iter()
            .filter_map(|s| {
                let section_type_str = s.section_type?;
                let content = s.content?;
                let section_type = parse_section_type(&section_type_str);
                Some(if let Some(order) = s.order {
                    Section::with_order(section_type, content, order)
                } else {
                    Section::new(section_type, content)
                })
            })
            .collect();

        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].section_type, SectionType::Goal);
        assert_eq!(sections[1].section_type, SectionType::Step);
        assert_eq!(sections[1].order, Some(1));
    }

    #[test]
    fn test_code_ref_conversion() {
        // Test code ref conversion logic directly
        let code_ref_rows = vec![
            CodeRefRow {
                path: Some("src/main.rs".to_string()),
                line_start: Some(1),
                line_end: Some(50),
                name: None,
                description: None,
            },
            CodeRefRow {
                path: Some("README.md".to_string()),
                line_start: None,
                line_end: None,
                name: Some("readme".to_string()),
                description: Some("Documentation".to_string()),
            },
            // Invalid row without path - should be filtered out
            CodeRefRow {
                path: None,
                line_start: Some(10),
                line_end: None,
                name: None,
                description: None,
            },
        ];

        let code_refs: Vec<CodeRef> = code_ref_rows
            .into_iter()
            .filter_map(|r| {
                let path = r.path?;
                let mut code_ref = if let (Some(start), Some(end)) = (r.line_start, r.line_end) {
                    CodeRef::range(path, start, end)
                } else if let Some(line) = r.line_start {
                    CodeRef::line(path, line)
                } else {
                    CodeRef::file(path)
                };
                if let Some(desc) = r.description {
                    code_ref = code_ref.with_description(desc);
                }
                Some(code_ref)
            })
            .collect();

        assert_eq!(code_refs.len(), 2);
        assert_eq!(code_refs[0].path, "src/main.rs");
        assert_eq!(code_refs[0].line_start, Some(1));
        assert_eq!(code_refs[0].line_end, Some(50));
        assert_eq!(code_refs[1].path, "README.md");
        assert_eq!(code_refs[1].description, Some("Documentation".to_string()));
    }

    #[tokio::test]
    async fn test_show_with_tags() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(
            &db,
            "tagged",
            "Tagged Task",
            "task",
            "todo",
            None,
            &["backend", "api"],
        )
        .await;

        let cmd = ShowCommand {
            id: "tagged".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        assert_eq!(detail.tags, vec!["backend", "api"]);

        cleanup(&temp_dir);
    }

    #[test]
    fn test_parse_section_type() {
        assert_eq!(parse_section_type("goal"), SectionType::Goal);
        assert_eq!(parse_section_type("context"), SectionType::Context);
        assert_eq!(
            parse_section_type("current_behavior"),
            SectionType::CurrentBehavior
        );
        assert_eq!(
            parse_section_type("desired_behavior"),
            SectionType::DesiredBehavior
        );
        assert_eq!(parse_section_type("step"), SectionType::Step);
        assert_eq!(
            parse_section_type("testing_criterion"),
            SectionType::TestingCriterion
        );
        assert_eq!(parse_section_type("anti_pattern"), SectionType::AntiPattern);
        assert_eq!(parse_section_type("failure_test"), SectionType::FailureTest);
        assert_eq!(parse_section_type("constraint"), SectionType::Constraint);
        // Unknown defaults to Goal
        assert_eq!(parse_section_type("unknown"), SectionType::Goal);
    }

    #[test]
    fn test_is_positive_space() {
        assert!(is_positive_space(&SectionType::Goal));
        assert!(is_positive_space(&SectionType::Context));
        assert!(is_positive_space(&SectionType::CurrentBehavior));
        assert!(is_positive_space(&SectionType::DesiredBehavior));
        assert!(is_positive_space(&SectionType::Step));
        assert!(is_positive_space(&SectionType::TestingCriterion));

        assert!(!is_positive_space(&SectionType::AntiPattern));
        assert!(!is_positive_space(&SectionType::FailureTest));
        assert!(!is_positive_space(&SectionType::Constraint));
    }

    #[test]
    fn test_format_timestamp() {
        // RFC3339 format
        assert_eq!(
            format_timestamp(Some("2024-01-15T10:30:00Z")),
            "2024-01-15 10:30"
        );

        // Fallback format
        let result = format_timestamp(Some("2024-01-15T10:30:00Z"));
        assert!(result.contains("2024"));

        // None format
        assert_eq!(format_timestamp(None), "");
    }

    #[test]
    fn test_format_code_ref_location() {
        let file_ref = CodeRef::file("src/main.rs");
        assert_eq!(format_code_ref_location(&file_ref), "src/main.rs");

        let line_ref = CodeRef::line("src/lib.rs", 42);
        assert_eq!(format_code_ref_location(&line_ref), "src/lib.rs:42");

        let range_ref = CodeRef::range("src/mod.rs", 10, 50);
        assert_eq!(format_code_ref_location(&range_ref), "src/mod.rs:10-50");
    }

    #[test]
    fn test_task_detail_display() {
        let detail = TaskDetail {
            id: "abc123".to_string(),
            title: "Test Task".to_string(),
            description: Some("A detailed description".to_string()),
            level: "task".to_string(),
            status: "todo".to_string(),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string()],
            created_at: Some("2024-01-15T10:30:00Z".to_string()),
            updated_at: Some("2024-01-15T11:00:00Z".to_string()),
            completed_at: None,
            needs_human_review: Some(false),
            sections: vec![
                Section::new(SectionType::Goal, "The goal"),
                Section::new(SectionType::AntiPattern, "Don't do this"),
            ],
            code_refs: vec![CodeRef::line("src/main.rs", 42)],
            parent: Some(TaskSummary {
                id: "parent".to_string(),
                title: "Parent".to_string(),
                level: "epic".to_string(),
                status: "todo".to_string(),
                priority: None,
                tags: vec![],
                needs_human_review: None,
            }),
            children: vec![],
            blocked_by: vec![],
            blocks: vec![],
        };

        let output = format!("{}", detail);

        assert!(output.contains("Task: abc123 - Test Task"));
        assert!(output.contains("Level:    task"));
        assert!(output.contains("Status:   todo"));
        assert!(output.contains("Priority: high"));
        assert!(output.contains("Tags:     backend"));
        assert!(output.contains("Description"));
        assert!(output.contains("A detailed description"));
        assert!(output.contains("Desired Behavior"));
        assert!(output.contains("Goal: The goal"));
        assert!(output.contains("Undesired Behavior"));
        assert!(output.contains("Anti-Patterns: Don't do this"));
        assert!(output.contains("Parent: parent - Parent"));
        assert!(output.contains("src/main.rs:42"));
    }

    #[test]
    fn test_task_detail_display_no_optional_fields() {
        let detail = TaskDetail {
            id: "abc123".to_string(),
            title: "Minimal Task".to_string(),
            description: None,
            level: "task".to_string(),
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
            created_at: None,
            updated_at: None,
            completed_at: None,
            needs_human_review: Some(false),
            sections: vec![],
            code_refs: vec![],
            parent: None,
            children: vec![],
            blocked_by: vec![],
            blocks: vec![],
        };

        let output = format!("{}", detail);

        assert!(output.contains("Task: abc123 - Minimal Task"));
        assert!(output.contains("Priority: (none)"));
        assert!(output.contains("Tags:     (none)"));
        // Should not contain sections or relationships
        assert!(!output.contains("Description"));
        assert!(!output.contains("Desired Behavior"));
        assert!(!output.contains("Undesired Behavior"));
        assert!(!output.contains("Relationships"));
        assert!(!output.contains("Code References"));
        // Without needs_human_review flag set, it should not show review line
        assert!(!output.contains("NEEDS HUMAN REVIEW"));
    }

    #[test]
    fn test_task_detail_display_with_needs_review() {
        let detail = TaskDetail {
            id: "abc123".to_string(),
            title: "Review Task".to_string(),
            description: None,
            level: "task".to_string(),
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
            created_at: None,
            updated_at: None,
            completed_at: None,
            needs_human_review: Some(true),
            sections: vec![],
            code_refs: vec![],
            parent: None,
            children: vec![],
            blocked_by: vec![],
            blocks: vec![],
        };

        let output = format!("{}", detail);

        assert!(output.contains("Human Review: True"));
    }

    #[test]
    fn test_task_detail_display_multiple_steps() {
        let detail = TaskDetail {
            id: "abc123".to_string(),
            title: "Task with Steps".to_string(),
            description: None,
            level: "task".to_string(),
            status: "todo".to_string(),
            priority: None,
            tags: vec![],
            created_at: None,
            updated_at: None,
            completed_at: None,
            needs_human_review: Some(false),
            sections: vec![
                Section::with_order(SectionType::Step, "First step", 1),
                Section::with_order(SectionType::Step, "Second step", 2),
            ],
            code_refs: vec![],
            parent: None,
            children: vec![],
            blocked_by: vec![],
            blocks: vec![],
        };

        let output = format!("{}", detail);

        assert!(output.contains("Steps:"));
        assert!(output.contains("1. [ ] First step"));
        assert!(output.contains("2. [ ] Second step"));
    }

    #[test]
    fn test_show_command_debug() {
        let cmd = ShowCommand {
            id: "test123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("ShowCommand") && debug_str.contains("id: \"test123\""),
            "Debug output should contain ShowCommand and id field value"
        );
    }

    #[test]
    fn test_task_detail_debug() {
        let detail = TaskDetail {
            id: "abc123".to_string(),
            title: "Test Task Title".to_string(),
            description: Some("Debug description".to_string()),
            level: "ticket".to_string(),
            status: "in_progress".to_string(),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string()],
            created_at: None,
            updated_at: None,
            completed_at: None,
            needs_human_review: Some(false),
            sections: vec![],
            code_refs: vec![],
            parent: Some(TaskSummary {
                id: "parent1".to_string(),
                title: "Parent Task".to_string(),
                level: "epic".to_string(),
                status: "todo".to_string(),
                priority: None,
                tags: vec![],
                needs_human_review: None,
            }),
            children: vec![],
            blocked_by: vec![],
            blocks: vec![],
        };
        let debug_str = format!("{:?}", detail);
        assert!(
            debug_str.contains("TaskDetail")
                && debug_str.contains("id: \"abc123\"")
                && debug_str.contains("Test Task Title")
                && debug_str.contains("ticket")
                && debug_str.contains("in_progress")
                && debug_str.contains("high")
                && debug_str.contains("backend")
                && debug_str.contains("parent1"),
            "Debug output should contain TaskDetail and all field values"
        );
    }
}
