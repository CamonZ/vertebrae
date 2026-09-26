//! Frontend-friendly data transfer types for Tauri commands
//!
//! These types are designed for serialization to TypeScript and don't include
//! database-specific types like SurrealDB's Thing or chrono's DateTime.

use serde::{Deserialize, Serialize};

pub mod daemon;
pub use daemon::*;

/// Current Sacrum settings state for GUI onboarding.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SacrumConfigStatus {
    /// Shared config.toml path, when the platform exposes a config directory.
    pub config_path: Option<String>,
    /// Whether config.toml exists on disk.
    pub config_exists: bool,
    /// Sacrum URL used by GUI onboarding.
    pub url: String,
    /// Whether a non-empty API token is configured.
    pub has_token: bool,
}

/// Result returned after GUI-native project initialization.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct InitializeProjectResult {
    /// Project slug registered in config.toml.
    pub slug: String,
    /// Sacrum project ID.
    pub project_id: String,
    /// Display name used for the Sacrum project.
    pub project_name: String,
    /// Canonical local project path.
    pub path: String,
    /// Whether this call created the project on Sacrum.
    pub project_created: bool,
}

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

/// Versioned provenance carried by an artifact attachment projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ArtifactLinkMetadata {
    pub version: u32,
    pub content_kind: String,
    pub format: String,
    pub origin: String,
    pub presentation: String,
    pub extensions: serde_json::Value,
}

impl From<vertebrae_core::ArtifactLinkMetadata> for ArtifactLinkMetadata {
    fn from(metadata: vertebrae_core::ArtifactLinkMetadata) -> Self {
        Self {
            version: metadata.version,
            content_kind: metadata.content_kind,
            format: metadata.format,
            origin: metadata.origin,
            presentation: metadata.presentation,
            extensions: serde_json::Value::Object(metadata.extensions),
        }
    }
}

/// A file projection returned from the project artifact list or Task.artifacts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Artifact {
    pub id: String,
    pub project_id: Option<String>,
    pub filename: String,
    pub body: String,
    pub logical_name: Option<String>,
    pub metadata: Option<ArtifactLinkMetadata>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

impl From<vertebrae_core::Artifact> for Artifact {
    fn from(artifact: vertebrae_core::Artifact) -> Self {
        Self {
            id: artifact.id,
            project_id: artifact.project_id,
            filename: artifact.filename,
            body: artifact.body,
            logical_name: artifact.logical_name,
            metadata: artifact.metadata.map(Into::into),
            created_at: artifact.created_at.map(|dt| dt.to_rfc3339()),
            updated_at: artifact.updated_at.map(|dt| dt.to_rfc3339()),
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
    /// Current step type (if task has a current step in workflow)
    pub step_type: Option<StepType>,
    /// Server-derived TaskRun controls for Run/Stop surfaces
    #[serde(default)]
    pub run_controls: Option<TaskRunControls>,
    /// Whether this task is archived
    #[serde(default)]
    pub archived: bool,
    /// Optional worktree path
    pub worktree: Option<String>,
    /// Reason why the task was rejected
    pub rejection_reason: Option<String>,
    /// Parent task ID (if any)
    pub parent_id: Option<String>,
    /// IDs of tasks this task depends on
    #[serde(default)]
    pub dependency_ids: Vec<String>,
    /// IDs of tasks that depend on this task (populated by get_task)
    #[serde(default)]
    pub dependent_ids: Vec<String>,
    /// IDs of child tasks (populated by get_task)
    #[serde(default)]
    pub child_ids: Vec<String>,
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
        let dependent_ids = task.dependents.iter().map(|task| task.id.clone()).collect();
        let child_ids = task.children.iter().map(|task| task.id.clone()).collect();

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
            step_type: task.step_type.map(Into::into),
            run_controls: task.run_controls.map(Into::into),
            archived: task.archived,
            worktree: task.worktree,
            rejection_reason: task.rejection_reason,
            parent_id: task.parent_id,
            dependency_ids: task.dependency_ids,
            dependent_ids,
            child_ids,
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
    /// Whether the task is archived
    pub archived: Option<bool>,
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
    Auto,
    BypassPermissions,
    Default,
    DontAsk,
    Plan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Anthropic,
    Openai,
    Typesafe,
}

impl PermissionMode {
    pub fn as_claude_arg(&self) -> &'static str {
        match self {
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Auto => "auto",
            PermissionMode::BypassPermissions => "bypassPermissions",
            PermissionMode::Default => "manual",
            PermissionMode::DontAsk => "dontAsk",
            PermissionMode::Plan => "plan",
        }
    }
}

impl From<vertebrae_core::PermissionMode> for PermissionMode {
    fn from(mode: vertebrae_core::PermissionMode) -> Self {
        match mode {
            vertebrae_core::PermissionMode::AcceptEdits => PermissionMode::AcceptEdits,
            vertebrae_core::PermissionMode::Auto => PermissionMode::Auto,
            vertebrae_core::PermissionMode::BypassPermissions => PermissionMode::BypassPermissions,
            vertebrae_core::PermissionMode::Default => PermissionMode::Default,
            vertebrae_core::PermissionMode::DontAsk => PermissionMode::DontAsk,
            vertebrae_core::PermissionMode::Plan => PermissionMode::Plan,
        }
    }
}

impl From<PermissionMode> for vertebrae_core::PermissionMode {
    fn from(mode: PermissionMode) -> Self {
        match mode {
            PermissionMode::AcceptEdits => vertebrae_core::PermissionMode::AcceptEdits,
            PermissionMode::Auto => vertebrae_core::PermissionMode::Auto,
            PermissionMode::BypassPermissions => vertebrae_core::PermissionMode::BypassPermissions,
            PermissionMode::Default => vertebrae_core::PermissionMode::Default,
            PermissionMode::DontAsk => vertebrae_core::PermissionMode::DontAsk,
            PermissionMode::Plan => vertebrae_core::PermissionMode::Plan,
        }
    }
}

/// Agent configuration for workflow steps - mirrors db::AgentConfig
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct AgentConfig {
    #[serde(default)]
    pub provider: Option<AgentProvider>,
    /// Model for the current session
    pub model: Option<String>,
    /// Codex upstream model provider configured in ~/.codex/config.toml
    pub codex_model_provider: Option<String>,
    /// Fallback model when default model is overloaded
    pub fallback_model: Option<String>,
    /// OpenAI/Codex reasoning effort for the configured model
    pub reasoning_effort: Option<String>,
    /// Provider serving speed preference.
    pub speed_tier: Option<String>,
    /// Provider style identifier.
    pub personality: Option<String>,
    /// Provider output detail level.
    pub verbosity: Option<String>,
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
            provider: config.provider.map(|provider| match provider {
                vertebrae_core::Provider::Anthropic => AgentProvider::Anthropic,
                vertebrae_core::Provider::Openai => AgentProvider::Openai,
                vertebrae_core::Provider::Typesafe => AgentProvider::Typesafe,
            }),
            model: config.model,
            codex_model_provider: config.codex_model_provider,
            fallback_model: config.fallback_model,
            reasoning_effort: config.reasoning_effort,
            speed_tier: config.speed_tier.map(|value| value.as_str().into()),
            personality: config.personality,
            verbosity: config.verbosity.map(|value| value.as_str().into()),
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

impl From<AgentConfig> for vertebrae_core::AgentConfig {
    fn from(config: AgentConfig) -> Self {
        vertebrae_core::AgentConfig {
            provider: config.provider.map(|provider| match provider {
                AgentProvider::Anthropic => vertebrae_core::Provider::Anthropic,
                AgentProvider::Openai => vertebrae_core::Provider::Openai,
                AgentProvider::Typesafe => vertebrae_core::Provider::Typesafe,
            }),
            model: config.model,
            codex_model_provider: config.codex_model_provider,
            fallback_model: config.fallback_model,
            reasoning_effort: config.reasoning_effort,
            speed_tier: config
                .speed_tier
                .as_deref()
                .and_then(vertebrae_core::SpeedTier::parse),
            personality: config
                .personality
                .map(|value| value.trim().to_ascii_lowercase()),
            verbosity: config
                .verbosity
                .as_deref()
                .and_then(vertebrae_core::OutputVerbosity::parse),
            system_prompt: config.system_prompt,
            append_system_prompt: config.append_system_prompt,
            agents: config.agents.map(|value| {
                serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value))
            }),
            tools: config.tools,
            allowed_tools: config.allowed_tools,
            disallowed_tools: config.disallowed_tools,
            permission_mode: config.permission_mode.map(Into::into),
            max_budget_usd: config.max_budget_usd,
            mcp_config: config.mcp_config,
            plugin_dirs: config.plugin_dirs,
            json_schema: config.json_schema.map(|value| {
                serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value))
            }),
        }
    }
}

/// Step type - mirrors core::StepType
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum StepType {
    #[default]
    LlmInference,
    StructuredInference,
    Route,
    WaitChildren,
    HumanInput,
    Stop,
    Finish,
    Unsupported(String),
}

impl From<vertebrae_core::StepType> for StepType {
    fn from(st: vertebrae_core::StepType) -> Self {
        match st {
            vertebrae_core::StepType::LlmInference => StepType::LlmInference,
            vertebrae_core::StepType::StructuredInference => StepType::StructuredInference,
            vertebrae_core::StepType::Route => StepType::Route,
            vertebrae_core::StepType::WaitChildren => StepType::WaitChildren,
            vertebrae_core::StepType::HumanInput => StepType::HumanInput,
            vertebrae_core::StepType::Stop => StepType::Stop,
            vertebrae_core::StepType::Finish => StepType::Finish,
            vertebrae_core::StepType::Unsupported(value) => StepType::Unsupported(value),
        }
    }
}

impl From<StepType> for vertebrae_core::StepType {
    fn from(st: StepType) -> Self {
        match st {
            StepType::LlmInference => vertebrae_core::StepType::LlmInference,
            StepType::StructuredInference => vertebrae_core::StepType::StructuredInference,
            StepType::Route => vertebrae_core::StepType::Route,
            StepType::WaitChildren => vertebrae_core::StepType::WaitChildren,
            StepType::HumanInput => vertebrae_core::StepType::HumanInput,
            StepType::Stop => vertebrae_core::StepType::Stop,
            StepType::Finish => vertebrae_core::StepType::Finish,
            StepType::Unsupported(value) => vertebrae_core::StepType::Unsupported(value),
        }
    }
}

/// Config of an `llm_inference` step.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct LlmInferenceStepConfig {
    pub version: i32,
    /// Prompt sent to the agent when executing this step
    pub prompt: Option<String>,
    /// JSON Schema describing the expected output of this step
    pub output_schema: Option<serde_json::Value>,
    /// Paths to .claude/agents/ files for this step
    pub agents: Vec<String>,
    /// Skill names available for this step
    pub skills: Vec<String>,
    /// Agent configuration for this step
    pub agent_config: AgentConfig,
}

/// Config of a `structured_inference` step.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StructuredInferenceStepConfig {
    pub version: i32,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// Input sent to the provider (string, object, or array; may hold
    /// `{{ dotted.path }}` references)
    pub state: Option<serde_json::Value>,
    /// System One question map the step asks the provider.
    pub questions: Option<serde_json::Value>,
}

/// Config of a `route` step.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct RouteStepConfig {
    pub version: i32,
    /// Opaque deterministic route configuration
    pub route_config: Option<serde_json::Value>,
}

/// Config of a `wait_children` step.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct WaitChildrenStepConfig {
    pub version: i32,
    /// JSON Schema describing the expected output of this step
    pub output_schema: Option<serde_json::Value>,
}

/// A step's `step_type`-specific configuration, serialized as the bare
/// config object. Narrow it with the owning step's `step_type`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(untagged)]
pub enum StepConfig {
    LlmInference(Box<LlmInferenceStepConfig>),
    StructuredInference(StructuredInferenceStepConfig),
    Route(RouteStepConfig),
    WaitChildren(WaitChildrenStepConfig),
}

impl From<vertebrae_core::StepConfig> for StepConfig {
    fn from(config: vertebrae_core::StepConfig) -> Self {
        match config {
            vertebrae_core::StepConfig::LlmInference(config) => {
                StepConfig::LlmInference(Box::new(LlmInferenceStepConfig {
                    version: config.version,
                    prompt: config.prompt,
                    output_schema: config.output_schema,
                    agents: config.agents,
                    skills: config.skills,
                    agent_config: config.agent_config.into(),
                }))
            }
            vertebrae_core::StepConfig::StructuredInference(config) => {
                StepConfig::StructuredInference(StructuredInferenceStepConfig {
                    version: config.version,
                    provider: config.provider,
                    model: config.model,
                    state: config.state,
                    questions: config.questions,
                })
            }
            vertebrae_core::StepConfig::Route(config) => StepConfig::Route(RouteStepConfig {
                version: config.version,
                route_config: config.route_config,
            }),
            vertebrae_core::StepConfig::WaitChildren(config) => {
                StepConfig::WaitChildren(WaitChildrenStepConfig {
                    version: config.version,
                    output_schema: config.output_schema,
                })
            }
        }
    }
}

/// Workflow step entity - mirrors core::Step
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Step {
    /// Step ID (string form)
    pub id: Option<String>,
    /// Display name for this step
    pub name: String,
    /// Reference to the workflow this step belongs to
    pub workflow_id: String,
    /// What this step should accomplish
    pub goal: Option<String>,
    /// Step type mirrored from core::StepType; fixed once the step exists.
    pub step_type: StepType,
    /// `step_type`-specific configuration; null for human_input, stop, and
    /// finish steps.
    pub config: Option<StepConfig>,
    /// Orchestrator-owned persistence configuration for this step
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistence_options: Option<serde_json::Value>,
    /// List of step IDs this step can transition to
    pub transitions_to: Vec<String>,
    /// Ordering index for sequential fallback (0-based, Sacrum: `step_order`).
    pub order: i32,
    /// Creation timestamp (ISO 8601 string)
    pub created_at: Option<String>,
    /// Last update timestamp (ISO 8601 string)
    pub updated_at: Option<String>,
}

/// Wire shape of a step in Sacrum channel payloads and GUI events.
#[derive(Deserialize)]
struct StepWire {
    id: Option<String>,
    name: String,
    workflow_id: String,
    #[serde(default)]
    goal: Option<String>,
    #[serde(default)]
    step_type: vertebrae_core::StepType,
    #[serde(default)]
    config: serde_json::Value,
    #[serde(default)]
    persistence_options: Option<serde_json::Value>,
    #[serde(default)]
    transitions_to: Vec<String>,
    #[serde(default, alias = "step_order")]
    order: i32,
    #[serde(default, alias = "inserted_at")]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

impl<'de> Deserialize<'de> for Step {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = StepWire::deserialize(deserializer)?;
        // The step type discriminates the config variant.
        let config = vertebrae_core::StepConfig::from_value(&wire.step_type, wire.config)
            .map_err(serde::de::Error::custom)?;
        Ok(Step {
            id: wire.id,
            name: wire.name,
            workflow_id: wire.workflow_id,
            goal: wire.goal,
            step_type: wire.step_type.into(),
            config: config.map(Into::into),
            persistence_options: wire.persistence_options,
            transitions_to: wire.transitions_to,
            order: wire.order,
            created_at: wire.created_at,
            updated_at: wire.updated_at,
        })
    }
}

impl From<vertebrae_core::Step> for Step {
    fn from(step: vertebrae_core::Step) -> Self {
        Step {
            id: step.id,
            name: step.name,
            workflow_id: step.workflow_id,
            goal: step.goal,
            step_type: step.step_type.into(),
            config: step.config.map(Into::into),
            persistence_options: step.persistence_options,
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
    /// Optional factory name used to group related workflows
    pub factory_name: Option<String>,
    /// Whether this is the default workflow for new tasks
    #[serde(default)]
    pub is_default: bool,
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
            factory_name: workflow.factory_name,
            is_default: workflow.is_default,
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
    pub order: Option<i32>,
    pub is_default: Option<bool>,
    pub kanban_column: Option<String>,
    pub factory_name: Option<String>,
    pub clear_factory_name: bool,
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
        if let Some(order) = opts.order {
            update = update.with_order(order);
        }
        if let Some(is_default) = opts.is_default {
            update = update.with_is_default(is_default);
        }
        if let Some(kanban_column) = opts.kanban_column {
            update = update.with_kanban_column(kanban_column);
        }
        if let Some(factory_name) = opts.factory_name {
            update = update.with_factory_name(factory_name);
        } else if opts.clear_factory_name {
            update = update.clear_factory_name();
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
    /// Effective maximum concurrent step attempts for the root TaskRun tree
    pub max_concurrency: Option<i32>,
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
    /// Ancestor TaskRun ID recorded by Sacrum, when this run belongs to a run tree
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
            max_concurrency: run.max_concurrency,
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

/// Trace data scoped to a single TaskRun.
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
    #[serde(
        alias = "started",
        alias = "running",
        alias = "waiting",
        alias = "cancelled"
    )]
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
/// Carries the full sacrum field set so the traces UI can render the rendered
/// config, output, context, transition_result, model/provider, token usage,
/// cost, duration, handoff, and session_id. All extended fields are
/// `Option`-typed because historical executions and minimal payloads may not
/// populate them. `config` is decoded by `step_type` when deserializing; the
/// `serde(default)` attributes only keep these fields optional in bindings.
#[derive(Debug, Clone, Serialize, specta::Type)]
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
    /// Semantic workflow step type, when provided by Sacrum
    #[serde(default)]
    pub step_type: Option<String>,
    /// When this step execution started (ISO 8601 string)
    #[serde(default)]
    pub started_at: String,
    /// When this step execution completed (ISO 8601 string)
    pub completed_at: Option<String>,
    /// Current status of this step execution
    #[serde(default = "StepExecution::default_status")]
    pub status: ExecutionStatus,
    /// Step config the execution ran with, templates rendered (rendered
    /// prompt for llm_inference, resolved state for structured_inference);
    /// null for human_input, stop, and finish. Narrow it with `step_type`.
    #[serde(default)]
    pub config: Option<StepConfig>,
    /// Final output of the execution
    #[serde(default)]
    pub output: Option<String>,
    /// Execution context (arbitrary JSON serialized as string)
    #[serde(default)]
    pub context: Option<String>,
    /// Transition decision payload (route steps)
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
    /// Cache-read ("cache hit") input tokens. Session-cumulative figure from
    /// Sacrum; aggregate per run by taking the latest execution's value.
    #[serde(default)]
    pub cache_read_tokens: Option<u32>,
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

/// Wire shape of a step execution in Sacrum channel payloads; `config` stays
/// raw JSON until `step_type` selects its variant.
#[derive(Deserialize)]
struct StepExecutionWire {
    id: Option<String>,
    #[serde(default)]
    task_id: String,
    #[serde(default)]
    task_run_id: Option<String>,
    #[serde(default)]
    workflow_id: String,
    #[serde(default)]
    step_name: String,
    #[serde(default)]
    step_type: Option<String>,
    #[serde(default)]
    started_at: String,
    completed_at: Option<String>,
    #[serde(default = "StepExecution::default_status")]
    status: ExecutionStatus,
    #[serde(default)]
    config: serde_json::Value,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    transition_result: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    model_provider: Option<String>,
    #[serde(default)]
    input_tokens: Option<u32>,
    #[serde(default)]
    output_tokens: Option<u32>,
    #[serde(default)]
    cache_read_tokens: Option<u32>,
    #[serde(default)]
    cost: Option<String>,
    #[serde(default)]
    duration_ms: Option<u32>,
    #[serde(default)]
    handoff: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

impl StepExecution {
    fn default_status() -> ExecutionStatus {
        ExecutionStatus::InProgress
    }
}

impl<'de> Deserialize<'de> for StepExecution {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = StepExecutionWire::deserialize(deserializer)?;
        let step_type =
            vertebrae_core::StepType::from_wire_str(wire.step_type.as_deref().unwrap_or_default());
        let config = vertebrae_core::StepConfig::from_value(&step_type, wire.config)
            .map_err(serde::de::Error::custom)?;
        Ok(StepExecution {
            id: wire.id,
            task_id: wire.task_id,
            task_run_id: wire.task_run_id,
            workflow_id: wire.workflow_id,
            step_name: wire.step_name,
            step_type: wire.step_type,
            started_at: wire.started_at,
            completed_at: wire.completed_at,
            status: wire.status,
            config: config.map(Into::into),
            output: wire.output,
            context: wire.context,
            transition_result: wire.transition_result,
            model: wire.model,
            model_provider: wire.model_provider,
            input_tokens: wire.input_tokens,
            output_tokens: wire.output_tokens,
            cache_read_tokens: wire.cache_read_tokens,
            cost: wire.cost,
            duration_ms: wire.duration_ms,
            handoff: wire.handoff,
            session_id: wire.session_id,
        })
    }
}

fn saturating_u64_to_u32(v: u64) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

impl From<vertebrae_core::StepExecution> for StepExecution {
    fn from(exec: vertebrae_core::StepExecution) -> Self {
        let (input_tokens, output_tokens, cache_read_tokens) = match exec.token_usage.as_ref() {
            Some(tu) => (
                Some(saturating_u64_to_u32(tu.input_tokens)),
                Some(saturating_u64_to_u32(tu.output_tokens)),
                tu.cache_read_input_tokens.map(saturating_u64_to_u32),
            ),
            None => (None, None, None),
        };
        StepExecution {
            id: exec.id,
            task_id: exec.task_id,
            task_run_id: exec.task_run_id,
            workflow_id: exec.workflow_id,
            step_name: exec.step_name,
            step_type: exec.step_type,
            started_at: exec.started_at.to_rfc3339(),
            completed_at: exec.completed_at.map(|dt| dt.to_rfc3339()),
            status: exec.status.into(),
            config: exec.config.map(Into::into),
            output: exec.output,
            context: exec.context,
            transition_result: exec.transition_result,
            model: exec.model_used,
            model_provider: exec.model_provider,
            input_tokens,
            output_tokens,
            cache_read_tokens,
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
    /// Stable key for ephemeral logs that replace earlier snapshots
    #[serde(default)]
    pub logical_key: Option<String>,
    /// Step execution ID this log belongs to
    #[serde(default)]
    pub step_execution_id: String,
    /// The log content
    #[serde(default)]
    pub content: String,
    /// Producer format used to select the compatible frontend parser.
    #[serde(default)]
    pub format: Option<String>,
    /// When this log was created (ISO 8601 string)
    #[serde(alias = "inserted_at", default)]
    pub created_at: String,
}

impl From<vertebrae_core::SessionLog> for SessionLog {
    fn from(log: vertebrae_core::SessionLog) -> Self {
        SessionLog {
            id: log.id,
            logical_key: log.logical_key,
            step_execution_id: log.step_execution_id,
            content: log.content,
            format: log.format,
            created_at: log.created_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecisionBehavior {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ResolvePermissionRequestInput {
    pub request_id: String,
    pub behavior: PermissionDecisionBehavior,
    pub message: Option<String>,
    pub updated_input: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolvePermissionRequestErrorKind {
    Unavailable,
    NotFound,
    Invalid,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
pub struct ResolvePermissionRequestError {
    pub kind: ResolvePermissionRequestErrorKind,
    pub message: String,
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
    pub factory_name: Option<String>,
    pub is_default: bool,
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
            factory_name: wf.factory_name,
            is_default: wf.is_default.unwrap_or(false),
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
    pub order: i32,
    pub transitions_to: Vec<String>,
    #[serde(default)]
    pub step_type: StepType,
    /// Config fields declared by `step_type` (snake_case keys; `agent_config`
    /// uses the GUI `AgentConfig` shape). Omitted fields take the type's
    /// defaults; must be null for human_input, stop, and finish steps.
    #[serde(default)]
    pub config: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub persistence_options: Option<serde_json::Value>,
}

/// Convert a patch's GUI-shaped `agent_config` (JSON-string `agents` and
/// `json_schema`) into the core shape Sacrum stores.
fn core_config_patch(
    mut patch: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    if let Some(agent_config) = patch.get_mut("agent_config") {
        if let Ok(gui) = serde_json::from_value::<AgentConfig>(agent_config.clone()) {
            let core: vertebrae_core::AgentConfig = gui.into();
            if let Ok(value) = serde_json::to_value(core) {
                *agent_config = value;
            }
        }
    }
    patch
}

impl CreateStepOptions {
    /// Build the core step, rejecting config fields the type does not declare.
    pub fn into_step(self) -> Result<vertebrae_core::Step, vertebrae_core::ServiceError> {
        let step_type: vertebrae_core::StepType = self.step_type.into();
        let mut step = vertebrae_core::Step::new(&self.name, self.workflow_id)
            .with_step_type(step_type)
            .with_order(self.order)
            .with_transitions_to(
                self.transitions_to
                    .iter()
                    .map(|id| id.to_lowercase())
                    .collect(),
            );
        if let Some(goal) = self.goal {
            step = step.with_goal(&goal);
        }
        if let Some(options) = self.persistence_options {
            step = step.with_persistence_options(options);
        }
        if let Some(config) = self.config {
            vertebrae_core::apply_config_patch(&mut step, &core_config_patch(config))?;
        }
        Ok(step)
    }
}

/// Options for updating a workflow step. A step's type cannot change.
/// Only fields that are Some will be updated. `config` is a partial patch:
/// only its keys are written, and a null value clears that field.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UpdateStepOptions {
    pub step_id: String,
    pub name: Option<String>,
    pub goal: Option<String>,
    #[serde(default)]
    pub config: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub persistence_options: Option<serde_json::Value>,
    #[serde(default)]
    pub clear_persistence_options: bool,
    pub order: Option<i32>,
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
        update.config = opts.config.map(core_config_patch);
        if let Some(order) = opts.order {
            update = update.with_order(order);
        }
        if opts.clear_persistence_options {
            update = update.with_persistence_options(None);
        } else if let Some(persistence_options) = opts.persistence_options {
            update = update.with_persistence_options(Some(persistence_options));
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

    #[test]
    fn task_from_core_exposes_relation_ids_without_nested_payloads() {
        let mut core = vertebrae_core::Task::new("Task", vertebrae_core::Level::Task);
        let mut dependent = vertebrae_core::Task::new("Dependent", vertebrae_core::Level::Task);
        dependent.id = "dependent-id".to_string();
        core.dependents.push(dependent);
        let mut child = vertebrae_core::Task::new("Child", vertebrae_core::Level::Task);
        child.id = "child-id".to_string();
        core.children.push(child);

        let gui = Task::from(core);

        assert_eq!(gui.dependent_ids, vec!["dependent-id"]);
        assert_eq!(gui.child_ids, vec!["child-id"]);
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
            PermissionMode::from(vertebrae_core::PermissionMode::Auto),
            PermissionMode::Auto
        );
        assert_eq!(
            PermissionMode::from(vertebrae_core::PermissionMode::BypassPermissions),
            PermissionMode::BypassPermissions
        );
        assert_eq!(
            PermissionMode::from(vertebrae_core::PermissionMode::Default),
            PermissionMode::Default
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
    fn agent_config_from_core_with_reasoning_effort() {
        let core = vertebrae_core::AgentConfig::new()
            .with_model("gpt-5.5")
            .with_reasoning_effort("medium");
        let gui = AgentConfig::from(core);
        assert_eq!(gui.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(gui.reasoning_effort.as_deref(), Some("medium"));
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
        assert_eq!(gui.step_type, StepType::LlmInference);
        let Some(StepConfig::LlmInference(config)) = gui.config else {
            panic!("expected llm_inference config");
        };
        assert_eq!(config.prompt, None);
        assert!(config.agents.is_empty());
        assert!(config.skills.is_empty());
        assert!(gui.transitions_to.is_empty());
        assert_eq!(gui.order, 0);
    }

    #[test]
    fn step_updated_payload_keeps_structured_inference_settings() {
        let payload = serde_json::json!({
            "id": "step-si",
            "name": "Classify",
            "workflow_id": "wf-1",
            "step_type": "structured_inference",
            "config": {
                "__type__": "structured_inference",
                "version": 1,
                "provider": "typesafe",
                "model": "jev",
                "state": {"title": "{{ task.title }}"},
                "questions": {"ok": {"type": "noul", "instructions": "ok?", "criteria": {"true": "yes", "false": "no"}}}
            }
        });
        let step: Step = serde_json::from_value(payload).unwrap();
        assert_eq!(step.step_type, StepType::StructuredInference);
        let Some(StepConfig::StructuredInference(config)) = &step.config else {
            panic!("expected structured_inference config");
        };
        assert_eq!(config.provider.as_deref(), Some("typesafe"));
        assert_eq!(config.model.as_deref(), Some("jev"));
        assert_eq!(
            config.state,
            Some(serde_json::json!({"title": "{{ task.title }}"}))
        );
        assert_eq!(
            config.questions,
            Some(serde_json::json!({
                "ok": {"type": "noul", "instructions": "ok?", "criteria": {"true": "yes", "false": "no"}}
            }))
        );

        let json = serde_json::to_value(&step).unwrap();
        assert_eq!(json["step_type"], "structured_inference");
        assert_eq!(json["config"]["provider"], "typesafe");
    }

    #[test]
    fn step_deserializes_channel_payload_config_by_step_type() {
        let step: Step = serde_json::from_value(serde_json::json!({
            "id": "step-1",
            "name": "Wait",
            "workflow_id": "wf-1",
            "step_type": "wait_children",
            "config": {"__type__": "wait_children", "version": 1, "output_schema": {"type": "object"}},
            "step_order": 3,
            "inserted_at": "2026-01-01T00:00:00Z"
        }))
        .unwrap();
        assert_eq!(step.step_type, StepType::WaitChildren);
        assert_eq!(step.order, 3);
        let Some(StepConfig::WaitChildren(config)) = step.config else {
            panic!("expected wait_children config");
        };
        assert_eq!(
            config.output_schema,
            Some(serde_json::json!({"type": "object"}))
        );

        let step: Step = serde_json::from_value(serde_json::json!({
            "id": "step-2",
            "name": "Implement",
            "workflow_id": "wf-1",
            "step_type": "llm_inference",
            "config": {
                "version": 1,
                "prompt": "Do it",
                "agents": ["a"],
                "skills": null,
                "agent_config": {"model": "opus"}
            }
        }))
        .unwrap();
        let Some(StepConfig::LlmInference(config)) = step.config else {
            panic!("expected llm_inference config");
        };
        assert_eq!(config.prompt.as_deref(), Some("Do it"));
        assert_eq!(config.agents, vec!["a"]);
        assert!(config.skills.is_empty());
        assert_eq!(config.agent_config.model.as_deref(), Some("opus"));

        let step: Step = serde_json::from_value(serde_json::json!({
            "id": "step-3",
            "name": "Done",
            "workflow_id": "wf-1",
            "step_type": "finish",
            "config": null
        }))
        .unwrap();
        assert!(step.config.is_none());
    }

    #[test]
    fn create_step_options_reject_undeclared_config_fields() {
        let options = |step_type: StepType, config: serde_json::Value| CreateStepOptions {
            workflow_id: "wf-1".to_string(),
            name: "Step".to_string(),
            goal: None,
            order: 0,
            transitions_to: vec![],
            step_type,
            config: config.as_object().cloned(),
            persistence_options: None,
        };

        let step = options(
            StepType::Route,
            serde_json::json!({"route_config": {"version": 1}}),
        )
        .into_step()
        .unwrap();
        assert_eq!(
            step.route_config(),
            Some(&serde_json::json!({"version": 1}))
        );

        let error = options(StepType::Route, serde_json::json!({"prompt": "x"}))
            .into_step()
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("$.prompt: is not supported for route steps"));

        let error = options(StepType::Finish, serde_json::json!({"prompt": "x"}))
            .into_step()
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("config: must be null for finish steps"));
    }

    #[test]
    fn update_step_options_convert_gui_agent_config() {
        let update: vertebrae_core::StepUpdate = UpdateStepOptions {
            step_id: "step-1".to_string(),
            name: None,
            goal: None,
            config: serde_json::json!({
                "agent_config": {"model": "opus", "json_schema": "{\"type\":\"object\"}"}
            })
            .as_object()
            .cloned(),
            persistence_options: None,
            clear_persistence_options: false,
            order: None,
            transitions_to: None,
        }
        .into();
        assert_eq!(
            update.config.unwrap()["agent_config"],
            serde_json::json!({"model": "opus", "json_schema": {"type": "object"}})
        );
    }

    #[test]
    fn update_step_options_forward_the_config_patch() {
        let update: vertebrae_core::StepUpdate = UpdateStepOptions {
            step_id: "step-1".to_string(),
            name: None,
            goal: None,
            config: serde_json::json!({"prompt": null, "skills": ["s"]})
                .as_object()
                .cloned(),
            persistence_options: None,
            clear_persistence_options: false,
            order: None,
            transitions_to: None,
        }
        .into();
        assert_eq!(
            serde_json::Value::Object(update.config.unwrap()),
            serde_json::json!({"prompt": null, "skills": ["s"]})
        );
    }

    #[test]
    fn step_type_finish_round_trips_between_core_and_gui() {
        let gui = StepType::from(vertebrae_core::StepType::Finish);
        assert_eq!(gui, StepType::Finish);
        assert_eq!(
            vertebrae_core::StepType::from(gui),
            vertebrae_core::StepType::Finish
        );
        assert_eq!(
            serde_json::to_string(&StepType::Finish).unwrap(),
            "\"finish\""
        );
    }

    #[test]
    fn step_type_stop_round_trips_between_core_and_gui() {
        let gui = StepType::from(vertebrae_core::StepType::Stop);
        assert_eq!(gui, StepType::Stop);
        assert_eq!(
            vertebrae_core::StepType::from(gui),
            vertebrae_core::StepType::Stop
        );
        assert_eq!(serde_json::to_string(&StepType::Stop).unwrap(), "\"stop\"");
    }

    #[test]
    fn agent_config_round_trips_provider_and_json_fields() {
        let gui = AgentConfig {
            provider: Some(AgentProvider::Openai),
            model: Some("gpt-5.5".to_string()),
            agents: Some(r#"{"reviewer":"strict"}"#.to_string()),
            json_schema: Some(r#"{"type":"object"}"#.to_string()),
            ..Default::default()
        };
        let core: vertebrae_core::AgentConfig = gui.clone().into();
        assert_eq!(core.provider, Some(vertebrae_core::Provider::Openai));
        assert_eq!(core.agents, Some(serde_json::json!({"reviewer": "strict"})));
        assert_eq!(
            core.json_schema,
            Some(serde_json::json!({"type": "object"}))
        );

        let round_tripped = AgentConfig::from(core);
        assert_eq!(round_tripped.provider, gui.provider);
        assert_eq!(round_tripped.agents, gui.agents);
        assert_eq!(round_tripped.json_schema, gui.json_schema);
    }

    #[test]
    fn update_step_options_sets_and_clears_persistence_options() {
        let options = |persistence_options, clear_persistence_options| UpdateStepOptions {
            step_id: "step".to_string(),
            name: None,
            goal: None,
            config: None,
            persistence_options,
            clear_persistence_options,
            order: None,
            transitions_to: None,
        };

        let configured: vertebrae_core::StepUpdate = options(
            Some(serde_json::json!({ "artifact": { "logical_name": "result" } })),
            false,
        )
        .into();
        assert_eq!(
            configured.persistence_options,
            Some(Some(serde_json::json!({
                "artifact": { "logical_name": "result" }
            })))
        );
        assert!(configured.config.is_none());

        let cleared: vertebrae_core::StepUpdate = options(None, true).into();
        assert_eq!(cleared.persistence_options, Some(None));
    }

    #[test]
    fn step_from_core_with_config() {
        let core = vertebrae_core::Step::new("review", "wf1")
            .with_goal("Review code")
            .with_prompt("Review the PR")
            .with_agent("claude")
            .with_skill("code-review")
            .with_order(5);
        let gui = Step::from(core);
        assert_eq!(gui.name, "review");
        assert_eq!(gui.goal, Some("Review code".to_string()));
        assert_eq!(gui.order, 5);
        let Some(StepConfig::LlmInference(config)) = gui.config else {
            panic!("expected llm_inference config");
        };
        assert_eq!(config.prompt, Some("Review the PR".to_string()));
        assert_eq!(config.agents, vec!["claude"]);
        assert_eq!(config.skills, vec!["code-review"]);
    }

    #[test]
    fn step_from_core_serializes_route_config_only() {
        let route_config = serde_json::json!({
            "version": 1,
            "rules": [{"future": {"nested": ["value", true, null]}}]
        });
        let core = vertebrae_core::Step::new("router", "wf1")
            .with_step_type(vertebrae_core::StepType::Route)
            .with_route_config(route_config.clone());

        let gui = Step::from(core);

        assert_eq!(gui.step_type, StepType::Route);
        assert_eq!(
            serde_json::to_value(&gui).unwrap()["config"],
            serde_json::json!({"version": 1, "route_config": route_config})
        );
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
        assert_eq!(gui.step_type, None);
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
            .with_config(vertebrae_core::StepConfig::LlmInference(Box::new(
                vertebrae_core::LlmInferenceConfig {
                    prompt: Some("the prompt".to_string()),
                    ..Default::default()
                },
            )))
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
        let Some(StepConfig::LlmInference(config)) = &gui.config else {
            panic!("expected llm_inference config");
        };
        assert_eq!(config.prompt.as_deref(), Some("the prompt"));
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
            "step_type": "structured_inference",
            "config": {
                "version": 1,
                "provider": "typesafe",
                "model": "jev",
                "state": {"title": "resolved"},
                "questions": {"ok": {"type": "noul", "instructions": "ok?", "criteria": {"true": "yes", "false": "no"}}}
            },
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
        let Some(StepConfig::StructuredInference(config)) = &exec.config else {
            panic!("expected structured_inference config");
        };
        assert_eq!(config.provider.as_deref(), Some("typesafe"));
        assert_eq!(config.state, Some(serde_json::json!({"title": "resolved"})));
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
        assert_eq!(
            serde_json::to_value(&again.config).unwrap(),
            serde_json::to_value(&exec.config).unwrap()
        );
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
        assert!(exec.config.is_none());
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
        let core = vertebrae_core::SessionLog::new("exec1", "log content").with_format("harness");
        let gui = SessionLog::from(core);
        assert_eq!(gui.step_execution_id, "exec1");
        assert_eq!(gui.content, "log content");
        assert_eq!(gui.format.as_deref(), Some("harness"));
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
            "step_type": "llm_inference",
            "config": {
                "__type__": "llm_inference",
                "version": 1,
                "prompt": "Review the PR carefully",
                "output_schema": null,
                "agents": [],
                "skills": [],
                "agent_config": {}
            },
            "order": 2,
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
        let Some(StepConfig::LlmInference(config)) = &step.config else {
            panic!("expected llm_inference config");
        };
        assert_eq!(config.prompt.as_deref(), Some("Review the PR carefully"));
        assert!(config.agents.is_empty());
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
            "step_type": "human_input",
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
        assert_eq!(exec.step_type.as_deref(), Some("human_input"));
        assert_eq!(exec.status, ExecutionStatus::InProgress);
        assert_eq!(exec.started_at, "2026-03-15T10:00:00.000000Z");
        assert_eq!(exec.completed_at, None);
    }

    #[test]
    fn step_execution_deserializes_live_status_aliases() {
        for status in ["started", "running", "waiting", "cancelled"] {
            let payload = serde_json::json!({
                "id": format!("exec-{status}"),
                "status": status
            });

            let exec: StepExecution =
                serde_json::from_value(payload).expect("live status alias should deserialize");
            assert_eq!(exec.status, ExecutionStatus::InProgress);
        }
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
        assert_eq!(exec.step_type, None);
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
