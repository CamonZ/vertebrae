//! Show command for displaying full task details
//!
//! Implements the `vtb show` command to display complete task information
//! including sections, relationships, and code references.

use crate::commands::list::TaskSummary;
use clap::Args;
use vertebrae_core::{CodeRef, Section, SectionType};
use vertebrae_core::{ServiceError, VertebraeServices, WorkflowInfo, WorkflowService};

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
    /// Feedback to address when a validation gate fails
    pub revision_feedback: Option<String>,
    /// Reason why the task was rejected
    pub rejection_reason: Option<String>,
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

/// Result from querying a task - handles display format
#[derive(Debug)]
struct TaskRow {
    id: String,
    title: String,
    description: Option<String>,
    level: String,
    status: String,
    priority: Option<String>,
    tags: Vec<String>,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
    completed_at: Option<chrono::DateTime<chrono::Utc>>,
    needs_human_review: Option<bool>,
    revision_feedback: Option<String>,
    rejection_reason: Option<String>,
    workflow_id: Option<String>,
    current_step_id: Option<String>,
    sections: Vec<SectionRow>,
    code_refs: Vec<CodeRefRow>,
}

/// Section row from database
#[derive(Debug)]
struct SectionRow {
    section_type: Option<String>,
    content: Option<String>,
    order: Option<u32>,
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
    status: String,
    priority: Option<String>,
    tags: Vec<String>,
    needs_human_review: Option<bool>,
}

impl From<RelatedTaskRow> for TaskSummary {
    fn from(row: RelatedTaskRow) -> Self {
        TaskSummary {
            id: row.id,
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

        // Fetch the main task using service layer
        let task = self.fetch_task(services, &id).await?;

        // Fetch related data in parallel-ish manner
        let parent = self.fetch_parent(services).await?;
        let children = self.fetch_children(services).await?;
        let blocked_by = self.fetch_blocked_by(services).await?;
        let blocks = self.fetch_blocks(services).await?;

        // Fetch workflow info if task is assigned to a workflow
        let workflow = self
            .fetch_workflow_info(
                services.workflows(),
                task.workflow_id.as_deref(),
                task.current_step_id.as_deref(),
            )
            .await?;

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

        // Compute the derived status from workflow info
        let derived_status = if let Some(ref wf) = workflow {
            let ids_suffix = match &wf.current_step_id {
                Some(step_id) => format!(" (workflow:{}, step:{})", wf.id, step_id),
                None => format!(" (workflow:{})", wf.id),
            };
            format!("{}:{}{}", wf.name, wf.current_step_name, ids_suffix)
        } else {
            task.status.clone()
        };

        Ok(TaskDetail {
            id: task.id,
            title: task.title,
            description: task.description,
            level: task.level.as_str().to_string(),
            status: derived_status,
            priority: task.priority.map(|p| p.as_str().to_string()),
            tags: task.tags,
            created_at: task.created_at.map(|dt| dt.to_string()),
            updated_at: task.updated_at.map(|dt| dt.to_string()),
            completed_at: task.completed_at.map(|dt| dt.to_string()),
            needs_human_review: task.needs_human_review,
            revision_feedback: task.revision_feedback,
            rejection_reason: task.rejection_reason,
            workflow,
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

        // Compute derived status from workflow step using service
        let derived_status = services.tasks().get_derived_status(&task).await?;

        // Convert Task to TaskRow for display
        Ok(TaskRow {
            id: task
                .id
                .ok_or_else(|| ServiceError::task_not_found(&self.id))?,
            title: task.title,
            description: task.description,
            level: task.level.as_str().to_string(),
            status: derived_status,
            priority: task.priority.map(|p| p.as_str().to_string()),
            tags: task.tags,
            created_at: task.created_at,
            updated_at: task.updated_at,
            completed_at: task.completed_at,
            needs_human_review: task.needs_human_review,
            revision_feedback: task.revision_feedback,
            rejection_reason: task.rejection_reason,
            workflow_id: task.workflow_id,
            current_step_id: task.current_step_id,
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

    /// Fetch the parent task (if any) using the service layer.
    async fn fetch_parent(
        &self,
        services: &VertebraeServices,
    ) -> Result<Option<TaskSummary>, ServiceError> {
        // Use service method to get parent ID
        let parent_id = services.tasks().get_parent(&self.id.to_lowercase()).await?;

        if let Some(parent_id) = parent_id {
            let task = services.tasks().get_task(&parent_id).await?;

            // Compute derived status from workflow info using service
            let derived_status = services.tasks().get_derived_status(&task).await?;

            Ok(Some(TaskSummary {
                id: parent_id,
                title: task.title,
                level: task.level.as_str().to_string(),
                status: derived_status,
                priority: task.priority.map(|p| p.as_str().to_string()),
                tags: task.tags,
                needs_human_review: task.needs_human_review,
            }))
        } else {
            Ok(None)
        }
    }

    /// Fetch children tasks using the service layer.
    async fn fetch_children(
        &self,
        services: &VertebraeServices,
    ) -> Result<Vec<TaskSummary>, ServiceError> {
        // Use service method to get child IDs
        let child_ids = services
            .tasks()
            .get_children(&self.id.to_lowercase())
            .await?;

        let mut children = Vec::new();
        for child_id in child_ids {
            let task = services.tasks().get_task(&child_id).await?;

            // Compute derived status from workflow info using service
            let derived_status = services.tasks().get_derived_status(&task).await?;

            children.push(TaskSummary {
                id: child_id,
                title: task.title,
                level: task.level.as_str().to_string(),
                status: derived_status,
                priority: task.priority.map(|p| p.as_str().to_string()),
                tags: task.tags,
                needs_human_review: task.needs_human_review,
            });
        }

        Ok(children)
    }

    /// Fetch tasks that this task depends on (blocked by).
    /// Only returns incomplete blockers (status != done).
    async fn fetch_blocked_by(
        &self,
        services: &VertebraeServices,
    ) -> Result<Vec<TaskSummary>, ServiceError> {
        // Use the service layer method to get incomplete blockers with details
        let blockers = services
            .tasks()
            .get_incomplete_blockers_with_details(&self.id.to_lowercase())
            .await?;

        Ok(blockers.into_iter().map(TaskSummary::from).collect())
    }

    /// Fetch tasks that are blocked by this task.
    async fn fetch_blocks(
        &self,
        services: &VertebraeServices,
    ) -> Result<Vec<TaskSummary>, ServiceError> {
        // Use service method to get dependent task IDs (tasks blocked by this one)
        let dependent_ids = services
            .tasks()
            .get_dependents(&self.id.to_lowercase())
            .await?;

        let mut blocks = Vec::new();
        for dependent_id in dependent_ids {
            let task = services.tasks().get_task(&dependent_id).await?;

            // Compute derived status from workflow info using service
            let derived_status = services.tasks().get_derived_status(&task).await?;

            blocks.push(TaskSummary {
                id: dependent_id,
                title: task.title,
                level: task.level.as_str().to_string(),
                status: derived_status,
                priority: task.priority.map(|p| p.as_str().to_string()),
                tags: task.tags,
                needs_human_review: task.needs_human_review,
            });
        }

        Ok(blocks)
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

        // Revision feedback (prominently displayed when present)
        if let Some(ref feedback) = self.revision_feedback {
            writeln!(f, "!! REVISION REQUIRED !!")?;
            writeln!(f, "{}", "-".repeat(40))?;
            writeln!(f, "{}", feedback)?;
            writeln!(f)?;
        }

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
