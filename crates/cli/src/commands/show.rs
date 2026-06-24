//! Show command for displaying full task details
//!
//! Implements the `vtb show` command to display complete task information
//! including sections, relationships, and code references.

use crate::commands::list::TaskSummary;
use crate::output::format_task_run_brief;
use clap::Args;
use serde::Serialize;
use vertebrae_core::{CodeRef, Section, SectionType, TaskRunControls, TaskRunSummary};
use vertebrae_core::{ServiceError, VertebraeServices, WorkflowInfo, WorkflowService};

/// Show full details of a task
#[derive(Debug, Args)]
pub struct ShowCommand {
    /// Task ID to show (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,
}

/// Detailed view of a task with all relationships
#[derive(Debug, Serialize)]
pub struct TaskDetail {
    /// The task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Optional description
    pub description: Option<String>,
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
    /// Creation timestamp
    pub created_at: Option<String>,
    /// Last update timestamp
    pub updated_at: Option<String>,
    /// Completed timestamp
    pub completed_at: Option<String>,
    /// Optional worktree path
    pub worktree: Option<String>,
    /// Reason why the task was rejected
    pub rejection_reason: Option<String>,
    /// Whether this task is archived
    pub archived: bool,
    /// Parent task ID (if any)
    pub parent_id: Option<String>,
    /// Workflow assignment information
    pub workflow: Option<WorkflowInfo>,
    /// Server-derived run controls.
    pub run_controls: Option<TaskRunControls>,
    /// Concise task-local run history.
    pub run_history: Vec<TaskRunSummary>,
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

/// Result from querying a task - handles display format
#[derive(Debug)]
struct TaskRow {
    id: String,
    title: String,
    description: Option<String>,
    level: String,
    workflow_name: Option<String>,
    step_name: Option<String>,
    priority: Option<String>,
    tags: Vec<String>,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
    archived: bool,
    worktree: Option<String>,
    rejection_reason: Option<String>,
    workflow_id: Option<String>,
    current_step_id: Option<String>,
    run_controls: Option<TaskRunControls>,
    parent_id: Option<String>,
    sections: Vec<SectionRow>,
    code_refs: Vec<CodeRefRow>,
    blockers: Vec<vertebrae_core::Task>,
    dependents: Vec<vertebrae_core::Task>,
    children: Vec<vertebrae_core::Task>,
}

/// Section row from database
#[derive(Debug)]
struct SectionRow {
    section_type: Option<String>,
    content: Option<String>,
    order: Option<u32>,
    done: Option<bool>,
    done_at: Option<chrono::DateTime<chrono::Utc>>,
    refs: Vec<CodeRefRow>,
}

/// Code reference row from database
#[derive(Debug)]
struct CodeRefRow {
    path: Option<String>,
    line_start: Option<u32>,
    line_end: Option<u32>,
    name: Option<String>,
    description: Option<String>,
}

/// Related task row from graph queries
#[derive(Debug)]
struct RelatedTaskRow {
    id: String,
    title: String,
    level: String,
    workflow_name: Option<String>,
    step_name: Option<String>,
    priority: Option<String>,
    tags: Vec<String>,
}

impl From<RelatedTaskRow> for TaskSummary {
    fn from(row: RelatedTaskRow) -> Self {
        TaskSummary {
            id: row.id,
            title: row.title,
            level: row.level,
            workflow_name: row.workflow_name,
            step_name: row.step_name,
            run_state: None,
            active_task_run_id: None,
            latest_step_execution_id: None,
            priority: row.priority,
            tags: row.tags,
            archived: false,
            parent_id: None,
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
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Database operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<TaskDetail, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch the main task using service layer (includes blockers, dependents, children)
        let task = self.fetch_task(services, &id).await?;

        // Fetch parent separately (not included in GET_TASK response)
        let parent = self
            .fetch_parent(services, task.parent_id.as_deref())
            .await?;

        // Convert embedded relationships to TaskSummary
        let children: Vec<TaskSummary> = task.children.iter().map(task_to_summary).collect();

        // Blockers: filter for incomplete only (step_name != "done")
        let blocked_by: Vec<TaskSummary> = task
            .blockers
            .iter()
            .filter(|t| t.step_name.as_deref() != Some("done"))
            .map(task_to_summary)
            .collect();

        let blocks: Vec<TaskSummary> = task.dependents.iter().map(task_to_summary).collect();

        // Fetch workflow info if task is assigned to a workflow
        let workflow = self
            .fetch_workflow_info(
                services.workflows(),
                task.workflow_id.as_deref(),
                task.current_step_id.as_deref(),
            )
            .await?;

        let run_controls = task.run_controls.clone();
        let run_history: Vec<TaskRunSummary> = services
            .executions()
            .task_runs(&id)
            .await?
            .iter()
            .map(TaskRunSummary::from)
            .collect();

        // Convert sections - filter out any without required fields
        let sections: Vec<Section> = task
            .sections
            .into_iter()
            .filter_map(|s| {
                let section_type_str = s.section_type?;
                let content = s.content?;
                let section_type = section_type_str.parse::<SectionType>().ok()?;

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
                section.done = s.done;
                section.done_at = s.done_at;
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

        // Compute the workflow position from workflow info.
        let (derived_workflow_name, derived_step_name) = if let Some(ref wf) = workflow {
            (Some(wf.name.clone()), Some(wf.current_step_name.clone()))
        } else {
            (task.workflow_name, task.step_name)
        };

        Ok(TaskDetail {
            id: task.id,
            title: task.title,
            description: task.description,
            level: task.level.as_str().to_string(),
            workflow_name: derived_workflow_name,
            step_name: derived_step_name,
            priority: task.priority.map(|p| p.as_str().to_string()),
            tags: task.tags,
            created_at: task.created_at.map(|dt| dt.to_string()),
            updated_at: task.updated_at.map(|dt| dt.to_string()),
            completed_at: task.completed_at.map(|dt| dt.to_string()),
            archived: task.archived,
            parent_id: task.parent_id,
            worktree: task.worktree,
            rejection_reason: task.rejection_reason,
            workflow,
            run_controls,
            run_history,
            sections,
            code_refs,
            parent,
            children,
            blocked_by,
            blocks,
        })
    }

    /// Fetch the main task by ID using the service layer.
    async fn fetch_task(
        &self,
        services: &VertebraeServices,
        id: &str,
    ) -> Result<TaskRow, ServiceError> {
        // Use service method to get the task
        let task = services.tasks().get_task(id).await?;

        // Convert Task to TaskRow for display
        Ok(TaskRow {
            id: task.id,
            title: task.title,
            description: task.description,
            level: task.level.as_str().to_string(),
            workflow_name: task.workflow_name,
            step_name: task.step_name,
            priority: task.priority.map(|p| p.as_str().to_string()),
            tags: task.tags,
            created_at: task.created_at,
            updated_at: task.updated_at,
            completed_at: task.completed_at,
            archived: task.archived,
            worktree: task.worktree,
            rejection_reason: task.rejection_reason,
            workflow_id: task.workflow_id,
            current_step_id: task.current_step_id,
            run_controls: task.run_controls,
            parent_id: task.parent_id,
            sections: task
                .sections
                .into_iter()
                .map(|s| SectionRow {
                    section_type: Some(s.section_type.as_str().to_string()),
                    content: Some(s.content),
                    order: s.order,
                    done: s.done,
                    done_at: s.done_at,
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
            blockers: task.blockers,
            dependents: task.dependents,
            children: task.children,
        })
    }

    /// Fetch the parent task (if any) using the service layer.
    async fn fetch_parent(
        &self,
        services: &VertebraeServices,
        parent_id: Option<&str>,
    ) -> Result<Option<TaskSummary>, ServiceError> {
        let parent_id = match parent_id {
            Some(id) => id,
            None => return Ok(None),
        };

        let task = services.tasks().get_task_summary(parent_id).await?;

        Ok(Some(TaskSummary {
            parent_id: None,
            ..TaskSummary::from(task)
        }))
    }

    /// Fetch workflow information for a task assigned to a workflow.
    async fn fetch_workflow_info(
        &self,
        service: &dyn WorkflowService,
        workflow_id: Option<&str>,
        current_step_id: Option<&str>,
    ) -> Result<Option<WorkflowInfo>, ServiceError> {
        let workflow_id = match workflow_id {
            Some(wf_id) => wf_id,
            None => return Ok(None),
        };

        // Fetch the workflow info from the service
        let info = service
            .get_workflow_info(workflow_id, current_step_id)
            .await?;
        Ok(Some(info))
    }
}

/// Convert a core Task to a TaskSummary for display in relationships.
fn task_to_summary(task: &vertebrae_core::Task) -> TaskSummary {
    TaskSummary::from(task)
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
        let workflow_display = match (&self.workflow_name, &self.step_name) {
            (Some(wf), Some(step)) => format!("{}:{}", wf, step),
            _ => "unassigned".to_string(),
        };
        writeln!(f, "Workflow: {}", workflow_display)?;
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
        if let Some(ref worktree) = self.worktree {
            writeln!(f, "Worktree: {}", worktree)?;
        }
        writeln!(f, "\n")?;

        // Rejection reason (prominently displayed when present)
        if let Some(ref reason) = self.rejection_reason {
            writeln!(f, "!! REJECTION REASON !!")?;
            writeln!(f, "{}", "-".repeat(40))?;
            writeln!(f, "{}", reason)?;
            writeln!(f)?;
        }

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

        writeln!(f, "Run")?;
        writeln!(f, "{}", "-".repeat(40))?;
        if let Some(active_run) = self
            .run_controls
            .as_ref()
            .and_then(|controls| controls.active_run.as_ref())
            .map(TaskRunSummary::from)
        {
            writeln!(f, "Run: {}", format_task_run_brief(&active_run))?;
        } else {
            writeln!(f, "Run: idle")?;
        }
        if let Some(ref controls) = self.run_controls {
            writeln!(f, "Controls: {}", format_run_controls(controls))?;
        }
        if !self.run_history.is_empty() {
            writeln!(f, "History:")?;
            for run in self.run_history.iter().rev().take(5) {
                writeln!(f, "  - {}", format_task_run_brief(run))?;
            }
        }
        writeln!(f)?;

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
            (SectionType::ChecklistItem, "Checklist Items"),
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

fn format_run_controls(controls: &TaskRunControls) -> String {
    let mut parts = vec![
        format!("runnable={}", controls.runnable),
        format!("stoppable={}", controls.stoppable),
    ];
    if let Some(ref code) = controls.disabled_reason_code {
        parts.push(format!("reasonCode={}", code));
    }
    if let Some(ref reason) = controls.disabled_reason {
        parts.push(format!("reason=\"{}\"", reason));
    }
    parts.join(" ")
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

    // For checklist items, show with checkboxes
    let is_checklist_item = section_type == SectionType::ChecklistItem;
    // For testing criteria, show inline refs
    let is_testing_criterion = section_type == SectionType::TestingCriterion;

    if sorted.len() == 1 {
        if is_checklist_item {
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
            if is_checklist_item {
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

    fn sample_task_detail() -> TaskDetail {
        TaskDetail {
            id: "abc12345-0000-4000-8000-000000000001".to_string(),
            title: "Sample task".to_string(),
            description: Some("A test task".to_string()),
            level: "ticket".to_string(),
            workflow_name: Some("Implementation".to_string()),
            step_name: Some("in_progress".to_string()),
            priority: Some("high".to_string()),
            tags: vec!["backend".to_string(), "api".to_string()],
            created_at: Some("2026-01-01T00:00:00Z".to_string()),
            updated_at: Some("2026-01-02T00:00:00Z".to_string()),
            completed_at: None,
            archived: false,
            parent_id: None,
            worktree: None,
            rejection_reason: None,
            workflow: None,
            run_controls: None,
            run_history: vec![],
            sections: vec![],
            code_refs: vec![],
            parent: None,
            children: vec![],
            blocked_by: vec![],
            blocks: vec![],
        }
    }

    #[test]
    fn test_task_detail_serializes_to_json() {
        let detail = sample_task_detail();
        let json = serde_json::to_value(&detail).unwrap();

        assert_eq!(json["id"], "abc12345-0000-4000-8000-000000000001");
        assert_eq!(json["title"], "Sample task");
        assert_eq!(json["description"], "A test task");
        assert_eq!(json["level"], "ticket");
        assert_eq!(json["workflow_name"], "Implementation");
        assert_eq!(json["step_name"], "in_progress");
        assert_eq!(json["priority"], "high");
        assert_eq!(json["tags"][0], "backend");
        assert_eq!(json["tags"][1], "api");
        assert!(json["completed_at"].is_null());
    }

    #[test]
    fn test_task_detail_json_includes_relationships() {
        let mut detail = sample_task_detail();
        detail.children = vec![TaskSummary {
            id: "child-0000-4000-8000-000000000001".to_string(),
            title: "Child task".to_string(),
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
        }];
        detail.blocked_by = vec![TaskSummary {
            id: "blocker-0000-4000-8000-000000000001".to_string(),
            title: "Blocking task".to_string(),
            level: "ticket".to_string(),
            workflow_name: None,
            step_name: Some("todo".to_string()),
            run_state: None,
            active_task_run_id: None,
            latest_step_execution_id: None,
            priority: None,
            tags: vec![],
            archived: false,
            parent_id: None,
        }];

        let json = serde_json::to_value(&detail).unwrap();
        let children = json["children"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["id"], "child-0000-4000-8000-000000000001");
        assert_eq!(children[0]["title"], "Child task");

        let blocked_by = json["blocked_by"].as_array().unwrap();
        assert_eq!(blocked_by.len(), 1);
        assert_eq!(blocked_by[0]["id"], "blocker-0000-4000-8000-000000000001");
        assert_eq!(blocked_by[0]["step_name"], "todo");
    }

    #[test]
    fn test_task_detail_json_includes_sections() {
        let mut detail = sample_task_detail();
        detail.sections = vec![Section::new(
            SectionType::ChecklistItem,
            "Write tests".to_string(),
        )];

        let json = serde_json::to_value(&detail).unwrap();
        let sections = json["sections"].as_array().unwrap();
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0]["content"], "Write tests");
        assert_eq!(
            sections[0]["type"], "checklist_item",
            "Section type is serialized as 'type' due to serde rename"
        );
    }

    #[test]
    fn test_task_detail_json_includes_code_refs() {
        let mut detail = sample_task_detail();
        detail.code_refs =
            vec![CodeRef::line("src/main.rs".to_string(), 42).with_name("main".to_string())];

        let json = serde_json::to_value(&detail).unwrap();
        let refs = json["code_refs"].as_array().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0]["path"], "src/main.rs");
        assert_eq!(refs[0]["line_start"], 42);
        assert_eq!(refs[0]["name"], "main");
    }

    #[test]
    fn test_task_detail_json_roundtrip_is_valid() {
        let detail = sample_task_detail();
        let json_string = serde_json::to_string(&detail).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_string).unwrap();
        assert!(
            parsed.is_object(),
            "Serialized TaskDetail should be a JSON object"
        );
        assert!(
            parsed.as_object().unwrap().contains_key("id"),
            "JSON object should contain id key"
        );
    }
}
