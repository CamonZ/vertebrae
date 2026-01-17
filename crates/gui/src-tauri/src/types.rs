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

impl From<vertebrae_db::Level> for TaskLevel {
    fn from(level: vertebrae_db::Level) -> Self {
        match level {
            vertebrae_db::Level::Epic => TaskLevel::Epic,
            vertebrae_db::Level::Ticket => TaskLevel::Ticket,
            vertebrae_db::Level::Task => TaskLevel::Task,
        }
    }
}

/// Task status - mirrors db::Status
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Backlog,
    Todo,
    InProgress,
    PendingReview,
    Done,
    Rejected,
}

impl From<vertebrae_db::Status> for TaskStatus {
    fn from(status: vertebrae_db::Status) -> Self {
        match status {
            vertebrae_db::Status::Backlog => TaskStatus::Backlog,
            vertebrae_db::Status::Todo => TaskStatus::Todo,
            vertebrae_db::Status::InProgress => TaskStatus::InProgress,
            vertebrae_db::Status::PendingReview => TaskStatus::PendingReview,
            vertebrae_db::Status::Done => TaskStatus::Done,
            vertebrae_db::Status::Rejected => TaskStatus::Rejected,
        }
    }
}

impl From<TaskStatus> for vertebrae_db::Status {
    fn from(status: TaskStatus) -> Self {
        match status {
            TaskStatus::Backlog => vertebrae_db::Status::Backlog,
            TaskStatus::Todo => vertebrae_db::Status::Todo,
            TaskStatus::InProgress => vertebrae_db::Status::InProgress,
            TaskStatus::PendingReview => vertebrae_db::Status::PendingReview,
            TaskStatus::Done => vertebrae_db::Status::Done,
            TaskStatus::Rejected => vertebrae_db::Status::Rejected,
        }
    }
}

/// Task priority - mirrors db::Priority
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Low,
    Medium,
    High,
    Critical,
}

impl From<vertebrae_db::Priority> for TaskPriority {
    fn from(priority: vertebrae_db::Priority) -> Self {
        match priority {
            vertebrae_db::Priority::Low => TaskPriority::Low,
            vertebrae_db::Priority::Medium => TaskPriority::Medium,
            vertebrae_db::Priority::High => TaskPriority::High,
            vertebrae_db::Priority::Critical => TaskPriority::Critical,
        }
    }
}

impl From<TaskPriority> for vertebrae_db::Priority {
    fn from(priority: TaskPriority) -> Self {
        match priority {
            TaskPriority::Low => vertebrae_db::Priority::Low,
            TaskPriority::Medium => vertebrae_db::Priority::Medium,
            TaskPriority::High => vertebrae_db::Priority::High,
            TaskPriority::Critical => vertebrae_db::Priority::Critical,
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
    Step,
    TestingCriterion,
    AntiPattern,
    FailureTest,
    Constraint,
}

impl From<vertebrae_db::SectionType> for SectionType {
    fn from(section_type: vertebrae_db::SectionType) -> Self {
        match section_type {
            vertebrae_db::SectionType::Goal => SectionType::Goal,
            vertebrae_db::SectionType::Context => SectionType::Context,
            vertebrae_db::SectionType::CurrentBehavior => SectionType::CurrentBehavior,
            vertebrae_db::SectionType::DesiredBehavior => SectionType::DesiredBehavior,
            vertebrae_db::SectionType::Step => SectionType::Step,
            vertebrae_db::SectionType::TestingCriterion => SectionType::TestingCriterion,
            vertebrae_db::SectionType::AntiPattern => SectionType::AntiPattern,
            vertebrae_db::SectionType::FailureTest => SectionType::FailureTest,
            vertebrae_db::SectionType::Constraint => SectionType::Constraint,
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

impl From<vertebrae_db::CodeRef> for CodeRef {
    fn from(code_ref: vertebrae_db::CodeRef) -> Self {
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

impl From<vertebrae_db::Section> for Section {
    fn from(section: vertebrae_db::Section) -> Self {
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

/// Summary of a task for list views - mirrors db::TaskSummary
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TaskSummary {
    /// The task ID
    pub id: String,
    /// Task title
    pub title: String,
    /// Hierarchy level
    pub level: TaskLevel,
    /// Current status
    pub status: TaskStatus,
    /// Optional priority
    pub priority: Option<TaskPriority>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
    /// When the task was created (ISO 8601 format)
    pub created_at: String,
}

impl From<vertebrae_db::TaskSummary> for TaskSummary {
    fn from(summary: vertebrae_db::TaskSummary) -> Self {
        TaskSummary {
            id: summary.id,
            title: summary.title,
            level: summary.level.into(),
            status: summary.status.into(),
            priority: summary.priority.map(Into::into),
            tags: summary.tags,
            needs_human_review: summary.needs_human_review,
            created_at: summary.created_at.to_rfc3339(),
        }
    }
}

/// Full task details - mirrors db::Task but with string IDs and dates
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Task {
    /// Task ID (string form)
    pub id: Option<String>,
    /// Task title
    pub title: String,
    /// Optional description
    pub description: Option<String>,
    /// Hierarchy level
    pub level: TaskLevel,
    /// Current status
    pub status: TaskStatus,
    /// Optional priority
    pub priority: Option<TaskPriority>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Creation timestamp (ISO 8601 string)
    pub created_at: Option<String>,
    /// Last update timestamp (ISO 8601 string)
    pub updated_at: Option<String>,
    /// When this task was started (ISO 8601 string)
    pub started_at: Option<String>,
    /// When this task was completed (ISO 8601 string)
    pub completed_at: Option<String>,
    /// Embedded sections
    pub sections: Vec<Section>,
    /// Embedded code references
    pub code_refs: Vec<CodeRef>,
    /// Whether this task needs human review
    pub needs_human_review: Option<bool>,
    /// Workflow ID (string form)
    pub workflow_id: Option<String>,
    /// Current step in workflow (0-indexed)
    pub current_step: Option<u32>,
}

impl From<vertebrae_db::Task> for Task {
    fn from(task: vertebrae_db::Task) -> Self {
        Task {
            id: task.id.map(|t| t.id.to_raw()),
            title: task.title,
            description: task.description,
            level: task.level.into(),
            status: task.status.into(),
            priority: task.priority.map(Into::into),
            tags: task.tags,
            created_at: task.created_at.map(|dt| dt.to_rfc3339()),
            updated_at: task.updated_at.map(|dt| dt.to_rfc3339()),
            started_at: task.started_at.map(|dt| dt.to_rfc3339()),
            completed_at: task.completed_at.map(|dt| dt.to_rfc3339()),
            sections: task.sections.into_iter().map(Into::into).collect(),
            code_refs: task.code_refs.into_iter().map(Into::into).collect(),
            needs_human_review: task.needs_human_review,
            workflow_id: task.workflow_id.map(|t| t.id.to_raw()),
            current_step: task.current_step.map(|s| s as u32),
        }
    }
}

/// Task with its relations (parent, children, dependencies)
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TaskWithRelations {
    /// The task itself
    pub task: Task,
    /// Parent task ID (if any)
    pub parent_id: Option<String>,
    /// Child task IDs
    pub children_ids: Vec<String>,
    /// Task IDs this task depends on (blockers)
    pub depends_on_ids: Vec<String>,
    /// Task IDs that depend on this task
    pub dependent_ids: Vec<String>,
}

/// Task hierarchy node for tree views
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TaskHierarchyNode {
    /// The task summary
    pub task: TaskSummary,
    /// Child nodes
    pub children: Vec<TaskHierarchyNode>,
}

/// Filter options for listing tasks
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct TaskFilterOptions {
    /// Filter by statuses (OR semantics)
    pub statuses: Option<Vec<TaskStatus>>,
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
}

impl From<TaskFilterOptions> for vertebrae_db::TaskFilter {
    fn from(opts: TaskFilterOptions) -> Self {
        let mut filter = vertebrae_db::TaskFilter::new();

        if let Some(statuses) = opts.statuses {
            for status in statuses {
                filter = filter.with_status(status.into());
            }
        }

        if let Some(levels) = opts.levels {
            for level in levels {
                filter = filter.with_level(match level {
                    TaskLevel::Epic => vertebrae_db::Level::Epic,
                    TaskLevel::Ticket => vertebrae_db::Level::Ticket,
                    TaskLevel::Task => vertebrae_db::Level::Task,
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

        filter
    }
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

impl From<vertebrae_db::PermissionMode> for PermissionMode {
    fn from(mode: vertebrae_db::PermissionMode) -> Self {
        match mode {
            vertebrae_db::PermissionMode::AcceptEdits => PermissionMode::AcceptEdits,
            vertebrae_db::PermissionMode::BypassPermissions => PermissionMode::BypassPermissions,
            vertebrae_db::PermissionMode::Default => PermissionMode::Default,
            vertebrae_db::PermissionMode::Delegate => PermissionMode::Delegate,
            vertebrae_db::PermissionMode::DontAsk => PermissionMode::DontAsk,
            vertebrae_db::PermissionMode::Plan => PermissionMode::Plan,
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
    pub tools: Vec<String>,
    /// List of tool names to allow
    pub allowed_tools: Vec<String>,
    /// List of tool names to deny
    pub disallowed_tools: Vec<String>,
    /// Permission mode to use for the session
    pub permission_mode: Option<PermissionMode>,
    /// Maximum dollar amount to spend on API calls
    pub max_budget_usd: Option<f64>,
    /// Paths to MCP server configuration files or JSON strings
    pub mcp_config: Vec<String>,
    /// Directories to load plugins from
    pub plugin_dirs: Vec<String>,
    /// JSON Schema for structured output validation (serialized as JSON string)
    pub json_schema: Option<String>,
}

impl From<vertebrae_db::AgentConfig> for AgentConfig {
    fn from(config: vertebrae_db::AgentConfig) -> Self {
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

/// Workflow step - mirrors db::WorkflowStep
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowStep {
    /// Display name for this step
    pub name: String,
    /// The agent configuration to use for this step
    pub agent_config: AgentConfig,
    /// Ordering index for sequential execution (0-based)
    pub order: u32,
}

impl From<vertebrae_db::WorkflowStep> for WorkflowStep {
    fn from(step: vertebrae_db::WorkflowStep) -> Self {
        WorkflowStep {
            name: step.name,
            agent_config: step.agent_config.into(),
            order: step.order,
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
    /// Ordered list of workflow steps
    pub steps: Vec<WorkflowStep>,
    /// Additional metadata as key-value pairs
    pub metadata: std::collections::HashMap<String, String>,
    /// Workflow to assign to task when completing the last step
    pub on_done_workflow: Option<String>,
    /// Workflow to assign to task when rejected
    pub on_reject_workflow: Option<String>,
    /// Creation timestamp (ISO 8601 string)
    pub created_at: Option<String>,
    /// Last update timestamp (ISO 8601 string)
    pub updated_at: Option<String>,
}

impl From<vertebrae_db::Workflow> for Workflow {
    fn from(workflow: vertebrae_db::Workflow) -> Self {
        Workflow {
            id: workflow.id.map(|t| t.id.to_raw()),
            name: workflow.name,
            description: workflow.description,
            steps: workflow.steps.into_iter().map(Into::into).collect(),
            metadata: workflow.metadata,
            on_done_workflow: workflow.on_done_workflow,
            on_reject_workflow: workflow.on_reject_workflow,
            created_at: workflow.created_at.map(|dt| dt.to_rfc3339()),
            updated_at: workflow.updated_at.map(|dt| dt.to_rfc3339()),
        }
    }
}

/// Workflow with its associated tasks
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowWithTasks {
    /// The workflow itself
    pub workflow: Workflow,
    /// Tasks associated with this workflow
    pub tasks: Vec<TaskSummary>,
}

/// Workflow with its associated tasks including full details and relations
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowWithTaskDetails {
    /// The workflow itself
    pub workflow: Workflow,
    /// Tasks associated with this workflow with full details and relations
    pub tasks: Vec<TaskWithRelations>,
}

// ============================================================================
// Execution Types
// ============================================================================

/// Execution status - mirrors db::ExecutionStatus
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    InProgress,
    Completed,
    Failed,
}

impl From<vertebrae_db::ExecutionStatus> for ExecutionStatus {
    fn from(status: vertebrae_db::ExecutionStatus) -> Self {
        match status {
            vertebrae_db::ExecutionStatus::InProgress => ExecutionStatus::InProgress,
            vertebrae_db::ExecutionStatus::Completed => ExecutionStatus::Completed,
            vertebrae_db::ExecutionStatus::Failed => ExecutionStatus::Failed,
        }
    }
}

/// Step execution record - mirrors db::StepExecution
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct StepExecution {
    /// Execution ID (string form)
    pub id: Option<String>,
    /// Task ID this execution belongs to
    pub task_id: String,
    /// Workflow ID being executed
    pub workflow_id: String,
    /// Name of the step being executed
    pub step_name: String,
    /// When this step execution started (ISO 8601 string)
    pub started_at: String,
    /// When this step execution completed (ISO 8601 string)
    pub completed_at: Option<String>,
    /// Current status of this step execution
    pub status: ExecutionStatus,
}

impl From<vertebrae_db::StepExecution> for StepExecution {
    fn from(exec: vertebrae_db::StepExecution) -> Self {
        StepExecution {
            id: exec.id.map(|t| t.id.to_raw()),
            task_id: exec.task_id.id.to_raw(),
            workflow_id: exec.workflow_id.id.to_raw(),
            step_name: exec.step_name,
            started_at: exec.started_at.to_rfc3339(),
            completed_at: exec.completed_at.map(|dt| dt.to_rfc3339()),
            status: exec.status.into(),
        }
    }
}

/// Session log entry - mirrors db::SessionLog
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SessionLog {
    /// Log ID (string form)
    pub id: Option<String>,
    /// Step execution ID this log belongs to
    pub step_execution_id: String,
    /// The log content
    pub content: String,
    /// When this log was created (ISO 8601 string)
    pub created_at: String,
}

impl From<vertebrae_db::SessionLog> for SessionLog {
    fn from(log: vertebrae_db::SessionLog) -> Self {
        SessionLog {
            id: log.id.map(|t| t.id.to_raw()),
            step_execution_id: log.step_execution_id.id.to_raw(),
            content: log.content,
            created_at: log.created_at.to_rfc3339(),
        }
    }
}
