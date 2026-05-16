//! Frontend-friendly data transfer types for Tauri commands
//!
//! These types are designed for serialization to TypeScript and don't include
//! database-specific types like SurrealDB's Thing or chrono's DateTime.

use serde::{Deserialize, Serialize};

/// Task hierarchy level - mirrors db::Level
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskLevel {
    Epic,
    Ticket,
    Task,
}

impl From<vertebrae_core::Level> for TaskLevel {
    fn from(level: vertebrae_core::Level) -> Self {
        match level {
            vertebrae_core::Level::Epic => TaskLevel::Epic,
            vertebrae_core::Level::Ticket => TaskLevel::Ticket,
            vertebrae_core::Level::Task => TaskLevel::Task,
        }
    }
}

// Note: Task.status is now a String derived from the workflow step name.
// The frontend uses strings directly for status values.

/// Task priority - mirrors db::Priority
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Low,
    Medium,
    High,
    Critical,
}

impl From<vertebrae_core::Priority> for TaskPriority {
    fn from(priority: vertebrae_core::Priority) -> Self {
        match priority {
            vertebrae_core::Priority::Low => TaskPriority::Low,
            vertebrae_core::Priority::Medium => TaskPriority::Medium,
            vertebrae_core::Priority::High => TaskPriority::High,
            vertebrae_core::Priority::Critical => TaskPriority::Critical,
        }
    }
}

impl From<TaskPriority> for vertebrae_core::Priority {
    fn from(priority: TaskPriority) -> Self {
        match priority {
            TaskPriority::Low => vertebrae_core::Priority::Low,
            TaskPriority::Medium => vertebrae_core::Priority::Medium,
            TaskPriority::High => vertebrae_core::Priority::High,
            TaskPriority::Critical => vertebrae_core::Priority::Critical,
        }
    }
}

/// Section type - mirrors db::SectionType
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SectionType {
    Goal,
    Context,
    CurrentBehavior,
    DesiredBehavior,
    ChecklistItem,
    TestingCriterion,
    AntiPattern,
    FailureTest,
    Constraint,
}

impl From<vertebrae_core::SectionType> for SectionType {
    fn from(section_type: vertebrae_core::SectionType) -> Self {
        match section_type {
            vertebrae_core::SectionType::Goal => SectionType::Goal,
            vertebrae_core::SectionType::Context => SectionType::Context,
            vertebrae_core::SectionType::CurrentBehavior => SectionType::CurrentBehavior,
            vertebrae_core::SectionType::DesiredBehavior => SectionType::DesiredBehavior,
            vertebrae_core::SectionType::ChecklistItem => SectionType::ChecklistItem,
            vertebrae_core::SectionType::TestingCriterion => SectionType::TestingCriterion,
            vertebrae_core::SectionType::AntiPattern => SectionType::AntiPattern,
            vertebrae_core::SectionType::FailureTest => SectionType::FailureTest,
            vertebrae_core::SectionType::Constraint => SectionType::Constraint,
        }
    }
}

/// Code reference - file location reference
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct CodeRef {
    /// Path to the file (relative to repository root)
    pub path: String,
    /// Optional starting line number
    pub line_start: Option<u32>,
    /// Optional ending line number
    pub line_end: Option<u32>,
    /// Optional name/label for this reference
    pub name: Option<String>,
    /// Optional description
    pub description: Option<String>,
}

impl From<vertebrae_core::CodeRef> for CodeRef {
    fn from(code_ref: vertebrae_core::CodeRef) -> Self {
        CodeRef {
            path: code_ref.path,
            line_start: code_ref.line_start,
            line_end: code_ref.line_end,
            name: code_ref.name,
            description: code_ref.description,
        }
    }
}

/// Section content within a task
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Section {
    /// The type of this section
    #[serde(rename = "type")]
    pub section_type: SectionType,
    /// The content of this section
    pub content: String,
    /// Optional ordering for sections of the same type
    pub order: Option<u32>,
    /// Whether this section (typically a step) is done
    pub done: Option<bool>,
    /// When this section was marked as done (ISO 8601 string)
    pub done_at: Option<String>,
    /// Code references attached to this section
    #[serde(default)]
    pub refs: Vec<CodeRef>,
}

impl From<vertebrae_core::Section> for Section {
    fn from(section: vertebrae_core::Section) -> Self {
        Section {
            section_type: section.section_type.into(),
            content: section.content,
            order: section.order,
            done: section.done,
            done_at: section.done_at.map(|dt| dt.to_rfc3339()),
            refs: section.refs.into_iter().map(Into::into).collect(),
        }
    }
}

/// Full task details - mirrors core::Task with string IDs and dates
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Task {
    /// Task ID (string form)
    pub id: String,
    /// Task title
    pub title: String,
    /// Optional description
    pub description: Option<String>,
    /// Hierarchy level (null when created without explicit level)
    pub level: Option<TaskLevel>,
    /// Optional priority
    pub priority: Option<TaskPriority>,
    /// Tags for categorization
    #[serde(default)]
    pub tags: Vec<String>,
    /// Workflow ID (string form)
    pub workflow_id: Option<String>,
    /// Current step ID (string form) - used for positioning
    pub current_step_id: Option<String>,
    /// Workflow name (if task is assigned to a workflow)
    pub workflow_name: Option<String>,
    /// Current step name (if task has a current step in workflow)
    pub step_name: Option<String>,
    /// Server-derived TaskRun controls for Run/Stop surfaces
    #[serde(default)]
    pub run_controls: Option<TaskRunControls>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
    /// Whether this task is archived
    #[serde(default)]
    pub archived: bool,
    /// Optional worktree path
    pub worktree: Option<String>,
    /// Review comment
    pub review_comment: Option<String>,
    /// Feedback to address when a validation gate fails
    pub revision_feedback: Option<String>,
    /// Reason why the task was rejected
    pub rejection_reason: Option<String>,
    /// Parent task ID (if any)
    pub parent_id: Option<String>,
    /// IDs of tasks this task depends on
    #[serde(default)]
    pub dependency_ids: Vec<String>,
    /// Embedded sections
    #[serde(default)]
    pub sections: Vec<Section>,
    /// Embedded code references
    #[serde(default)]
    pub code_refs: Vec<CodeRef>,
    /// Creation timestamp (ISO 8601 string)
    #[serde(alias = "inserted_at")]
    pub created_at: Option<String>,
    /// Last update timestamp (ISO 8601 string)
    pub updated_at: Option<String>,
    /// When this task was started (ISO 8601 string)
    pub started_at: Option<String>,
    /// When this task was completed (ISO 8601 string)
    pub completed_at: Option<String>,
}

impl From<vertebrae_core::Task> for Task {
    fn from(task: vertebrae_core::Task) -> Self {
        Task {
            id: task.id,
            title: task.title,
            description: task.description,
            level: Some(task.level.into()),
            priority: task.priority.map(Into::into),
            tags: task.tags,
            workflow_id: task.workflow_id,
            current_step_id: task.current_step_id,
            workflow_name: task.workflow_name,
            step_name: task.step_name,
            run_controls: task.run_controls.map(Into::into),
            needs_human_review: task.needs_human_review,
            archived: task.archived,
            worktree: task.worktree,
            review_comment: task.review_comment,
            revision_feedback: task.revision_feedback,
            rejection_reason: task.rejection_reason,
            parent_id: task.parent_id,
            dependency_ids: task.dependency_ids,
            sections: task.sections.into_iter().map(Into::into).collect(),
            code_refs: task.code_refs.into_iter().map(Into::into).collect(),
            created_at: task.created_at.map(|dt| dt.to_rfc3339()),
            updated_at: task.updated_at.map(|dt| dt.to_rfc3339()),
            started_at: task.started_at.map(|dt| dt.to_rfc3339()),
            completed_at: task.completed_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

/// Task tree node for hierarchical views
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TaskTreeNode {
    /// The task
    pub task: Task,
    /// Whether this task has incomplete blockers
    pub has_blockers: bool,
    /// Number of incomplete blockers
    pub blocker_count: u32,
    /// Child nodes
    pub children: Vec<TaskTreeNode>,
}

/// Filter options for listing tasks
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct TaskFilterOptions {
    /// Filter by step names (OR semantics) - workflow step names
    pub step_names: Option<Vec<String>>,
    /// Filter by levels (OR semantics)
    pub levels: Option<Vec<TaskLevel>>,
    /// Filter by tags (OR semantics)
    pub tags: Option<Vec<String>>,
    /// Show only root items (no parent)
    pub root_only: Option<bool>,
    /// Show only children of a specific task
    pub children_of: Option<String>,
    /// Include done items (excluded by default)
    pub include_done: Option<bool>,
    /// Search text in title and description
    pub search: Option<String>,
    /// Filter by workflow_id (tasks assigned to a specific workflow)
    pub workflow_id: Option<String>,
    /// Filter by current_step_id (tasks currently sitting at a specific step)
    pub step_id: Option<String>,
}

impl From<TaskFilterOptions> for vertebrae_core::TaskFilter {
    fn from(opts: TaskFilterOptions) -> Self {
        let mut filter = vertebrae_core::TaskFilter::new();

        if let Some(step_names) = opts.step_names {
            for step_name in step_names {
                filter = filter.with_step_name(step_name);
            }
        }

        if let Some(levels) = opts.levels {
            for level in levels {
                filter = filter.with_level(match level {
                    TaskLevel::Epic => vertebrae_core::Level::Epic,
                    TaskLevel::Ticket => vertebrae_core::Level::Ticket,
                    TaskLevel::Task => vertebrae_core::Level::Task,
                });
            }
        }

        if let Some(tags) = opts.tags {
            filter = filter.with_tags(tags);
        }

        if opts.root_only.unwrap_or(false) {
            filter = filter.root_only();
        }

        if let Some(parent_id) = opts.children_of {
            filter = filter.children_of(parent_id);
        }

        if opts.include_done.unwrap_or(false) {
            filter = filter.include_done();
        }

        if let Some(search) = opts.search {
            filter = filter.with_search(search);
        }

        if let Some(workflow_id) = opts.workflow_id {
            filter = filter.with_workflow_id(workflow_id);
        }

        if let Some(step_id) = opts.step_id {
            filter = filter.with_step_id(step_id);
        }

        filter
    }
}

/// Options for updating a task - allows updating multiple fields at once
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct UpdateTaskOptions {
    /// New title (if provided)
    pub title: Option<String>,
    /// New description (if provided, null clears it)
    pub description: Option<Option<String>>,
    /// New priority (if provided, null clears it)
    pub priority: Option<Option<String>>,
    /// Tags to add
    #[serde(default)]
    pub add_tags: Vec<String>,
    /// Tags to remove
    #[serde(default)]
    pub remove_tags: Vec<String>,
    /// New task level (epic, ticket, task)
    pub level: Option<String>,
    /// Human review flag
    pub needs_human_review: Option<bool>,
    /// Whether the task is archived
    pub archived: Option<bool>,
    /// Revision feedback text
    pub revision_feedback: Option<Option<String>>,
    /// Worktree path (if provided, null clears it)
    pub worktree: Option<Option<String>>,
}

// ============================================================================
// Workflow Types
// ============================================================================

/// Permission mode for agent sessions - mirrors db::PermissionMode
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    AcceptEdits,
    BypassPermissions,
    Default,
    Delegate,
    DontAsk,
    Plan,
}

impl From<vertebrae_core::PermissionMode> for PermissionMode {
    fn from(mode: vertebrae_core::PermissionMode) -> Self {
        match mode {
            vertebrae_core::PermissionMode::AcceptEdits => PermissionMode::AcceptEdits,
            vertebrae_core::PermissionMode::BypassPermissions => PermissionMode::BypassPermissions,
            vertebrae_core::PermissionMode::Default => PermissionMode::Default,
            vertebrae_core::PermissionMode::Delegate => PermissionMode::Delegate,
            vertebrae_core::PermissionMode::DontAsk => PermissionMode::DontAsk,
            vertebrae_core::PermissionMode::Plan => PermissionMode::Plan,
        }
    }
}

/// Agent configuration for workflow steps - mirrors db::AgentConfig
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct AgentConfig {
    /// Model for the current session
    pub model: Option<String>,
    /// Fallback model when default model is overloaded
    pub fallback_model: Option<String>,
    /// System prompt to use for the session
    pub system_prompt: Option<String>,
    /// Append a system prompt to the default system prompt
    pub append_system_prompt: Option<String>,
    /// JSON object defining custom agents (serialized as JSON string)
    pub agents: Option<String>,
    /// List of available tools from the built-in set
    #[serde(default)]
    pub tools: Vec<String>,
    /// List of tool names to allow
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// List of tool names to deny
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    /// Permission mode to use for the session
    pub permission_mode: Option<PermissionMode>,
    /// Maximum dollar amount to spend on API calls
    pub max_budget_usd: Option<f64>,
    /// Paths to MCP server configuration files or JSON strings
    #[serde(default)]
    pub mcp_config: Vec<String>,
    /// Directories to load plugins from
    #[serde(default)]
    pub plugin_dirs: Vec<String>,
    /// JSON Schema for structured output validation (serialized as JSON string)
    pub json_schema: Option<String>,
}

impl From<vertebrae_core::AgentConfig> for AgentConfig {
    fn from(config: vertebrae_core::AgentConfig) -> Self {
        AgentConfig {
            model: config.model,
            fallback_model: config.fallback_model,
            system_prompt: config.system_prompt,
            append_system_prompt: config.append_system_prompt,
            agents: config.agents.map(|v| v.to_string()),
            tools: config.tools,
            allowed_tools: config.allowed_tools,
            disallowed_tools: config.disallowed_tools,
            permission_mode: config.permission_mode.map(Into::into),
            max_budget_usd: config.max_budget_usd,
            mcp_config: config.mcp_config,
            plugin_dirs: config.plugin_dirs,
            json_schema: config.json_schema.map(|v| v.to_string()),
        }
    }
}

/// Step type - mirrors core::StepType
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum StepType {
    #[default]
    Execute,
    Evaluate,
    Route,
    WaitChildren,
    HumanInput,
    Unsupported(String),
}

impl From<vertebrae_core::StepType> for StepType {
    fn from(st: vertebrae_core::StepType) -> Self {
        match st {
            vertebrae_core::StepType::Execute => StepType::Execute,
            vertebrae_core::StepType::Evaluate => StepType::Evaluate,
            vertebrae_core::StepType::Route => StepType::Route,
            vertebrae_core::StepType::WaitChildren => StepType::WaitChildren,
            vertebrae_core::StepType::HumanInput => StepType::HumanInput,
            vertebrae_core::StepType::Unsupported(value) => StepType::Unsupported(value),
        }
    }
}

impl From<StepType> for vertebrae_core::StepType {
    fn from(st: StepType) -> Self {
        match st {
            StepType::Execute => vertebrae_core::StepType::Execute,
            StepType::Evaluate => vertebrae_core::StepType::Evaluate,
            StepType::Route => vertebrae_core::StepType::Route,
            StepType::WaitChildren => vertebrae_core::StepType::WaitChildren,
            StepType::HumanInput => vertebrae_core::StepType::HumanInput,
            StepType::Unsupported(value) => vertebrae_core::StepType::Unsupported(value),
        }
    }
}

/// Workflow step entity - mirrors db::Step
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Step {
    /// Step ID (string form)
    pub id: Option<String>,
    /// Display name for this step
    pub name: String,
    /// Reference to the workflow this step belongs to
    pub workflow_id: String,
    /// What this step should accomplish
    pub goal: Option<String>,
    /// Prompt sent to the agent when executing this step
    pub prompt: Option<String>,
    /// Paths to .claude/agents/ files for this step
    #[serde(default)]
    pub agents: Vec<String>,
    /// Skill names available for this step
    #[serde(default)]
    pub skills: Vec<String>,
    /// Agent configuration for this step
    #[serde(default)]
    pub agent_config: AgentConfig,
    /// The type of this step (execute, evaluate, route)
    #[serde(default)]
    pub step_type: StepType,
    /// JSON Schema describing the expected output of this step
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    /// Whether this is a final step (no outgoing transitions)
    #[serde(default)]
    pub is_final: bool,
    /// List of step IDs this step can transition to
    #[serde(default)]
    pub transitions_to: Vec<String>,
    /// Ordering index for sequential fallback (0-based, Sacrum: `step_order`).
    #[serde(default, alias = "step_order")]
    pub order: i32,
    /// Creation timestamp (ISO 8601 string)
    #[serde(alias = "inserted_at")]
    pub created_at: Option<String>,
    /// Last update timestamp (ISO 8601 string)
    pub updated_at: Option<String>,
}

impl From<vertebrae_core::Step> for Step {
    fn from(step: vertebrae_core::Step) -> Self {
        Step {
            id: step.id,
            name: step.name,
            workflow_id: step.workflow_id,
            goal: step.goal,
            prompt: step.prompt,
            agents: step.agents,
            skills: step.skills,
            agent_config: step.agent_config.into(),
            step_type: step.step_type.into(),
            output_schema: step.output_schema,
            is_final: step.is_final,
            transitions_to: step.transitions_to,
            order: step.order,
            created_at: step.created_at.map(|dt| dt.to_rfc3339()),
            updated_at: step.updated_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

/// Workflow - mirrors db::Workflow
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Workflow {
    /// Workflow ID (string form)
    pub id: Option<String>,
    /// Workflow name
    pub name: String,
    /// Optional description of the workflow
    pub description: Option<String>,
    /// Reference to the initial step in the workflow
    #[serde(alias = "initial_step_id")]
    pub initial_step: Option<String>,
    /// Optional kanban column
    pub kanban_column: Option<String>,
    /// Whether this is the default workflow for new tasks
    #[serde(default)]
    pub is_default: bool,
    /// Whether this is a terminal workflow (cannot transition out)
    #[serde(default)]
    pub is_final: bool,
    /// Sort order for displaying workflows (Sacrum: `display_order`).
    #[serde(default, alias = "order")]
    pub display_order: i32,
    /// Additional metadata as key-value pairs
    #[serde(default)]
    pub metadata: std::collections::HashMap<String, String>,
    /// Creation timestamp (ISO 8601 string)
    #[serde(alias = "inserted_at")]
    pub created_at: Option<String>,
    /// Last update timestamp (ISO 8601 string)
    pub updated_at: Option<String>,
}

impl From<vertebrae_core::Workflow> for Workflow {
    fn from(workflow: vertebrae_core::Workflow) -> Self {
        Workflow {
            id: workflow.id,
            name: workflow.name,
            description: workflow.description,
            initial_step: workflow.initial_step,
            kanban_column: workflow.kanban_column,
            is_default: workflow.is_default,
            is_final: workflow.is_final,
            display_order: workflow.order,
            metadata: workflow.metadata,
            created_at: workflow.created_at.map(|dt| dt.to_rfc3339()),
            updated_at: workflow.updated_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

/// Options for updating a workflow from the GUI.
///
/// Only fields that are Some will be updated.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UpdateWorkflowOptions {
    pub workflow_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub auto_advance: Option<bool>,
    pub order: Option<i32>,
    pub is_default: Option<bool>,
    pub is_final: Option<bool>,
    pub kanban_column: Option<String>,
}

impl From<UpdateWorkflowOptions> for vertebrae_core::UpdateWorkflowOptions {
    fn from(opts: UpdateWorkflowOptions) -> Self {
        let mut update = vertebrae_core::UpdateWorkflowOptions::new();
        if let Some(name) = opts.name {
            update = update.with_name(name);
        }
        if let Some(description) = opts.description {
            update = update.with_description(description);
        }
        if let Some(auto_advance) = opts.auto_advance {
            update = update.with_auto_advance(auto_advance);
        }
        if let Some(order) = opts.order {
            update = update.with_order(order);
        }
        if let Some(is_default) = opts.is_default {
            update = update.with_is_default(is_default);
        }
        if let Some(is_final) = opts.is_final {
            update = update.with_is_final(is_final);
        }
        if let Some(kanban_column) = opts.kanban_column {
            update = update.with_kanban_column(kanban_column);
        }
        update
    }
}

/// Workflow with its associated tasks
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowWithTasks {
    /// The workflow itself
    pub workflow: Workflow,
    /// Tasks associated with this workflow
    pub tasks: Vec<Task>,
}

/// Workflow with its associated tasks including full details
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowWithTaskDetails {
    /// The workflow itself
    pub workflow: Workflow,
    /// Tasks associated with this workflow
    pub tasks: Vec<Task>,
}

/// Workflow transition - defines allowed transitions between workflows
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowTransition {
    /// Transition ID (string form)
    pub id: Option<String>,
    /// Source workflow ID
    pub from_workflow_id: String,
    /// Source workflow name
    pub from_workflow_name: String,
    /// Target workflow ID
    pub to_workflow_id: String,
    /// Target workflow name
    pub to_workflow_name: String,
    /// Human-readable label for this transition
    pub label: String,
    /// Optional target step ID in the destination workflow
    pub target_step_id: Option<String>,
}

// ============================================================================
// Execution Types
// ============================================================================

/// Durable lifecycle status for a task workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Queued,
    Executing,
    Waiting,
    Stopping,
    Stopped,
    Completed,
    Failed,
}

impl From<vertebrae_core::TaskRunStatus> for TaskRunStatus {
    fn from(status: vertebrae_core::TaskRunStatus) -> Self {
        match status {
            vertebrae_core::TaskRunStatus::Queued => TaskRunStatus::Queued,
            vertebrae_core::TaskRunStatus::Executing => TaskRunStatus::Executing,
            vertebrae_core::TaskRunStatus::Waiting => TaskRunStatus::Waiting,
            vertebrae_core::TaskRunStatus::Stopping => TaskRunStatus::Stopping,
            vertebrae_core::TaskRunStatus::Stopped => TaskRunStatus::Stopped,
            vertebrae_core::TaskRunStatus::Completed => TaskRunStatus::Completed,
            vertebrae_core::TaskRunStatus::Failed => TaskRunStatus::Failed,
        }
    }
}

/// Durable workflow run for a task.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TaskRun {
    /// TaskRun ID
    pub id: String,
    /// Task ID this run belongs to
    pub task_id: String,
    /// Project ID this run belongs to
    pub project_id: String,
    /// User ID, when returned by the backend
    pub user_id: Option<String>,
    /// Durable run lifecycle status
    pub status: TaskRunStatus,
    /// When this run started (ISO 8601 string)
    pub started_at: Option<String>,
    /// When this run ended (ISO 8601 string)
    pub ended_at: Option<String>,
    /// When stop was requested (ISO 8601 string)
    pub stop_requested_at: Option<String>,
    /// Latest step execution ID associated with this run
    pub latest_step_execution_id: Option<String>,
    /// Terminal outcome kind
    pub outcome_kind: Option<String>,
    /// Structured terminal outcome context
    pub outcome_context: Option<serde_json::Value>,
    /// Parent TaskRun ID for child workflow runs
    pub parent_task_run_id: Option<String>,
    /// Root TaskRun ID for recursive traces
    pub root_task_run_id: Option<String>,
    /// Step execution that triggered this child run
    pub triggered_by_step_execution_id: Option<String>,
    /// Creation timestamp from Sacrum (ISO 8601 string)
    pub inserted_at: Option<String>,
    /// Last update timestamp from Sacrum (ISO 8601 string)
    pub updated_at: Option<String>,
}

impl From<vertebrae_core::TaskRun> for TaskRun {
    fn from(run: vertebrae_core::TaskRun) -> Self {
        TaskRun {
            id: run.id,
            task_id: run.task_id,
            project_id: run.project_id,
            user_id: run.user_id,
            status: run.status.into(),
            started_at: run.started_at.map(|dt| dt.to_rfc3339()),
            ended_at: run.ended_at.map(|dt| dt.to_rfc3339()),
            stop_requested_at: run.stop_requested_at.map(|dt| dt.to_rfc3339()),
            latest_step_execution_id: run.latest_step_execution_id,
            outcome_kind: run.outcome_kind,
            outcome_context: run.outcome_context,
            parent_task_run_id: run.parent_task_run_id,
            root_task_run_id: run.root_task_run_id,
            triggered_by_step_execution_id: run.triggered_by_step_execution_id,
            inserted_at: run.inserted_at.map(|dt| dt.to_rfc3339()),
            updated_at: run.updated_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

/// Server-derived controls for Run/Stop task actions.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TaskRunControls {
    #[serde(default)]
    pub runnable: bool,
    #[serde(default)]
    pub stoppable: bool,
    pub disabled_reason_code: Option<String>,
    pub disabled_reason: Option<String>,
    pub active_run: Option<TaskRun>,
}

impl From<vertebrae_core::TaskRunControls> for TaskRunControls {
    fn from(controls: vertebrae_core::TaskRunControls) -> Self {
        TaskRunControls {
            runnable: controls.runnable,
            stoppable: controls.stoppable,
            disabled_reason_code: controls.disabled_reason_code,
            disabled_reason: controls.disabled_reason,
            active_run: controls.active_run.map(Into::into),
        }
    }
}

/// Trace tree rooted at a TaskRun.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TaskRunTrace {
    pub root_task_run_id: String,
    #[serde(default)]
    pub task_runs: Vec<TaskRun>,
    #[serde(default)]
    pub step_executions: Vec<StepExecution>,
    #[serde(default)]
    pub session_logs: Vec<SessionLog>,
}

impl From<vertebrae_core::TaskRunTrace> for TaskRunTrace {
    fn from(trace: vertebrae_core::TaskRunTrace) -> Self {
        TaskRunTrace {
            root_task_run_id: trace.root_task_run_id,
            task_runs: trace.task_runs.into_iter().map(Into::into).collect(),
            step_executions: trace.step_executions.into_iter().map(Into::into).collect(),
            session_logs: trace.session_logs.into_iter().map(Into::into).collect(),
        }
    }
}

/// StopRun command input. Provide either `task_run_id` or `task_id`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct StopRunRequest {
    pub task_run_id: Option<String>,
    pub task_id: Option<String>,
}

/// Execution status - mirrors db::ExecutionStatus
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    InProgress,
    Completed,
    Failed,
}

impl From<vertebrae_core::ExecutionStatus> for ExecutionStatus {
    fn from(status: vertebrae_core::ExecutionStatus) -> Self {
        match status {
            vertebrae_core::ExecutionStatus::InProgress => ExecutionStatus::InProgress,
            vertebrae_core::ExecutionStatus::Completed => ExecutionStatus::Completed,
            vertebrae_core::ExecutionStatus::Failed => ExecutionStatus::Failed,
        }
    }
}

/// Step execution record - mirrors db::StepExecution.
///
/// Carries the full sacrum field set so the traces UI can render prompt,
/// output, context, transition_result, model/provider, token usage, cost,
/// duration, handoff, and session_id. All extended fields are `Option`-typed
/// because historical executions and minimal payloads may not populate them.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct StepExecution {
    /// Execution ID (string form)
    pub id: Option<String>,
    /// Task ID this execution belongs to
    #[serde(default)]
    pub task_id: String,
    /// TaskRun ID this execution belongs to, when present
    #[serde(default)]
    pub task_run_id: Option<String>,
    /// Workflow ID being executed
    #[serde(default)]
    pub workflow_id: String,
    /// Name of the step being executed
    #[serde(default)]
    pub step_name: String,
    /// When this step execution started (ISO 8601 string)
    #[serde(default)]
    pub started_at: String,
    /// When this step execution completed (ISO 8601 string)
    pub completed_at: Option<String>,
    /// Current status of this step execution
    #[serde(default = "StepExecution::default_status")]
    pub status: ExecutionStatus,
    /// Prompt text/JSON that drove the execution
    #[serde(default)]
    pub prompt: Option<String>,
    /// Final output of the execution
    #[serde(default)]
    pub output: Option<String>,
    /// Execution context (arbitrary JSON serialized as string)
    #[serde(default)]
    pub context: Option<String>,
    /// Transition decision payload (route/evaluate steps)
    #[serde(default)]
    pub transition_result: Option<String>,
    /// Model identifier (e.g. "claude-opus-4")
    #[serde(default)]
    pub model: Option<String>,
    /// Model provider (e.g. "anthropic")
    #[serde(default)]
    pub model_provider: Option<String>,
    /// Input tokens consumed
    #[serde(default)]
    pub input_tokens: Option<u32>,
    /// Output tokens emitted
    #[serde(default)]
    pub output_tokens: Option<u32>,
    /// Cost in USD, serialized as a string to preserve Decimal precision
    /// across the Sacrum WS / GraphQL boundary.
    #[serde(default)]
    pub cost: Option<String>,
    /// Wall-clock duration in milliseconds
    #[serde(default)]
    pub duration_ms: Option<u32>,
    /// Handoff payload from a route step (JSON encoded)
    #[serde(default)]
    pub handoff: Option<String>,
    /// Provider session identifier (e.g. Claude session ID)
    #[serde(default)]
    pub session_id: Option<String>,
}

impl StepExecution {
    fn default_status() -> ExecutionStatus {
        ExecutionStatus::InProgress
    }
}

fn saturating_u64_to_u32(v: u64) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

impl From<vertebrae_core::StepExecution> for StepExecution {
    fn from(exec: vertebrae_core::StepExecution) -> Self {
        let (input_tokens, output_tokens) = match exec.token_usage.as_ref() {
            Some(tu) => (
                Some(saturating_u64_to_u32(tu.input_tokens)),
                Some(saturating_u64_to_u32(tu.output_tokens)),
            ),
            None => (None, None),
        };
        StepExecution {
            id: exec.id,
            task_id: exec.task_id,
            task_run_id: exec.task_run_id,
            workflow_id: exec.workflow_id,
            step_name: exec.step_name,
            started_at: exec.started_at.to_rfc3339(),
            completed_at: exec.completed_at.map(|dt| dt.to_rfc3339()),
            status: exec.status.into(),
            prompt: exec.prompt,
            output: exec.output,
            context: exec.context,
            transition_result: exec.transition_result,
            model: exec.model_used,
            model_provider: exec.model_provider,
            input_tokens,
            output_tokens,
            cost: exec.cost_usd.map(|c| c.to_string()),
            duration_ms: exec.duration_ms.map(saturating_u64_to_u32),
            handoff: exec.handoff,
            session_id: exec.session_id,
        }
    }
}

/// Session log entry - mirrors db::SessionLog
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SessionLog {
    /// Log ID (string form)
    pub id: Option<String>,
    /// Step execution ID this log belongs to
    #[serde(default)]
    pub step_execution_id: String,
    /// The log content
    #[serde(default)]
    pub content: String,
    /// When this log was created (ISO 8601 string)
    #[serde(alias = "inserted_at", default)]
    pub created_at: String,
}

impl From<vertebrae_core::SessionLog> for SessionLog {
    fn from(log: vertebrae_core::SessionLog) -> Self {
        SessionLog {
            id: log.id,
            step_execution_id: log.step_execution_id,
            content: log.content,
            created_at: log.created_at.to_rfc3339(),
        }
    }
}

// ============================================================================
// Live Chat Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ChatSession {
    pub id: String,
    pub project_id: String,
    pub status: String,
    pub session_kind: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub stop_requested_at: Option<String>,
    pub inserted_at: Option<String>,
    pub updated_at: Option<String>,
}

impl From<vertebrae_core::ChatSession> for ChatSession {
    fn from(session: vertebrae_core::ChatSession) -> Self {
        ChatSession {
            id: session.id,
            project_id: session.project_id,
            status: session.status,
            session_kind: session.session_kind,
            started_at: session.started_at.map(|dt| dt.to_rfc3339()),
            ended_at: session.ended_at.map(|dt| dt.to_rfc3339()),
            stop_requested_at: session.stop_requested_at.map(|dt| dt.to_rfc3339()),
            inserted_at: session.inserted_at.map(|dt| dt.to_rfc3339()),
            updated_at: session.updated_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DeleteChatSessionResult {
    pub deleted_session_id: String,
    pub success: bool,
}

impl From<vertebrae_core::DeleteChatSessionResult> for DeleteChatSessionResult {
    fn from(result: vertebrae_core::DeleteChatSessionResult) -> Self {
        DeleteChatSessionResult {
            deleted_session_id: result.deleted_session_id,
            success: result.success,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ChatMessage {
    pub id: String,
    pub project_id: String,
    pub chat_session_id: String,
    pub role: String,
    pub content: String,
    pub content_format: Option<String>,
    pub client_message_id: Option<String>,
    pub inserted_at: Option<String>,
    pub updated_at: Option<String>,
}

impl From<vertebrae_core::ChatMessage> for ChatMessage {
    fn from(message: vertebrae_core::ChatMessage) -> Self {
        ChatMessage {
            id: message.id,
            project_id: message.project_id,
            chat_session_id: message.chat_session_id,
            role: message.role,
            content: message.content,
            content_format: message.content_format,
            client_message_id: message.client_message_id,
            inserted_at: message.inserted_at.map(|dt| dt.to_rfc3339()),
            updated_at: message.updated_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

// ============================================================================
// Pipeline Types
// ============================================================================

/// Per-step task counts grouped by hierarchy level — direct mirror of the
/// Sacrum `pipeline_summary.workflow_steps[].task_counts` field.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct PipelineTaskCounts {
    pub epic: i32,
    pub ticket: i32,
    pub task: i32,
}

/// Per-step pipeline counts grouped by hierarchy level plus active TaskRun
/// count.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct PipelineStepCounts {
    pub epic: i32,
    pub ticket: i32,
    pub task: i32,
    pub active: i32,
}

/// Workflow step entry in the pipeline summary payload, including the
/// resolver-computed `pipeline_counts`/`active_count` aggregates and the
/// preloaded list of intra-workflow `transitions_to` step IDs.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PipelineStep {
    pub id: String,
    pub name: String,
    pub workflow_id: String,
    pub goal: Option<String>,
    pub step_order: i32,
    pub step_type: Option<String>,
    pub is_final: bool,
    /// IDs of the steps that this step transitions into within the same workflow.
    pub transitions_to: Vec<String>,
    /// Per-level task counts for tasks currently parked at this step.
    pub task_counts: PipelineTaskCounts,
    /// Canonical per-step counts from Sacrum, including active TaskRun count.
    pub pipeline_counts: PipelineStepCounts,
    /// Number of active TaskRuns for tasks currently parked at this step.
    pub active_count: i32,
}

/// Inter-workflow transition entry returned by `pipeline_summary`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PipelineWorkflowTransition {
    pub id: String,
    pub from_workflow_id: String,
    pub to_workflow_id: String,
    pub target_step_id: Option<String>,
    pub label: String,
}

/// Single workflow entry in the pipeline summary payload, with its preloaded
/// steps (carrying aggregates) and outbound inter-workflow transitions.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PipelineWorkflow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub initial_step_id: Option<String>,
    pub kanban_column: Option<String>,
    pub is_default: bool,
    pub is_final: bool,
    pub display_order: i32,
    pub workflow_steps: Vec<PipelineStep>,
    pub transitions: Vec<PipelineWorkflowTransition>,
}

/// Full pipeline summary payload returned by `get_pipeline_summary`.
///
/// One `PipelineWorkflow` per workflow in the project. There is intentionally
/// no top-level flat task index — the GUI refreshes this authoritative
/// aggregate payload from Sacrum websocket events.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PipelineSummary {
    pub workflows: Vec<PipelineWorkflow>,
}

impl From<vertebrae_sacrum_client::PipelineWorkflowResponse> for PipelineWorkflow {
    fn from(wf: vertebrae_sacrum_client::PipelineWorkflowResponse) -> Self {
        let workflow_steps = wf
            .workflow_steps
            .into_iter()
            .map(PipelineStep::from)
            .collect();
        let transitions = wf
            .transitions
            .into_iter()
            .map(PipelineWorkflowTransition::from)
            .collect();
        PipelineWorkflow {
            id: wf.id,
            name: wf.name,
            description: wf.description,
            initial_step_id: wf.initial_step_id,
            kanban_column: wf.kanban_column,
            is_default: wf.is_default.unwrap_or(false),
            is_final: wf.is_final.unwrap_or(false),
            display_order: wf.display_order.unwrap_or(0),
            workflow_steps,
            transitions,
        }
    }
}

impl From<vertebrae_sacrum_client::PipelineStepResponse> for PipelineStep {
    fn from(step: vertebrae_sacrum_client::PipelineStepResponse) -> Self {
        let transitions_to = step
            .transitions
            .iter()
            .map(|t| t.to_step_id.clone())
            .collect();
        let task_counts = step.effective_task_counts();
        let active_count = step.effective_active_count();
        PipelineStep {
            id: step.id,
            name: step.name,
            workflow_id: step.workflow_id,
            goal: step.goal,
            step_order: step.step_order,
            step_type: step.step_type,
            is_final: step.is_final,
            transitions_to,
            task_counts: PipelineTaskCounts {
                epic: task_counts.epic,
                ticket: task_counts.ticket,
                task: task_counts.task,
            },
            pipeline_counts: PipelineStepCounts {
                epic: task_counts.epic,
                ticket: task_counts.ticket,
                task: task_counts.task,
                active: active_count,
            },
            active_count,
        }
    }
}

impl From<vertebrae_sacrum_client::PipelineWorkflowTransitionResponse>
    for PipelineWorkflowTransition
{
    fn from(t: vertebrae_sacrum_client::PipelineWorkflowTransitionResponse) -> Self {
        PipelineWorkflowTransition {
            id: t.id,
            from_workflow_id: t.from_workflow_id,
            to_workflow_id: t.to_workflow_id,
            target_step_id: t.target_step_id,
            label: t.label.unwrap_or_default(),
        }
    }
}

/// Options for creating a workflow step.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CreateStepOptions {
    pub workflow_id: String,
    pub name: String,
    pub goal: Option<String>,
    pub agents: Vec<String>,
    pub skills: Vec<String>,
    pub order: i32,
    pub is_final: bool,
    pub transitions_to: Vec<String>,
    #[serde(default)]
    pub step_type: StepType,
    pub output_schema: Option<serde_json::Value>,
}

/// Options for updating a workflow step.
/// Only fields that are Some will be updated.
/// Note: agent_config is intentionally omitted — not editable from the GUI.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UpdateStepOptions {
    pub step_id: String,
    pub name: Option<String>,
    pub goal: Option<String>,
    pub prompt: Option<String>,
    pub agents: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub step_type: Option<StepType>,
    pub output_schema: Option<serde_json::Value>,
    pub order: Option<i32>,
    pub is_final: Option<bool>,
    pub transitions_to: Option<Vec<String>>,
}

impl From<UpdateStepOptions> for vertebrae_core::StepUpdate {
    fn from(opts: UpdateStepOptions) -> Self {
        let mut update = vertebrae_core::StepUpdate::new();
        if let Some(name) = opts.name {
            update = update.with_name(&name);
        }
        if let Some(goal) = opts.goal {
            update = update.with_goal(&goal);
        }
        if let Some(prompt) = opts.prompt {
            update = update.with_prompt(&prompt);
        }
        if let Some(agents) = opts.agents {
            update = update.with_agents(agents);
        }
        if let Some(skills) = opts.skills {
            update = update.with_skills(skills);
        }
        if let Some(order) = opts.order {
            update = update.with_order(order);
        }
        if let Some(step_type) = opts.step_type {
            update = update.with_step_type(step_type.into());
        }
        if let Some(output_schema) = opts.output_schema {
            update = update.with_output_schema(Some(output_schema));
        }
        if let Some(is_final) = opts.is_final {
            update = update.with_is_final(is_final);
        }
        if let Some(transitions) = opts.transitions_to {
            let transition_ids: Vec<String> =
                transitions.iter().map(|id| id.to_lowercase()).collect();
            update = update.with_transitions_to(transition_ids);
        }
        update
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── TaskLevel Conversion Tests ─────────────────────────────────

    #[test]
    fn task_level_from_core_epic() {
        let core_level = vertebrae_core::Level::Epic;
        let gui_level = TaskLevel::from(core_level);
        assert_eq!(gui_level, TaskLevel::Epic);
    }

    #[test]
    fn task_level_from_core_ticket() {
        let core_level = vertebrae_core::Level::Ticket;
        let gui_level = TaskLevel::from(core_level);
        assert_eq!(gui_level, TaskLevel::Ticket);
    }

    #[test]
    fn task_level_from_core_task() {
        let core_level = vertebrae_core::Level::Task;
        let gui_level = TaskLevel::from(core_level);
        assert_eq!(gui_level, TaskLevel::Task);
    }

    // ─── TaskPriority Conversion Tests ──────────────────────────────

    #[test]
    fn task_priority_from_core_low() {
        let core_priority = vertebrae_core::Priority::Low;
        let gui_priority = TaskPriority::from(core_priority);
        assert_eq!(gui_priority, TaskPriority::Low);
    }

    #[test]
    fn task_priority_from_core_medium() {
        let core_priority = vertebrae_core::Priority::Medium;
        let gui_priority = TaskPriority::from(core_priority);
        assert_eq!(gui_priority, TaskPriority::Medium);
    }

    #[test]
    fn task_priority_from_core_high() {
        let core_priority = vertebrae_core::Priority::High;
        let gui_priority = TaskPriority::from(core_priority);
        assert_eq!(gui_priority, TaskPriority::High);
    }

    #[test]
    fn task_priority_from_core_critical() {
        let core_priority = vertebrae_core::Priority::Critical;
        let gui_priority = TaskPriority::from(core_priority);
        assert_eq!(gui_priority, TaskPriority::Critical);
    }

    #[test]
    fn task_priority_to_core_low() {
        let gui_priority = TaskPriority::Low;
        let core_priority = vertebrae_core::Priority::from(gui_priority);
        assert_eq!(core_priority, vertebrae_core::Priority::Low);
    }

    #[test]
    fn task_priority_to_core_medium() {
        let gui_priority = TaskPriority::Medium;
        let core_priority = vertebrae_core::Priority::from(gui_priority);
        assert_eq!(core_priority, vertebrae_core::Priority::Medium);
    }

    #[test]
    fn task_priority_to_core_high() {
        let gui_priority = TaskPriority::High;
        let core_priority = vertebrae_core::Priority::from(gui_priority);
        assert_eq!(core_priority, vertebrae_core::Priority::High);
    }

    #[test]
    fn task_priority_to_core_critical() {
        let gui_priority = TaskPriority::Critical;
        let core_priority = vertebrae_core::Priority::from(gui_priority);
        assert_eq!(core_priority, vertebrae_core::Priority::Critical);
    }

    #[test]
    fn task_priority_round_trip() {
        let original = vertebrae_core::Priority::High;
        let gui = TaskPriority::from(original.clone());
        let back = vertebrae_core::Priority::from(gui);
        assert_eq!(original, back);
    }

    // ─── SectionType Conversion Tests ───────────────────────────────

    #[test]
    fn section_type_from_core_goal() {
        let core = vertebrae_core::SectionType::Goal;
        let gui = SectionType::from(core);
        assert_eq!(gui, SectionType::Goal);
    }

    #[test]
    fn section_type_from_core_all_variants() {
        assert_eq!(
            SectionType::from(vertebrae_core::SectionType::Context),
            SectionType::Context
        );
        assert_eq!(
            SectionType::from(vertebrae_core::SectionType::CurrentBehavior),
            SectionType::CurrentBehavior
        );
        assert_eq!(
            SectionType::from(vertebrae_core::SectionType::DesiredBehavior),
            SectionType::DesiredBehavior
        );
        assert_eq!(
            SectionType::from(vertebrae_core::SectionType::ChecklistItem),
            SectionType::ChecklistItem
        );
        assert_eq!(
            SectionType::from(vertebrae_core::SectionType::TestingCriterion),
            SectionType::TestingCriterion
        );
        assert_eq!(
            SectionType::from(vertebrae_core::SectionType::AntiPattern),
            SectionType::AntiPattern
        );
        assert_eq!(
            SectionType::from(vertebrae_core::SectionType::FailureTest),
            SectionType::FailureTest
        );
        assert_eq!(
            SectionType::from(vertebrae_core::SectionType::Constraint),
            SectionType::Constraint
        );
    }

    // ─── CodeRef Conversion Tests ───────────────────────────────────

    #[test]
    fn code_ref_from_core_basic() {
        let core = vertebrae_core::CodeRef::file("src/main.rs");
        let gui = CodeRef::from(core);
        assert_eq!(gui.path, "src/main.rs");
        assert_eq!(gui.line_start, None);
        assert_eq!(gui.line_end, None);
        assert_eq!(gui.name, None);
        assert_eq!(gui.description, None);
    }

    #[test]
    fn code_ref_from_core_with_line() {
        let core = vertebrae_core::CodeRef::line("src/main.rs", 42);
        let gui = CodeRef::from(core);
        assert_eq!(gui.path, "src/main.rs");
        assert_eq!(gui.line_start, Some(42));
        assert_eq!(gui.line_end, None);
    }

    #[test]
    fn code_ref_from_core_with_range() {
        let core = vertebrae_core::CodeRef::range("src/main.rs", 10, 20);
        let gui = CodeRef::from(core);
        assert_eq!(gui.path, "src/main.rs");
        assert_eq!(gui.line_start, Some(10));
        assert_eq!(gui.line_end, Some(20));
    }

    #[test]
    fn code_ref_from_core_with_metadata() {
        let core = vertebrae_core::CodeRef::file("src/main.rs")
            .with_name("main_fn")
            .with_description("Entry point");
        let gui = CodeRef::from(core);
        assert_eq!(gui.path, "src/main.rs");
        assert_eq!(gui.name, Some("main_fn".to_string()));
        assert_eq!(gui.description, Some("Entry point".to_string()));
    }

    // ─── Section Conversion Tests ────────────────────────────────────

    #[test]
    fn section_from_core_basic() {
        let core = vertebrae_core::Section::new(vertebrae_core::SectionType::Goal, "Goal content");
        let gui = Section::from(core);
        assert_eq!(gui.section_type, SectionType::Goal);
        assert_eq!(gui.content, "Goal content");
        assert_eq!(gui.order, None);
        assert_eq!(gui.done, None);
        assert_eq!(gui.done_at, None);
        assert!(gui.refs.is_empty());
    }

    #[test]
    fn section_from_core_with_order() {
        let core = vertebrae_core::Section::with_order(
            vertebrae_core::SectionType::ChecklistItem,
            "Do this",
            5,
        );
        let gui = Section::from(core);
        assert_eq!(gui.section_type, SectionType::ChecklistItem);
        assert_eq!(gui.order, Some(5));
    }

    #[test]
    fn section_from_core_with_done() {
        let core =
            vertebrae_core::Section::new(vertebrae_core::SectionType::Goal, "Goal").with_done(true);
        let gui = Section::from(core);
        assert_eq!(gui.done, Some(true));
        assert!(gui.done_at.is_some());
    }

    #[test]
    fn section_from_core_with_refs() {
        let ref1 = vertebrae_core::CodeRef::file("test.rs");
        let ref2 = vertebrae_core::CodeRef::file("test2.rs");
        let core = vertebrae_core::Section::new(vertebrae_core::SectionType::Goal, "Goal")
            .with_refs(vec![ref1, ref2]);
        let gui = Section::from(core);
        assert_eq!(gui.refs.len(), 2);
    }

    // ─── Task Conversion Tests ──────────────────────────────────────

    #[test]
    fn task_from_core_minimal() {
        let core = vertebrae_core::Task::new("Task", vertebrae_core::Level::Task);
        let gui = Task::from(core);
        assert_eq!(gui.title, "Task");
        assert_eq!(gui.level, Some(TaskLevel::Task));
        assert_eq!(gui.priority, None);
        assert!(gui.description.is_none());
        assert!(gui.tags.is_empty());
        assert!(gui.sections.is_empty());
        assert!(gui.code_refs.is_empty());
    }

    #[test]
    fn task_from_core_full() {
        let core = vertebrae_core::Task::new("Task", vertebrae_core::Level::Epic)
            .with_description("Task description")
            .with_priority(vertebrae_core::Priority::Critical)
            .with_tag("urgent");
        let gui = Task::from(core);
        assert_eq!(gui.title, "Task");
        assert_eq!(gui.level, Some(TaskLevel::Epic));
        assert_eq!(gui.description, Some("Task description".to_string()));
        assert_eq!(gui.priority, Some(TaskPriority::Critical));
        assert_eq!(gui.tags, vec!["urgent"]);
    }

    #[test]
    fn task_from_core_with_sections_and_refs() {
        let section = vertebrae_core::Section::new(vertebrae_core::SectionType::Goal, "Goal");
        let code_ref = vertebrae_core::CodeRef::file("src/main.rs");
        let core = vertebrae_core::Task::new("Task", vertebrae_core::Level::Task)
            .with_section(section)
            .with_code_ref(code_ref);
        let gui = Task::from(core);
        assert_eq!(gui.sections.len(), 1);
        assert_eq!(gui.code_refs.len(), 1);
    }

    #[test]
    fn task_from_core_with_timestamps() {
        use chrono::prelude::*;
        let mut core = vertebrae_core::Task::new("Task", vertebrae_core::Level::Task);
        let now = Utc::now();
        core.created_at = Some(now);
        core.updated_at = Some(now);
        core.started_at = Some(now);
        core.completed_at = Some(now);

        let gui = Task::from(core);
        assert!(gui.created_at.is_some());
        assert!(gui.updated_at.is_some());
        assert!(gui.started_at.is_some());
        assert!(gui.completed_at.is_some());
    }

    // ─── TaskFilterOptions Conversion Tests ─────────────────────────

    #[test]
    fn task_filter_from_gui_empty() {
        let gui_filter = TaskFilterOptions::default();
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert!(core_filter.levels.is_empty());
        assert!(core_filter.step_names.is_empty());
        assert!(!core_filter.root_only);
    }

    #[test]
    fn task_filter_from_gui_with_levels() {
        let gui_filter = TaskFilterOptions {
            levels: Some(vec![TaskLevel::Epic, TaskLevel::Task]),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert_eq!(core_filter.levels.len(), 2);
        assert!(core_filter.levels.contains(&vertebrae_core::Level::Epic));
        assert!(core_filter.levels.contains(&vertebrae_core::Level::Task));
    }

    #[test]
    fn task_filter_from_gui_with_statuses() {
        let gui_filter = TaskFilterOptions {
            step_names: Some(vec!["in_progress".to_string(), "done".to_string()]),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert_eq!(core_filter.step_names, vec!["in_progress", "done"]);
    }

    #[test]
    fn task_filter_from_gui_with_tags() {
        let gui_filter = TaskFilterOptions {
            tags: Some(vec!["rust".to_string(), "cli".to_string()]),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert_eq!(core_filter.tags, vec!["rust", "cli"]);
    }

    #[test]
    fn task_filter_from_gui_root_only() {
        let gui_filter = TaskFilterOptions {
            root_only: Some(true),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert!(core_filter.root_only);
    }

    #[test]
    fn task_filter_from_gui_children_of() {
        let gui_filter = TaskFilterOptions {
            children_of: Some("parent123".to_string()),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert_eq!(core_filter.children_of, Some("parent123".to_string()));
    }

    #[test]
    fn task_filter_from_gui_include_done() {
        let gui_filter = TaskFilterOptions {
            include_done: Some(true),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert!(core_filter.include_done);
    }

    #[test]
    fn task_filter_from_gui_with_search() {
        let gui_filter = TaskFilterOptions {
            search: Some("authentication".to_string()),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert_eq!(core_filter.search, Some("authentication".to_string()));
    }

    #[test]
    fn task_filter_from_gui_with_workflow_id() {
        let gui_filter = TaskFilterOptions {
            workflow_id: Some("wf123".to_string()),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert_eq!(core_filter.workflow_id, Some("wf123".to_string()));
    }

    #[test]
    fn task_filter_from_gui_with_step_id() {
        let gui_filter = TaskFilterOptions {
            step_id: Some("step-abc".to_string()),
            ..Default::default()
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert_eq!(core_filter.step_id, Some("step-abc".to_string()));
    }

    #[test]
    fn task_filter_from_gui_complex() {
        let gui_filter = TaskFilterOptions {
            levels: Some(vec![TaskLevel::Epic]),
            step_names: Some(vec!["in_progress".to_string()]),
            tags: Some(vec!["urgent".to_string()]),
            root_only: Some(true),
            include_done: Some(false),
            search: Some("auth".to_string()),
            children_of: None,
            workflow_id: Some("wf1".to_string()),
            step_id: Some("step-1".to_string()),
        };
        let core_filter = vertebrae_core::TaskFilter::from(gui_filter);
        assert_eq!(core_filter.levels.len(), 1);
        assert_eq!(core_filter.step_names.len(), 1);
        assert_eq!(core_filter.tags.len(), 1);
        assert!(core_filter.root_only);
        assert!(!core_filter.include_done);
        assert_eq!(core_filter.search, Some("auth".to_string()));
        assert_eq!(core_filter.workflow_id, Some("wf1".to_string()));
        assert_eq!(core_filter.step_id, Some("step-1".to_string()));
    }

    // ─── PermissionMode Conversion Tests ────────────────────────────

    #[test]
    fn permission_mode_from_core_accept_edits() {
        let core = vertebrae_core::PermissionMode::AcceptEdits;
        let gui = PermissionMode::from(core);
        assert_eq!(gui, PermissionMode::AcceptEdits);
    }

    #[test]
    fn permission_mode_from_core_all_variants() {
        assert_eq!(
            PermissionMode::from(vertebrae_core::PermissionMode::BypassPermissions),
            PermissionMode::BypassPermissions
        );
        assert_eq!(
            PermissionMode::from(vertebrae_core::PermissionMode::Default),
            PermissionMode::Default
        );
        assert_eq!(
            PermissionMode::from(vertebrae_core::PermissionMode::Delegate),
            PermissionMode::Delegate
        );
        assert_eq!(
            PermissionMode::from(vertebrae_core::PermissionMode::DontAsk),
            PermissionMode::DontAsk
        );
        assert_eq!(
            PermissionMode::from(vertebrae_core::PermissionMode::Plan),
            PermissionMode::Plan
        );
    }

    // ─── AgentConfig Conversion Tests ────────────────────────────────

    #[test]
    fn agent_config_from_core_empty() {
        let core = vertebrae_core::AgentConfig::new();
        let gui = AgentConfig::from(core);
        assert_eq!(gui.model, None);
        assert_eq!(gui.fallback_model, None);
        assert_eq!(gui.system_prompt, None);
        assert!(gui.tools.is_empty());
        assert!(gui.allowed_tools.is_empty());
        assert!(gui.disallowed_tools.is_empty());
        assert_eq!(gui.permission_mode, None);
        assert_eq!(gui.max_budget_usd, None);
    }

    #[test]
    fn agent_config_from_core_with_model() {
        let core = vertebrae_core::AgentConfig::new().with_model("claude-opus");
        let gui = AgentConfig::from(core);
        assert_eq!(gui.model, Some("claude-opus".to_string()));
    }

    #[test]
    fn agent_config_from_core_with_tools() {
        let core = vertebrae_core::AgentConfig::new()
            .with_tools(vec!["read".to_string(), "write".to_string()]);
        let gui = AgentConfig::from(core);
        assert_eq!(gui.tools, vec!["read", "write"]);
    }

    #[test]
    fn agent_config_from_core_with_permission_mode() {
        let core = vertebrae_core::AgentConfig::new()
            .with_permission_mode(vertebrae_core::PermissionMode::Plan);
        let gui = AgentConfig::from(core);
        assert_eq!(gui.permission_mode, Some(PermissionMode::Plan));
    }

    #[test]
    fn agent_config_from_core_with_json_value() {
        let core = vertebrae_core::AgentConfig::new()
            .with_json_schema(serde_json::json!({"type": "object"}));
        let gui = AgentConfig::from(core);
        assert!(gui.json_schema.is_some());
    }

    // ─── Step Conversion Tests ──────────────────────────────────────

    #[test]
    fn step_from_core_basic() {
        let core = vertebrae_core::Step::new("review", "wf1");
        let gui = Step::from(core);
        assert_eq!(gui.name, "review");
        assert_eq!(gui.workflow_id, "wf1");
        assert_eq!(gui.goal, None);
        assert_eq!(gui.prompt, None);
        assert!(gui.agents.is_empty());
        assert!(gui.skills.is_empty());
        assert!(!gui.is_final);
        assert!(gui.transitions_to.is_empty());
        assert_eq!(gui.order, 0);
    }

    #[test]
    fn step_from_core_with_config() {
        let core = vertebrae_core::Step::new("review", "wf1")
            .with_goal("Review code")
            .with_prompt("Review the PR")
            .with_agent("claude")
            .with_skill("code-review")
            .with_is_final(true)
            .with_order(5);
        let gui = Step::from(core);
        assert_eq!(gui.name, "review");
        assert_eq!(gui.goal, Some("Review code".to_string()));
        assert_eq!(gui.prompt, Some("Review the PR".to_string()));
        assert_eq!(gui.agents, vec!["claude"]);
        assert_eq!(gui.skills, vec!["code-review"]);
        assert!(gui.is_final);
        assert_eq!(gui.order, 5);
    }

    // ─── Workflow Conversion Tests ──────────────────────────────────

    #[test]
    fn workflow_from_core_basic() {
        let core = vertebrae_core::Workflow::new("Review");
        let gui = Workflow::from(core);
        assert_eq!(gui.name, "Review");
        assert_eq!(gui.description, None);
        assert_eq!(gui.initial_step, None);
        assert!(gui.metadata.is_empty());
    }

    #[test]
    fn workflow_from_core_with_metadata() {
        let core = vertebrae_core::Workflow::new("Dev")
            .with_description("Development workflow")
            .with_metadata("env", "staging")
            .with_initial_step("step1");
        let gui = Workflow::from(core);
        assert_eq!(gui.name, "Dev");
        assert_eq!(gui.description, Some("Development workflow".to_string()));
        assert_eq!(gui.initial_step, Some("step1".to_string()));
        assert_eq!(gui.metadata.get("env").unwrap(), "staging");
    }

    // ─── ExecutionStatus Conversion Tests ────────────────────────────

    #[test]
    fn execution_status_from_core_in_progress() {
        let core = vertebrae_core::ExecutionStatus::InProgress;
        let gui = ExecutionStatus::from(core);
        assert_eq!(gui, ExecutionStatus::InProgress);
    }

    #[test]
    fn execution_status_from_core_all() {
        assert_eq!(
            ExecutionStatus::from(vertebrae_core::ExecutionStatus::Completed),
            ExecutionStatus::Completed
        );
        assert_eq!(
            ExecutionStatus::from(vertebrae_core::ExecutionStatus::Failed),
            ExecutionStatus::Failed
        );
    }

    // ─── StepExecution Conversion Tests ─────────────────────────────

    #[test]
    fn step_execution_from_core() {
        let core = vertebrae_core::StepExecution::new("task1", "wf1", "review");
        let gui = StepExecution::from(core);
        assert_eq!(gui.task_id, "task1");
        assert_eq!(gui.workflow_id, "wf1");
        assert_eq!(gui.step_name, "review");
        assert_eq!(gui.status, ExecutionStatus::InProgress);
        assert_eq!(gui.completed_at, None);
    }

    #[test]
    fn step_execution_from_core_with_completion() {
        let mut core = vertebrae_core::StepExecution::new("task1", "wf1", "review");
        core.complete();
        let gui = StepExecution::from(core);
        assert_eq!(gui.status, ExecutionStatus::Completed);
        assert!(gui.completed_at.is_some());
    }

    #[test]
    fn step_execution_from_core_rfc3339_format() {
        let core = vertebrae_core::StepExecution::new("t", "w", "s");
        let gui = StepExecution::from(core);
        chrono::DateTime::parse_from_rfc3339(&gui.started_at)
            .expect("started_at should be valid RFC3339");
    }

    #[test]
    fn step_execution_from_core_maps_full_field_set() {
        let core = vertebrae_core::StepExecution::new("task1", "wf1", "review")
            .with_prompt("the prompt")
            .with_output("the output")
            .with_context(r#"{"k":"v"}"#)
            .with_transition_result("approved")
            .with_model_used("claude-opus")
            .with_model_provider("anthropic")
            .with_session_id("sess-42")
            .with_token_usage(vertebrae_core::TokenUsage::new(1000, 500))
            .with_cost_usd(0.0123)
            .with_duration_ms(2_500)
            .with_handoff(r#"{"to":"next"}"#);

        let gui = StepExecution::from(core);
        assert_eq!(gui.prompt.as_deref(), Some("the prompt"));
        assert_eq!(gui.output.as_deref(), Some("the output"));
        assert_eq!(gui.context.as_deref(), Some(r#"{"k":"v"}"#));
        assert_eq!(gui.transition_result.as_deref(), Some("approved"));
        assert_eq!(gui.model.as_deref(), Some("claude-opus"));
        assert_eq!(gui.model_provider.as_deref(), Some("anthropic"));
        assert_eq!(gui.session_id.as_deref(), Some("sess-42"));
        assert_eq!(gui.input_tokens, Some(1000));
        assert_eq!(gui.output_tokens, Some(500));
        assert_eq!(gui.cost.as_deref(), Some("0.0123"));
        assert_eq!(gui.duration_ms, Some(2_500));
        assert_eq!(gui.handoff.as_deref(), Some(r#"{"to":"next"}"#));
    }

    #[test]
    fn step_execution_round_trip_serialization_with_full_field_set() {
        // Mirrors the shape sacrum sends over the WS channel and ensures we
        // do not drop any rich field on its way to the frontend.
        let payload = serde_json::json!({
            "id": "exec-1",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "review",
            "started_at": "2024-01-01T00:00:00Z",
            "completed_at": "2024-01-01T00:00:05Z",
            "status": "completed",
            "prompt": "do the thing",
            "output": "done",
            "context": "{\"k\":\"v\"}",
            "transition_result": "approved",
            "model": "claude-opus",
            "model_provider": "anthropic",
            "input_tokens": 1234u32,
            "output_tokens": 567u32,
            "cost": "0.025",
            "duration_ms": 4321u32,
            "handoff": "{\"to\":\"next\"}",
            "session_id": "sess-99",
        });

        let exec: StepExecution = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(exec.id.as_deref(), Some("exec-1"));
        assert_eq!(exec.task_id, "task-1");
        assert_eq!(exec.status, ExecutionStatus::Completed);
        assert_eq!(exec.prompt.as_deref(), Some("do the thing"));
        assert_eq!(exec.output.as_deref(), Some("done"));
        assert_eq!(exec.context.as_deref(), Some("{\"k\":\"v\"}"));
        assert_eq!(exec.transition_result.as_deref(), Some("approved"));
        assert_eq!(exec.model.as_deref(), Some("claude-opus"));
        assert_eq!(exec.model_provider.as_deref(), Some("anthropic"));
        assert_eq!(exec.input_tokens, Some(1234));
        assert_eq!(exec.output_tokens, Some(567));
        assert_eq!(exec.cost.as_deref(), Some("0.025"));
        assert_eq!(exec.duration_ms, Some(4321));
        assert_eq!(exec.handoff.as_deref(), Some("{\"to\":\"next\"}"));
        assert_eq!(exec.session_id.as_deref(), Some("sess-99"));

        // Re-serialize and re-deserialize to round-trip.
        let again: StepExecution =
            serde_json::from_value(serde_json::to_value(&exec).unwrap()).unwrap();
        assert_eq!(again.prompt, exec.prompt);
        assert_eq!(again.output, exec.output);
        assert_eq!(again.context, exec.context);
        assert_eq!(again.transition_result, exec.transition_result);
        assert_eq!(again.model, exec.model);
        assert_eq!(again.model_provider, exec.model_provider);
        assert_eq!(again.input_tokens, exec.input_tokens);
        assert_eq!(again.output_tokens, exec.output_tokens);
        assert_eq!(again.cost, exec.cost);
        assert_eq!(again.duration_ms, exec.duration_ms);
        assert_eq!(again.handoff, exec.handoff);
        assert_eq!(again.session_id, exec.session_id);
    }

    #[test]
    fn step_execution_deserializes_with_missing_optional_fields() {
        // Historical executions / minimal payloads only include the timeline
        // fields. The new fields must default to None and not error.
        let payload = serde_json::json!({
            "id": "exec-min",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "todo",
            "started_at": "2024-01-01T00:00:00Z",
            "status": "in_progress",
        });
        let exec: StepExecution = serde_json::from_value(payload).unwrap();
        assert!(exec.prompt.is_none());
        assert!(exec.output.is_none());
        assert!(exec.context.is_none());
        assert!(exec.transition_result.is_none());
        assert!(exec.model.is_none());
        assert!(exec.model_provider.is_none());
        assert!(exec.input_tokens.is_none());
        assert!(exec.output_tokens.is_none());
        assert!(exec.cost.is_none());
        assert!(exec.duration_ms.is_none());
        assert!(exec.handoff.is_none());
        assert!(exec.session_id.is_none());
    }

    /// Sacrum's `project_channel.ex` serializes Decimal cost via
    /// `Decimal.to_string`, so the WS payload arrives as a JSON string. The
    /// field must deserialize without dropping the entire StepExecution.
    #[test]
    fn step_execution_accepts_decimal_string_cost_from_sacrum() {
        let payload = serde_json::json!({
            "id": "exec-decimal",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "review",
            "started_at": "2024-01-01T00:00:00Z",
            "status": "completed",
            "cost": "0.0742",
        });
        let exec: StepExecution = serde_json::from_value(payload).unwrap();
        assert_eq!(exec.cost.as_deref(), Some("0.0742"));
    }

    // ─── SessionLog Conversion Tests ────────────────────────────────

    #[test]
    fn session_log_from_core() {
        let core = vertebrae_core::SessionLog::new("exec1", "log content");
        let gui = SessionLog::from(core);
        assert_eq!(gui.step_execution_id, "exec1");
        assert_eq!(gui.content, "log content");
        assert!(!gui.created_at.is_empty());
    }

    #[test]
    fn session_log_from_core_rfc3339_format() {
        let core = vertebrae_core::SessionLog::new("e1", "content");
        let gui = SessionLog::from(core);
        chrono::DateTime::parse_from_rfc3339(&gui.created_at)
            .expect("created_at should be valid RFC3339");
    }

    // ─── Sacrum WS Payload Deserialization Tests ────────────────────

    #[test]
    fn task_deserializes_from_sacrum_ws_payload() {
        let payload = serde_json::json!({
            "id": "abc12345-0000-4000-8000-000000000001",
            "title": "Implement feature X",
            "description": "A task from Sacrum WS",
            "level": "ticket",
            "priority": "high",
            "tags": ["rust", "gui"],
            "workflow_id": "wf-001",
            "current_step_id": "step-001",
            "workflow_name": "Development",
            "step_name": "in_progress",
            "needs_human_review": false,
            "archived": false,
            "parent_id": null,
            "inserted_at": "2026-03-15T10:00:00.000000Z",
            "updated_at": "2026-03-15T11:00:00.000000Z",
            "started_at": "2026-03-15T10:30:00.000000Z",
            "completed_at": null,
            "short_id": "abc12345",
            "project_id": "proj-001"
        });

        let task: Task = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(task.id, "abc12345-0000-4000-8000-000000000001");
        assert_eq!(task.title, "Implement feature X");
        assert_eq!(task.description, Some("A task from Sacrum WS".to_string()));
        assert_eq!(task.level, Some(TaskLevel::Ticket));
        assert_eq!(task.priority, Some(TaskPriority::High));
        assert_eq!(task.tags, vec!["rust", "gui"]);
        assert_eq!(task.workflow_id, Some("wf-001".to_string()));
        assert_eq!(
            task.created_at,
            Some("2026-03-15T10:00:00.000000Z".to_string())
        );
        assert!(!task.archived);
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
        assert!(task.dependency_ids.is_empty());
    }

    #[test]
    fn task_deserializes_from_minimal_sacrum_payload() {
        let payload = serde_json::json!({
            "id": "task-minimal",
            "title": "Minimal task",
            "level": "task",
            "inserted_at": "2026-03-15T10:00:00.000000Z"
        });

        let task: Task = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(task.id, "task-minimal");
        assert_eq!(task.title, "Minimal task");
        assert_eq!(task.level, Some(TaskLevel::Task));
        assert!(!task.archived);
        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
        assert!(task.dependency_ids.is_empty());
        assert_eq!(
            task.created_at,
            Some("2026-03-15T10:00:00.000000Z".to_string())
        );
    }

    #[test]
    fn task_inserted_at_maps_to_created_at() {
        let payload = serde_json::json!({
            "id": "t1",
            "title": "Test",
            "level": "task",
            "inserted_at": "2026-01-01T00:00:00Z"
        });

        let task: Task = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(task.created_at, Some("2026-01-01T00:00:00Z".to_string()));
    }

    #[test]
    fn task_ignores_unknown_fields() {
        let payload = serde_json::json!({
            "id": "t2",
            "title": "Test",
            "level": "task",
            "short_id": "t2",
            "project_id": "proj-xyz",
            "some_future_field": 42
        });

        let task: Task = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(task.id, "t2");
    }

    #[test]
    fn workflow_deserializes_from_sacrum_ws_payload() {
        let payload = serde_json::json!({
            "id": "wf-001",
            "name": "Development",
            "description": "Standard dev workflow",
            "initial_step": "step-backlog",
            "inserted_at": "2026-03-15T10:00:00.000000Z",
            "updated_at": "2026-03-15T11:00:00.000000Z",
            "short_id": "wf001",
            "project_id": "proj-001"
        });

        let workflow: Workflow = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(workflow.id, Some("wf-001".to_string()));
        assert_eq!(workflow.name, "Development");
        assert_eq!(
            workflow.description,
            Some("Standard dev workflow".to_string())
        );
        assert_eq!(workflow.initial_step, Some("step-backlog".to_string()));
        assert_eq!(
            workflow.created_at,
            Some("2026-03-15T10:00:00.000000Z".to_string())
        );
        assert!(workflow.metadata.is_empty());
    }

    #[test]
    fn step_deserializes_from_sacrum_ws_payload() {
        let payload = serde_json::json!({
            "id": "step-001",
            "name": "review",
            "workflow_id": "wf-001",
            "goal": "Review code changes",
            "prompt": "Review the PR carefully",
            "order": 2,
            "is_final": false,
            "inserted_at": "2026-03-15T10:00:00.000000Z",
            "updated_at": "2026-03-15T11:00:00.000000Z",
            "short_id": "s001",
            "project_id": "proj-001"
        });

        let step: Step = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(step.id, Some("step-001".to_string()));
        assert_eq!(step.name, "review");
        assert_eq!(step.workflow_id, "wf-001");
        assert_eq!(step.goal, Some("Review code changes".to_string()));
        assert_eq!(step.order, 2);
        assert!(!step.is_final);
        assert!(step.agents.is_empty());
        assert!(step.skills.is_empty());
        assert!(step.transitions_to.is_empty());
        assert_eq!(
            step.created_at,
            Some("2026-03-15T10:00:00.000000Z".to_string())
        );
    }

    #[test]
    fn step_deserializes_from_minimal_sacrum_payload() {
        let payload = serde_json::json!({
            "id": "step-min",
            "name": "backlog",
            "workflow_id": "wf-001"
        });

        let step: Step = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(step.name, "backlog");
        assert_eq!(step.workflow_id, "wf-001");
        assert_eq!(step.order, 0);
        assert!(!step.is_final);
        assert!(step.transitions_to.is_empty());
    }

    #[test]
    fn section_deserializes_from_sacrum_ws_payload() {
        let payload = serde_json::json!({
            "id": "sec-001",
            "task_id": "task-001",
            "type": "checklist_item",
            "content": "Add unit tests",
            "order": 1,
            "done": false,
            "done_at": null,
            "project_id": "proj-001"
        });

        let section: Section = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(section.section_type, SectionType::ChecklistItem);
        assert_eq!(section.content, "Add unit tests");
        assert_eq!(section.order, Some(1));
        assert_eq!(section.done, Some(false));
        assert!(section.refs.is_empty());
    }

    #[test]
    fn step_execution_deserializes_from_sacrum_ws_payload() {
        let payload = serde_json::json!({
            "id": "exec-001",
            "task_id": "task-001",
            "workflow_id": "wf-001",
            "step_name": "review",
            "status": "in_progress",
            "started_at": "2026-03-15T10:00:00.000000Z",
            "completed_at": null,
            "inserted_at": "2026-03-15T09:59:00.000000Z",
            "project_id": "proj-001"
        });

        let exec: StepExecution = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(exec.id, Some("exec-001".to_string()));
        assert_eq!(exec.task_id, "task-001");
        assert_eq!(exec.workflow_id, "wf-001");
        assert_eq!(exec.step_name, "review");
        assert_eq!(exec.status, ExecutionStatus::InProgress);
        assert_eq!(exec.started_at, "2026-03-15T10:00:00.000000Z");
        assert_eq!(exec.completed_at, None);
    }

    #[test]
    fn step_execution_deserializes_with_minimal_fields() {
        let payload = serde_json::json!({
            "id": "exec-min"
        });

        let exec: StepExecution = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(exec.id, Some("exec-min".to_string()));
        assert_eq!(exec.task_id, "");
        assert_eq!(exec.workflow_id, "");
        assert_eq!(exec.step_name, "");
        assert_eq!(exec.status, ExecutionStatus::InProgress);
    }

    #[test]
    fn session_log_deserializes_from_sacrum_ws_payload() {
        let payload = serde_json::json!({
            "id": "log-001",
            "step_execution_id": "exec-001",
            "content": "Step completed successfully",
            "inserted_at": "2026-03-15T10:05:00.000000Z",
            "project_id": "proj-001"
        });

        let log: SessionLog = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(log.id, Some("log-001".to_string()));
        assert_eq!(log.step_execution_id, "exec-001");
        assert_eq!(log.content, "Step completed successfully");
        assert_eq!(log.created_at, "2026-03-15T10:05:00.000000Z");
    }

    #[test]
    fn session_log_inserted_at_maps_to_created_at() {
        let payload = serde_json::json!({
            "id": "log-002",
            "inserted_at": "2026-01-01T00:00:00Z"
        });

        let log: SessionLog = serde_json::from_value(payload).expect("should deserialize");
        assert_eq!(log.created_at, "2026-01-01T00:00:00Z");
    }
}
