//! Show command for displaying full task details
//!
//! Implements the `vtb show` command to display complete task information
//! including sections, relationships, and code references.

use crate::commands::list::TaskSummary;
use clap::Args;
use serde::Deserialize;
use vertebrae_core::{ServiceError, TaskService};
use vertebrae_db::{CodeRef, Database, DbError, Section, SectionType};

/// Show full details of a task
#[derive(Debug, Args)]
pub struct ShowCommand {
    /// Task ID to show (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Workflow assignment information
#[derive(Debug)]
pub struct WorkflowInfo {
    /// Workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Current step name
    pub current_step_name: String,
    /// Current step index (0-based)
    pub current_step_index: usize,
    /// Total number of steps
    pub total_steps: usize,
    /// Previous step name (if any)
    pub prev_step_name: Option<String>,
    /// Next step name (if any)
    pub next_step_name: Option<String>,
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
    /// Workflow assignment information
    pub workflow: Option<WorkflowInfo>,
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
    workflow_id: Option<surrealdb::sql::Thing>,
    #[serde(default)]
    current_step: Option<usize>,
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
    #[serde(default)]
    refs: Vec<CodeRefRow>,
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
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Database operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<TaskDetail, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();
        let db = service.database();

        // Fetch the main task
        let task = self.fetch_task(db, &id).await.map_err(|e| match e {
            DbError::TaskNotFound { task_id } => ServiceError::task_not_found(&task_id),
            other => ServiceError::Database(other),
        })?;

        // Fetch related data in parallel-ish manner
        let parent = self
            .fetch_parent(db, &id)
            .await
            .map_err(ServiceError::Database)?;
        let children = self
            .fetch_children(db, &id)
            .await
            .map_err(ServiceError::Database)?;
        let blocked_by = self
            .fetch_blocked_by(db, &id)
            .await
            .map_err(ServiceError::Database)?;
        let blocks = self
            .fetch_blocks(db, &id)
            .await
            .map_err(ServiceError::Database)?;

        // Fetch workflow info if task is assigned to a workflow
        let workflow = self
            .fetch_workflow_info(db, task.workflow_id.as_ref(), task.current_step)
            .await
            .map_err(ServiceError::Database)?;

        // Convert sections - filter out any without required fields
        let sections: Vec<Section> = task
            .sections
            .into_iter()
            .filter_map(|s| {
                let section_type_str = s.section_type?;
                let content = s.content?;
                let section_type = parse_section_type(&section_type_str);

                // Convert section refs
                let section_refs: Vec<CodeRef> = s
                    .refs
                    .into_iter()
                    .filter_map(|r| {
                        let path = r.path?;
                        let mut code_ref =
                            if let (Some(start), Some(end)) = (r.line_start, r.line_end) {
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

                let mut section = if let Some(order) = s.order {
                    Section::with_order(section_type, content, order)
                } else {
                    Section::new(section_type, content)
                };
                section.refs = section_refs;
                Some(section)
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
            workflow,
            sections,
            code_refs,
            parent,
            children,
            blocked_by,
            blocks,
        })
    }

    /// Fetch the main task by ID using the repository layer.
    async fn fetch_task(&self, db: &Database, id: &str) -> Result<TaskRow, DbError> {
        // Use repository method instead of raw query to ensure consistency
        let task = db
            .tasks()
            .get(id)
            .await?
            .ok_or_else(|| DbError::TaskNotFound {
                task_id: self.id.clone(),
            })?;

        // Convert Task to TaskRow for display
        Ok(TaskRow {
            id: task.id.ok_or_else(|| DbError::TaskNotFound {
                task_id: self.id.clone(),
            })?,
            title: task.title,
            description: task.description,
            level: task.level.as_str().to_string(),
            status: task.status.as_str().to_string(),
            priority: task.priority.map(|p| p.as_str().to_string()),
            tags: task.tags,
            created_at: task.created_at.map(surrealdb::sql::Datetime::from),
            updated_at: task.updated_at.map(surrealdb::sql::Datetime::from),
            completed_at: task.completed_at.map(surrealdb::sql::Datetime::from),
            needs_human_review: task.needs_human_review,
            workflow_id: task.workflow_id,
            current_step: task.current_step,
            sections: task
                .sections
                .into_iter()
                .map(|s| SectionRow {
                    section_type: Some(s.section_type.as_str().to_string()),
                    content: Some(s.content),
                    order: s.order,
                    refs: s
                        .refs
                        .into_iter()
                        .map(|r| CodeRefRow {
                            path: Some(r.path),
                            line_start: r.line_start,
                            line_end: r.line_end,
                            name: r.name,
                            description: r.description,
                        })
                        .collect(),
                })
                .collect(),
            code_refs: task
                .code_refs
                .into_iter()
                .map(|r| CodeRefRow {
                    path: Some(r.path),
                    line_start: r.line_start,
                    line_end: r.line_end,
                    name: r.name,
                    description: r.description,
                })
                .collect(),
        })
    }

    /// Fetch the parent task (if any) using the repository layer.
    async fn fetch_parent(&self, db: &Database, id: &str) -> Result<Option<TaskSummary>, DbError> {
        // Use repository method to get parent ID
        let parent_id = db.relationships().get_parent(id).await?;

        if let Some(parent_id) = parent_id {
            let task = db
                .tasks()
                .get(&parent_id)
                .await?
                .ok_or_else(|| DbError::TaskNotFound {
                    task_id: parent_id.clone(),
                })?;

            Ok(Some(TaskSummary {
                id: parent_id,
                title: task.title,
                level: task.level.as_str().to_string(),
                status: task.status.as_str().to_string(),
                priority: task.priority.map(|p| p.as_str().to_string()),
                tags: task.tags,
                needs_human_review: task.needs_human_review,
            }))
        } else {
            Ok(None)
        }
    }

    /// Fetch children tasks using the repository layer.
    async fn fetch_children(&self, db: &Database, id: &str) -> Result<Vec<TaskSummary>, DbError> {
        // Use repository method to get child IDs
        let child_ids = db.relationships().get_children(id).await?;

        let mut children = Vec::new();
        for child_id in child_ids {
            if let Some(task) = db.tasks().get(&child_id).await? {
                children.push(TaskSummary {
                    id: child_id,
                    title: task.title,
                    level: task.level.as_str().to_string(),
                    status: task.status.as_str().to_string(),
                    priority: task.priority.map(|p| p.as_str().to_string()),
                    tags: task.tags,
                    needs_human_review: task.needs_human_review,
                });
            }
        }

        Ok(children)
    }

    /// Fetch tasks that this task depends on (blocked by).
    /// Only returns incomplete blockers (status != done).
    async fn fetch_blocked_by(&self, db: &Database, id: &str) -> Result<Vec<TaskSummary>, DbError> {
        // Use the service layer method to get incomplete blockers with details
        let blockers = db.graph().get_incomplete_blockers_with_details(id).await?;

        Ok(blockers.into_iter().map(TaskSummary::from).collect())
    }

    /// Fetch tasks that are blocked by this task.
    async fn fetch_blocks(&self, db: &Database, id: &str) -> Result<Vec<TaskSummary>, DbError> {
        // Use repository method to get dependent task IDs (tasks blocked by this one)
        let dependent_ids = db.relationships().get_dependents(id).await?;

        let mut blocks = Vec::new();
        for dependent_id in dependent_ids {
            if let Some(task) = db.tasks().get(&dependent_id).await? {
                blocks.push(TaskSummary {
                    id: dependent_id,
                    title: task.title,
                    level: task.level.as_str().to_string(),
                    status: task.status.as_str().to_string(),
                    priority: task.priority.map(|p| p.as_str().to_string()),
                    tags: task.tags,
                    needs_human_review: task.needs_human_review,
                });
            }
        }

        Ok(blocks)
    }

    /// Fetch workflow information for a task assigned to a workflow.
    async fn fetch_workflow_info(
        &self,
        db: &Database,
        workflow_id: Option<&surrealdb::sql::Thing>,
        current_step: Option<usize>,
    ) -> Result<Option<WorkflowInfo>, DbError> {
        let (workflow_id, step_index) = match (workflow_id, current_step) {
            (Some(wf_id), Some(step)) => (wf_id, step),
            _ => return Ok(None),
        };

        // Fetch the workflow
        let workflow = db.workflows().get(&workflow_id.id.to_raw()).await?;

        let workflow = match workflow {
            Some(w) => w,
            None => {
                // Workflow doesn't exist anymore - return minimal info
                return Ok(Some(WorkflowInfo {
                    id: workflow_id.id.to_raw(),
                    name: "(deleted workflow)".to_string(),
                    current_step_name: format!("Step {}", step_index + 1),
                    current_step_index: step_index,
                    total_steps: 0,
                    prev_step_name: None,
                    next_step_name: None,
                }));
            }
        };

        // Get ordered steps
        let steps = workflow.ordered_steps();
        let total_steps = steps.len();

        // Get current step name
        let current_step_name = if step_index < steps.len() {
            steps[step_index].name.clone()
        } else {
            format!("Step {}", step_index + 1)
        };

        // Get previous step name
        let prev_step_name = if step_index > 0 && step_index <= steps.len() {
            Some(steps[step_index - 1].name.clone())
        } else {
            None
        };

        // Get next step name
        let next_step_name = if step_index + 1 < steps.len() {
            Some(steps[step_index + 1].name.clone())
        } else {
            None
        };

        Ok(Some(WorkflowInfo {
            id: workflow_id.id.to_raw(),
            name: workflow.name,
            current_step_name,
            current_step_index: step_index,
            total_steps,
            prev_step_name,
            next_step_name,
        }))
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

        // Workflow section (if assigned)
        if let Some(ref wf) = self.workflow {
            writeln!(f, "Workflow")?;
            writeln!(f, "{}", "-".repeat(40))?;
            writeln!(f, "Name:     {}", wf.name)?;
            writeln!(
                f,
                "Step:     {}/{} - {}",
                wf.current_step_index + 1,
                wf.total_steps,
                wf.current_step_name
            )?;
            if let Some(ref prev) = wf.prev_step_name {
                writeln!(f, "Previous: {}", prev)?;
            }
            if let Some(ref next) = wf.next_step_name {
                writeln!(f, "Next:     {}", next)?;
            }
            writeln!(f)?;
        }

        // Description section (if present)
        if let Some(ref description) = self.description {
            writeln!(f, "Description")?;
            writeln!(f, "{}", "-".repeat(40))?;
            writeln!(f, "{}", description)?;
            writeln!(f)?;
        }

        // Render each section type with its own heading
        // Define section types in display order with their labels
        let section_configs: &[(SectionType, &str)] = &[
            (SectionType::Goal, "Goal"),
            (SectionType::Context, "Context"),
            (SectionType::CurrentBehavior, "Current Behavior"),
            (SectionType::DesiredBehavior, "Desired Behavior"),
            (SectionType::Step, "Steps"),
            (SectionType::TestingCriterion, "Testing Criteria"),
            (SectionType::AntiPattern, "Anti-Patterns"),
            (SectionType::FailureTest, "Failure Tests"),
            (SectionType::Constraint, "Constraints"),
        ];

        for (section_type, label) in section_configs {
            format_section_with_heading(f, &self.sections, section_type.clone(), label)?;
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

/// Format sections of a specific type with their own heading
fn format_section_with_heading(
    f: &mut std::fmt::Formatter<'_>,
    sections: &[Section],
    section_type: SectionType,
    label: &str,
) -> std::fmt::Result {
    let matching: Vec<&Section> = sections
        .iter()
        .filter(|s| s.section_type == section_type)
        .collect();

    if matching.is_empty() {
        return Ok(());
    }

    // Sort by order if available
    let mut sorted: Vec<_> = matching;
    sorted.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    // Write the heading
    writeln!(f, "{}", label)?;
    writeln!(f, "{}", "-".repeat(40))?;

    // For steps, show with checkboxes
    let is_step = section_type == SectionType::Step;
    // For testing criteria, show inline refs
    let is_testing_criterion = section_type == SectionType::TestingCriterion;

    if sorted.len() == 1 {
        if is_step {
            let checkbox = if sorted[0].done.unwrap_or(false) {
                "[x]"
            } else {
                "[ ]"
            };
            writeln!(f, "{} {}", checkbox, sorted[0].content)?;
        } else {
            writeln!(f, "{}", sorted[0].content)?;
        }
        // Show refs for single testing criterion
        if is_testing_criterion && !sorted[0].refs.is_empty() {
            for code_ref in &sorted[0].refs {
                writeln!(f, "   -> {}", format_code_ref_location(code_ref))?;
            }
        }
    } else {
        for (i, section) in sorted.iter().enumerate() {
            if is_step {
                let checkbox = if section.done.unwrap_or(false) {
                    "[x]"
                } else {
                    "[ ]"
                };
                writeln!(f, "{}. {} {}", i + 1, checkbox, section.content)?;
            } else {
                writeln!(f, "{}. {}", i + 1, section.content)?;
            }
            // Show refs inline for each testing criterion
            if is_testing_criterion && !section.refs.is_empty() {
                for code_ref in &section.refs {
                    writeln!(f, "   -> {}", format_code_ref_location(code_ref))?;
                }
            }
        }
    }

    writeln!(f)?;

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
    use vertebrae_core::DefaultTaskService;
    use vertebrae_db::{Level, Priority, Status, Task};

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> DefaultTaskService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultTaskService::new(db)
    }

    /// Helper to create a task using the service
    async fn create_task(
        service: &DefaultTaskService,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
        priority: Option<&str>,
        tags: &[&str],
    ) {
        let db = service.database();
        let level_enum = match level {
            "epic" => Level::Epic,
            "ticket" => Level::Ticket,
            _ => Level::Task,
        };

        let status_enum = match status {
            "backlog" => Status::Backlog,
            "in_progress" => Status::InProgress,
            "pending_review" => Status::PendingReview,
            "done" => Status::Done,
            "rejected" => Status::Rejected,
            _ => Status::Todo,
        };

        let priority_enum = priority.and_then(|p| match p {
            "critical" => Some(Priority::Critical),
            "high" => Some(Priority::High),
            "medium" => Some(Priority::Medium),
            "low" => Some(Priority::Low),
            _ => None,
        });

        let mut task = Task::new(title, level_enum);
        task.status = status_enum;
        task.priority = priority_enum;
        task.tags = tags.iter().map(|s| s.to_string()).collect();

        db.tasks().create(id, &task).await.unwrap();
    }

    /// Helper to create a child_of relationship using the service
    async fn create_child_of(service: &DefaultTaskService, child_id: &str, parent_id: &str) {
        let db = service.database();
        db.relationships()
            .create_child_of(child_id, parent_id)
            .await
            .unwrap();
    }

    /// Helper to create a depends_on relationship using the service
    async fn create_depends_on(service: &DefaultTaskService, task_id: &str, dep_id: &str) {
        let db = service.database();
        db.relationships()
            .create_depends_on(task_id, dep_id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_show_simple_task() {
        let service = setup_test_service().await;

        create_task(
            &service,
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

        let result = cmd.execute(&service).await;
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
    }

    #[tokio::test]
    async fn test_show_nonexistent_task() {
        let service = setup_test_service().await;

        let cmd = ShowCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::TaskNotFound { task_id }) => {
                assert_eq!(
                    task_id, "nonexistent",
                    "Expected task_id 'nonexistent', got: {}",
                    task_id
                );
            }
            Err(other) => panic!("Expected TaskNotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_show_case_insensitive() {
        let service = setup_test_service().await;

        create_task(&service, "abc123", "Test Task", "task", "todo", None, &[]).await;

        let cmd = ShowCommand {
            id: "ABC123".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Case-insensitive lookup failed");
    }

    #[tokio::test]
    async fn test_show_with_parent() {
        let service = setup_test_service().await;

        create_task(
            &service,
            "parent1",
            "Parent Epic",
            "epic",
            "in_progress",
            Some("high"),
            &["backend", "core"],
        )
        .await;
        create_task(&service, "child1", "Child Task", "task", "todo", None, &[]).await;
        create_child_of(&service, "child1", "parent1").await;

        let cmd = ShowCommand {
            id: "child1".to_string(),
        };

        let result = cmd.execute(&service).await;
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
    }

    #[tokio::test]
    async fn test_show_with_children() {
        let service = setup_test_service().await;

        create_task(
            &service,
            "parent1",
            "Parent Epic",
            "epic",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(
            &service,
            "child1",
            "Child 1",
            "ticket",
            "in_progress",
            Some("high"),
            &["frontend"],
        )
        .await;
        create_task(
            &service,
            "child2",
            "Child 2",
            "ticket",
            "backlog",
            Some("medium"),
            &["backend"],
        )
        .await;
        create_child_of(&service, "child1", "parent1").await;
        create_child_of(&service, "child2", "parent1").await;

        let cmd = ShowCommand {
            id: "parent1".to_string(),
        };

        let result = cmd.execute(&service).await;
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
        assert_eq!(child2.status, "backlog");
        assert_eq!(child2.priority, Some("medium".to_string()));
        assert_eq!(child2.tags, vec!["backend"]);
    }

    #[tokio::test]
    async fn test_show_with_dependencies() {
        let service = setup_test_service().await;

        // Use in_progress status - completed blockers are filtered out
        create_task(
            &service,
            "dep1",
            "Dependency Task",
            "task",
            "in_progress",
            Some("critical"),
            &["blocker", "core"],
        )
        .await;
        create_task(&service, "task1", "Main Task", "task", "backlog", None, &[]).await;
        create_depends_on(&service, "task1", "dep1").await;

        let cmd = ShowCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        assert_eq!(detail.blocked_by.len(), 1);

        let dep = &detail.blocked_by[0];
        assert_eq!(dep.id, "dep1");
        assert_eq!(dep.title, "Dependency Task");
        assert_eq!(dep.level, "task");
        assert_eq!(dep.status, "in_progress");
        assert_eq!(dep.priority, Some("critical".to_string()));
        assert_eq!(dep.tags, vec!["blocker", "core"]);
    }

    #[tokio::test]
    async fn test_show_filters_completed_blockers() {
        let service = setup_test_service().await;

        // Completed blocker should not appear in blocked_by
        create_task(
            &service,
            "done_dep",
            "Done Dependency",
            "task",
            "done",
            None,
            &[],
        )
        .await;
        create_task(&service, "task1", "Main Task", "task", "backlog", None, &[]).await;
        create_depends_on(&service, "task1", "done_dep").await;

        let cmd = ShowCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        // Completed blockers are filtered out
        assert!(
            detail.blocked_by.is_empty(),
            "Completed blockers should be filtered out"
        );
    }

    #[tokio::test]
    async fn test_show_with_blocks() {
        let service = setup_test_service().await;

        create_task(
            &service,
            "blocker",
            "Blocker Task",
            "task",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(
            &service,
            "dependent",
            "Dependent Task",
            "task",
            "backlog",
            None,
            &[],
        )
        .await;
        create_depends_on(&service, "dependent", "blocker").await;

        let cmd = ShowCommand {
            id: "blocker".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        assert_eq!(detail.blocks.len(), 1);
        assert_eq!(detail.blocks[0].id, "dependent");
    }

    #[tokio::test]
    async fn test_show_with_empty_sections_and_refs() {
        // Note: Due to SurrealDB SCHEMAFULL behavior with array<object>,
        // nested object fields are not preserved unless explicitly defined.
        // This test verifies that the show command handles empty sections/refs gracefully.
        let service = setup_test_service().await;

        // Create a task using the service
        create_task(
            &service,
            "withdata",
            "Task with Data",
            "ticket",
            "todo",
            None,
            &[],
        )
        .await;

        let cmd = ShowCommand {
            id: "withdata".to_string(),
        };

        let result = cmd.execute(&service).await;
        assert!(
            result.is_ok(),
            "Show with empty sections/refs failed: {:?}",
            result.err()
        );

        let detail = result.unwrap();
        // Empty sections and refs should work fine
        assert!(detail.sections.is_empty());
        assert!(detail.code_refs.is_empty());
    }

    #[test]
    fn test_section_conversion() {
        // Test section conversion logic directly
        let section_rows = vec![
            SectionRow {
                section_type: Some("goal".to_string()),
                content: Some("The goal".to_string()),
                order: None,
                refs: vec![],
            },
            SectionRow {
                section_type: Some("step".to_string()),
                content: Some("Step 1".to_string()),
                order: Some(1),
                refs: vec![],
            },
            // Invalid row without required fields - should be filtered out
            SectionRow {
                section_type: None,
                content: Some("No type".to_string()),
                order: None,
                refs: vec![],
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
        let service = setup_test_service().await;

        create_task(
            &service,
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let detail = result.unwrap();
        assert_eq!(detail.tags, vec!["backend", "api"]);
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
            workflow: None,
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
        // Each section type now has its own heading
        assert!(output.contains("Goal\n"));
        assert!(output.contains("The goal"));
        assert!(output.contains("Anti-Patterns\n"));
        assert!(output.contains("Don't do this"));
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
            workflow: None,
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
        // No section type headings should appear when there are no sections
        assert!(!output.contains("Goal\n"));
        assert!(!output.contains("Steps\n"));
        assert!(!output.contains("Anti-Patterns\n"));
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
            workflow: None,
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
            workflow: None,
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

        // Steps has its own heading followed by dashes
        assert!(output.contains("Steps\n"));
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
            workflow: None,
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

    #[test]
    fn test_task_detail_display_with_workflow() {
        let detail = TaskDetail {
            id: "abc123".to_string(),
            title: "Workflow Task".to_string(),
            description: None,
            level: "task".to_string(),
            status: "in_progress".to_string(),
            priority: None,
            tags: vec![],
            created_at: None,
            updated_at: None,
            completed_at: None,
            needs_human_review: None,
            workflow: Some(WorkflowInfo {
                id: "wf123".to_string(),
                name: "Code Review".to_string(),
                current_step_name: "Review".to_string(),
                current_step_index: 1,
                total_steps: 3,
                prev_step_name: Some("Triage".to_string()),
                next_step_name: Some("Merge".to_string()),
            }),
            sections: vec![],
            code_refs: vec![],
            parent: None,
            children: vec![],
            blocked_by: vec![],
            blocks: vec![],
        };

        let output = format!("{}", detail);

        assert!(output.contains("Workflow"));
        assert!(output.contains("Name:     Code Review"));
        assert!(output.contains("Step:     2/3 - Review"));
        assert!(output.contains("Previous: Triage"));
        assert!(output.contains("Next:     Merge"));
    }

    #[test]
    fn test_task_detail_display_with_workflow_first_step() {
        let detail = TaskDetail {
            id: "abc123".to_string(),
            title: "Workflow Task".to_string(),
            description: None,
            level: "task".to_string(),
            status: "in_progress".to_string(),
            priority: None,
            tags: vec![],
            created_at: None,
            updated_at: None,
            completed_at: None,
            needs_human_review: None,
            workflow: Some(WorkflowInfo {
                id: "wf123".to_string(),
                name: "Simple Workflow".to_string(),
                current_step_name: "First Step".to_string(),
                current_step_index: 0,
                total_steps: 2,
                prev_step_name: None,
                next_step_name: Some("Second Step".to_string()),
            }),
            sections: vec![],
            code_refs: vec![],
            parent: None,
            children: vec![],
            blocked_by: vec![],
            blocks: vec![],
        };

        let output = format!("{}", detail);

        assert!(output.contains("Step:     1/2 - First Step"));
        assert!(!output.contains("Previous:"));
        assert!(output.contains("Next:     Second Step"));
    }

    #[test]
    fn test_workflow_info_debug() {
        let info = WorkflowInfo {
            id: "wf123".to_string(),
            name: "Test Workflow".to_string(),
            current_step_name: "Step One".to_string(),
            current_step_index: 0,
            total_steps: 2,
            prev_step_name: None,
            next_step_name: Some("Step Two".to_string()),
        };
        let debug_str = format!("{:?}", info);
        assert!(
            debug_str.contains("WorkflowInfo")
                && debug_str.contains("wf123")
                && debug_str.contains("Test Workflow"),
            "Debug output should contain WorkflowInfo and field values"
        );
    }
}
