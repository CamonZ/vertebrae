//! Domain models for Vertebrae
//!
//! These are the canonical domain models for the Vertebrae task management system.
//! All IDs are plain strings rather than database-specific record types.

use crate::model_catalog::Provider;
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
    pub const ALL: [SectionType; 9] = [
        SectionType::Goal,
        SectionType::Context,
        SectionType::CurrentBehavior,
        SectionType::DesiredBehavior,
        SectionType::ChecklistItem,
        SectionType::TestingCriterion,
        SectionType::AntiPattern,
        SectionType::FailureTest,
        SectionType::Constraint,
    ];

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

/// The type of a workflow step.
///
/// `Stop` marks a run boundary: reaching it stops the current TaskRun without
/// completing the task, and the single outgoing transition is followed by a
/// later TaskRun. `Finish` is the promptless terminal step that completes the
/// task.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum StepType {
    #[default]
    Execute,
    Evaluate,
    Route,
    WaitChildren,
    HumanInput,
    /// Ends the current task run at a workflow boundary without completing the task.
    Stop,
    Finish,
    Unsupported(String),
}

impl StepType {
    pub fn from_wire_str(value: &str) -> Self {
        match value {
            "execute" => StepType::Execute,
            "evaluate" => StepType::Evaluate,
            "route" => StepType::Route,
            "wait_children" => StepType::WaitChildren,
            "human_input" => StepType::HumanInput,
            "stop" => StepType::Stop,
            "finish" => StepType::Finish,
            _ => StepType::Unsupported(value.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            StepType::Execute => "execute",
            StepType::Evaluate => "evaluate",
            StepType::Route => "route",
            StepType::WaitChildren => "wait_children",
            StepType::HumanInput => "human_input",
            StepType::Stop => "stop",
            StepType::Finish => "finish",
            StepType::Unsupported(value) => value.as_str(),
        }
    }

    /// The JSON Schema that route steps must use as their output_schema.
    /// Must match the Sacrum backend's `routing_contract_schema/0`.
    ///
    /// The `handoff` property is optional; route steps that do not emit a
    /// handoff payload may use [`Self::routing_contract_schema_without_handoff`]
    /// instead. Both shapes are accepted by the Sacrum validator.
    pub fn routing_contract_schema() -> serde_json::Value {
        let mut schema = Self::routing_contract_schema_without_handoff();
        schema["properties"]["handoff"] = serde_json::json!({
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
        });
        schema["required"] = serde_json::json!(["transition_to", "transition_type", "handoff"]);
        schema
    }

    /// The routing contract shape without the optional `handoff` property.
    /// Kept as a canonical alternative so route steps that do not emit a
    /// handoff payload still pass validation. Must match the Sacrum backend's
    /// `routing_contract_schema_without_handoff/0`.
    pub fn routing_contract_schema_without_handoff() -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "transition_to": {"type": "string"},
                "transition_type": {"type": "string", "enum": ["intra_workflow", "inter_workflow"]}
            },
            "required": ["transition_to", "transition_type"],
            "additionalProperties": false
        })
    }
}

impl serde::Serialize for StepType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> serde::Deserialize<'de> for StepType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(StepType::from_wire_str(&value))
    }
}

impl std::fmt::Display for StepType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
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

/// Durable lifecycle status for a task workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

impl TaskRunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskRunStatus::Queued => "queued",
            TaskRunStatus::Executing => "executing",
            TaskRunStatus::Waiting => "waiting",
            TaskRunStatus::Stopping => "stopping",
            TaskRunStatus::Stopped => "stopped",
            TaskRunStatus::Completed => "completed",
            TaskRunStatus::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(TaskRunStatus::Queued),
            "executing" => Some(TaskRunStatus::Executing),
            "waiting" => Some(TaskRunStatus::Waiting),
            "stopping" => Some(TaskRunStatus::Stopping),
            "stopped" => Some(TaskRunStatus::Stopped),
            "completed" => Some(TaskRunStatus::Completed),
            "failed" => Some(TaskRunStatus::Failed),
            _ => None,
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            TaskRunStatus::Queued
                | TaskRunStatus::Executing
                | TaskRunStatus::Waiting
                | TaskRunStatus::Stopping
        )
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskRunStatus::Stopped | TaskRunStatus::Completed | TaskRunStatus::Failed
        )
    }

    pub fn is_stoppable(&self) -> bool {
        matches!(
            self,
            TaskRunStatus::Queued | TaskRunStatus::Executing | TaskRunStatus::Waiting
        )
    }
}

impl std::fmt::Display for TaskRunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Permission mode for Claude CLI execution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    AcceptEdits,
    #[serde(alias = "delegate")]
    Auto,
    BypassPermissions,
    Default,
    DontAsk,
    Plan,
}

impl PermissionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Auto => "auto",
            PermissionMode::BypassPermissions => "bypassPermissions",
            PermissionMode::Default => "default",
            PermissionMode::DontAsk => "dontAsk",
            PermissionMode::Plan => "plan",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "acceptEdits" => Some(PermissionMode::AcceptEdits),
            "auto" => Some(PermissionMode::Auto),
            "bypassPermissions" => Some(PermissionMode::BypassPermissions),
            "default" => Some(PermissionMode::Default),
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
    pub include_archived: bool,
    pub search: Option<String>,
    pub workflow_id: Option<String>,
    pub current_step: Option<String>,
    pub step_id: Option<String>,
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

    pub fn with_step_id(mut self, step_id: impl Into<String>) -> Self {
        self.step_id = Some(step_id.into());
        self
    }
}

/// Configuration for an agent execution.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Built-in execution provider. `None` means the implicit Anthropic default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_model_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
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

    pub fn with_provider(mut self, provider: Provider) -> Self {
        self.provider = Some(provider);
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn with_codex_model_provider(mut self, provider: impl Into<String>) -> Self {
        self.codex_model_provider = Some(provider.into().trim().to_ascii_lowercase());
        self
    }

    pub fn with_reasoning_effort(mut self, effort: impl Into<String>) -> Self {
        self.reasoning_effort = Some(effort.into().trim().to_ascii_lowercase());
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

    /// Translate this config into Claude Code CLI flags. Anthropic-specific —
    /// other providers must use their own translator.
    pub fn to_claude_cli_args(&self) -> Vec<String> {
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
        self.provider.is_none()
            && self.model.is_none()
            && self.codex_model_provider.is_none()
            && self.reasoning_effort.is_none()
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
        if other.provider.is_some() {
            self.provider = other.provider;
        }
        if other.model.is_some() {
            self.model = other.model;
        }
        if other.codex_model_provider.is_some() {
            self.codex_model_provider = other.codex_model_provider;
        }
        if other.reasoning_effort.is_some() {
            self.reasoning_effort = other.reasoning_effort;
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
        self.provider == other.provider
            && self.model == other.model
            && self.codex_model_provider == other.codex_model_provider
            && self.reasoning_effort == other.reasoning_effort
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

/// An artifact file, optionally enriched with attachment context.
///
/// Sacrum exposes the creation timestamp as `inserted_at`; the core model uses
/// the same `created_at` name as the other domain models while accepting both
/// wire names during deserialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    /// Unique artifact identifier.
    pub id: String,

    /// Project that owns the artifact when the operation establishes project scope.
    ///
    /// Sacrum's root `artifact(id:)` query is user-scoped and does not return
    /// the owning project. In that case this is `None`; clients must not infer
    /// ownership from their active project configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,

    /// Artifact filename.
    pub filename: String,

    /// Artifact body.
    pub body: String,

    /// Stable logical name of the attachment returned by an attachment-context
    /// operation. Root artifact reads may leave this unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_name: Option<String>,

    /// Provider-neutral attachment provenance returned by an attachment-context
    /// operation. Root artifact reads may leave this unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ArtifactLinkMetadata>,

    /// Creation timestamp.
    #[serde(alias = "inserted_at")]
    pub created_at: Option<DateTime<Utc>>,

    /// Last update timestamp.
    pub updated_at: Option<DateTime<Utc>>,
}

impl Artifact {
    /// Create an artifact value without persistence timestamps.
    pub fn new(
        id: impl Into<String>,
        project_id: impl Into<String>,
        filename: impl Into<String>,
        body: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            project_id: Some(project_id.into()),
            filename: filename.into(),
            body: body.into(),
            logical_name: None,
            metadata: None,
            created_at: None,
            updated_at: None,
        }
    }
}

/// Versioned, provider-neutral provenance for an artifact attachment.
///
/// The envelope mirrors Sacrum's supported contract. Provider-specific or
/// forward-compatible data belongs in `extensions` and is preserved exactly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactLinkMetadata {
    pub version: u32,
    pub content_kind: String,
    pub format: String,
    pub origin: String,
    pub presentation: String,
    pub extensions: serde_json::Map<String, serde_json::Value>,
}

impl ArtifactLinkMetadata {
    /// Create the current version of the required provenance envelope.
    pub fn new(
        content_kind: impl Into<String>,
        format: impl Into<String>,
        origin: impl Into<String>,
        presentation: impl Into<String>,
    ) -> Self {
        Self {
            version: 1,
            content_kind: content_kind.into(),
            format: format.into(),
            origin: origin.into(),
            presentation: presentation.into(),
            extensions: serde_json::Map::new(),
        }
    }

    /// Add or replace an opaque extension without interpreting its value.
    pub fn with_extension(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.extensions.insert(key.into(), value);
        self
    }

    /// Validate the versioned envelope required by Sacrum.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 {
            return Err("metadata version must be 1");
        }
        for (field, value) in [
            ("metadata content_kind", &self.content_kind),
            ("metadata format", &self.format),
            ("metadata origin", &self.origin),
            ("metadata presentation", &self.presentation),
        ] {
            if value.trim().is_empty() {
                return Err(match field {
                    "metadata content_kind" => "metadata content_kind must not be blank",
                    "metadata format" => "metadata format must not be blank",
                    "metadata origin" => "metadata origin must not be blank",
                    _ => "metadata presentation must not be blank",
                });
            }
        }
        Ok(())
    }
}

fn validate_attachment_fields(
    subject_type: &Option<String>,
    subject_id: &Option<String>,
    logical_name: &Option<String>,
    metadata: &Option<ArtifactLinkMetadata>,
) -> Result<(), &'static str> {
    match (subject_type, subject_id) {
        (None, None) => {}
        (Some(subject_type), Some(subject_id)) => {
            if !matches!(
                subject_type.as_str(),
                "project" | "task" | "task_section" | "workflow" | "task_run" | "step_execution"
            ) {
                return Err("subject_type must be a supported artifact subject type");
            }
            if subject_id.trim().is_empty() {
                return Err("subject_id must not be blank");
            }
        }
        _ => return Err("subject_type and subject_id must be provided together"),
    }

    if logical_name
        .as_ref()
        .is_some_and(|name| name.trim().is_empty())
    {
        return Err("logical_name must not be blank");
    }
    if logical_name
        .as_ref()
        .is_some_and(|name| name.chars().count() > 255)
    {
        return Err("logical_name must be at most 255 characters");
    }
    if let Some(metadata) = metadata {
        metadata.validate()?;
    }
    Ok(())
}

/// Input for creating an artifact.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateArtifactInput {
    /// Artifact filename.
    pub filename: String,

    /// Artifact body.
    pub body: String,

    /// Optional type of the artifact's direct attachment target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_type: Option<String>,

    /// Optional ID of the artifact's direct attachment target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,

    /// Optional stable logical name for the new attachment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_name: Option<String>,

    /// Optional versioned provenance for the new attachment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ArtifactLinkMetadata>,
}

impl CreateArtifactInput {
    /// Create input for a standalone artifact.
    pub fn new(filename: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            filename: filename.into(),
            body: body.into(),
            subject_type: None,
            subject_id: None,
            logical_name: None,
            metadata: None,
        }
    }

    /// Set the direct attachment target.
    pub fn with_subject(
        mut self,
        subject_type: impl Into<String>,
        subject_id: impl Into<String>,
    ) -> Self {
        self.subject_type = Some(subject_type.into());
        self.subject_id = Some(subject_id.into());
        self
    }

    /// Set the attachment's stable logical name.
    pub fn with_logical_name(mut self, logical_name: impl Into<String>) -> Self {
        self.logical_name = Some(logical_name.into());
        self
    }

    /// Set versioned attachment provenance.
    pub fn with_metadata(mut self, metadata: ArtifactLinkMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Validate the optional direct attachment target.
    ///
    /// Sacrum accepts a target only when both its type and ID are supplied.
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_attachment_fields(
            &self.subject_type,
            &self.subject_id,
            &self.logical_name,
            &self.metadata,
        )
    }
}

/// Input for updating an artifact.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateArtifactInput {
    /// New artifact filename.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,

    /// New artifact body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,

    /// Replacement attachment target. Both values must be supplied together.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_type: Option<String>,

    /// Replacement attachment target ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,

    /// Updated stable logical name for the attachment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_name: Option<String>,

    /// Updated versioned provenance for the attachment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ArtifactLinkMetadata>,
}

impl UpdateArtifactInput {
    /// Create empty update input.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a new filename.
    pub fn with_filename(mut self, filename: impl Into<String>) -> Self {
        self.filename = Some(filename.into());
        self
    }

    /// Set a new body.
    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// Replace the attachment target.
    pub fn with_subject(
        mut self,
        subject_type: impl Into<String>,
        subject_id: impl Into<String>,
    ) -> Self {
        self.subject_type = Some(subject_type.into());
        self.subject_id = Some(subject_id.into());
        self
    }

    /// Update the attachment's stable logical name.
    pub fn with_logical_name(mut self, logical_name: impl Into<String>) -> Self {
        self.logical_name = Some(logical_name.into());
        self
    }

    /// Update versioned attachment provenance.
    pub fn with_metadata(mut self, metadata: ArtifactLinkMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Validate supported attachment fields.
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_attachment_fields(
            &self.subject_type,
            &self.subject_id,
            &self.logical_name,
            &self.metadata,
        )
    }

    /// Whether this input changes at least one artifact field.
    pub fn has_updates(&self) -> bool {
        self.filename.is_some()
            || self.body.is_some()
            || self.subject_type.is_some()
            || self.subject_id.is_some()
            || self.logical_name.is_some()
            || self.metadata.is_some()
    }
}

/// Input for retrieving a project-subject attachment by its stable logical name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GetArtifactByLogicalNameInput {
    pub subject_type: String,
    pub subject_id: String,
    pub logical_name: String,
}

impl GetArtifactByLogicalNameInput {
    pub fn new(
        subject_type: impl Into<String>,
        subject_id: impl Into<String>,
        logical_name: impl Into<String>,
    ) -> Self {
        Self {
            subject_type: subject_type.into(),
            subject_id: subject_id.into(),
            logical_name: logical_name.into(),
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        validate_attachment_fields(
            &Some(self.subject_type.clone()),
            &Some(self.subject_id.clone()),
            &Some(self.logical_name.clone()),
            &None,
        )
    }
}

/// Input for listing the artifacts attached to the active project.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListArtifactInput {
    /// Maximum number of artifacts to return.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,

    /// Number of artifacts to skip before returning results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
}

impl ListArtifactInput {
    /// Create an input using Sacrum's default pagination.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the maximum number of artifacts to return.
    pub fn with_limit(mut self, limit: i32) -> Self {
        self.limit = Some(limit);
        self
    }

    /// Set the number of artifacts to skip.
    pub fn with_offset(mut self, offset: i32) -> Self {
        self.offset = Some(offset);
        self
    }
}

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

    /// Current step type (if task has a current step in workflow)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_type: Option<StepType>,

    /// Server-derived TaskRun controls for Run/Stop surfaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_controls: Option<TaskRunControls>,

    /// Whether this task is archived
    #[serde(default)]
    pub archived: bool,

    /// Optional worktree path for this task
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,

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
            step_type: None,
            run_controls: None,
            archived: false,
            worktree: None,
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
            && self.workflow_id == other.workflow_id
            && self.current_step_id == other.current_step_id
            && self.run_controls == other.run_controls
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

    /// Agent file paths
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,

    /// Skill names
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,

    /// Agent configuration
    #[serde(default)]
    pub agent_config: AgentConfig,

    /// The type of this step (execute, evaluate, route, wait_children,
    /// human_input, or finish)
    #[serde(default)]
    pub step_type: StepType,

    /// JSON Schema describing the expected output of this step
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,

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
            agents: Vec::new(),
            skills: Vec::new(),
            agent_config: AgentConfig::default(),
            step_type: StepType::default(),
            output_schema: None,
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

    /// Set the step type
    pub fn with_step_type(mut self, step_type: StepType) -> Self {
        self.step_type = step_type;
        self
    }

    /// Set the output schema
    pub fn with_output_schema(mut self, schema: serde_json::Value) -> Self {
        self.output_schema = Some(schema);
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

    /// Display order
    #[serde(default)]
    pub order: i32,

    /// Whether this is the default workflow for new tasks
    #[serde(default)]
    pub is_default: bool,

    /// Optional kanban column for workflows
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kanban_column: Option<String>,

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
            order: 0,
            is_default: false,
            kanban_column: None,
            transitions: Vec::new(),
            created_at: None,
            updated_at: None,
        }
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

    /// Set whether this is the default workflow
    pub fn with_is_default(mut self, is_default: bool) -> Self {
        self.is_default = is_default;
        self
    }

    /// Set the kanban column
    pub fn with_kanban_column(mut self, kanban_column: impl Into<String>) -> Self {
        self.kanban_column = Some(kanban_column.into());
        self
    }
}

impl PartialEq for Workflow {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
            && self.description == other.description
            && self.initial_step == other.initial_step
            && self.metadata == other.metadata
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

    /// Task run ID, when the execution belongs to a durable TaskRun.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_run_id: Option<String>,

    /// Workflow ID
    pub workflow_id: String,

    /// Step name
    pub step_name: String,

    /// Semantic workflow step type, when provided by Sacrum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_type: Option<String>,

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

    /// Model provider (e.g., "anthropic", "openai")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,

    /// Handoff payload from a route step — JSON-encoded string mirroring the
    /// sacrum `handoff` map field. Optional because most executions do not
    /// emit a handoff.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff: Option<String>,
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
            task_run_id: None,
            workflow_id: workflow_id.into(),
            step_name: step_name.into(),
            step_type: None,
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
            model_provider: None,
            handoff: None,
        }
    }

    /// Set model provider
    pub fn with_model_provider(mut self, provider: impl Into<String>) -> Self {
        self.model_provider = Some(provider.into());
        self
    }

    /// Set task run ID
    pub fn with_task_run_id(mut self, task_run_id: impl Into<String>) -> Self {
        self.task_run_id = Some(task_run_id.into());
        self
    }

    /// Set handoff payload (JSON-encoded string)
    pub fn with_handoff(mut self, handoff: impl Into<String>) -> Self {
        self.handoff = Some(handoff.into());
        self
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
            && self.task_run_id == other.task_run_id
            && self.workflow_id == other.workflow_id
            && self.step_name == other.step_name
            && self.step_type == other.step_type
            && self.status == other.status
    }
}

impl Eq for StepExecution {}

/// A durable workflow run for a task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRun {
    /// Unique identifier.
    pub id: String,

    /// Task ID.
    pub task_id: String,

    /// Project ID.
    pub project_id: String,

    /// User ID, present in GraphQL responses that request it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,

    /// Durable run lifecycle status.
    pub status: TaskRunStatus,

    /// Effective maximum number of concurrent step attempts for this run's
    /// root TaskRun tree. `None` uses Sacrum's global execution-pool limit.
    #[serde(default)]
    pub max_concurrency: Option<i32>,

    /// When the run started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,

    /// When the run ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime<Utc>>,

    /// When a stop was requested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_requested_at: Option<DateTime<Utc>>,

    /// Latest step execution ID associated with the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_step_execution_id: Option<String>,

    /// Terminal outcome kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_kind: Option<String>,

    /// Structured terminal outcome context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_context: Option<serde_json::Value>,

    /// Parent task run ID for child workflow runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_run_id: Option<String>,

    /// Root task run ID for a trace tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_task_run_id: Option<String>,

    /// Step execution that triggered this child run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggered_by_step_execution_id: Option<String>,

    /// Creation timestamp from Sacrum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inserted_at: Option<DateTime<Utc>>,

    /// Last update timestamp from Sacrum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

impl TaskRun {
    pub fn is_active(&self) -> bool {
        self.status.is_active()
    }

    pub fn is_terminal(&self) -> bool {
        self.status.is_terminal()
    }

    pub fn is_stoppable(&self) -> bool {
        self.status.is_stoppable()
    }
}

/// Compact TaskRun representation for list and control surfaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRunSummary {
    pub id: String,
    pub task_id: String,
    pub status: TaskRunStatus,
    #[serde(default)]
    pub max_concurrency: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_step_execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_task_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggered_by_step_execution_id: Option<String>,
}

impl From<&TaskRun> for TaskRunSummary {
    fn from(run: &TaskRun) -> Self {
        Self {
            id: run.id.clone(),
            task_id: run.task_id.clone(),
            status: run.status.clone(),
            max_concurrency: run.max_concurrency,
            started_at: run.started_at,
            ended_at: run.ended_at,
            latest_step_execution_id: run.latest_step_execution_id.clone(),
            parent_task_run_id: run.parent_task_run_id.clone(),
            root_task_run_id: run.root_task_run_id.clone(),
            triggered_by_step_execution_id: run.triggered_by_step_execution_id.clone(),
        }
    }
}

/// Server-derived controls for Run/Stop task actions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRunControls {
    #[serde(default)]
    pub runnable: bool,
    #[serde(default)]
    pub stoppable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_run: Option<TaskRun>,
}

/// Trace tree for a root TaskRun, including child runs and related records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRunTrace {
    pub root_task_run_id: String,
    #[serde(default)]
    pub task_runs: Vec<TaskRun>,
    #[serde(default)]
    pub step_executions: Vec<StepExecution>,
    #[serde(default)]
    pub session_logs: Vec<SessionLog>,
}

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

    /// Log format, e.g. stream-json or openai
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,

    /// Stable key for log entries that should be updated in place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_key: Option<String>,

    /// When created
    #[serde(alias = "inserted_at")]
    pub created_at: DateTime<Utc>,
}

impl SessionLog {
    /// Create a new session log
    pub fn new(step_execution_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            id: None,
            step_execution_id: step_execution_id.into(),
            content: content.into(),
            format: None,
            logical_key: None,
            created_at: Utc::now(),
        }
    }

    /// Set log format
    pub fn with_format(mut self, format: impl Into<String>) -> Self {
        self.format = Some(format.into());
        self
    }

    /// Set logical key for upsertable session logs
    pub fn with_logical_key(mut self, logical_key: impl Into<String>) -> Self {
        self.logical_key = Some(logical_key.into());
        self
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
    /// New agents list
    pub agents: Option<Vec<String>>,
    /// New skills list
    pub skills: Option<Vec<String>>,
    /// New agent config
    pub agent_config: Option<serde_json::Value>,
    /// New step type
    pub step_type: Option<StepType>,
    /// New output schema
    pub output_schema: Option<Option<serde_json::Value>>,
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

    /// Set the step type
    pub fn with_step_type(mut self, step_type: StepType) -> Self {
        self.step_type = Some(step_type);
        self
    }

    /// Set the output schema (Some to set, None to clear)
    pub fn with_output_schema(mut self, schema: Option<serde_json::Value>) -> Self {
        self.output_schema = Some(schema);
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

    // ─── Artifact ──────────────────────────────────────────────────

    #[test]
    fn artifact_preserves_identity_and_content() {
        let artifact = Artifact::new("artifact-1", "project-1", "notes.md", "hello");

        assert_eq!(artifact.id, "artifact-1");
        assert_eq!(artifact.project_id.as_deref(), Some("project-1"));
        assert_eq!(artifact.filename, "notes.md");
        assert_eq!(artifact.body, "hello");
        assert!(artifact.created_at.is_none());
        assert!(artifact.updated_at.is_none());
    }

    #[test]
    fn artifact_deserializes_sacrum_inserted_at_timestamp() {
        let artifact: Artifact = serde_json::from_value(serde_json::json!({
            "id": "artifact-1",
            "project_id": "project-1",
            "filename": "notes.md",
            "body": "hello",
            "inserted_at": "2026-07-29T12:00:00Z",
            "updated_at": "2026-07-29T12:01:00Z"
        }))
        .expect("artifact response should deserialize");

        assert_eq!(
            artifact.created_at,
            Some("2026-07-29T12:00:00Z".parse().unwrap())
        );
        assert_eq!(
            artifact.updated_at,
            Some("2026-07-29T12:01:00Z".parse().unwrap())
        );
    }

    #[test]
    fn create_artifact_input_requires_subject_type_and_id_together() {
        let standalone = CreateArtifactInput::new("notes.md", "hello");
        assert!(standalone.validate().is_ok());

        let attached = standalone.clone().with_subject("task", "task-1");
        assert!(attached.validate().is_ok());

        let missing_id = CreateArtifactInput {
            subject_type: Some("task".into()),
            ..standalone.clone()
        };
        assert_eq!(
            missing_id.validate(),
            Err("subject_type and subject_id must be provided together")
        );

        let missing_type = CreateArtifactInput {
            subject_id: Some("task-1".into()),
            ..standalone
        };
        assert_eq!(
            missing_type.validate(),
            Err("subject_type and subject_id must be provided together")
        );
    }

    #[test]
    fn artifact_link_metadata_preserves_extensions_and_validates_envelope() {
        let metadata = ArtifactLinkMetadata::new("conversation", "jsonl", "harness", "raw")
            .with_extension("provider", serde_json::json!({"trace": [1, 2]}));
        assert!(metadata.validate().is_ok());
        assert_eq!(
            serde_json::to_value(&metadata).unwrap()["extensions"]["provider"]["trace"],
            serde_json::json!([1, 2])
        );

        assert_eq!(
            ArtifactLinkMetadata {
                version: 2,
                ..metadata.clone()
            }
            .validate(),
            Err("metadata version must be 1")
        );
        for (metadata, expected) in [
            (
                ArtifactLinkMetadata {
                    content_kind: " ".into(),
                    ..metadata.clone()
                },
                "metadata content_kind must not be blank",
            ),
            (
                ArtifactLinkMetadata {
                    format: " ".into(),
                    ..metadata.clone()
                },
                "metadata format must not be blank",
            ),
            (
                ArtifactLinkMetadata {
                    origin: " ".into(),
                    ..metadata.clone()
                },
                "metadata origin must not be blank",
            ),
            (
                ArtifactLinkMetadata {
                    presentation: " ".into(),
                    ..metadata
                },
                "metadata presentation must not be blank",
            ),
        ] {
            assert_eq!(metadata.validate(), Err(expected));
        }

        assert!(
            serde_json::from_value::<ArtifactLinkMetadata>(serde_json::json!({
                "version": 1,
                "content_kind": "conversation",
                "format": "jsonl",
                "origin": "harness",
                "presentation": "raw"
            }))
            .is_err()
        );
    }

    #[test]
    fn attachment_inputs_validate_supported_subjects_and_link_fields() {
        let metadata = ArtifactLinkMetadata::new("result", "markdown", "agent", "rendered");
        let create = CreateArtifactInput::new("result.md", "# Result")
            .with_subject("task", "task-id")
            .with_logical_name("result")
            .with_metadata(metadata.clone());
        assert!(create.validate().is_ok());

        assert_eq!(
            CreateArtifactInput::new("x", "x")
                .with_subject("unknown", "subject")
                .validate(),
            Err("subject_type must be a supported artifact subject type")
        );
        assert_eq!(
            CreateArtifactInput::new("x", "x")
                .with_logical_name(" ")
                .validate(),
            Err("logical_name must not be blank")
        );
        assert_eq!(
            CreateArtifactInput::new("x", "x")
                .with_logical_name("x".repeat(256))
                .validate(),
            Err("logical_name must be at most 255 characters")
        );

        let update = UpdateArtifactInput::new()
            .with_logical_name("result")
            .with_metadata(metadata);
        assert!(update.has_updates());
        assert!(update.validate().is_ok());
    }

    #[test]
    fn logical_name_lookup_requires_a_complete_supported_subject() {
        assert!(
            GetArtifactByLogicalNameInput::new("task", "task-id", "result")
                .validate()
                .is_ok()
        );
        assert_eq!(
            GetArtifactByLogicalNameInput::new("task", "", "result").validate(),
            Err("subject_id must not be blank")
        );
    }

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
        assert!(!task.archived);
    }

    #[test]
    fn task_builder_methods() {
        let task = Task::new("T", Level::Epic)
            .with_description("desc")
            .with_priority(Priority::High)
            .with_tag("rust")
            .with_tags(vec!["cli", "core"])
            .with_workflow("wf1".into(), "s1".into())
            .with_current_step_id("s2".into());

        assert_eq!(task.description.as_deref(), Some("desc"));
        assert_eq!(task.priority, Some(Priority::High));
        assert_eq!(task.tags, vec!["rust", "cli", "core"]);
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
            .with_transition("step2")
            .with_transitions_to(vec!["s3".into()])
            .with_order(5);

        assert_eq!(step.name, "review");
        assert_eq!(step.workflow_id, "wf1");
        assert_eq!(step.goal.as_deref(), Some("Review the code"));
        assert_eq!(step.agents, vec!["agent1"]);
        assert_eq!(step.skills, vec!["lint"]);
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
            .with_order(2)
            .with_metadata("key", "value")
            .with_initial_step("step1");

        assert_eq!(wf.name, "Dev");
        assert_eq!(wf.description.as_deref(), Some("Development workflow"));
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

    // ─── TaskRun ───────────────────────────────────────────────────

    #[test]
    fn task_run_status_parse_display_and_helpers() {
        assert_eq!(TaskRunStatus::parse("queued"), Some(TaskRunStatus::Queued));
        assert_eq!(
            TaskRunStatus::parse("executing"),
            Some(TaskRunStatus::Executing)
        );
        assert_eq!(
            TaskRunStatus::parse("waiting"),
            Some(TaskRunStatus::Waiting)
        );
        assert_eq!(
            TaskRunStatus::parse("stopping"),
            Some(TaskRunStatus::Stopping)
        );
        assert_eq!(
            TaskRunStatus::parse("stopped"),
            Some(TaskRunStatus::Stopped)
        );
        assert_eq!(
            TaskRunStatus::parse("completed"),
            Some(TaskRunStatus::Completed)
        );
        assert_eq!(TaskRunStatus::parse("failed"), Some(TaskRunStatus::Failed));
        assert_eq!(TaskRunStatus::parse("unknown"), None);

        assert_eq!(TaskRunStatus::Waiting.to_string(), "waiting");
        assert!(TaskRunStatus::Executing.is_active());
        assert!(TaskRunStatus::Stopping.is_active());
        assert!(!TaskRunStatus::Stopping.is_stoppable());
        assert!(TaskRunStatus::Completed.is_terminal());
    }

    #[test]
    fn task_run_deserializes_snake_case_lineage_fields() {
        let json = r#"{
            "id": "run-child",
            "task_id": "task-child",
            "project_id": "project-1",
            "user_id": "user-1",
            "status": "waiting",
            "max_concurrency": 3,
            "started_at": "2026-05-07T12:00:00Z",
            "ended_at": null,
            "stop_requested_at": null,
            "latest_step_execution_id": "exec-child",
            "outcome_kind": null,
            "outcome_context": {"retry_count": 1},
            "parent_task_run_id": "run-parent",
            "root_task_run_id": "run-root",
            "triggered_by_step_execution_id": "exec-parent",
            "inserted_at": "2026-05-07T12:00:00Z",
            "updated_at": "2026-05-07T12:01:00Z"
        }"#;

        let run: TaskRun = serde_json::from_str(json).expect("deserialize task run");

        assert_eq!(run.id, "run-child");
        assert_eq!(run.task_id, "task-child");
        assert_eq!(run.project_id, "project-1");
        assert_eq!(run.user_id.as_deref(), Some("user-1"));
        assert_eq!(run.status, TaskRunStatus::Waiting);
        assert_eq!(run.max_concurrency, Some(3));
        assert!(run.is_active());
        assert!(run.is_stoppable());
        assert_eq!(run.latest_step_execution_id.as_deref(), Some("exec-child"));
        assert_eq!(
            run.outcome_context
                .as_ref()
                .and_then(|context| context.get("retry_count"))
                .and_then(serde_json::Value::as_i64),
            Some(1)
        );
        assert_eq!(run.parent_task_run_id.as_deref(), Some("run-parent"));
        assert_eq!(run.root_task_run_id.as_deref(), Some("run-root"));
        assert_eq!(
            run.triggered_by_step_execution_id.as_deref(),
            Some("exec-parent")
        );
        assert!(run.started_at.is_some());
        assert!(run.inserted_at.is_some());
        assert!(run.updated_at.is_some());
    }

    #[test]
    fn task_run_trace_deserializes_snake_case_payload() {
        let json = r#"{
            "root_task_run_id": "run-root",
            "task_runs": [
                {
                    "id": "run-root",
                    "task_id": "task-root",
                    "project_id": "project-1",
                    "status": "executing",
                    "max_concurrency": 3,
                    "started_at": "2026-05-07T12:00:00Z",
                    "parent_task_run_id": null,
                    "root_task_run_id": null,
                    "triggered_by_step_execution_id": null
                },
                {
                    "id": "run-child",
                    "task_id": "task-child",
                    "project_id": "project-1",
                    "status": "queued",
                    "max_concurrency": 3,
                    "started_at": "2026-05-07T12:02:00Z",
                    "parent_task_run_id": "run-root",
                    "root_task_run_id": "run-root",
                    "triggered_by_step_execution_id": "exec-root"
                }
            ],
            "step_executions": [
                {
                    "id": "exec-root",
                    "task_id": "task-root",
                    "task_run_id": "run-root",
                    "workflow_id": "workflow-1",
                    "step_name": "wait_children",
                    "started_at": "2026-05-07T12:01:00Z",
                    "status": "completed"
                }
            ],
            "session_logs": [
                {
                    "id": "log-root",
                    "step_execution_id": "exec-root",
                    "content": "child scheduled",
                    "inserted_at": "2026-05-07T12:01:30Z",
                    "updated_at": "2026-05-07T12:01:30Z"
                }
            ]
        }"#;

        let trace: TaskRunTrace = serde_json::from_str(json).expect("deserialize trace");

        assert_eq!(trace.root_task_run_id, "run-root");
        assert_eq!(trace.task_runs.len(), 2);
        assert_eq!(trace.task_runs[0].max_concurrency, Some(3));
        assert_eq!(trace.task_runs[1].max_concurrency, Some(3));
        assert_eq!(trace.task_runs[0].parent_task_run_id, None);
        assert_eq!(
            trace.task_runs[1].parent_task_run_id.as_deref(),
            Some("run-root")
        );
        assert_eq!(
            trace.task_runs[1].root_task_run_id.as_deref(),
            Some("run-root")
        );
        assert_eq!(
            trace.task_runs[1].triggered_by_step_execution_id.as_deref(),
            Some("exec-root")
        );
        assert_eq!(trace.step_executions.len(), 1);
        assert_eq!(
            trace.step_executions[0].task_run_id.as_deref(),
            Some("run-root")
        );
        assert_eq!(trace.session_logs.len(), 1);
        assert_eq!(trace.session_logs[0].id.as_deref(), Some("log-root"));
        assert_eq!(trace.session_logs[0].content, "child scheduled");
    }

    // ─── StepExecution ──────────────────────────────────────────────

    #[test]
    fn step_execution_new_and_builders() {
        let exec = StepExecution::new("task1", "wf1", "review")
            .with_task_run_id("run1")
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
        assert_eq!(exec.task_run_id.as_deref(), Some("run1"));
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
    fn step_execution_handoff_and_model_provider_round_trip() {
        let exec = StepExecution::new("t", "w", "route")
            .with_model_provider("anthropic")
            .with_handoff(r#"{"to":"impl_step","reason":"approved"}"#);
        assert_eq!(exec.model_provider.as_deref(), Some("anthropic"));
        assert_eq!(
            exec.handoff.as_deref(),
            Some(r#"{"to":"impl_step","reason":"approved"}"#)
        );

        let json = serde_json::to_string(&exec).expect("serialize");
        assert!(json.contains("\"handoff\""));
        assert!(json.contains("\"model_provider\""));
        let back: StepExecution = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.handoff, exec.handoff);
        assert_eq!(back.model_provider, exec.model_provider);

        // When unset the fields should be omitted from the wire format.
        let bare = StepExecution::new("t", "w", "s");
        let bare_json = serde_json::to_string(&bare).expect("serialize bare");
        assert!(!bare_json.contains("\"handoff\""));
        assert!(!bare_json.contains("\"model_provider\""));
        assert!(!bare_json.contains("\"task_run_id\""));
    }

    #[test]
    fn step_execution_legacy_payload_defaults_task_run_id() {
        let json = r#"{
            "task_id": "task-1",
            "workflow_id": "workflow-1",
            "step_name": "execute",
            "started_at": "2026-05-07T12:00:00Z",
            "status": "in_progress"
        }"#;

        let execution: StepExecution =
            serde_json::from_str(json).expect("deserialize legacy step execution");

        assert_eq!(execution.task_id, "task-1");
        assert_eq!(execution.task_run_id, None);
        assert_eq!(execution.status, ExecutionStatus::InProgress);
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
        let log = SessionLog::new("exec1", "log content")
            .with_format("anthropic")
            .with_logical_key("thinking:sess-1")
            .with_created_at(t);
        assert_eq!(log.step_execution_id, "exec1");
        assert_eq!(log.content, "log content");
        assert_eq!(log.format.as_deref(), Some("anthropic"));
        assert_eq!(log.logical_key.as_deref(), Some("thinking:sess-1"));
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
            .with_transitions_to(vec!["s2".into()])
            .with_order(3);

        assert_eq!(u.name.as_deref(), Some("new_name"));
        assert_eq!(u.goal.as_deref(), Some("new_goal"));
        assert_eq!(u.agents.as_ref().unwrap(), &vec!["a1".to_string()]);
        assert_eq!(u.skills.as_ref().unwrap(), &vec!["s1".to_string()]);
        assert!(u.agent_config.is_some());
        assert_eq!(u.transitions_to.as_ref().unwrap(), &vec!["s2".to_string()]);
        assert_eq!(u.order, Some(3));
    }

    // ─── StepType Enum Tests ────────────────────────────────────────

    #[test]
    fn step_type_default_is_execute() {
        assert_eq!(StepType::default(), StepType::Execute);
    }

    #[test]
    fn step_type_as_str() {
        assert_eq!(StepType::Execute.as_str(), "execute");
        assert_eq!(StepType::Evaluate.as_str(), "evaluate");
        assert_eq!(StepType::Route.as_str(), "route");
        assert_eq!(StepType::WaitChildren.as_str(), "wait_children");
        assert_eq!(StepType::HumanInput.as_str(), "human_input");
        assert_eq!(StepType::Stop.as_str(), "stop");
        assert_eq!(StepType::Finish.as_str(), "finish");
        assert_eq!(
            StepType::Unsupported("manual_gate".to_string()).as_str(),
            "manual_gate"
        );
    }

    #[test]
    fn step_type_display() {
        assert_eq!(StepType::Execute.to_string(), "execute");
        assert_eq!(StepType::Evaluate.to_string(), "evaluate");
        assert_eq!(StepType::Route.to_string(), "route");
        assert_eq!(StepType::WaitChildren.to_string(), "wait_children");
        assert_eq!(StepType::HumanInput.to_string(), "human_input");
        assert_eq!(StepType::Stop.to_string(), "stop");
        assert_eq!(StepType::Finish.to_string(), "finish");
        assert_eq!(
            StepType::Unsupported("manual_gate".to_string()).to_string(),
            "manual_gate"
        );
    }

    #[test]
    fn routing_contract_schema_includes_optional_handoff() {
        let schema = StepType::routing_contract_schema();
        let expected = serde_json::json!({
            "type": "object",
            "properties": {
                "transition_to": {"type": "string"},
                "transition_type": {"type": "string", "enum": ["intra_workflow", "inter_workflow"]},
                "handoff": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                    "additionalProperties": false
                }
            },
            "required": ["transition_to", "transition_type", "handoff"],
            "additionalProperties": false
        });
        assert_eq!(schema, expected);
    }

    #[test]
    fn routing_contract_schema_without_handoff_matches_previous_shape() {
        let schema = StepType::routing_contract_schema_without_handoff();
        let expected = serde_json::json!({
            "type": "object",
            "properties": {
                "transition_to": {"type": "string"},
                "transition_type": {"type": "string", "enum": ["intra_workflow", "inter_workflow"]}
            },
            "required": ["transition_to", "transition_type"],
            "additionalProperties": false
        });
        assert_eq!(schema, expected);
    }

    #[test]
    fn step_type_serde_roundtrip() {
        for (variant, expected_json) in [
            (StepType::Execute, "\"execute\""),
            (StepType::Evaluate, "\"evaluate\""),
            (StepType::Route, "\"route\""),
            (StepType::WaitChildren, "\"wait_children\""),
            (StepType::HumanInput, "\"human_input\""),
            (StepType::Stop, "\"stop\""),
            (StepType::Finish, "\"finish\""),
        ] {
            let serialized = serde_json::to_string(&variant).unwrap();
            assert_eq!(serialized, expected_json);

            let deserialized: StepType = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, variant);
        }
    }

    #[test]
    fn step_type_serde_preserves_unknown_values() {
        let deserialized: StepType = serde_json::from_str("\"manual_gate\"").unwrap();
        assert_eq!(
            deserialized,
            StepType::Unsupported("manual_gate".to_string())
        );
        assert_eq!(
            serde_json::to_string(&deserialized).unwrap(),
            "\"manual_gate\""
        );
    }

    #[test]
    fn step_with_step_type_and_output_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "score": { "type": "number" }
            }
        });
        let step = Step::new("eval", "wf1")
            .with_step_type(StepType::Evaluate)
            .with_output_schema(schema.clone());

        assert_eq!(step.step_type, StepType::Evaluate);
        assert_eq!(step.output_schema, Some(schema));
    }

    #[test]
    fn step_new_defaults_step_type_to_execute() {
        let step = Step::new("run", "wf1");
        assert_eq!(step.step_type, StepType::Execute);
        assert_eq!(step.output_schema, None);
    }

    #[test]
    fn step_serde_roundtrip_with_new_fields() {
        let schema = serde_json::json!({"type": "string"});
        let step = Step::new("route_step", "wf1")
            .with_step_type(StepType::Route)
            .with_output_schema(schema.clone());

        let json = serde_json::to_string(&step).unwrap();
        let deserialized: Step = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.step_type, StepType::Route);
        assert_eq!(deserialized.output_schema, Some(schema));
    }

    #[test]
    fn step_deserializes_without_new_fields() {
        let json = r#"{"name":"legacy","workflow_id":"wf1"}"#;
        let step: Step = serde_json::from_str(json).unwrap();
        assert_eq!(step.step_type, StepType::Execute);
        assert_eq!(step.output_schema, None);
    }

    #[test]
    fn step_update_with_step_type_and_output_schema() {
        let schema = serde_json::json!({"type": "boolean"});
        let u = StepUpdate::new()
            .with_step_type(StepType::Evaluate)
            .with_output_schema(Some(schema.clone()));

        assert_eq!(u.step_type, Some(StepType::Evaluate));
        assert_eq!(u.output_schema, Some(Some(schema)));
    }

    #[test]
    fn step_update_clear_output_schema() {
        let u = StepUpdate::new().with_output_schema(None);
        assert_eq!(u.output_schema, Some(None));
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
        assert_eq!(PermissionMode::Auto.as_str(), "auto");
        assert_eq!(PermissionMode::Default.as_str(), "default");
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
        assert_eq!(PermissionMode::Auto.to_string(), "auto");
        assert_eq!(PermissionMode::Default.to_string(), "default");
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
        assert_eq!(PermissionMode::parse("auto"), Some(PermissionMode::Auto));
        assert_eq!(
            PermissionMode::parse("default"),
            Some(PermissionMode::Default)
        );
        assert_eq!(PermissionMode::parse("delegate"), None);
        assert_eq!(
            PermissionMode::parse("dontAsk"),
            Some(PermissionMode::DontAsk)
        );
        assert_eq!(PermissionMode::parse("plan"), Some(PermissionMode::Plan));
        assert_eq!(PermissionMode::parse("invalid"), None);
        assert_eq!(PermissionMode::parse(""), None);
    }

    #[test]
    fn permission_mode_deserializes_legacy_delegate_as_auto() {
        let config: AgentConfig = serde_json::from_value(serde_json::json!({
            "model": "claude-sonnet-4-5",
            "permission_mode": "delegate"
        }))
        .expect("legacy delegate should not discard the agent config");

        assert_eq!(config.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(config.permission_mode, Some(PermissionMode::Auto));
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
    fn task_filter_step_id_defaults_to_none() {
        let filter = TaskFilter::new();
        assert!(filter.step_id.is_none());
    }

    #[test]
    fn task_filter_with_step_id() {
        let uuid = "11111111-2222-3333-4444-555555555555";
        let filter = TaskFilter::new().with_step_id(uuid);
        assert_eq!(filter.step_id.as_deref(), Some(uuid));
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
            .include_archived();
        assert!(filter.root_only);
        assert_eq!(filter.levels, vec![Level::Epic]);
        assert_eq!(filter.priorities, vec![Priority::High]);
        assert_eq!(filter.search, Some("test".to_string()));
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
    fn agent_config_with_reasoning_effort() {
        let config = AgentConfig::new().with_reasoning_effort(" HIGH ");
        assert_eq!(config.reasoning_effort, Some("high".to_string()));
        assert!(!config.is_empty());
    }

    #[test]
    fn agent_config_reasoning_effort_round_trips_json() {
        let config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-5.5")
            .with_reasoning_effort("xhigh");
        let json = serde_json::to_string(&config).expect("serialize agent config");
        assert!(json.contains(r#""reasoning_effort":"xhigh""#));

        let parsed: AgentConfig = serde_json::from_str(&json).expect("deserialize agent config");
        assert_eq!(parsed, config);
        assert_eq!(parsed.reasoning_effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn agent_config_codex_model_provider_round_trips_json() {
        let config = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("deepseek/deepseek-v4-flash")
            .with_codex_model_provider(" OpenRouter ");
        let json = serde_json::to_string(&config).expect("serialize agent config");
        assert!(json.contains(r#""codex_model_provider":"openrouter""#));

        let parsed: AgentConfig = serde_json::from_str(&json).expect("deserialize agent config");
        assert_eq!(parsed, config);
        assert_eq!(parsed.codex_model_provider.as_deref(), Some("openrouter"));
    }

    #[test]
    fn agent_config_omits_absent_reasoning_effort() {
        let config = AgentConfig::new().with_model("gpt-5.5");
        let json = serde_json::to_value(&config).expect("serialize agent config");
        assert_eq!(json.get("model").and_then(|v| v.as_str()), Some("gpt-5.5"));
        assert!(
            json.get("reasoning_effort").is_none(),
            "reasoning_effort should be omitted when None, got {json}"
        );
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
    fn agent_config_to_claude_cli_args() {
        let config = AgentConfig::new()
            .with_model("claude-opus")
            .with_fallback_model("claude-sonnet")
            .with_system_prompt("Be helpful")
            .with_tools(vec!["bash".to_string()])
            .with_permission_mode(PermissionMode::Plan)
            .with_max_budget_usd(5.5);

        let args = config.to_claude_cli_args();
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
            .with_permission_mode(PermissionMode::Auto);

        let merged = config1.merge(config2);
        assert_eq!(merged.model, Some("claude-sonnet".to_string()));
        assert_eq!(merged.reasoning_effort, None);
        assert_eq!(merged.system_prompt, Some("Original".to_string()));
        assert_eq!(merged.fallback_model, Some("claude-haiku".to_string()));
        assert_eq!(merged.permission_mode, Some(PermissionMode::Auto));
    }

    #[test]
    fn agent_config_merge_overlays_reasoning_effort() {
        let config1 = AgentConfig::new()
            .with_model("gpt-5.5")
            .with_reasoning_effort("medium");
        let config2 = AgentConfig::new().with_reasoning_effort("high");

        let merged = config1.merge(config2);
        assert_eq!(merged.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(merged.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn agent_config_merge_overlays_codex_model_provider() {
        let config1 = AgentConfig::new()
            .with_provider(Provider::Openai)
            .with_model("gpt-5.5")
            .with_codex_model_provider("openrouter");
        let config2 = AgentConfig::new().with_codex_model_provider("zai");

        let merged = config1.merge(config2);
        assert_eq!(merged.provider, Some(Provider::Openai));
        assert_eq!(merged.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(merged.codex_model_provider.as_deref(), Some("zai"));
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

        let config4 = AgentConfig::new()
            .with_model("claude")
            .with_reasoning_effort("high")
            .with_max_budget_usd(10.5);
        assert_ne!(config1, config4);
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

    // ─── Kanban column ───────────────────────────────────────────────

    #[test]
    fn workflow_kanban_column_defaults_to_none() {
        let wf = Workflow::new("W");
        assert!(wf.kanban_column.is_none());
    }

    #[test]
    fn workflow_with_kanban_column_builder() {
        let wf = Workflow::new("W").with_kanban_column("In Progress");
        assert_eq!(wf.kanban_column, Some("In Progress".to_string()));
    }

    #[test]
    fn workflow_serde_roundtrip_with_kanban_column() {
        let wf = Workflow::new("Test")
            .with_kanban_column("In Progress")
            .with_description("A workflow");
        let json_str = serde_json::to_string(&wf).unwrap();
        let deserialized: Workflow = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized.name, "Test");
        assert_eq!(deserialized.kanban_column, Some("In Progress".to_string()));
        assert_eq!(deserialized.description, Some("A workflow".to_string()));
    }

    #[test]
    fn workflow_serde_roundtrip_without_kanban_column() {
        let wf = Workflow::new("Test");
        let json_str = serde_json::to_string(&wf).unwrap();
        let deserialized: Workflow = serde_json::from_str(&json_str).unwrap();
        assert!(deserialized.kanban_column.is_none());
    }

    // ─── is_default ─────────────────────────────────────────────────

    #[test]
    fn workflow_is_default_defaults_to_false() {
        let wf = Workflow::new("W");
        assert!(!wf.is_default);
    }

    #[test]
    fn workflow_with_is_default_builder() {
        let wf = Workflow::new("W").with_is_default(true);
        assert!(wf.is_default);
    }

    #[test]
    fn workflow_serde_roundtrip_with_is_default() {
        let wf = Workflow::new("Test")
            .with_is_default(true)
            .with_description("A workflow");
        let json_str = serde_json::to_string(&wf).unwrap();
        let deserialized: Workflow = serde_json::from_str(&json_str).unwrap();
        assert_eq!(deserialized.name, "Test");
        assert!(deserialized.is_default);
        assert_eq!(deserialized.description, Some("A workflow".to_string()));
    }

    #[test]
    fn workflow_serde_roundtrip_without_is_default() {
        let wf = Workflow::new("Test");
        let json_str = serde_json::to_string(&wf).unwrap();
        let deserialized: Workflow = serde_json::from_str(&json_str).unwrap();
        assert!(!deserialized.is_default);
    }
}
