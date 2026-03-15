//! Domain models for Vertebrae
//!
//! These are the canonical domain models for the Vertebrae task management system.
//! All IDs are plain strings rather than database-specific record types.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Default workflow ID for new tasks
pub const DEFAULT_WORKFLOW_ID: &str = "default";

// ─── Core Enums ────────────────────────────────────────────────────────────

/// Task hierarchy level
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Epic,
    Ticket,
    Task,
}

impl Level {
    pub fn as_str(&self) -> &'static str {
        match self {
            Level::Epic => "epic",
            Level::Ticket => "ticket",
            Level::Task => "task",
        }
    }
}

impl std::fmt::Display for Level {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Task priority level
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    Medium,
    High,
    Critical,
}

impl Priority {
    pub fn as_str(&self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
            Priority::Critical => "critical",
        }
    }
}

impl std::fmt::Display for Priority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Section type for task documentation
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

impl SectionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            SectionType::Goal => "goal",
            SectionType::Context => "context",
            SectionType::CurrentBehavior => "current_behavior",
            SectionType::DesiredBehavior => "desired_behavior",
            SectionType::ChecklistItem => "checklist_item",
            SectionType::TestingCriterion => "testing_criterion",
            SectionType::AntiPattern => "anti_pattern",
            SectionType::FailureTest => "failure_test",
            SectionType::Constraint => "constraint",
        }
    }
}

impl std::fmt::Display for SectionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl std::str::FromStr for SectionType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "goal" => Ok(SectionType::Goal),
            "context" => Ok(SectionType::Context),
            "current_behavior" => Ok(SectionType::CurrentBehavior),
            "desired_behavior" => Ok(SectionType::DesiredBehavior),
            "checklist_item" => Ok(SectionType::ChecklistItem),
            "testing_criterion" => Ok(SectionType::TestingCriterion),
            "anti_pattern" => Ok(SectionType::AntiPattern),
            "failure_test" => Ok(SectionType::FailureTest),
            "constraint" => Ok(SectionType::Constraint),
            _ => Err(format!(
                "invalid section type '{}'. Valid types: goal, context, current_behavior, \
                 desired_behavior, checklist_item, testing_criterion, anti_pattern, failure_test, constraint",
                s
            )),
        }
    }
}

impl SectionType {
    /// Whether this section type is single-instance (can only have one per task).
    ///
    /// Single-instance types: goal, context, current_behavior, desired_behavior
    /// Multi-instance types: checklist_item, testing_criterion, anti_pattern, failure_test, constraint
    pub fn is_single_instance(&self) -> bool {
        matches!(
            self,
            SectionType::Goal
                | SectionType::Context
                | SectionType::CurrentBehavior
                | SectionType::DesiredBehavior
        )
    }
}

/// Execution status for a workflow step
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    InProgress,
    Completed,
    Failed,
}

impl ExecutionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExecutionStatus::InProgress => "in_progress",
            ExecutionStatus::Completed => "completed",
            ExecutionStatus::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "in_progress" => Some(ExecutionStatus::InProgress),
            "completed" => Some(ExecutionStatus::Completed),
            "failed" => Some(ExecutionStatus::Failed),
            _ => None,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, ExecutionStatus::Completed | ExecutionStatus::Failed)
    }
}

impl std::fmt::Display for ExecutionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Permission mode for Claude CLI execution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    AcceptEdits,
    BypassPermissions,
    Default,
    Delegate,
    DontAsk,
    Plan,
}

impl PermissionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::BypassPermissions => "bypassPermissions",
            PermissionMode::Default => "default",
            PermissionMode::Delegate => "delegate",
            PermissionMode::DontAsk => "dontAsk",
            PermissionMode::Plan => "plan",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "acceptEdits" => Some(PermissionMode::AcceptEdits),
            "bypassPermissions" => Some(PermissionMode::BypassPermissions),
            "default" => Some(PermissionMode::Default),
            "delegate" => Some(PermissionMode::Delegate),
            "dontAsk" => Some(PermissionMode::DontAsk),
            "plan" => Some(PermissionMode::Plan),
            _ => None,
        }
    }
}

impl std::fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

// ─── Core Structs ──────────────────────────────────────────────────────────

/// A section of content within a task
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    #[serde(rename = "type")]
    pub section_type: SectionType,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<CodeRef>,
}

impl Section {
    pub fn new(section_type: SectionType, content: impl Into<String>) -> Self {
        Self {
            section_type,
            content: content.into(),
            order: None,
            done: None,
            done_at: None,
            refs: Vec::new(),
        }
    }

    pub fn with_order(section_type: SectionType, content: impl Into<String>, order: u32) -> Self {
        Self {
            section_type,
            content: content.into(),
            order: Some(order),
            done: None,
            done_at: None,
            refs: Vec::new(),
        }
    }

    pub fn with_done(mut self, done: bool) -> Self {
        self.done = Some(done);
        if done {
            self.done_at = Some(Utc::now());
        } else {
            self.done_at = None;
        }
        self
    }

    pub fn mark_done(&mut self) {
        self.done = Some(true);
        self.done_at = Some(Utc::now());
    }

    pub fn with_ref(mut self, code_ref: CodeRef) -> Self {
        self.refs.push(code_ref);
        self
    }

    pub fn with_refs(mut self, code_refs: impl IntoIterator<Item = CodeRef>) -> Self {
        self.refs.extend(code_refs);
        self
    }
}

impl PartialEq for Section {
    fn eq(&self, other: &Self) -> bool {
        self.section_type == other.section_type
            && self.content == other.content
            && self.order == other.order
            && self.done == other.done
            && self.refs == other.refs
    }
}

impl Eq for Section {}

/// A code reference attached to a task
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeRef {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_end: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl CodeRef {
    pub fn file(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            line_start: None,
            line_end: None,
            name: None,
            description: None,
        }
    }

    pub fn line(path: impl Into<String>, line: u32) -> Self {
        Self {
            path: path.into(),
            line_start: Some(line),
            line_end: None,
            name: None,
            description: None,
        }
    }

    pub fn range(path: impl Into<String>, start: u32, end: u32) -> Self {
        Self {
            path: path.into(),
            line_start: Some(start),
            line_end: Some(end),
            name: None,
            description: None,
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// Token usage statistics from Claude execution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
}

impl TokenUsage {
    pub fn new(input_tokens: u64, output_tokens: u64) -> Self {
        Self {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
        }
    }

    pub fn with_cache_read(mut self, tokens: u64) -> Self {
        self.cache_read_input_tokens = Some(tokens);
        self
    }

    pub fn with_cache_creation(mut self, tokens: u64) -> Self {
        self.cache_creation_input_tokens = Some(tokens);
        self
    }

    pub fn total(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
}

/// Blocker node in dependency tree
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockerNode {
    pub id: String,
    pub title: String,
    pub level: String,
    pub step_name: Option<String>,
    pub children: Vec<BlockerNode>,
}

/// Task filter for queries
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskFilter {
    pub levels: Vec<Level>,
    pub step_names: Vec<String>,
    pub priorities: Vec<Priority>,
    pub tags: Vec<String>,
    pub root_only: bool,
    pub children_of: Option<String>,
    pub include_done: bool,
    pub include_archived: bool,
    pub search: Option<String>,
    pub workflow_id: Option<String>,
    pub current_step: Option<String>,
}

impl TaskFilter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_level(mut self, level: Level) -> Self {
        self.levels.push(level);
        self
    }

    pub fn with_levels(mut self, levels: impl IntoIterator<Item = Level>) -> Self {
        self.levels.extend(levels);
        self
    }

    pub fn with_step_name(mut self, step_name: impl Into<String>) -> Self {
        self.step_names.push(step_name.into());
        self
    }

    pub fn with_step_names(
        mut self,
        step_names: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.step_names
            .extend(step_names.into_iter().map(|s| s.into()));
        self
    }

    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priorities.push(priority);
        self
    }

    pub fn with_priorities(mut self, priorities: impl IntoIterator<Item = Priority>) -> Self {
        self.priorities.extend(priorities);
        self
    }

    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    pub fn with_tags(mut self, tags: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.tags.extend(tags.into_iter().map(|t| t.into()));
        self
    }

    pub fn root_only(mut self) -> Self {
        self.root_only = true;
        self
    }

    pub fn children_of(mut self, parent_id: impl Into<String>) -> Self {
        self.children_of = Some(parent_id.into());
        self
    }

    pub fn include_done(mut self) -> Self {
        self.include_done = true;
        self
    }

    pub fn include_archived(mut self) -> Self {
        self.include_archived = true;
        self
    }

    pub fn with_search(mut self, search: impl Into<String>) -> Self {
        self.search = Some(search.into());
        self
    }

    pub fn with_workflow_id(mut self, workflow_id: impl Into<String>) -> Self {
        self.workflow_id = Some(workflow_id.into());
        self
    }

    pub fn with_current_step(mut self, step_name: impl Into<String>) -> Self {
        self.current_step = Some(step_name.into());
        self
    }
}

/// Configuration for a Claude agent execution
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disallowed_tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_budget_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_config: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugin_dirs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_schema: Option<serde_json::Value>,
}

impl AgentConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn with_fallback_model(mut self, model: impl Into<String>) -> Self {
        self.fallback_model = Some(model.into());
        self
    }

    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = Some(prompt.into());
        self
    }

    pub fn with_append_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.append_system_prompt = Some(prompt.into());
        self
    }

    pub fn with_agents(mut self, agents: serde_json::Value) -> Self {
        self.agents = Some(agents);
        self
    }

    pub fn with_tools(mut self, tools: Vec<String>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_allowed_tools(mut self, tools: Vec<String>) -> Self {
        self.allowed_tools = tools;
        self
    }

    pub fn with_disallowed_tools(mut self, tools: Vec<String>) -> Self {
        self.disallowed_tools = tools;
        self
    }

    pub fn with_permission_mode(mut self, mode: PermissionMode) -> Self {
        self.permission_mode = Some(mode);
        self
    }

    pub fn with_max_budget_usd(mut self, budget: f64) -> Self {
        self.max_budget_usd = Some(budget);
        self
    }

    pub fn with_mcp_config(mut self, configs: Vec<String>) -> Self {
        self.mcp_config = configs;
        self
    }

    pub fn with_plugin_dirs(mut self, dirs: Vec<String>) -> Self {
        self.plugin_dirs = dirs;
        self
    }

    pub fn with_json_schema(mut self, schema: serde_json::Value) -> Self {
        self.json_schema = Some(schema);
        self
    }

    pub fn to_cli_args(&self) -> Vec<String> {
        let mut args = Vec::new();

        if let Some(ref model) = self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        if let Some(ref model) = self.fallback_model {
            args.push("--fallback-model".to_string());
            args.push(model.clone());
        }
        if let Some(ref prompt) = self.system_prompt {
            args.push("--system-prompt".to_string());
            args.push(prompt.clone());
        }
        if let Some(ref prompt) = self.append_system_prompt {
            args.push("--append-system-prompt".to_string());
            args.push(prompt.clone());
        }
        if let Some(ref agents) = self.agents {
            args.push("--agents".to_string());
            args.push(agents.to_string());
        }
        if !self.tools.is_empty() {
            args.push("--tools".to_string());
            args.extend(self.tools.iter().cloned());
        }
        if !self.allowed_tools.is_empty() {
            args.push("--allowed-tools".to_string());
            args.extend(self.allowed_tools.iter().cloned());
        }
        if !self.disallowed_tools.is_empty() {
            args.push("--disallowed-tools".to_string());
            args.extend(self.disallowed_tools.iter().cloned());
        }
        if let Some(ref mode) = self.permission_mode {
            args.push("--permission-mode".to_string());
            args.push(mode.as_str().to_string());
        }
        if let Some(budget) = self.max_budget_usd {
            args.push("--max-budget-usd".to_string());
            args.push(format_float(budget));
        }
        for config in &self.mcp_config {
            args.push("--mcp-config".to_string());
            args.push(config.clone());
        }
        for dir in &self.plugin_dirs {
            args.push("--plugin-dir".to_string());
            args.push(dir.clone());
        }
        if let Some(ref schema) = self.json_schema {
            args.push("--json-schema".to_string());
            args.push(schema.to_string());
        }

        args
    }

    pub fn is_empty(&self) -> bool {
        self.model.is_none()
            && self.fallback_model.is_none()
            && self.system_prompt.is_none()
            && self.append_system_prompt.is_none()
            && self.agents.is_none()
            && self.tools.is_empty()
            && self.allowed_tools.is_empty()
            && self.disallowed_tools.is_empty()
            && self.permission_mode.is_none()
            && self.max_budget_usd.is_none()
            && self.mcp_config.is_empty()
            && self.plugin_dirs.is_empty()
            && self.json_schema.is_none()
    }

    pub fn merge(mut self, other: AgentConfig) -> Self {
        if other.model.is_some() {
            self.model = other.model;
        }
        if other.fallback_model.is_some() {
            self.fallback_model = other.fallback_model;
        }
        if other.system_prompt.is_some() {
            self.system_prompt = other.system_prompt;
        }
        if other.append_system_prompt.is_some() {
            self.append_system_prompt = other.append_system_prompt;
        }
        if other.agents.is_some() {
            self.agents = other.agents;
        }
        if !other.tools.is_empty() {
            self.tools = other.tools;
        }
        if !other.allowed_tools.is_empty() {
            self.allowed_tools = other.allowed_tools;
        }
        if !other.disallowed_tools.is_empty() {
            self.disallowed_tools = other.disallowed_tools;
        }
        if other.permission_mode.is_some() {
            self.permission_mode = other.permission_mode;
        }
        if other.max_budget_usd.is_some() {
            self.max_budget_usd = other.max_budget_usd;
        }
        if !other.mcp_config.is_empty() {
            self.mcp_config = other.mcp_config;
        }
        if !other.plugin_dirs.is_empty() {
            self.plugin_dirs = other.plugin_dirs;
        }
        if other.json_schema.is_some() {
            self.json_schema = other.json_schema;
        }
        self
    }
}

impl PartialEq for AgentConfig {
    fn eq(&self, other: &Self) -> bool {
        self.model == other.model
            && self.fallback_model == other.fallback_model
            && self.system_prompt == other.system_prompt
            && self.append_system_prompt == other.append_system_prompt
            && self.agents == other.agents
            && self.tools == other.tools
            && self.allowed_tools == other.allowed_tools
            && self.disallowed_tools == other.disallowed_tools
            && self.permission_mode == other.permission_mode
            && float_option_eq(self.max_budget_usd, other.max_budget_usd)
            && self.mcp_config == other.mcp_config
            && self.plugin_dirs == other.plugin_dirs
            && self.json_schema == other.json_schema
    }
}

impl Eq for AgentConfig {}

fn float_option_eq(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x.total_cmp(&y) == std::cmp::Ordering::Equal,
        _ => false,
    }
}

fn format_float(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{:.0}", value)
    } else {
        let s = format!("{}", value);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Database Thing type placeholder (for compatibility during migration)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Thing {
    pub tb: String,
    pub id: String,
}

impl Thing {
    pub fn to_raw(&self) -> String {
        self.id.clone()
    }
}

impl<T: Into<String>, U: Into<String>> From<(T, U)> for Thing {
    fn from((tb, id): (T, U)) -> Self {
        Self {
            tb: tb.into(),
            id: id.into(),
        }
    }
}

impl std::fmt::Display for Thing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.tb, self.id)
    }
}

// ─── Domain Models ─────────────────────────────────────────────────────────

/// A task in the Vertebrae task management system (domain model)
///
/// This is the canonical task type used throughout the system.
/// All IDs are plain strings rather than database-specific record types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    /// Unique identifier (always populated for persisted tasks)
    pub id: String,

    /// Task title
    pub title: String,

    /// Optional description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Hierarchy level (epic, ticket, task)
    pub level: Level,

    /// Optional priority
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,

    /// Tags for categorization
    #[serde(default)]
    pub tags: Vec<String>,

    /// Workflow ID (as string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,

    /// Current step ID (as string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step_id: Option<String>,

    /// Workflow name (if task is assigned to a workflow)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,

    /// Current step name (if task has a current step in workflow)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_name: Option<String>,

    /// Whether this task needs human review
    #[serde(default)]
    pub needs_human_review: Option<bool>,

    /// Whether this task is archived
    #[serde(default)]
    pub archived: bool,

    /// Optional worktree path for this task
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,

    /// Review comment
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_comment: Option<String>,

    /// Feedback for revision
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_feedback: Option<String>,

    /// Rejection reason
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,

    /// Parent task ID (if any)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,

    /// IDs of tasks this task depends on
    #[serde(default)]
    pub dependency_ids: Vec<String>,

    /// Embedded sections
    #[serde(default)]
    pub sections: Vec<Section>,

    /// Embedded code references
    #[serde(default, rename = "refs")]
    pub code_refs: Vec<CodeRef>,

    /// Blocker tasks (populated by get_task, empty by default)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<Task>,

    /// Dependent tasks (populated by get_task, empty by default)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependents: Vec<Task>,

    /// Child tasks (populated by get_task, empty by default)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Task>,

    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,

    /// Last update timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,

    /// When this task was started
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,

    /// When this task was completed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

impl Task {
    /// Create a new task with required fields
    pub fn new(title: impl Into<String>, level: Level) -> Self {
        Self {
            id: String::new(),
            title: title.into(),
            description: None,
            level,
            priority: None,
            tags: Vec::new(),
            workflow_id: None,
            current_step_id: None,
            workflow_name: None,
            step_name: None,
            needs_human_review: None,
            archived: false,
            worktree: None,
            review_comment: None,
            revision_feedback: None,
            rejection_reason: None,
            parent_id: None,
            dependency_ids: Vec::new(),
            sections: Vec::new(),
            code_refs: Vec::new(),
            blockers: Vec::new(),
            dependents: Vec::new(),
            children: Vec::new(),
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
        }
    }

    /// Set the description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Set the priority
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = Some(priority);
        self
    }

    /// Add a tag
    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    /// Add multiple tags
    pub fn with_tags(mut self, tags: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.tags.extend(tags.into_iter().map(|t| t.into()));
        self
    }

    /// Add a section
    pub fn with_section(mut self, section: Section) -> Self {
        self.sections.push(section);
        self
    }

    /// Add a code reference
    pub fn with_code_ref(mut self, code_ref: CodeRef) -> Self {
        self.code_refs.push(code_ref);
        self
    }

    /// Mark as needing human review
    pub fn with_needs_human_review(mut self, needs_review: bool) -> Self {
        self.needs_human_review = Some(needs_review);
        self
    }

    /// Assign to a workflow with a step
    pub fn with_workflow(mut self, workflow_id: String, step_id: String) -> Self {
        self.workflow_id = Some(workflow_id);
        self.current_step_id = Some(step_id);
        self
    }

    /// Clear workflow assignment
    pub fn without_workflow(mut self) -> Self {
        self.workflow_id = None;
        self.current_step_id = None;
        self
    }

    /// Set the current step ID
    pub fn with_current_step_id(mut self, step_id: String) -> Self {
        self.current_step_id = Some(step_id);
        self
    }
}

impl PartialEq for Task {
    fn eq(&self, other: &Self) -> bool {
        self.title == other.title
            && self.description == other.description
            && self.level == other.level
            && self.priority == other.priority
            && self.tags == other.tags
            && self.sections == other.sections
            && self.code_refs == other.code_refs
            && self.needs_human_review == other.needs_human_review
            && self.workflow_id == other.workflow_id
            && self.current_step_id == other.current_step_id
    }
}

impl Eq for Task {}

/// A workflow step entity (domain model)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    /// Unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// Display name
    pub name: String,

    /// Workflow this step belongs to
    pub workflow_id: String,

    /// Goal for this step
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,

    /// Prompt sent to the agent when executing this step
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,

    /// Evaluation prompt used to assess step output for branching decisions
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval_prompt: Option<String>,

    /// Agent file paths
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,

    /// Skill names
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,

    /// Agent configuration
    #[serde(default)]
    pub agent_config: AgentConfig,

    /// Whether this is a final step
    #[serde(default)]
    pub is_final: bool,

    /// Step IDs this step can transition to
    #[serde(default)]
    pub transitions_to: Vec<String>,

    /// Ordering index
    #[serde(default)]
    pub order: i32,

    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,

    /// Last update timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

impl Step {
    /// Create a new step
    pub fn new(name: impl Into<String>, workflow_id: impl Into<String>) -> Self {
        Self {
            id: None,
            name: name.into(),
            workflow_id: workflow_id.into(),
            goal: None,
            prompt: None,
            eval_prompt: None,
            agents: Vec::new(),
            skills: Vec::new(),
            agent_config: AgentConfig::default(),
            is_final: false,
            transitions_to: Vec::new(),
            order: 0,
            created_at: None,
            updated_at: None,
        }
    }

    /// Set the goal
    pub fn with_goal(mut self, goal: impl Into<String>) -> Self {
        self.goal = Some(goal.into());
        self
    }

    /// Set the prompt
    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into());
        self
    }

    /// Set the evaluation prompt
    pub fn with_eval_prompt(mut self, eval_prompt: impl Into<String>) -> Self {
        self.eval_prompt = Some(eval_prompt.into());
        self
    }

    /// Set the agents
    pub fn with_agents(mut self, agents: Vec<String>) -> Self {
        self.agents = agents;
        self
    }

    /// Add an agent
    pub fn with_agent(mut self, agent: impl Into<String>) -> Self {
        self.agents.push(agent.into());
        self
    }

    /// Set the skills
    pub fn with_skills(mut self, skills: Vec<String>) -> Self {
        self.skills = skills;
        self
    }

    /// Add a skill
    pub fn with_skill(mut self, skill: impl Into<String>) -> Self {
        self.skills.push(skill.into());
        self
    }

    /// Set the agent configuration
    pub fn with_agent_config(mut self, agent_config: AgentConfig) -> Self {
        self.agent_config = agent_config;
        self
    }

    /// Mark as final
    pub fn with_is_final(mut self, is_final: bool) -> Self {
        self.is_final = is_final;
        self
    }

    /// Add a transition
    pub fn with_transition(mut self, step_id: impl Into<String>) -> Self {
        self.transitions_to.push(step_id.into());
        self
    }

    /// Set all transitions
    pub fn with_transitions_to(mut self, transitions: Vec<String>) -> Self {
        self.transitions_to = transitions;
        self
    }

    /// Set the order
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = order;
        self
    }
}

impl PartialEq for Step {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for Step {}

/// A workflow definition (domain model)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    /// Unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// Workflow name
    pub name: String,

    /// Optional description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Initial step ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_step: Option<String>,

    /// Additional metadata
    #[serde(default)]
    pub metadata: std::collections::HashMap<String, String>,

    /// Auto-advance on completion
    #[serde(default)]
    pub auto_advance: bool,

    /// Display order
    #[serde(default)]
    pub order: i32,

    /// Transitions to other workflows
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transitions: Vec<WorkflowTransition>,

    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,

    /// Last update timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

impl Workflow {
    /// Create a new workflow
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: None,
            name: name.into(),
            description: None,
            initial_step: None,
            metadata: std::collections::HashMap::new(),
            auto_advance: false,
            order: 0,
            transitions: Vec::new(),
            created_at: None,
            updated_at: None,
        }
    }

    /// Set auto_advance
    pub fn with_auto_advance(mut self, auto_advance: bool) -> Self {
        self.auto_advance = auto_advance;
        self
    }

    /// Set the display order
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = order;
        self
    }

    /// Set the description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Add a metadata key-value pair
    pub fn with_metadata(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }

    /// Set the initial step
    pub fn with_initial_step(mut self, step_id: impl Into<String>) -> Self {
        self.initial_step = Some(step_id.into());
        self
    }
}

impl PartialEq for Workflow {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
            && self.description == other.description
            && self.initial_step == other.initial_step
            && self.metadata == other.metadata
            && self.auto_advance == other.auto_advance
    }
}

impl Eq for Workflow {}

/// A record of a workflow step execution (domain model)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepExecution {
    /// Unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// Task ID
    pub task_id: String,

    /// Workflow ID
    pub workflow_id: String,

    /// Step name
    pub step_name: String,

    /// When execution started
    pub started_at: DateTime<Utc>,

    /// When execution completed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,

    /// Execution status
    pub status: ExecutionStatus,

    /// JSON context data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,

    /// JSON prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,

    /// Final text result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,

    /// Transition decision result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_result: Option<String>,

    /// Model used
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_used: Option<String>,

    /// Claude session ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,

    /// Token usage statistics
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenUsage>,

    /// Cost in USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,

    /// Duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl StepExecution {
    /// Create a new step execution
    pub fn new(
        task_id: impl Into<String>,
        workflow_id: impl Into<String>,
        step_name: impl Into<String>,
    ) -> Self {
        Self {
            id: None,
            task_id: task_id.into(),
            workflow_id: workflow_id.into(),
            step_name: step_name.into(),
            started_at: Utc::now(),
            completed_at: None,
            status: ExecutionStatus::InProgress,
            context: None,
            prompt: None,
            output: None,
            transition_result: None,
            model_used: None,
            session_id: None,
            token_usage: None,
            cost_usd: None,
            duration_ms: None,
        }
    }

    /// Set started_at
    pub fn with_started_at(mut self, started_at: DateTime<Utc>) -> Self {
        self.started_at = started_at;
        self
    }

    /// Set context
    pub fn with_context(mut self, context: impl Into<String>) -> Self {
        self.context = Some(context.into());
        self
    }

    /// Set prompt
    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into());
        self
    }

    /// Set output
    pub fn with_output(mut self, output: impl Into<String>) -> Self {
        self.output = Some(output.into());
        self
    }

    /// Set transition result
    pub fn with_transition_result(mut self, result: impl Into<String>) -> Self {
        self.transition_result = Some(result.into());
        self
    }

    /// Set model used
    pub fn with_model_used(mut self, model: impl Into<String>) -> Self {
        self.model_used = Some(model.into());
        self
    }

    /// Set session ID
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    /// Set token usage
    pub fn with_token_usage(mut self, usage: TokenUsage) -> Self {
        self.token_usage = Some(usage);
        self
    }

    /// Set cost
    pub fn with_cost_usd(mut self, cost: f64) -> Self {
        self.cost_usd = Some(cost);
        self
    }

    /// Set duration
    pub fn with_duration_ms(mut self, duration: u64) -> Self {
        self.duration_ms = Some(duration);
        self
    }

    /// Mark as completed
    pub fn complete(&mut self) {
        self.status = ExecutionStatus::Completed;
        self.completed_at = Some(Utc::now());
    }

    /// Mark as completed at specific time
    pub fn complete_at(&mut self, completed_at: DateTime<Utc>) {
        self.status = ExecutionStatus::Completed;
        self.completed_at = Some(completed_at);
    }

    /// Mark as failed
    pub fn fail(&mut self) {
        self.status = ExecutionStatus::Failed;
        self.completed_at = Some(Utc::now());
    }

    /// Mark as failed at specific time
    pub fn fail_at(&mut self, completed_at: DateTime<Utc>) {
        self.status = ExecutionStatus::Failed;
        self.completed_at = Some(completed_at);
    }

    /// Check if finished
    pub fn is_finished(&self) -> bool {
        self.status.is_terminal()
    }

    /// Get duration
    pub fn duration(&self) -> Option<chrono::Duration> {
        self.completed_at.map(|end| end - self.started_at)
    }
}

impl PartialEq for StepExecution {
    fn eq(&self, other: &Self) -> bool {
        self.task_id == other.task_id
            && self.workflow_id == other.workflow_id
            && self.step_name == other.step_name
            && self.status == other.status
    }
}

impl Eq for StepExecution {}

/// A session log entry (domain model)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLog {
    /// Unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// Step execution ID
    pub step_execution_id: String,

    /// Log content
    pub content: String,

    /// When created
    pub created_at: DateTime<Utc>,
}

impl SessionLog {
    /// Create a new session log
    pub fn new(step_execution_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            id: None,
            step_execution_id: step_execution_id.into(),
            content: content.into(),
            created_at: Utc::now(),
        }
    }

    /// Set creation time
    pub fn with_created_at(mut self, created_at: DateTime<Utc>) -> Self {
        self.created_at = created_at;
        self
    }
}

impl PartialEq for SessionLog {
    fn eq(&self, other: &Self) -> bool {
        self.step_execution_id == other.step_execution_id && self.content == other.content
    }
}

impl Eq for SessionLog {}

/// A workflow transition edge (domain model)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowTransition {
    /// Unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

    /// Source workflow ID
    pub from_workflow: String,

    /// Target workflow ID
    pub to_workflow: String,

    /// Human-readable label
    pub label: String,

    /// Optional target step ID in the target workflow
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_step: Option<String>,

    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
}

impl WorkflowTransition {
    /// Create a new transition
    pub fn new(
        from_workflow: impl Into<String>,
        to_workflow: impl Into<String>,
        label: impl Into<String>,
    ) -> Self {
        Self {
            id: None,
            from_workflow: from_workflow.into(),
            to_workflow: to_workflow.into(),
            label: label.into(),
            target_step: None,
            created_at: None,
        }
    }

    /// Set the target step
    pub fn with_target_step(mut self, step: impl Into<String>) -> Self {
        self.target_step = Some(step.into());
        self
    }
}

/// Update options for a task (domain model, no Thing fields)
#[derive(Debug, Default)]
pub struct TaskUpdate {
    /// New title
    pub title: Option<String>,
    /// New description (Some(Some(x)) to set, Some(None) to clear)
    pub description: Option<Option<String>>,
    /// New priority
    pub priority: Option<Option<Priority>>,
    /// Tags to add
    pub add_tags: Vec<String>,
    /// Tags to remove
    pub remove_tags: Vec<String>,
    /// Code references to set (replaces all)
    pub refs: Option<Vec<CodeRef>>,
    /// Whether to clear refs
    pub clear_refs: bool,
    /// Whether to set started_at to now
    pub set_started_at: bool,
    /// Whether to set started_at only if null
    pub set_started_at_if_null: bool,
    /// Workflow ID to assign (Some(Some(x)) to set, Some(None) to clear)
    pub workflow_id: Option<Option<String>>,
    /// Current step ID (Some(Some(x)) to set, Some(None) to clear)
    pub current_step_id: Option<Option<String>>,
    /// New task level
    pub level: Option<String>,
    /// Whether to set completed_at to now
    pub set_completed_at: bool,
    /// Revision feedback (Some(Some(x)) to set, Some(None) to clear)
    pub revision_feedback: Option<Option<String>>,
    /// Rejection reason (Some(Some(x)) to set, Some(None) to clear)
    pub rejection_reason: Option<Option<String>>,
}

/// Update options for a step (domain model, no Thing fields)
#[derive(Debug, Default)]
pub struct StepUpdate {
    /// New name
    pub name: Option<String>,
    /// New goal
    pub goal: Option<String>,
    /// New prompt
    pub prompt: Option<String>,
    /// New evaluation prompt
    pub eval_prompt: Option<String>,
    /// New agents list
    pub agents: Option<Vec<String>>,
    /// New skills list
    pub skills: Option<Vec<String>>,
    /// New agent config
    pub agent_config: Option<serde_json::Value>,
    /// New is_final value
    pub is_final: Option<bool>,
    /// New transitions_to list (string IDs)
    pub transitions_to: Option<Vec<String>>,
    /// New order value
    pub order: Option<i32>,
}

impl StepUpdate {
    /// Create a new empty update
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a new name
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Set a new goal
    pub fn with_goal(mut self, goal: impl Into<String>) -> Self {
        self.goal = Some(goal.into());
        self
    }

    /// Set a new prompt
    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into());
        self
    }

    /// Set a new evaluation prompt
    pub fn with_eval_prompt(mut self, eval_prompt: impl Into<String>) -> Self {
        self.eval_prompt = Some(eval_prompt.into());
        self
    }

    /// Set agents list
    pub fn with_agents(mut self, agents: Vec<String>) -> Self {
        self.agents = Some(agents);
        self
    }

    /// Set skills list
    pub fn with_skills(mut self, skills: Vec<String>) -> Self {
        self.skills = Some(skills);
        self
    }

    /// Set a new agent config
    pub fn with_agent_config(mut self, config: serde_json::Value) -> Self {
        self.agent_config = Some(config);
        self
    }

    /// Set the is_final flag
    pub fn with_is_final(mut self, is_final: bool) -> Self {
        self.is_final = Some(is_final);
        self
    }

    /// Set transitions_to list (string IDs)
    pub fn with_transitions_to(mut self, transitions: Vec<String>) -> Self {
        self.transitions_to = Some(transitions);
        self
    }

    /// Set the order
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = Some(order);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Task ───────────────────────────────────────────────────────

    #[test]
    fn task_new_sets_defaults() {
        let task = Task::new("My Task", Level::Task);
        assert_eq!(task.title, "My Task");
        assert_eq!(task.level, Level::Task);
        assert!(task.id.is_empty());
        assert!(task.description.is_none());
        assert!(task.priority.is_none());
        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
        assert!(task.workflow_id.is_none());
        assert!(task.current_step_id.is_none());
        assert!(task.parent_id.is_none());
        assert!(task.dependency_ids.is_empty());
        assert!(task.workflow_name.is_none());
        assert!(task.step_name.is_none());
        assert!(task.review_comment.is_none());
        assert!(!task.archived);
    }

    #[test]
    fn task_builder_methods() {
        let task = Task::new("T", Level::Epic)
            .with_description("desc")
            .with_priority(Priority::High)
            .with_tag("rust")
            .with_tags(vec!["cli", "core"])
            .with_needs_human_review(true)
            .with_workflow("wf1".into(), "s1".into())
            .with_current_step_id("s2".into());

        assert_eq!(task.description.as_deref(), Some("desc"));
        assert_eq!(task.priority, Some(Priority::High));
        assert_eq!(task.tags, vec!["rust", "cli", "core"]);
        assert_eq!(task.needs_human_review, Some(true));
        assert_eq!(task.workflow_id.as_deref(), Some("wf1"));
        assert_eq!(task.current_step_id.as_deref(), Some("s2"));
    }

    #[test]
    fn task_without_workflow() {
        let task = Task::new("T", Level::Task)
            .with_workflow("wf".into(), "s".into())
            .without_workflow();
        assert!(task.workflow_id.is_none());
        assert!(task.current_step_id.is_none());
    }

    #[test]
    fn task_with_section_and_code_ref() {
        let section = Section {
            section_type: SectionType::ChecklistItem,
            content: "Do something".into(),
            order: Some(1),
            done: Some(false),
            done_at: None,
            refs: vec![],
        };
        let code_ref = CodeRef {
            path: "src/main.rs".into(),
            name: None,
            line_start: None,
            line_end: None,
            description: None,
        };
        let task = Task::new("T", Level::Task)
            .with_section(section.clone())
            .with_code_ref(code_ref.clone());
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.code_refs.len(), 1);
    }

    #[test]
    fn task_partial_eq_ignores_timestamps() {
        let mut a = Task::new("Same", Level::Task);
        let mut b = Task::new("Same", Level::Task);
        assert_eq!(a, b);

        a.created_at = Some(Utc::now());
        // b has no created_at but they should still be equal
        assert_eq!(a, b);

        b.title = "Different".into();
        assert_ne!(a, b);
    }

    // ─── Step ───────────────────────────────────────────────────────

    #[test]
    fn step_new_and_builders() {
        let step = Step::new("review", "wf1")
            .with_goal("Review the code")
            .with_agent("claude")
            .with_agents(vec!["agent1".into()])
            .with_skill("code-review")
            .with_skills(vec!["lint".into()])
            .with_agent_config(AgentConfig::default())
            .with_is_final(true)
            .with_transition("step2")
            .with_transitions_to(vec!["s3".into()])
            .with_order(5);

        assert_eq!(step.name, "review");
        assert_eq!(step.workflow_id, "wf1");
        assert_eq!(step.goal.as_deref(), Some("Review the code"));
        assert_eq!(step.agents, vec!["agent1"]);
        assert_eq!(step.skills, vec!["lint"]);
        assert!(step.is_final);
        assert_eq!(step.transitions_to, vec!["s3"]);
        assert_eq!(step.order, 5);
    }

    #[test]
    fn step_partial_eq_uses_id() {
        let mut a = Step::new("a", "wf");
        let mut b = Step::new("b", "wf");
        a.id = Some("same".into());
        b.id = Some("same".into());
        assert_eq!(a, b);

        b.id = Some("diff".into());
        assert_ne!(a, b);
    }

    // ─── Workflow ───────────────────────────────────────────────────

    #[test]
    fn workflow_new_and_builders() {
        let wf = Workflow::new("Dev")
            .with_description("Development workflow")
            .with_auto_advance(true)
            .with_order(2)
            .with_metadata("key", "value")
            .with_initial_step("step1");

        assert_eq!(wf.name, "Dev");
        assert_eq!(wf.description.as_deref(), Some("Development workflow"));
        assert!(wf.auto_advance);
        assert_eq!(wf.order, 2);
        assert_eq!(wf.metadata.get("key").unwrap(), "value");
        assert_eq!(wf.initial_step.as_deref(), Some("step1"));
    }

    #[test]
    fn workflow_partial_eq_ignores_timestamps() {
        let a = Workflow::new("A").with_description("d");
        let b = Workflow::new("A").with_description("d");
        assert_eq!(a, b);

        let c = Workflow::new("B");
        assert_ne!(a, c);
    }

    // ─── StepExecution ──────────────────────────────────────────────

    #[test]
    fn step_execution_new_and_builders() {
        let exec = StepExecution::new("task1", "wf1", "review")
            .with_context("ctx")
            .with_prompt("do stuff")
            .with_output("done")
            .with_transition_result("next_step")
            .with_model_used("claude-3")
            .with_session_id("sess1")
            .with_token_usage(TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
                cache_creation_input_tokens: Some(0),
                cache_read_input_tokens: Some(0),
            })
            .with_cost_usd(0.05)
            .with_duration_ms(1500);

        assert_eq!(exec.task_id, "task1");
        assert_eq!(exec.workflow_id, "wf1");
        assert_eq!(exec.step_name, "review");
        assert_eq!(exec.context.as_deref(), Some("ctx"));
        assert_eq!(exec.prompt.as_deref(), Some("do stuff"));
        assert_eq!(exec.output.as_deref(), Some("done"));
        assert_eq!(exec.transition_result.as_deref(), Some("next_step"));
        assert_eq!(exec.model_used.as_deref(), Some("claude-3"));
        assert_eq!(exec.session_id.as_deref(), Some("sess1"));
        assert!(exec.token_usage.is_some());
        assert_eq!(exec.cost_usd, Some(0.05));
        assert_eq!(exec.duration_ms, Some(1500));
        assert_eq!(exec.status, ExecutionStatus::InProgress);
    }

    #[test]
    fn step_execution_with_started_at() {
        let t = Utc::now();
        let exec = StepExecution::new("t", "w", "s").with_started_at(t);
        assert_eq!(exec.started_at, t);
    }

    #[test]
    fn step_execution_complete_and_fail() {
        let mut exec = StepExecution::new("t", "w", "s");
        assert!(!exec.is_finished());
        assert!(exec.duration().is_none());

        exec.complete();
        assert_eq!(exec.status, ExecutionStatus::Completed);
        assert!(exec.completed_at.is_some());
        assert!(exec.is_finished());
        assert!(exec.duration().is_some());

        let mut exec2 = StepExecution::new("t", "w", "s");
        let t = Utc::now();
        exec2.complete_at(t);
        assert_eq!(exec2.completed_at, Some(t));

        let mut exec3 = StepExecution::new("t", "w", "s");
        exec3.fail();
        assert_eq!(exec3.status, ExecutionStatus::Failed);
        assert!(exec3.is_finished());

        let mut exec4 = StepExecution::new("t", "w", "s");
        exec4.fail_at(t);
        assert_eq!(exec4.completed_at, Some(t));
        assert_eq!(exec4.status, ExecutionStatus::Failed);
    }

    #[test]
    fn step_execution_partial_eq() {
        let a = StepExecution::new("t", "w", "s");
        let b = StepExecution::new("t", "w", "s");
        assert_eq!(a, b);

        let c = StepExecution::new("t2", "w", "s");
        assert_ne!(a, c);
    }

    // ─── SessionLog ─────────────────────────────────────────────────

    #[test]
    fn session_log_new_and_builders() {
        let t = Utc::now();
        let log = SessionLog::new("exec1", "log content").with_created_at(t);
        assert_eq!(log.step_execution_id, "exec1");
        assert_eq!(log.content, "log content");
        assert_eq!(log.created_at, t);
    }

    #[test]
    fn session_log_partial_eq() {
        let a = SessionLog::new("e1", "content");
        let b = SessionLog::new("e1", "content");
        assert_eq!(a, b);
        let c = SessionLog::new("e2", "content");
        assert_ne!(a, c);
    }

    // ─── WorkflowTransition ─────────────────────────────────────────

    #[test]
    fn workflow_transition_new_and_builders() {
        let t = WorkflowTransition::new("wf1", "wf2", "on_done").with_target_step("step1");
        assert_eq!(t.from_workflow, "wf1");
        assert_eq!(t.to_workflow, "wf2");
        assert_eq!(t.label, "on_done");
        assert_eq!(t.target_step.as_deref(), Some("step1"));
    }

    // ─── StepUpdate ─────────────────────────────────────────────────

    #[test]
    fn step_update_builders() {
        let u = StepUpdate::new()
            .with_name("new_name")
            .with_goal("new_goal")
            .with_agents(vec!["a1".into()])
            .with_skills(vec!["s1".into()])
            .with_agent_config(serde_json::json!({"key": "val"}))
            .with_is_final(true)
            .with_transitions_to(vec!["s2".into()])
            .with_order(3);

        assert_eq!(u.name.as_deref(), Some("new_name"));
        assert_eq!(u.goal.as_deref(), Some("new_goal"));
        assert_eq!(u.agents.as_ref().unwrap(), &vec!["a1".to_string()]);
        assert_eq!(u.skills.as_ref().unwrap(), &vec!["s1".to_string()]);
        assert!(u.agent_config.is_some());
        assert_eq!(u.is_final, Some(true));
        assert_eq!(u.transitions_to.as_ref().unwrap(), &vec!["s2".to_string()]);
        assert_eq!(u.order, Some(3));
    }

    // ─── Level Enum Tests ───────────────────────────────────────────

    #[test]
    fn level_as_str() {
        assert_eq!(Level::Epic.as_str(), "epic");
        assert_eq!(Level::Ticket.as_str(), "ticket");
        assert_eq!(Level::Task.as_str(), "task");
    }

    #[test]
    fn level_display() {
        assert_eq!(Level::Epic.to_string(), "epic");
        assert_eq!(Level::Ticket.to_string(), "ticket");
        assert_eq!(Level::Task.to_string(), "task");
    }

    // ─── Priority Enum Tests ────────────────────────────────────────

    #[test]
    fn priority_as_str() {
        assert_eq!(Priority::Low.as_str(), "low");
        assert_eq!(Priority::Medium.as_str(), "medium");
        assert_eq!(Priority::High.as_str(), "high");
        assert_eq!(Priority::Critical.as_str(), "critical");
    }

    #[test]
    fn priority_display() {
        assert_eq!(Priority::Low.to_string(), "low");
        assert_eq!(Priority::Medium.to_string(), "medium");
        assert_eq!(Priority::High.to_string(), "high");
        assert_eq!(Priority::Critical.to_string(), "critical");
    }

    // ─── SectionType Enum Tests ─────────────────────────────────────

    #[test]
    fn section_type_as_str() {
        assert_eq!(SectionType::Goal.as_str(), "goal");
        assert_eq!(SectionType::Context.as_str(), "context");
        assert_eq!(SectionType::CurrentBehavior.as_str(), "current_behavior");
        assert_eq!(SectionType::DesiredBehavior.as_str(), "desired_behavior");
        assert_eq!(SectionType::ChecklistItem.as_str(), "checklist_item");
        assert_eq!(SectionType::TestingCriterion.as_str(), "testing_criterion");
        assert_eq!(SectionType::AntiPattern.as_str(), "anti_pattern");
        assert_eq!(SectionType::FailureTest.as_str(), "failure_test");
        assert_eq!(SectionType::Constraint.as_str(), "constraint");
    }

    #[test]
    fn section_type_display() {
        assert_eq!(SectionType::Goal.to_string(), "goal");
        assert_eq!(SectionType::Context.to_string(), "context");
        assert_eq!(SectionType::CurrentBehavior.to_string(), "current_behavior");
        assert_eq!(SectionType::DesiredBehavior.to_string(), "desired_behavior");
        assert_eq!(SectionType::ChecklistItem.to_string(), "checklist_item");
        assert_eq!(
            SectionType::TestingCriterion.to_string(),
            "testing_criterion"
        );
        assert_eq!(SectionType::AntiPattern.to_string(), "anti_pattern");
        assert_eq!(SectionType::FailureTest.to_string(), "failure_test");
        assert_eq!(SectionType::Constraint.to_string(), "constraint");
    }

    // ─── ExecutionStatus Enum Tests ─────────────────────────────────

    #[test]
    fn execution_status_as_str() {
        assert_eq!(ExecutionStatus::InProgress.as_str(), "in_progress");
        assert_eq!(ExecutionStatus::Completed.as_str(), "completed");
        assert_eq!(ExecutionStatus::Failed.as_str(), "failed");
    }

    #[test]
    fn execution_status_display() {
        assert_eq!(ExecutionStatus::InProgress.to_string(), "in_progress");
        assert_eq!(ExecutionStatus::Completed.to_string(), "completed");
        assert_eq!(ExecutionStatus::Failed.to_string(), "failed");
    }

    #[test]
    fn execution_status_parse() {
        assert_eq!(
            ExecutionStatus::parse("in_progress"),
            Some(ExecutionStatus::InProgress)
        );
        assert_eq!(
            ExecutionStatus::parse("completed"),
            Some(ExecutionStatus::Completed)
        );
        assert_eq!(
            ExecutionStatus::parse("failed"),
            Some(ExecutionStatus::Failed)
        );
        assert_eq!(ExecutionStatus::parse("invalid"), None);
        assert_eq!(ExecutionStatus::parse(""), None);
    }

    #[test]
    fn execution_status_is_terminal() {
        assert!(!ExecutionStatus::InProgress.is_terminal());
        assert!(ExecutionStatus::Completed.is_terminal());
        assert!(ExecutionStatus::Failed.is_terminal());
    }

    // ─── PermissionMode Enum Tests ──────────────────────────────────

    #[test]
    fn permission_mode_as_str() {
        assert_eq!(PermissionMode::AcceptEdits.as_str(), "acceptEdits");
        assert_eq!(
            PermissionMode::BypassPermissions.as_str(),
            "bypassPermissions"
        );
        assert_eq!(PermissionMode::Default.as_str(), "default");
        assert_eq!(PermissionMode::Delegate.as_str(), "delegate");
        assert_eq!(PermissionMode::DontAsk.as_str(), "dontAsk");
        assert_eq!(PermissionMode::Plan.as_str(), "plan");
    }

    #[test]
    fn permission_mode_display() {
        assert_eq!(PermissionMode::AcceptEdits.to_string(), "acceptEdits");
        assert_eq!(
            PermissionMode::BypassPermissions.to_string(),
            "bypassPermissions"
        );
        assert_eq!(PermissionMode::Default.to_string(), "default");
        assert_eq!(PermissionMode::Delegate.to_string(), "delegate");
        assert_eq!(PermissionMode::DontAsk.to_string(), "dontAsk");
        assert_eq!(PermissionMode::Plan.to_string(), "plan");
    }

    #[test]
    fn permission_mode_parse() {
        assert_eq!(
            PermissionMode::parse("acceptEdits"),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(
            PermissionMode::parse("bypassPermissions"),
            Some(PermissionMode::BypassPermissions)
        );
        assert_eq!(
            PermissionMode::parse("default"),
            Some(PermissionMode::Default)
        );
        assert_eq!(
            PermissionMode::parse("delegate"),
            Some(PermissionMode::Delegate)
        );
        assert_eq!(
            PermissionMode::parse("dontAsk"),
            Some(PermissionMode::DontAsk)
        );
        assert_eq!(PermissionMode::parse("plan"), Some(PermissionMode::Plan));
        assert_eq!(PermissionMode::parse("invalid"), None);
        assert_eq!(PermissionMode::parse(""), None);
    }

    // ─── Section Builder Tests ──────────────────────────────────────

    #[test]
    fn section_new() {
        let section = Section::new(SectionType::Goal, "Goal content");
        assert_eq!(section.section_type, SectionType::Goal);
        assert_eq!(section.content, "Goal content");
        assert!(section.order.is_none());
        assert!(section.done.is_none());
        assert!(section.done_at.is_none());
        assert!(section.refs.is_empty());
    }

    #[test]
    fn section_with_order() {
        let section = Section::with_order(SectionType::ChecklistItem, "Checklist item", 5);
        assert_eq!(section.section_type, SectionType::ChecklistItem);
        assert_eq!(section.content, "Checklist item");
        assert_eq!(section.order, Some(5));
        assert!(section.done.is_none());
    }

    #[test]
    fn section_with_done() {
        let section = Section::new(SectionType::Goal, "Goal").with_done(true);
        assert_eq!(section.done, Some(true));
        assert!(section.done_at.is_some());

        let section2 = Section::new(SectionType::Goal, "Goal").with_done(false);
        assert_eq!(section2.done, Some(false));
        assert!(section2.done_at.is_none());
    }

    #[test]
    fn section_mark_done() {
        let mut section = Section::new(SectionType::Goal, "Goal");
        assert!(section.done_at.is_none());
        section.mark_done();
        assert_eq!(section.done, Some(true));
        assert!(section.done_at.is_some());
    }

    #[test]
    fn section_with_ref() {
        let code_ref = CodeRef::file("test.rs");
        let section = Section::new(SectionType::Goal, "Goal").with_ref(code_ref.clone());
        assert_eq!(section.refs.len(), 1);
        assert_eq!(section.refs[0], code_ref);
    }

    #[test]
    fn section_with_refs() {
        let ref1 = CodeRef::file("test1.rs");
        let ref2 = CodeRef::file("test2.rs");
        let section =
            Section::new(SectionType::Goal, "Goal").with_refs(vec![ref1.clone(), ref2.clone()]);
        assert_eq!(section.refs.len(), 2);
        assert_eq!(section.refs[0], ref1);
        assert_eq!(section.refs[1], ref2);
    }

    // ─── CodeRef Builder Tests ──────────────────────────────────────

    #[test]
    fn code_ref_file() {
        let code_ref = CodeRef::file("src/main.rs");
        assert_eq!(code_ref.path, "src/main.rs");
        assert!(code_ref.line_start.is_none());
        assert!(code_ref.line_end.is_none());
        assert!(code_ref.name.is_none());
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn code_ref_line() {
        let code_ref = CodeRef::line("src/main.rs", 42);
        assert_eq!(code_ref.path, "src/main.rs");
        assert_eq!(code_ref.line_start, Some(42));
        assert!(code_ref.line_end.is_none());
        assert!(code_ref.name.is_none());
    }

    #[test]
    fn code_ref_range() {
        let code_ref = CodeRef::range("src/main.rs", 10, 20);
        assert_eq!(code_ref.path, "src/main.rs");
        assert_eq!(code_ref.line_start, Some(10));
        assert_eq!(code_ref.line_end, Some(20));
        assert!(code_ref.name.is_none());
    }

    #[test]
    fn code_ref_with_name() {
        let code_ref = CodeRef::file("src/main.rs").with_name("main_function");
        assert_eq!(code_ref.name, Some("main_function".to_string()));
    }

    #[test]
    fn code_ref_with_description() {
        let code_ref = CodeRef::file("src/main.rs").with_description("Entry point");
        assert_eq!(code_ref.description, Some("Entry point".to_string()));
    }

    #[test]
    fn code_ref_full_chain() {
        let code_ref = CodeRef::range("src/main.rs", 10, 20)
            .with_name("foo")
            .with_description("The foo function");
        assert_eq!(code_ref.path, "src/main.rs");
        assert_eq!(code_ref.line_start, Some(10));
        assert_eq!(code_ref.line_end, Some(20));
        assert_eq!(code_ref.name, Some("foo".to_string()));
        assert_eq!(code_ref.description, Some("The foo function".to_string()));
    }

    // ─── TokenUsage Tests ───────────────────────────────────────────

    #[test]
    fn token_usage_new() {
        let usage = TokenUsage::new(100, 50);
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        assert!(usage.cache_read_input_tokens.is_none());
        assert!(usage.cache_creation_input_tokens.is_none());
    }

    #[test]
    fn token_usage_with_cache_read() {
        let usage = TokenUsage::new(100, 50).with_cache_read(20);
        assert_eq!(usage.cache_read_input_tokens, Some(20));
    }

    #[test]
    fn token_usage_with_cache_creation() {
        let usage = TokenUsage::new(100, 50).with_cache_creation(30);
        assert_eq!(usage.cache_creation_input_tokens, Some(30));
    }

    #[test]
    fn token_usage_total() {
        let usage = TokenUsage::new(100, 50);
        assert_eq!(usage.total(), 150);

        let usage2 = TokenUsage::new(1000, 2000);
        assert_eq!(usage2.total(), 3000);
    }

    // ─── Thing Tests ────────────────────────────────────────────────

    #[test]
    fn thing_from_tuple() {
        let thing = Thing::from(("tasks", "123"));
        assert_eq!(thing.tb, "tasks");
        assert_eq!(thing.id, "123");
    }

    #[test]
    fn thing_to_raw() {
        let thing = Thing {
            tb: "tasks".to_string(),
            id: "xyz".to_string(),
        };
        assert_eq!(thing.to_raw(), "xyz");
    }

    #[test]
    fn thing_display() {
        let thing = Thing {
            tb: "tasks".to_string(),
            id: "123".to_string(),
        };
        assert_eq!(thing.to_string(), "tasks:123");
    }

    // ─── TaskFilter Tests ───────────────────────────────────────────

    #[test]
    fn task_filter_new() {
        let filter = TaskFilter::new();
        assert!(filter.levels.is_empty());
        assert!(filter.step_names.is_empty());
        assert!(filter.priorities.is_empty());
        assert!(filter.tags.is_empty());
        assert!(!filter.root_only);
        assert!(filter.children_of.is_none());
        assert!(!filter.include_done);
        assert!(!filter.include_archived);
        assert!(filter.search.is_none());
        assert!(filter.workflow_id.is_none());
        assert!(filter.current_step.is_none());
    }

    #[test]
    fn task_filter_with_level() {
        let filter = TaskFilter::new().with_level(Level::Epic);
        assert_eq!(filter.levels, vec![Level::Epic]);
    }

    #[test]
    fn task_filter_with_levels() {
        let filter = TaskFilter::new().with_levels(vec![Level::Epic, Level::Ticket]);
        assert_eq!(filter.levels, vec![Level::Epic, Level::Ticket]);
    }

    #[test]
    fn task_filter_with_step_name() {
        let filter = TaskFilter::new().with_step_name("in_progress");
        assert_eq!(filter.step_names, vec!["in_progress"]);
    }

    #[test]
    fn task_filter_with_step_names() {
        let filter = TaskFilter::new().with_step_names(vec!["in_progress", "done"]);
        assert_eq!(filter.step_names, vec!["in_progress", "done"]);
    }

    #[test]
    fn task_filter_with_priority() {
        let filter = TaskFilter::new().with_priority(Priority::High);
        assert_eq!(filter.priorities, vec![Priority::High]);
    }

    #[test]
    fn task_filter_with_priorities() {
        let filter = TaskFilter::new().with_priorities(vec![Priority::High, Priority::Critical]);
        assert_eq!(filter.priorities, vec![Priority::High, Priority::Critical]);
    }

    #[test]
    fn task_filter_with_tag() {
        let filter = TaskFilter::new().with_tag("rust");
        assert_eq!(filter.tags, vec!["rust"]);
    }

    #[test]
    fn task_filter_with_tags() {
        let filter = TaskFilter::new().with_tags(vec!["rust", "cli"]);
        assert_eq!(filter.tags, vec!["rust", "cli"]);
    }

    #[test]
    fn task_filter_root_only() {
        let filter = TaskFilter::new().root_only();
        assert!(filter.root_only);
    }

    #[test]
    fn task_filter_children_of() {
        let filter = TaskFilter::new().children_of("parent123");
        assert_eq!(filter.children_of, Some("parent123".to_string()));
    }

    #[test]
    fn task_filter_include_done() {
        let filter = TaskFilter::new().include_done();
        assert!(filter.include_done);
    }

    #[test]
    fn task_filter_with_search() {
        let filter = TaskFilter::new().with_search("authentication");
        assert_eq!(filter.search, Some("authentication".to_string()));
    }

    #[test]
    fn task_filter_with_workflow_id() {
        let filter = TaskFilter::new().with_workflow_id("wf123");
        assert_eq!(filter.workflow_id, Some("wf123".to_string()));
    }

    #[test]
    fn task_filter_with_current_step() {
        let filter = TaskFilter::new().with_current_step("review");
        assert_eq!(filter.current_step, Some("review".to_string()));
    }

    #[test]
    fn task_filter_include_archived() {
        let filter = TaskFilter::new().include_archived();
        assert!(filter.include_archived);
    }

    #[test]
    fn task_filter_chain_multiple() {
        let filter = TaskFilter::new()
            .root_only()
            .with_level(Level::Epic)
            .with_priority(Priority::High)
            .with_search("test")
            .include_done()
            .include_archived();
        assert!(filter.root_only);
        assert_eq!(filter.levels, vec![Level::Epic]);
        assert_eq!(filter.priorities, vec![Priority::High]);
        assert_eq!(filter.search, Some("test".to_string()));
        assert!(filter.include_done);
        assert!(filter.include_archived);
    }

    #[test]
    fn task_archived_serde_default() {
        let json = r#"{"id":"1","title":"T","level":"task","tags":[]}"#;
        let task: Task = serde_json::from_str(json).unwrap();
        assert!(!task.archived);
    }

    #[test]
    fn task_archived_serde_roundtrip() {
        let mut task = Task::new("T", Level::Task);
        task.archived = true;
        let json = serde_json::to_string(&task).unwrap();
        let parsed: Task = serde_json::from_str(&json).unwrap();
        assert!(parsed.archived);
    }

    // ─── AgentConfig Tests ──────────────────────────────────────────

    #[test]
    fn agent_config_new() {
        let config = AgentConfig::new();
        assert!(config.is_empty());

        let config2 = AgentConfig::new().with_model("claude");
        assert!(!config2.is_empty());
    }

    #[test]
    fn agent_config_with_model() {
        let config = AgentConfig::new().with_model("claude-opus");
        assert_eq!(config.model, Some("claude-opus".to_string()));
        assert!(!config.is_empty());
    }

    #[test]
    fn agent_config_with_fallback_model() {
        let config = AgentConfig::new().with_fallback_model("claude-sonnet");
        assert_eq!(config.fallback_model, Some("claude-sonnet".to_string()));
    }

    #[test]
    fn agent_config_with_system_prompt() {
        let config = AgentConfig::new().with_system_prompt("Be helpful");
        assert_eq!(config.system_prompt, Some("Be helpful".to_string()));
    }

    #[test]
    fn agent_config_with_append_system_prompt() {
        let config = AgentConfig::new().with_append_system_prompt("Also be concise");
        assert_eq!(
            config.append_system_prompt,
            Some("Also be concise".to_string())
        );
    }

    #[test]
    fn agent_config_with_tools() {
        let tools = vec!["read".to_string(), "write".to_string()];
        let config = AgentConfig::new().with_tools(tools.clone());
        assert_eq!(config.tools, tools);
    }

    #[test]
    fn agent_config_with_allowed_tools() {
        let tools = vec!["bash".to_string()];
        let config = AgentConfig::new().with_allowed_tools(tools.clone());
        assert_eq!(config.allowed_tools, tools);
    }

    #[test]
    fn agent_config_with_disallowed_tools() {
        let tools = vec!["rm".to_string()];
        let config = AgentConfig::new().with_disallowed_tools(tools.clone());
        assert_eq!(config.disallowed_tools, tools);
    }

    #[test]
    fn agent_config_with_permission_mode() {
        let config = AgentConfig::new().with_permission_mode(PermissionMode::Plan);
        assert_eq!(config.permission_mode, Some(PermissionMode::Plan));
    }

    #[test]
    fn agent_config_with_max_budget_usd() {
        let config = AgentConfig::new().with_max_budget_usd(10.5);
        assert_eq!(config.max_budget_usd, Some(10.5));
    }

    #[test]
    fn agent_config_with_mcp_config() {
        let configs = vec!["config1".to_string()];
        let config = AgentConfig::new().with_mcp_config(configs.clone());
        assert_eq!(config.mcp_config, configs);
    }

    #[test]
    fn agent_config_with_plugin_dirs() {
        let dirs = vec!["plugins/".to_string()];
        let config = AgentConfig::new().with_plugin_dirs(dirs.clone());
        assert_eq!(config.plugin_dirs, dirs);
    }

    #[test]
    fn agent_config_with_json_schema() {
        let schema = serde_json::json!({"type": "object"});
        let config = AgentConfig::new().with_json_schema(schema.clone());
        assert_eq!(config.json_schema, Some(schema));
    }

    #[test]
    fn agent_config_is_empty() {
        let config = AgentConfig::new();
        assert!(config.is_empty());

        let config2 = AgentConfig::new().with_model("claude");
        assert!(!config2.is_empty());
    }

    #[test]
    fn agent_config_to_cli_args() {
        let config = AgentConfig::new()
            .with_model("claude-opus")
            .with_fallback_model("claude-sonnet")
            .with_system_prompt("Be helpful")
            .with_tools(vec!["bash".to_string()])
            .with_permission_mode(PermissionMode::Plan)
            .with_max_budget_usd(5.5);

        let args = config.to_cli_args();
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"claude-opus".to_string()));
        assert!(args.contains(&"--fallback-model".to_string()));
        assert!(args.contains(&"claude-sonnet".to_string()));
        assert!(args.contains(&"--system-prompt".to_string()));
        assert!(args.contains(&"Be helpful".to_string()));
        assert!(args.contains(&"--tools".to_string()));
        assert!(args.contains(&"bash".to_string()));
        assert!(args.contains(&"--permission-mode".to_string()));
        assert!(args.contains(&"plan".to_string()));
        assert!(args.contains(&"--max-budget-usd".to_string()));
    }

    #[test]
    fn agent_config_merge() {
        let config1 = AgentConfig::new()
            .with_model("claude-opus")
            .with_system_prompt("Original");
        let config2 = AgentConfig::new()
            .with_model("claude-sonnet")
            .with_fallback_model("claude-haiku")
            .with_permission_mode(PermissionMode::Delegate);

        let merged = config1.merge(config2);
        assert_eq!(merged.model, Some("claude-sonnet".to_string()));
        assert_eq!(merged.system_prompt, Some("Original".to_string()));
        assert_eq!(merged.fallback_model, Some("claude-haiku".to_string()));
        assert_eq!(merged.permission_mode, Some(PermissionMode::Delegate));
    }

    #[test]
    fn agent_config_equality() {
        let config1 = AgentConfig::new()
            .with_model("claude")
            .with_max_budget_usd(10.5);
        let config2 = AgentConfig::new()
            .with_model("claude")
            .with_max_budget_usd(10.5);
        assert_eq!(config1, config2);

        let config3 = AgentConfig::new()
            .with_model("claude")
            .with_max_budget_usd(20.0);
        assert_ne!(config1, config3);
    }

    #[test]
    fn format_float_whole() {
        let formatted = format_float(5.0);
        assert_eq!(formatted, "5");
    }

    #[test]
    fn format_float_with_decimals() {
        let formatted = format_float(5.5);
        assert_eq!(formatted, "5.5");

        let formatted2 = format_float(5.55);
        assert_eq!(formatted2, "5.55");
    }

    #[test]
    fn format_float_trailing_zeros() {
        let formatted = format_float(5.500);
        assert_eq!(formatted, "5.5");

        let formatted2 = format_float(5.10);
        assert_eq!(formatted2, "5.1");
    }
}
