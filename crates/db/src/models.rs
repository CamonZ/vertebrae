//! Data models for Vertebrae task management
//!
//! Defines Rust types that map to the SurrealDB schema for tasks,
//! sections, code references, and related enums.

// Allow dead code for types that are defined for future use
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use surrealdb::sql::Thing;

/// Default workflow ID for new tasks
pub const DEFAULT_WORKFLOW_ID: &str = "default";

/// Task hierarchy level
///
/// Represents the granularity of a task in the hierarchy:
/// Epic > Ticket > Task
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Epic,
    Ticket,
    Task,
}

impl Level {
    /// Returns the string representation used in the database
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
///
/// Optional priority for tasks, from low to critical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    Medium,
    High,
    Critical,
}

impl Priority {
    /// Returns the string representation used in the database
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
///
/// Defines the different types of content sections that can be
/// embedded in a task document.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

impl SectionType {
    /// Returns the string representation used in the database
    pub fn as_str(&self) -> &'static str {
        match self {
            SectionType::Goal => "goal",
            SectionType::Context => "context",
            SectionType::CurrentBehavior => "current_behavior",
            SectionType::DesiredBehavior => "desired_behavior",
            SectionType::Step => "step",
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

/// A section of content within a task
///
/// Sections provide structured documentation for tasks,
/// organized by type (goal, context, steps, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Section {
    /// The type of this section
    #[serde(rename = "type")]
    pub section_type: SectionType,

    /// The content of this section
    pub content: String,

    /// Optional ordering for sections of the same type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,

    /// Whether this section (typically a step) is done
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,

    /// When this section was marked as done (only for steps)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<DateTime<Utc>>,

    /// Code references attached to this section (only for testing_criterion)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<CodeRef>,
}

impl Section {
    /// Create a new section with the given type and content
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

    /// Create a new section with ordering
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

    /// Mark this section as done, setting done_at to the current time if done is true
    pub fn with_done(mut self, done: bool) -> Self {
        self.done = Some(done);
        if done {
            self.done_at = Some(Utc::now());
        } else {
            self.done_at = None;
        }
        self
    }

    /// Mark this section as done with a specific timestamp
    pub fn mark_done(&mut self) {
        self.done = Some(true);
        self.done_at = Some(Utc::now());
    }

    /// Add a code reference to this section
    pub fn with_ref(mut self, code_ref: CodeRef) -> Self {
        self.refs.push(code_ref);
        self
    }

    /// Add multiple code references to this section
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
        // Ignore done_at in equality comparison (similar to how Task ignores timestamps)
    }
}

impl Eq for Section {}

/// A code reference attached to a task
///
/// References link tasks to specific locations in the codebase,
/// enabling traceability between documentation and implementation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeRef {
    /// Path to the file (relative to repository root)
    pub path: String,

    /// Optional starting line number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_start: Option<u32>,

    /// Optional ending line number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_end: Option<u32>,

    /// Optional name/label for this reference (e.g., function name)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Optional description of what this reference points to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl CodeRef {
    /// Create a new code reference to a file
    pub fn file(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            line_start: None,
            line_end: None,
            name: None,
            description: None,
        }
    }

    /// Create a new code reference to a specific line
    pub fn line(path: impl Into<String>, line: u32) -> Self {
        Self {
            path: path.into(),
            line_start: Some(line),
            line_end: None,
            name: None,
            description: None,
        }
    }

    /// Create a new code reference to a line range
    pub fn range(path: impl Into<String>, start: u32, end: u32) -> Self {
        Self {
            path: path.into(),
            line_start: Some(start),
            line_end: Some(end),
            name: None,
            description: None,
        }
    }

    /// Add a name/label to this code reference
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Add a description to this code reference
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// A task in the Vertebrae task management system
///
/// Tasks are the primary nodes in the graph, with relationships
/// defined by `child_of` and `depends_on` edges.
///
/// Note: Status is derived from workflow_id and current_step_id, not stored as a field.
/// Every task always has both workflow_id and current_step_id set from creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    /// Unique identifier (SurrealDB record ID)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Thing>,

    /// Task title
    pub title: String,

    /// Optional description providing more context about the task
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

    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,

    /// Last update timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,

    /// When this task was started (transitioned to in_progress)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,

    /// When this task was completed (transitioned to done)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,

    /// Embedded sections
    #[serde(default)]
    pub sections: Vec<Section>,

    /// Embedded code references
    #[serde(default, rename = "refs")]
    pub code_refs: Vec<CodeRef>,

    /// Whether this task needs human review before completion
    #[serde(default)]
    pub needs_human_review: Option<bool>,

    /// Feedback to address when a validation gate fails (prompt/reason to send back)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_feedback: Option<String>,

    /// Reason why the task was rejected (terminal status explanation)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,

    /// The workflow this task is assigned to (if any)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<Thing>,

    /// Reference to the current step in the workflow
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step_id: Option<Thing>,
}

impl Task {
    /// Create a new task with required fields
    ///
    /// New tasks are created without workflow assignment. Use the service layer's
    /// `assign_workflow` to assign a workflow which will also set the initial step.
    pub fn new(title: impl Into<String>, level: Level) -> Self {
        Self {
            id: None,
            title: title.into(),
            description: None,
            level,
            priority: None,
            tags: Vec::new(),
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
            sections: Vec::new(),
            code_refs: Vec::new(),
            needs_human_review: None,
            revision_feedback: None,
            rejection_reason: None,
            workflow_id: None,
            current_step_id: None,
        }
    }

    /// Set the description of this task
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Set the priority of this task
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = Some(priority);
        self
    }

    /// Add a tag to this task
    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    /// Add multiple tags to this task
    pub fn with_tags(mut self, tags: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.tags.extend(tags.into_iter().map(|t| t.into()));
        self
    }

    /// Add a section to this task
    pub fn with_section(mut self, section: Section) -> Self {
        self.sections.push(section);
        self
    }

    /// Add a code reference to this task
    pub fn with_code_ref(mut self, code_ref: CodeRef) -> Self {
        self.code_refs.push(code_ref);
        self
    }

    /// Mark this task as needing human review
    pub fn with_needs_human_review(mut self, needs_review: bool) -> Self {
        self.needs_human_review = Some(needs_review);
        self
    }

    /// Assign this task to a workflow with a specific step
    pub fn with_workflow(mut self, workflow_id: Thing, step_id: Thing) -> Self {
        self.workflow_id = Some(workflow_id);
        self.current_step_id = Some(step_id);
        self
    }

    /// Clear workflow assignment from this task
    pub fn without_workflow(mut self) -> Self {
        self.workflow_id = None;
        self.current_step_id = None;
        self
    }

    /// Set the current step reference
    pub fn with_current_step_id(mut self, step_id: Thing) -> Self {
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

/// A workflow step entity
///
/// Steps are standalone database entities that belong to a workflow and can
/// define transitions to other steps, enabling graph-based workflow navigation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    /// Unique identifier (SurrealDB record ID)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Thing>,

    /// Display name for this step
    pub name: String,

    /// Reference to the workflow this step belongs to
    pub workflow_id: Thing,

    /// What this step should accomplish
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,

    /// Paths to .claude/agents/ files for this step
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,

    /// Skill names available for this step
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,

    /// Agent configuration for this step (legacy, kept for backwards compatibility)
    #[serde(default)]
    pub agent_config: AgentConfig,

    /// Whether this is a final step (no outgoing transitions)
    #[serde(default)]
    pub is_final: bool,

    /// List of step IDs this step can transition to
    #[serde(default)]
    pub transitions_to: Vec<Thing>,

    /// Ordering index for sequential fallback (0-based)
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
    /// Create a new step with the given name and workflow ID
    pub fn new(name: impl Into<String>, workflow_id: Thing) -> Self {
        Self {
            id: None,
            name: name.into(),
            workflow_id,
            goal: None,
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

    /// Set the goal for this step
    pub fn with_goal(mut self, goal: impl Into<String>) -> Self {
        self.goal = Some(goal.into());
        self
    }

    /// Set the agents for this step
    pub fn with_agents(mut self, agents: Vec<String>) -> Self {
        self.agents = agents;
        self
    }

    /// Add an agent to this step
    pub fn with_agent(mut self, agent: impl Into<String>) -> Self {
        self.agents.push(agent.into());
        self
    }

    /// Set the skills for this step
    pub fn with_skills(mut self, skills: Vec<String>) -> Self {
        self.skills = skills;
        self
    }

    /// Add a skill to this step
    pub fn with_skill(mut self, skill: impl Into<String>) -> Self {
        self.skills.push(skill.into());
        self
    }

    /// Set the agent configuration for this step
    pub fn with_agent_config(mut self, agent_config: AgentConfig) -> Self {
        self.agent_config = agent_config;
        self
    }

    /// Mark this step as final (no outgoing transitions)
    pub fn with_is_final(mut self, is_final: bool) -> Self {
        self.is_final = is_final;
        self
    }

    /// Add a transition to another step
    pub fn with_transition(mut self, step_id: Thing) -> Self {
        self.transitions_to.push(step_id);
        self
    }

    /// Set all transitions at once (replaces existing list)
    pub fn with_transitions_to(mut self, transitions: Vec<Thing>) -> Self {
        self.transitions_to = transitions;
        self
    }

    /// Set the order for this step
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

/// A workflow definition
///
/// Workflows define a sequence of steps to be executed by agents.
/// Each workflow has a name, description, and references first-class Step entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    /// Unique identifier (SurrealDB record ID)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Thing>,

    /// Workflow name
    pub name: String,

    /// Optional description of the workflow
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Reference to the initial step in the workflow
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_step: Option<Thing>,

    /// Additional metadata as key-value pairs
    #[serde(default)]
    pub metadata: std::collections::HashMap<String, String>,

    /// Whether to automatically advance to the next step on successful completion
    #[serde(default)]
    pub auto_advance: bool,

    /// Display order for sorting workflows (lower values appear first)
    #[serde(default)]
    pub order: i32,

    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,

    /// Last update timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
}

impl Workflow {
    /// Create a new workflow with the given name
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: None,
            name: name.into(),
            description: None,
            initial_step: None,
            metadata: std::collections::HashMap::new(),
            auto_advance: false,
            order: 0,
            created_at: None,
            updated_at: None,
        }
    }

    /// Set auto_advance for this workflow
    pub fn with_auto_advance(mut self, auto_advance: bool) -> Self {
        self.auto_advance = auto_advance;
        self
    }

    /// Set the display order for this workflow
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = order;
        self
    }

    /// Set the description of this workflow
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Add a metadata key-value pair
    pub fn with_metadata(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }

    /// Set the initial step reference for this workflow
    pub fn with_initial_step(mut self, step_id: Thing) -> Self {
        self.initial_step = Some(step_id);
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

/// Execution status for a workflow step
///
/// Represents the current state of a step execution in its lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    /// Step execution is currently in progress
    InProgress,
    /// Step execution completed successfully
    Completed,
    /// Step execution failed
    Failed,
}

impl ExecutionStatus {
    /// Returns the string representation used in the database
    pub fn as_str(&self) -> &'static str {
        match self {
            ExecutionStatus::InProgress => "in_progress",
            ExecutionStatus::Completed => "completed",
            ExecutionStatus::Failed => "failed",
        }
    }

    /// Parse a status string into an ExecutionStatus enum.
    ///
    /// Returns `None` if the string doesn't match any known status.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "in_progress" => Some(ExecutionStatus::InProgress),
            "completed" => Some(ExecutionStatus::Completed),
            "failed" => Some(ExecutionStatus::Failed),
            _ => None,
        }
    }

    /// Returns true if this status represents a terminal state
    pub fn is_terminal(&self) -> bool {
        matches!(self, ExecutionStatus::Completed | ExecutionStatus::Failed)
    }
}

impl std::fmt::Display for ExecutionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Token usage statistics from Claude execution
///
/// Tracks input, output, and cache token usage for billing and optimization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Number of input tokens processed
    pub input_tokens: u64,
    /// Number of output tokens generated
    pub output_tokens: u64,
    /// Number of tokens read from cache
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    /// Number of tokens written to cache
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,
}

impl TokenUsage {
    /// Create a new TokenUsage with required fields
    pub fn new(input_tokens: u64, output_tokens: u64) -> Self {
        Self {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
        }
    }

    /// Set cache read tokens
    pub fn with_cache_read(mut self, tokens: u64) -> Self {
        self.cache_read_input_tokens = Some(tokens);
        self
    }

    /// Set cache creation tokens
    pub fn with_cache_creation(mut self, tokens: u64) -> Self {
        self.cache_creation_input_tokens = Some(tokens);
        self
    }

    /// Calculate total tokens (input + output)
    pub fn total(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }
}

/// A record of a workflow step execution
///
/// StepExecution tracks each time a task enters a workflow step,
/// providing an immutable audit trail of all workflow executions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepExecution {
    /// Unique identifier (SurrealDB record ID)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Thing>,

    /// Reference to the task this execution belongs to
    pub task_id: Thing,

    /// Reference to the workflow being executed
    pub workflow_id: Thing,

    /// Name of the step being executed (matches Step.name)
    pub step_name: String,

    /// When this step execution started
    pub started_at: DateTime<Utc>,

    /// When this step execution completed (if completed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,

    /// Current status of this step execution
    pub status: ExecutionStatus,

    // --- Turn data fields (populated after execution) ---
    /// JSON context data about the task provided by the orchestrator
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,

    /// JSON prompt sent to the orchestrator for this execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,

    /// Final text result from the execution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,

    /// Result of transition decision (e.g., "advance", "reject", "retry")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_result: Option<String>,

    /// Model that executed this step (e.g., "claude-sonnet-4-20250514")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_used: Option<String>,

    /// Claude session ID for debugging
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,

    /// Token usage statistics
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenUsage>,

    /// Execution cost in USD
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,

    /// Execution duration in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl StepExecution {
    /// Create a new step execution record
    ///
    /// The execution starts with `InProgress` status and the current timestamp.
    pub fn new(task_id: Thing, workflow_id: Thing, step_name: impl Into<String>) -> Self {
        Self {
            id: None,
            task_id,
            workflow_id,
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

    /// Create a new step execution with a specific start time
    pub fn with_started_at(mut self, started_at: DateTime<Utc>) -> Self {
        self.started_at = started_at;
        self
    }

    /// Set the context JSON for this execution
    pub fn with_context(mut self, context: impl Into<String>) -> Self {
        self.context = Some(context.into());
        self
    }

    /// Set the prompt used for this execution
    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into());
        self
    }

    /// Set the output from this execution
    pub fn with_output(mut self, output: impl Into<String>) -> Self {
        self.output = Some(output.into());
        self
    }

    /// Set the transition result for this execution
    pub fn with_transition_result(mut self, result: impl Into<String>) -> Self {
        self.transition_result = Some(result.into());
        self
    }

    /// Set the model used for this execution
    pub fn with_model_used(mut self, model: impl Into<String>) -> Self {
        self.model_used = Some(model.into());
        self
    }

    /// Set the session ID for this execution
    pub fn with_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    /// Set the token usage for this execution
    pub fn with_token_usage(mut self, usage: TokenUsage) -> Self {
        self.token_usage = Some(usage);
        self
    }

    /// Set the cost in USD for this execution
    pub fn with_cost_usd(mut self, cost: f64) -> Self {
        self.cost_usd = Some(cost);
        self
    }

    /// Set the duration in milliseconds for this execution
    pub fn with_duration_ms(mut self, duration: u64) -> Self {
        self.duration_ms = Some(duration);
        self
    }

    /// Mark this step execution as completed successfully
    pub fn complete(&mut self) {
        self.status = ExecutionStatus::Completed;
        self.completed_at = Some(Utc::now());
    }

    /// Mark this step execution as completed with a specific timestamp
    pub fn complete_at(&mut self, completed_at: DateTime<Utc>) {
        self.status = ExecutionStatus::Completed;
        self.completed_at = Some(completed_at);
    }

    /// Mark this step execution as failed
    pub fn fail(&mut self) {
        self.status = ExecutionStatus::Failed;
        self.completed_at = Some(Utc::now());
    }

    /// Mark this step execution as failed with a specific timestamp
    pub fn fail_at(&mut self, completed_at: DateTime<Utc>) {
        self.status = ExecutionStatus::Failed;
        self.completed_at = Some(completed_at);
    }

    /// Check if this step execution has finished (completed or failed)
    pub fn is_finished(&self) -> bool {
        self.status.is_terminal()
    }

    /// Get the duration of this step execution if completed
    ///
    /// Returns `None` if the step has not completed yet.
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
        // Ignore timestamps in equality comparison (similar to how Task ignores timestamps)
    }
}

impl Eq for StepExecution {}

/// A log entry for a workflow step execution
///
/// SessionLog stores content from Claude sessions during step execution,
/// providing a record of what happened during each step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLog {
    /// Unique identifier (SurrealDB record ID)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Thing>,

    /// Reference to the step execution this log belongs to
    pub step_execution_id: Thing,

    /// The log content (arbitrary text from Claude sessions)
    pub content: String,

    /// When this log was created
    pub created_at: DateTime<Utc>,
}

impl SessionLog {
    /// Create a new session log entry
    ///
    /// The log is created with the current timestamp.
    pub fn new(step_execution_id: Thing, content: impl Into<String>) -> Self {
        Self {
            id: None,
            step_execution_id,
            content: content.into(),
            created_at: Utc::now(),
        }
    }

    /// Create a new session log with a specific creation time
    pub fn with_created_at(mut self, created_at: DateTime<Utc>) -> Self {
        self.created_at = created_at;
        self
    }
}

impl PartialEq for SessionLog {
    fn eq(&self, other: &Self) -> bool {
        self.step_execution_id == other.step_execution_id && self.content == other.content
        // Ignore id and created_at in equality comparison
    }
}

impl Eq for SessionLog {}

/// Permission mode for Claude CLI execution
///
/// Defines how permissions are handled during agent execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Accept all edit operations automatically
    AcceptEdits,
    /// Bypass all permission checks (dangerous - use only in sandboxes)
    BypassPermissions,
    /// Default permission handling with prompts
    Default,
    /// Delegate permission decisions
    Delegate,
    /// Never ask for permissions (may fail on operations requiring permission)
    DontAsk,
    /// Plan mode - suggest changes without executing
    Plan,
}

impl PermissionMode {
    /// Returns the string representation used in the CLI
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

    /// Parse a permission mode string into a PermissionMode enum.
    ///
    /// Returns `None` if the string doesn't match any known mode.
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

/// Configuration for a Claude agent execution
///
/// AgentConfig captures all CLI-passable options that can be used when
/// executing a workflow step via the Claude CLI. All fields are optional
/// to allow partial configuration and merging with defaults.
///
/// # Example
///
/// ```rust
/// use vertebrae_db::AgentConfig;
///
/// let config = AgentConfig::new()
///     .with_model("sonnet")
///     .with_system_prompt("You are a code reviewer")
///     .with_allowed_tools(vec!["Read".to_string(), "Grep".to_string()]);
///
/// let args = config.to_cli_args();
/// // args would be: ["--model", "sonnet", "--systemPrompt", "You are a code reviewer", "--allowedTools", "Read", "Grep"]
/// ```
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Model for the current session (e.g., "sonnet", "opus", or full model name)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,

    /// Fallback model when default model is overloaded
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,

    /// System prompt to use for the session
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,

    /// Append a system prompt to the default system prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,

    /// JSON object defining custom agents
    /// Example: {"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<serde_json::Value>,

    /// List of available tools from the built-in set
    /// Use empty vec to disable all tools, or specify tool names (e.g., ["Bash", "Edit", "Read"])
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,

    /// List of tool names to allow (e.g., ["Bash(git:*)", "Edit"])
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,

    /// List of tool names to deny (e.g., ["Bash(rm:*)", "Write"])
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disallowed_tools: Vec<String>,

    /// Permission mode to use for the session
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,

    /// Maximum dollar amount to spend on API calls
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_budget_usd: Option<f64>,

    /// Paths to MCP server configuration files or JSON strings
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_config: Vec<String>,

    /// Directories to load plugins from
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugin_dirs: Vec<String>,

    /// JSON Schema for structured output validation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_schema: Option<serde_json::Value>,
}

impl AgentConfig {
    /// Create a new empty AgentConfig
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the model for this configuration
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Set the fallback model for this configuration
    pub fn with_fallback_model(mut self, model: impl Into<String>) -> Self {
        self.fallback_model = Some(model.into());
        self
    }

    /// Set the system prompt for this configuration
    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = Some(prompt.into());
        self
    }

    /// Set the append system prompt for this configuration
    pub fn with_append_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.append_system_prompt = Some(prompt.into());
        self
    }

    /// Set the custom agents JSON for this configuration
    pub fn with_agents(mut self, agents: serde_json::Value) -> Self {
        self.agents = Some(agents);
        self
    }

    /// Set the available tools for this configuration
    pub fn with_tools(mut self, tools: Vec<String>) -> Self {
        self.tools = tools;
        self
    }

    /// Set the allowed tools for this configuration
    pub fn with_allowed_tools(mut self, tools: Vec<String>) -> Self {
        self.allowed_tools = tools;
        self
    }

    /// Set the disallowed tools for this configuration
    pub fn with_disallowed_tools(mut self, tools: Vec<String>) -> Self {
        self.disallowed_tools = tools;
        self
    }

    /// Set the permission mode for this configuration
    pub fn with_permission_mode(mut self, mode: PermissionMode) -> Self {
        self.permission_mode = Some(mode);
        self
    }

    /// Set the maximum budget in USD for this configuration
    pub fn with_max_budget_usd(mut self, budget: f64) -> Self {
        self.max_budget_usd = Some(budget);
        self
    }

    /// Set the MCP config paths for this configuration
    pub fn with_mcp_config(mut self, configs: Vec<String>) -> Self {
        self.mcp_config = configs;
        self
    }

    /// Set the plugin directories for this configuration
    pub fn with_plugin_dirs(mut self, dirs: Vec<String>) -> Self {
        self.plugin_dirs = dirs;
        self
    }

    /// Set the JSON schema for structured output for this configuration
    pub fn with_json_schema(mut self, schema: serde_json::Value) -> Self {
        self.json_schema = Some(schema);
        self
    }

    /// Convert this configuration to Claude CLI arguments.
    ///
    /// Returns a vector of strings that can be passed to the Claude CLI.
    /// Only fields that are set (Some or non-empty) will generate arguments.
    ///
    /// # Example
    ///
    /// ```rust
    /// use vertebrae_db::AgentConfig;
    ///
    /// let config = AgentConfig::new()
    ///     .with_model("sonnet")
    ///     .with_max_budget_usd(5.0);
    ///
    /// let args = config.to_cli_args();
    /// assert_eq!(args, vec!["--model", "sonnet", "--maxBudgetUsd", "5"]);
    /// ```
    pub fn to_cli_args(&self) -> Vec<String> {
        let mut args = Vec::new();

        // Model
        if let Some(ref model) = self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        // Fallback model
        if let Some(ref model) = self.fallback_model {
            args.push("--fallbackModel".to_string());
            args.push(model.clone());
        }

        // System prompt
        if let Some(ref prompt) = self.system_prompt {
            args.push("--systemPrompt".to_string());
            args.push(prompt.clone());
        }

        // Append system prompt
        if let Some(ref prompt) = self.append_system_prompt {
            args.push("--appendSystemPrompt".to_string());
            args.push(prompt.clone());
        }

        // Agents JSON
        if let Some(ref agents) = self.agents {
            args.push("--agents".to_string());
            args.push(agents.to_string());
        }

        // Tools
        if !self.tools.is_empty() {
            args.push("--tools".to_string());
            args.extend(self.tools.iter().cloned());
        }

        // Allowed tools
        if !self.allowed_tools.is_empty() {
            args.push("--allowedTools".to_string());
            args.extend(self.allowed_tools.iter().cloned());
        }

        // Disallowed tools
        if !self.disallowed_tools.is_empty() {
            args.push("--disallowedTools".to_string());
            args.extend(self.disallowed_tools.iter().cloned());
        }

        // Permission mode
        if let Some(ref mode) = self.permission_mode {
            args.push("--permissionMode".to_string());
            args.push(mode.as_str().to_string());
        }

        // Max budget USD
        if let Some(budget) = self.max_budget_usd {
            args.push("--maxBudgetUsd".to_string());
            // Format without trailing zeros for cleaner output
            args.push(format_float(budget));
        }

        // MCP config
        for config in &self.mcp_config {
            args.push("--mcpConfig".to_string());
            args.push(config.clone());
        }

        // Plugin dirs
        for dir in &self.plugin_dirs {
            args.push("--pluginDir".to_string());
            args.push(dir.clone());
        }

        // JSON schema
        if let Some(ref schema) = self.json_schema {
            args.push("--json-schema".to_string());
            args.push(schema.to_string());
        }

        args
    }

    /// Check if this configuration is empty (all fields are None or empty)
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

    /// Merge another config into this one.
    ///
    /// The other config's values take precedence over this config's values.
    /// For Vec fields, the other config's values replace this config's values
    /// if the other config's Vec is non-empty.
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

/// Compare two optional f64 values for equality, handling NaN correctly
fn float_option_eq(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => {
            // Use total_cmp for consistent ordering that handles NaN
            x.total_cmp(&y) == std::cmp::Ordering::Equal
        }
        _ => false,
    }
}

/// Format a float without unnecessary trailing zeros
fn format_float(value: f64) -> String {
    // Check if the value is a whole number
    if value.fract() == 0.0 {
        format!("{:.0}", value)
    } else {
        // Remove trailing zeros
        let s = format!("{}", value);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Workflow transition edge defining valid transitions between workflows.
///
/// This edge table stores the allowed transitions between workflows, enabling
/// tasks to move from one workflow to another (e.g., from "implementation" workflow
/// to "review" workflow). The `target_step` optionally specifies which step in the
/// target workflow to start at.
///
/// The edge direction is: from_workflow -> workflow_transitions -> to_workflow
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkflowTransition {
    /// Unique identifier (SurrealDB record ID)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Thing>,

    /// The workflow this transition starts from
    pub from_workflow: Thing,

    /// The workflow this transition goes to
    pub to_workflow: Thing,

    /// Human-readable label for this transition (e.g., "Submit for Review")
    pub label: String,

    /// Optional reference to a specific step in the target workflow to start at.
    /// If None, the transition starts at the target workflow's initial step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_step: Option<Thing>,

    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
}

impl WorkflowTransition {
    /// Create a new workflow transition.
    ///
    /// # Arguments
    ///
    /// * `from_workflow` - The workflow this transition starts from
    /// * `to_workflow` - The workflow this transition goes to
    /// * `label` - Human-readable label for this transition
    pub fn new(from_workflow: Thing, to_workflow: Thing, label: impl Into<String>) -> Self {
        Self {
            id: None,
            from_workflow,
            to_workflow,
            label: label.into(),
            target_step: None,
            created_at: None,
        }
    }

    /// Set the target step for this transition.
    ///
    /// When specified, tasks using this transition will start at this step
    /// in the target workflow instead of the workflow's initial step.
    pub fn with_target_step(mut self, step: Thing) -> Self {
        self.target_step = Some(step);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    // Level enum tests
    #[test]
    fn test_level_as_str() {
        assert_eq!(Level::Epic.as_str(), "epic");
        assert_eq!(Level::Ticket.as_str(), "ticket");
        assert_eq!(Level::Task.as_str(), "task");
    }

    #[test]
    fn test_level_display() {
        assert_eq!(format!("{}", Level::Epic), "epic");
        assert_eq!(format!("{}", Level::Ticket), "ticket");
        assert_eq!(format!("{}", Level::Task), "task");
    }

    #[test]
    fn test_level_serialize() {
        assert_eq!(serde_json::to_string(&Level::Epic).unwrap(), "\"epic\"");
        assert_eq!(serde_json::to_string(&Level::Ticket).unwrap(), "\"ticket\"");
        assert_eq!(serde_json::to_string(&Level::Task).unwrap(), "\"task\"");
    }

    #[test]
    fn test_level_deserialize() {
        assert_eq!(
            serde_json::from_str::<Level>("\"epic\"").unwrap(),
            Level::Epic
        );
        assert_eq!(
            serde_json::from_str::<Level>("\"ticket\"").unwrap(),
            Level::Ticket
        );
        assert_eq!(
            serde_json::from_str::<Level>("\"task\"").unwrap(),
            Level::Task
        );
    }

    #[test]
    fn test_level_clone_and_eq() {
        let level = Level::Epic;
        let cloned = level.clone();
        assert_eq!(level, cloned);
    }

    // Priority enum tests
    #[test]
    fn test_priority_as_str() {
        assert_eq!(Priority::Low.as_str(), "low");
        assert_eq!(Priority::Medium.as_str(), "medium");
        assert_eq!(Priority::High.as_str(), "high");
        assert_eq!(Priority::Critical.as_str(), "critical");
    }

    #[test]
    fn test_priority_display() {
        assert_eq!(format!("{}", Priority::Low), "low");
        assert_eq!(format!("{}", Priority::Medium), "medium");
        assert_eq!(format!("{}", Priority::High), "high");
        assert_eq!(format!("{}", Priority::Critical), "critical");
    }

    #[test]
    fn test_priority_serialize() {
        assert_eq!(serde_json::to_string(&Priority::Low).unwrap(), "\"low\"");
        assert_eq!(
            serde_json::to_string(&Priority::Medium).unwrap(),
            "\"medium\""
        );
        assert_eq!(serde_json::to_string(&Priority::High).unwrap(), "\"high\"");
        assert_eq!(
            serde_json::to_string(&Priority::Critical).unwrap(),
            "\"critical\""
        );
    }

    #[test]
    fn test_priority_deserialize() {
        assert_eq!(
            serde_json::from_str::<Priority>("\"low\"").unwrap(),
            Priority::Low
        );
        assert_eq!(
            serde_json::from_str::<Priority>("\"medium\"").unwrap(),
            Priority::Medium
        );
        assert_eq!(
            serde_json::from_str::<Priority>("\"high\"").unwrap(),
            Priority::High
        );
        assert_eq!(
            serde_json::from_str::<Priority>("\"critical\"").unwrap(),
            Priority::Critical
        );
    }

    #[test]
    fn test_priority_clone_and_eq() {
        let priority = Priority::High;
        let cloned = priority.clone();
        assert_eq!(priority, cloned);
    }

    // SectionType enum tests
    #[test]
    fn test_section_type_as_str() {
        assert_eq!(SectionType::Goal.as_str(), "goal");
        assert_eq!(SectionType::Context.as_str(), "context");
        assert_eq!(SectionType::CurrentBehavior.as_str(), "current_behavior");
        assert_eq!(SectionType::DesiredBehavior.as_str(), "desired_behavior");
        assert_eq!(SectionType::Step.as_str(), "step");
        assert_eq!(SectionType::TestingCriterion.as_str(), "testing_criterion");
        assert_eq!(SectionType::AntiPattern.as_str(), "anti_pattern");
        assert_eq!(SectionType::FailureTest.as_str(), "failure_test");
        assert_eq!(SectionType::Constraint.as_str(), "constraint");
    }

    #[test]
    fn test_section_type_display() {
        assert_eq!(format!("{}", SectionType::Goal), "goal");
        assert_eq!(format!("{}", SectionType::Context), "context");
        assert_eq!(
            format!("{}", SectionType::CurrentBehavior),
            "current_behavior"
        );
        assert_eq!(
            format!("{}", SectionType::DesiredBehavior),
            "desired_behavior"
        );
        assert_eq!(format!("{}", SectionType::Step), "step");
        assert_eq!(
            format!("{}", SectionType::TestingCriterion),
            "testing_criterion"
        );
        assert_eq!(format!("{}", SectionType::AntiPattern), "anti_pattern");
        assert_eq!(format!("{}", SectionType::FailureTest), "failure_test");
        assert_eq!(format!("{}", SectionType::Constraint), "constraint");
    }

    #[test]
    fn test_section_type_serialize() {
        assert_eq!(
            serde_json::to_string(&SectionType::Goal).unwrap(),
            "\"goal\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::Context).unwrap(),
            "\"context\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::CurrentBehavior).unwrap(),
            "\"current_behavior\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::DesiredBehavior).unwrap(),
            "\"desired_behavior\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::Step).unwrap(),
            "\"step\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::TestingCriterion).unwrap(),
            "\"testing_criterion\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::AntiPattern).unwrap(),
            "\"anti_pattern\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::FailureTest).unwrap(),
            "\"failure_test\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::Constraint).unwrap(),
            "\"constraint\""
        );
    }

    #[test]
    fn test_section_type_deserialize() {
        assert_eq!(
            serde_json::from_str::<SectionType>("\"goal\"").unwrap(),
            SectionType::Goal
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"context\"").unwrap(),
            SectionType::Context
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"current_behavior\"").unwrap(),
            SectionType::CurrentBehavior
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"desired_behavior\"").unwrap(),
            SectionType::DesiredBehavior
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"step\"").unwrap(),
            SectionType::Step
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"testing_criterion\"").unwrap(),
            SectionType::TestingCriterion
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"anti_pattern\"").unwrap(),
            SectionType::AntiPattern
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"failure_test\"").unwrap(),
            SectionType::FailureTest
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"constraint\"").unwrap(),
            SectionType::Constraint
        );
    }

    #[test]
    fn test_section_type_clone_and_eq() {
        let section_type = SectionType::Goal;
        let cloned = section_type.clone();
        assert_eq!(section_type, cloned);
    }

    // Section tests
    #[test]
    fn test_section_new() {
        let section = Section::new(SectionType::Goal, "Implement feature X");
        assert_eq!(section.section_type, SectionType::Goal);
        assert_eq!(section.content, "Implement feature X");
        assert!(section.order.is_none());
        assert!(section.done.is_none());
        assert!(section.done_at.is_none());
    }

    #[test]
    fn test_section_with_order() {
        let section = Section::with_order(SectionType::Step, "Step 1: Do something", 1);
        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Step 1: Do something");
        assert_eq!(section.order, Some(1));
        assert!(section.done.is_none());
        assert!(section.done_at.is_none());
    }

    #[test]
    fn test_section_with_done() {
        let before = Utc::now();
        let section = Section::with_order(SectionType::Step, "Step 1", 1).with_done(true);
        let after = Utc::now();

        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Step 1");
        assert_eq!(section.order, Some(1));
        assert_eq!(section.done, Some(true));
        // done_at should be set when done is true
        assert!(
            section.done_at.is_some(),
            "done_at should be set when done is true"
        );
        let done_at = section.done_at.unwrap();
        assert!(
            done_at >= before && done_at <= after,
            "done_at should be within the test execution time"
        );
    }

    #[test]
    fn test_section_with_done_false() {
        let section = Section::new(SectionType::Step, "Step 1").with_done(false);
        assert_eq!(section.done, Some(false));
        // done_at should be None when done is false
        assert!(
            section.done_at.is_none(),
            "done_at should be None when done is false"
        );
    }

    #[test]
    fn test_section_serialize() {
        let section = Section::new(SectionType::Goal, "Test goal");
        let value = serde_json::to_value(&section).unwrap();
        assert_eq!(value["type"], "goal");
        assert_eq!(value["content"], "Test goal");
    }

    #[test]
    fn test_section_serialize_with_order() {
        let section = Section::with_order(SectionType::Step, "Step content", 5);
        let value = serde_json::to_value(&section).unwrap();
        assert_eq!(value["type"], "step");
        assert_eq!(value["content"], "Step content");
        assert_eq!(value["order"], 5);
    }

    #[test]
    fn test_section_serialize_with_done() {
        let section = Section::with_order(SectionType::Step, "Step content", 1).with_done(true);
        let value = serde_json::to_value(&section).unwrap();
        assert_eq!(value["type"], "step");
        assert_eq!(value["content"], "Step content");
        assert_eq!(value["order"], 1);
        assert_eq!(value["done"], true);
        // done_at should be serialized when present
        assert!(
            value.get("done_at").is_some(),
            "done_at should be serialized when done is true"
        );
        // Verify it's a proper ISO8601 datetime string
        let done_at_str = value["done_at"].as_str().unwrap();
        assert!(
            done_at_str.contains('T'),
            "done_at should be ISO8601 format with 'T' separator"
        );
    }

    #[test]
    fn test_section_deserialize_with_done() {
        let json = r#"{"type":"step","content":"Do this","order":1,"done":true,"done_at":"2025-01-06T12:00:00Z"}"#;
        let section: Section = serde_json::from_str(json).unwrap();
        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Do this");
        assert_eq!(section.order, Some(1));
        assert_eq!(section.done, Some(true));
        // done_at should be deserialized
        assert!(
            section.done_at.is_some(),
            "done_at should be deserialized when present"
        );
        let done_at = section.done_at.unwrap();
        assert_eq!(done_at.hour(), 12);
    }

    #[test]
    fn test_section_deserialize() {
        let json = r#"{"type":"context","content":"Some context"}"#;
        let section: Section = serde_json::from_str(json).unwrap();
        assert_eq!(section.section_type, SectionType::Context);
        assert_eq!(section.content, "Some context");
        assert!(section.order.is_none());
    }

    #[test]
    fn test_section_deserialize_with_order() {
        let json = r#"{"type":"step","content":"Do this","order":3}"#;
        let section: Section = serde_json::from_str(json).unwrap();
        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Do this");
        assert_eq!(section.order, Some(3));
    }

    #[test]
    fn test_section_clone_and_eq() {
        let section = Section::new(SectionType::Goal, "Test");
        let cloned = section.clone();
        assert_eq!(section, cloned);
    }

    // Section done_at tests
    #[test]
    fn test_section_mark_done_sets_done_at() {
        let before = Utc::now();
        let mut section = Section::new(SectionType::Step, "Step to mark done");
        section.mark_done();
        let after = Utc::now();

        assert_eq!(
            section.done,
            Some(true),
            "done should be true after mark_done"
        );
        assert!(
            section.done_at.is_some(),
            "done_at should be set after mark_done"
        );
        let done_at = section.done_at.unwrap();
        assert!(
            done_at >= before && done_at <= after,
            "done_at should be within 1 second of call time"
        );
    }

    #[test]
    fn test_section_deserialize_without_done_at_field() {
        // Testing backward compatibility: old JSON without done_at should work
        let json = r#"{"type":"step","content":"Old step","order":1,"done":true}"#;
        let section: Section = serde_json::from_str(json).unwrap();
        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Old step");
        assert_eq!(section.done, Some(true));
        // done_at should be None when not in JSON (backward compatibility)
        assert!(
            section.done_at.is_none(),
            "done_at should be None when not present in old JSON"
        );
    }

    #[test]
    fn test_section_serialize_omits_done_at_when_none() {
        let section = Section::new(SectionType::Step, "Step without done_at");
        let value = serde_json::to_value(&section).unwrap();
        assert!(
            value.get("done_at").is_none(),
            "done_at should be omitted when None"
        );
    }

    #[test]
    fn test_section_done_false_clears_done_at() {
        // First mark as done
        let mut section = Section::new(SectionType::Step, "Step").with_done(true);
        assert!(
            section.done_at.is_some(),
            "done_at should be set after with_done(true)"
        );

        // Then mark as not done - done_at should be cleared
        section = section.with_done(false);
        assert_eq!(section.done, Some(false));
        assert!(
            section.done_at.is_none(),
            "done_at should be None when done is false"
        );
    }

    #[test]
    fn test_section_eq_ignores_done_at() {
        let section1 = Section::new(SectionType::Step, "Same step");
        let mut section2 = Section::new(SectionType::Step, "Same step");
        section2.done_at = Some(Utc::now());

        // Sections should be equal even with different done_at values
        assert_eq!(
            section1, section2,
            "Sections should be equal regardless of done_at timestamp"
        );
    }

    #[test]
    fn test_section_done_at_is_datetime_type() {
        let mut section = Section::new(SectionType::Step, "Type check");
        let now: DateTime<Utc> = Utc::now();
        section.done_at = Some(now);

        // This is a compile-time check - if it compiles, the types are correct
        let _done_at: Option<DateTime<Utc>> = section.done_at;
    }

    // CodeRef tests
    #[test]
    fn test_code_ref_file() {
        let code_ref = CodeRef::file("src/main.rs");
        assert_eq!(code_ref.path, "src/main.rs");
        assert!(code_ref.line_start.is_none());
        assert!(code_ref.line_end.is_none());
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn test_code_ref_line() {
        let code_ref = CodeRef::line("src/lib.rs", 42);
        assert_eq!(code_ref.path, "src/lib.rs");
        assert_eq!(code_ref.line_start, Some(42));
        assert!(code_ref.line_end.is_none());
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn test_code_ref_range() {
        let code_ref = CodeRef::range("src/module.rs", 10, 50);
        assert_eq!(code_ref.path, "src/module.rs");
        assert_eq!(code_ref.line_start, Some(10));
        assert_eq!(code_ref.line_end, Some(50));
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn test_code_ref_with_description() {
        let code_ref = CodeRef::file("src/api.rs").with_description("API implementation");
        assert_eq!(code_ref.path, "src/api.rs");
        assert_eq!(code_ref.description, Some("API implementation".to_string()));
    }

    #[test]
    fn test_code_ref_serialize() {
        let code_ref = CodeRef::range("test.rs", 1, 10);
        let value = serde_json::to_value(&code_ref).unwrap();
        assert_eq!(value["path"], "test.rs");
        assert_eq!(value["line_start"], 1);
        assert_eq!(value["line_end"], 10);
    }

    #[test]
    fn test_code_ref_serialize_minimal() {
        let code_ref = CodeRef::file("minimal.rs");
        let value = serde_json::to_value(&code_ref).unwrap();
        assert_eq!(value["path"], "minimal.rs");
        assert!(value.get("line_start").is_none());
        assert!(value.get("line_end").is_none());
        assert!(value.get("description").is_none());
    }

    #[test]
    fn test_code_ref_deserialize() {
        let json = r#"{"path":"src/test.rs","line_start":5,"line_end":15}"#;
        let code_ref: CodeRef = serde_json::from_str(json).unwrap();
        assert_eq!(code_ref.path, "src/test.rs");
        assert_eq!(code_ref.line_start, Some(5));
        assert_eq!(code_ref.line_end, Some(15));
    }

    #[test]
    fn test_code_ref_deserialize_minimal() {
        let json = r#"{"path":"file.rs"}"#;
        let code_ref: CodeRef = serde_json::from_str(json).unwrap();
        assert_eq!(code_ref.path, "file.rs");
        assert!(code_ref.line_start.is_none());
        assert!(code_ref.line_end.is_none());
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn test_code_ref_clone_and_eq() {
        let code_ref = CodeRef::range("test.rs", 1, 10);
        let cloned = code_ref.clone();
        assert_eq!(code_ref, cloned);
    }

    // Task tests
    #[test]
    fn test_task_new() {
        let task = Task::new("Implement feature", Level::Task);
        assert!(task.id.is_none());
        assert_eq!(task.title, "Implement feature");
        assert_eq!(task.level, Level::Task);
        assert!(task.priority.is_none());
        assert!(task.tags.is_empty());
        assert!(task.created_at.is_none());
        assert!(task.updated_at.is_none());
        assert!(task.started_at.is_none());
        assert!(task.completed_at.is_none());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
        // Tasks are created without workflow assignment - use service layer to assign
        assert!(
            task.workflow_id.is_none(),
            "New tasks are created without workflow assignment"
        );
        assert!(
            task.current_step_id.is_none(),
            "New tasks have no current step until workflow is assigned"
        );
    }

    #[test]
    fn test_task_with_priority() {
        let task = Task::new("Test", Level::Task).with_priority(Priority::High);
        assert_eq!(task.priority, Some(Priority::High));
    }

    #[test]
    fn test_task_with_tag() {
        let task = Task::new("Test", Level::Task).with_tag("backend");
        assert_eq!(task.tags, vec!["backend"]);
    }

    #[test]
    fn test_task_with_tags() {
        let task = Task::new("Test", Level::Task).with_tags(["backend", "api", "v2"]);
        assert_eq!(task.tags, vec!["backend", "api", "v2"]);
    }

    #[test]
    fn test_task_with_section() {
        let task =
            Task::new("Test", Level::Task).with_section(Section::new(SectionType::Goal, "Goal"));
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].section_type, SectionType::Goal);
    }

    #[test]
    fn test_task_with_code_ref() {
        let task = Task::new("Test", Level::Task).with_code_ref(CodeRef::file("src/main.rs"));
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");
    }

    #[test]
    fn test_task_builder_chain() {
        let task = Task::new("Complex Task", Level::Epic)
            .with_priority(Priority::Critical)
            .with_tags(["urgent", "backend"])
            .with_section(Section::new(SectionType::Goal, "Complete the epic"))
            .with_code_ref(CodeRef::file("docs/spec.md"));

        assert_eq!(task.title, "Complex Task");
        assert_eq!(task.level, Level::Epic);
        assert_eq!(task.priority, Some(Priority::Critical));
        assert_eq!(task.tags, vec!["urgent", "backend"]);
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.code_refs.len(), 1);
    }

    #[test]
    fn test_task_serialize() {
        let task = Task::new("Test Task", Level::Ticket)
            .with_priority(Priority::Medium)
            .with_tag("test");

        let value = serde_json::to_value(&task).unwrap();
        assert_eq!(value["title"], "Test Task");
        assert_eq!(value["level"], "ticket");
        assert_eq!(value["priority"], "medium");
        assert_eq!(value["tags"], serde_json::json!(["test"]));
    }

    #[test]
    fn test_task_serialize_minimal() {
        let task = Task::new("Minimal", Level::Task);
        let value = serde_json::to_value(&task).unwrap();
        assert_eq!(value["title"], "Minimal");
        assert_eq!(value["level"], "task");
        assert!(value.get("priority").is_none());
        assert!(value.get("id").is_none());
    }

    #[test]
    fn test_task_deserialize() {
        let json = r#"{
            "title": "Deserialized Task",
            "level": "epic",
            "priority": "low",
            "tags": ["a", "b"],
            "sections": [],
            "refs": []
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert_eq!(task.title, "Deserialized Task");
        assert_eq!(task.level, Level::Epic);
        assert_eq!(task.priority, Some(Priority::Low));
        assert_eq!(task.tags, vec!["a", "b"]);
    }

    #[test]
    fn test_task_deserialize_minimal() {
        let json = r#"{
            "title": "Minimal",
            "level": "task"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert_eq!(task.title, "Minimal");
        assert_eq!(task.level, Level::Task);
        assert!(task.priority.is_none());
        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
    }

    #[test]
    fn test_task_clone_and_eq() {
        let task = Task::new("Test", Level::Task)
            .with_priority(Priority::High)
            .with_tag("test");
        let cloned = task.clone();
        assert_eq!(task, cloned);
    }

    #[test]
    fn test_task_eq_ignores_timestamps() {
        let task1 = Task::new("Test", Level::Task);
        let mut task2 = Task::new("Test", Level::Task);
        task2.created_at = Some(Utc::now());
        // Tasks should be equal even with different timestamps
        assert_eq!(task1, task2);
    }

    #[test]
    fn test_task_with_full_sections() {
        let task = Task::new("Feature Implementation", Level::Ticket)
            .with_section(Section::new(SectionType::Goal, "Implement the feature"))
            .with_section(Section::new(SectionType::Context, "Background info"))
            .with_section(Section::new(
                SectionType::CurrentBehavior,
                "Currently does nothing",
            ))
            .with_section(Section::new(
                SectionType::DesiredBehavior,
                "Should do something",
            ))
            .with_section(Section::with_order(SectionType::Step, "First step", 1))
            .with_section(Section::with_order(SectionType::Step, "Second step", 2))
            .with_section(Section::new(
                SectionType::TestingCriterion,
                "Tests should pass",
            ))
            .with_section(Section::new(SectionType::AntiPattern, "Don't do this"))
            .with_section(Section::new(
                SectionType::FailureTest,
                "Should fail when...",
            ))
            .with_section(Section::new(SectionType::Constraint, "Must be fast"));

        assert_eq!(task.sections.len(), 10);
    }

    #[test]
    fn test_task_with_full_code_refs() {
        let task = Task::new("Code Review", Level::Task)
            .with_code_ref(CodeRef::file("README.md"))
            .with_code_ref(CodeRef::line("src/main.rs", 1))
            .with_code_ref(CodeRef::range("src/lib.rs", 10, 50).with_description("Core logic"));

        assert_eq!(task.code_refs.len(), 3);
        assert_eq!(
            task.code_refs[2].description,
            Some("Core logic".to_string())
        );
    }

    #[test]
    fn test_task_started_at_field() {
        let mut task = Task::new("Test", Level::Task);
        assert!(task.started_at.is_none());

        let now = Utc::now();
        task.started_at = Some(now);
        assert_eq!(task.started_at, Some(now));
    }

    #[test]
    fn test_task_completed_at_field() {
        let mut task = Task::new("Test", Level::Task);
        assert!(task.completed_at.is_none());

        let now = Utc::now();
        task.completed_at = Some(now);
        assert_eq!(task.completed_at, Some(now));
    }

    #[test]
    fn test_task_serialize_with_started_at() {
        let mut task = Task::new("Started Task", Level::Task);
        let now = Utc::now();
        task.started_at = Some(now);

        let value = serde_json::to_value(&task).unwrap();
        assert!(
            value.get("started_at").is_some(),
            "started_at should be serialized"
        );
        // Verify it's a proper ISO8601 datetime string
        let started_at_str = value["started_at"].as_str().unwrap();
        assert!(
            started_at_str.contains('T'),
            "started_at should be ISO8601 format with 'T' separator"
        );
    }

    #[test]
    fn test_task_serialize_with_completed_at() {
        let mut task = Task::new("Completed Task", Level::Task);
        let now = Utc::now();
        task.completed_at = Some(now);

        let value = serde_json::to_value(&task).unwrap();
        assert!(
            value.get("completed_at").is_some(),
            "completed_at should be serialized"
        );
        // Verify it's a proper ISO8601 datetime string
        let completed_at_str = value["completed_at"].as_str().unwrap();
        assert!(
            completed_at_str.contains('T'),
            "completed_at should be ISO8601 format with 'T' separator"
        );
    }

    #[test]
    fn test_task_serialize_without_timestamps_omits_fields() {
        let task = Task::new("No Timestamps", Level::Task);
        let value = serde_json::to_value(&task).unwrap();
        assert!(
            value.get("started_at").is_none(),
            "started_at should be omitted when None"
        );
        assert!(
            value.get("completed_at").is_none(),
            "completed_at should be omitted when None"
        );
    }

    #[test]
    fn test_task_deserialize_with_started_at() {
        let json = r#"{
            "title": "Started Task",
            "level": "task",
            "started_at": "2025-01-06T12:00:00Z"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.started_at.is_some());
        let started_at = task.started_at.unwrap();
        assert_eq!(started_at.hour(), 12);
    }

    #[test]
    fn test_task_deserialize_with_completed_at() {
        let json = r#"{
            "title": "Completed Task",
            "level": "task",
            "completed_at": "2025-01-06T15:30:00Z"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.completed_at.is_some());
        let completed_at = task.completed_at.unwrap();
        assert_eq!(completed_at.hour(), 15);
        assert_eq!(completed_at.minute(), 30);
    }

    #[test]
    fn test_task_deserialize_without_timestamps() {
        let json = r#"{
            "title": "No Timestamps",
            "level": "task"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.started_at.is_none());
        assert!(task.completed_at.is_none());
    }

    #[test]
    fn test_task_deserialize_with_both_timestamps() {
        let json = r#"{
            "title": "Full Lifecycle Task",
            "level": "task",
            "started_at": "2025-01-06T10:00:00Z",
            "completed_at": "2025-01-06T14:00:00Z"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.started_at.is_some());
        assert!(task.completed_at.is_some());
        // completed_at should be after started_at
        let started = task.started_at.unwrap();
        let completed = task.completed_at.unwrap();
        assert!(
            completed > started,
            "completed_at should be after started_at"
        );
    }

    #[test]
    fn test_task_timestamps_are_datetime_type() {
        let mut task = Task::new("Type Check", Level::Task);
        let now: DateTime<Utc> = Utc::now();
        task.started_at = Some(now);
        task.completed_at = Some(now);

        // Verify the types are DateTime<Utc>, not String
        // This is a compile-time check - if it compiles, the types are correct
        let _started: Option<DateTime<Utc>> = task.started_at;
        let _completed: Option<DateTime<Utc>> = task.completed_at;
    }

    // Task workflow assignment tests
    #[test]
    fn test_task_with_workflow() {
        let workflow_id = Thing::from(("workflow", "wf123"));
        let step_id = Thing::from(("step", "step1"));
        let task = Task::new("Task with workflow", Level::Task)
            .with_workflow(workflow_id.clone(), step_id.clone());

        assert_eq!(task.workflow_id, Some(workflow_id));
        assert_eq!(task.current_step_id, Some(step_id));
    }

    #[test]
    fn test_task_without_workflow() {
        let workflow_id = Thing::from(("workflow", "wf123"));
        let step_id = Thing::from(("step", "step2"));
        let task = Task::new("Task", Level::Task)
            .with_workflow(workflow_id, step_id)
            .without_workflow();

        assert!(task.workflow_id.is_none());
        assert!(task.current_step_id.is_none());
    }

    #[test]
    fn test_task_workflow_serialize() {
        let workflow_id = Thing::from(("workflow", "wf123"));
        let step_id = Thing::from(("step", "step1"));
        let task =
            Task::new("Workflow Task", Level::Task).with_workflow(workflow_id, step_id.clone());

        let value = serde_json::to_value(&task).unwrap();
        assert!(
            value.get("workflow_id").is_some(),
            "workflow_id should be serialized"
        );
        assert!(
            value.get("current_step_id").is_some(),
            "current_step_id should be serialized"
        );
    }

    #[test]
    fn test_task_workflow_serialize_without_workflow() {
        // Tasks are created without workflow assignment
        let task = Task::new("Without Workflow", Level::Task);
        let value = serde_json::to_value(&task).unwrap();

        // workflow_id and current_step_id are None and skip_serializing_if = "Option::is_none"
        assert!(
            value.get("workflow_id").is_none(),
            "workflow_id should not be present without workflow assignment"
        );
        assert!(
            value.get("current_step_id").is_none(),
            "current_step_id should not be present without workflow assignment"
        );
    }

    #[test]
    fn test_task_workflow_roundtrip() {
        // Create a task with workflow, serialize it, then deserialize it
        let workflow_id = Thing::from(("workflow", "wf456"));
        let step_id = Thing::from(("step", "step2"));
        let original = Task::new("Workflow Task", Level::Task)
            .with_workflow(workflow_id.clone(), step_id.clone());

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: Task = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.workflow_id, Some(workflow_id));
        assert_eq!(deserialized.current_step_id, Some(step_id));
    }

    #[test]
    fn test_task_workflow_deserialize_without_workflow() {
        let json = r#"{
            "title": "No Workflow Task",
            "level": "task"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.workflow_id.is_none());
        assert!(task.current_step_id.is_none());
    }

    #[test]
    fn test_task_workflow_equality() {
        let workflow_id = Thing::from(("workflow", "wf123"));
        let step_id = Thing::from(("step", "step1"));
        let task1 =
            Task::new("Test", Level::Task).with_workflow(workflow_id.clone(), step_id.clone());
        let task2 = Task::new("Test", Level::Task).with_workflow(workflow_id, step_id);
        let task3 = Task::new("Test", Level::Task);

        assert_eq!(task1, task2);
        assert_ne!(task1, task3);
    }

    // Workflow tests
    #[test]
    fn test_workflow_new() {
        let workflow = Workflow::new("CI Pipeline");
        assert!(workflow.id.is_none());
        assert_eq!(workflow.name, "CI Pipeline");
        assert!(workflow.description.is_none());
        assert!(workflow.initial_step.is_none());
        assert!(workflow.metadata.is_empty());
        assert!(workflow.created_at.is_none());
        assert!(workflow.updated_at.is_none());
    }

    #[test]
    fn test_workflow_with_description() {
        let workflow =
            Workflow::new("Build Pipeline").with_description("Builds and tests the project");
        assert_eq!(
            workflow.description,
            Some("Builds and tests the project".to_string())
        );
    }

    #[test]
    fn test_workflow_with_metadata() {
        let workflow = Workflow::new("Metadata Test")
            .with_metadata("version", "1.0")
            .with_metadata("owner", "team-a");
        assert_eq!(workflow.metadata.get("version"), Some(&"1.0".to_string()));
        assert_eq!(workflow.metadata.get("owner"), Some(&"team-a".to_string()));
    }

    #[test]
    fn test_workflow_with_auto_advance() {
        let workflow = Workflow::new("Auto Advance Test").with_auto_advance(true);
        assert!(workflow.auto_advance);

        let workflow_default = Workflow::new("Default Auto Advance");
        assert!(!workflow_default.auto_advance);
    }

    #[test]
    fn test_workflow_serialize_minimal() {
        let workflow = Workflow::new("Minimal");
        let value = serde_json::to_value(&workflow).unwrap();
        assert_eq!(value["name"], "Minimal");
        assert!(value.get("id").is_none());
        assert!(value.get("description").is_none());
        assert!(value.get("created_at").is_none());
        assert!(value.get("updated_at").is_none());
    }

    #[test]
    fn test_workflow_deserialize_minimal() {
        let json = r#"{"name": "Minimal"}"#;
        let workflow: Workflow = serde_json::from_str(json).unwrap();
        assert_eq!(workflow.name, "Minimal");
        assert!(workflow.description.is_none());
        assert!(workflow.metadata.is_empty());
    }

    #[test]
    fn test_workflow_clone_and_eq() {
        let workflow = Workflow::new("Clone Test")
            .with_description("Test")
            .with_metadata("k", "v");
        let cloned = workflow.clone();
        assert_eq!(workflow, cloned);
    }

    #[test]
    fn test_workflow_eq_ignores_timestamps() {
        let workflow1 = Workflow::new("Test");
        let mut workflow2 = Workflow::new("Test");
        workflow2.created_at = Some(Utc::now());
        workflow2.updated_at = Some(Utc::now());
        // Workflows should be equal even with different timestamps
        assert_eq!(workflow1, workflow2);
    }

    #[test]
    fn test_workflow_builder_chain() {
        let workflow = Workflow::new("Full Pipeline")
            .with_description("Complete CI/CD pipeline")
            .with_metadata("version", "2.0")
            .with_metadata("team", "platform");

        assert_eq!(workflow.name, "Full Pipeline");
        assert!(workflow.description.is_some());
        assert_eq!(workflow.metadata.len(), 2);
    }

    #[test]
    fn test_workflow_serialize_deserialize_roundtrip() {
        let original = Workflow::new("Roundtrip Test")
            .with_description("Test roundtrip serialization")
            .with_metadata("key1", "value1")
            .with_metadata("key2", "value2");

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: Workflow = serde_json::from_str(&json).unwrap();

        assert_eq!(original, deserialized);
    }

    // ========================================
    // ExecutionStatus enum tests
    // ========================================

    #[test]
    fn test_execution_status_as_str() {
        assert_eq!(ExecutionStatus::InProgress.as_str(), "in_progress");
        assert_eq!(ExecutionStatus::Completed.as_str(), "completed");
        assert_eq!(ExecutionStatus::Failed.as_str(), "failed");
    }

    #[test]
    fn test_execution_status_display() {
        assert_eq!(format!("{}", ExecutionStatus::InProgress), "in_progress");
        assert_eq!(format!("{}", ExecutionStatus::Completed), "completed");
        assert_eq!(format!("{}", ExecutionStatus::Failed), "failed");
    }

    #[test]
    fn test_execution_status_parse() {
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
        assert_eq!(ExecutionStatus::parse("unknown"), None);
        assert_eq!(ExecutionStatus::parse(""), None);
    }

    #[test]
    fn test_execution_status_is_terminal() {
        assert!(!ExecutionStatus::InProgress.is_terminal());
        assert!(ExecutionStatus::Completed.is_terminal());
        assert!(ExecutionStatus::Failed.is_terminal());
    }

    #[test]
    fn test_execution_status_serialize() {
        assert_eq!(
            serde_json::to_string(&ExecutionStatus::InProgress).unwrap(),
            "\"in_progress\""
        );
        assert_eq!(
            serde_json::to_string(&ExecutionStatus::Completed).unwrap(),
            "\"completed\""
        );
        assert_eq!(
            serde_json::to_string(&ExecutionStatus::Failed).unwrap(),
            "\"failed\""
        );
    }

    #[test]
    fn test_execution_status_deserialize() {
        assert_eq!(
            serde_json::from_str::<ExecutionStatus>("\"in_progress\"").unwrap(),
            ExecutionStatus::InProgress
        );
        assert_eq!(
            serde_json::from_str::<ExecutionStatus>("\"completed\"").unwrap(),
            ExecutionStatus::Completed
        );
        assert_eq!(
            serde_json::from_str::<ExecutionStatus>("\"failed\"").unwrap(),
            ExecutionStatus::Failed
        );
    }

    #[test]
    fn test_execution_status_clone_and_eq() {
        let status = ExecutionStatus::InProgress;
        let cloned = status.clone();
        assert_eq!(status, cloned);
    }

    // ========================================
    // StepExecution struct tests
    // ========================================

    #[test]
    fn test_step_execution_new() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let before = Utc::now();
        let execution = StepExecution::new(task_id.clone(), workflow_id.clone(), "review");
        let after = Utc::now();

        assert!(execution.id.is_none());
        assert_eq!(execution.task_id, task_id);
        assert_eq!(execution.workflow_id, workflow_id);
        assert_eq!(execution.step_name, "review");
        assert!(
            execution.started_at >= before && execution.started_at <= after,
            "started_at should be within test execution time"
        );
        assert!(execution.completed_at.is_none());
        assert_eq!(execution.status, ExecutionStatus::InProgress);
    }

    #[test]
    fn test_step_execution_with_started_at() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));
        let custom_time = Utc::now() - chrono::Duration::hours(1);

        let execution =
            StepExecution::new(task_id, workflow_id, "test").with_started_at(custom_time);

        assert_eq!(execution.started_at, custom_time);
    }

    #[test]
    fn test_step_execution_complete() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let mut execution = StepExecution::new(task_id, workflow_id, "build");

        let before = Utc::now();
        execution.complete();
        let after = Utc::now();

        assert_eq!(execution.status, ExecutionStatus::Completed);
        assert!(execution.completed_at.is_some());
        let completed_at = execution.completed_at.unwrap();
        assert!(
            completed_at >= before && completed_at <= after,
            "completed_at should be within test execution time"
        );
    }

    #[test]
    fn test_step_execution_complete_at() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));
        let custom_time = Utc::now() - chrono::Duration::minutes(30);

        let mut execution = StepExecution::new(task_id, workflow_id, "deploy");
        execution.complete_at(custom_time);

        assert_eq!(execution.status, ExecutionStatus::Completed);
        assert_eq!(execution.completed_at, Some(custom_time));
    }

    #[test]
    fn test_step_execution_fail() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let mut execution = StepExecution::new(task_id, workflow_id, "test");

        let before = Utc::now();
        execution.fail();
        let after = Utc::now();

        assert_eq!(execution.status, ExecutionStatus::Failed);
        assert!(execution.completed_at.is_some());
        let completed_at = execution.completed_at.unwrap();
        assert!(
            completed_at >= before && completed_at <= after,
            "completed_at should be within test execution time"
        );
    }

    #[test]
    fn test_step_execution_fail_at() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));
        let custom_time = Utc::now() - chrono::Duration::minutes(15);

        let mut execution = StepExecution::new(task_id, workflow_id, "lint");
        execution.fail_at(custom_time);

        assert_eq!(execution.status, ExecutionStatus::Failed);
        assert_eq!(execution.completed_at, Some(custom_time));
    }

    #[test]
    fn test_step_execution_is_finished() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let mut execution = StepExecution::new(task_id.clone(), workflow_id.clone(), "step");
        assert!(
            !execution.is_finished(),
            "InProgress should not be finished"
        );

        execution.complete();
        assert!(execution.is_finished(), "Completed should be finished");

        let mut execution2 = StepExecution::new(task_id, workflow_id, "step2");
        execution2.fail();
        assert!(execution2.is_finished(), "Failed should be finished");
    }

    #[test]
    fn test_step_execution_duration() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let start_time = Utc::now() - chrono::Duration::hours(1);
        let end_time = Utc::now();

        let mut execution =
            StepExecution::new(task_id, workflow_id, "long_step").with_started_at(start_time);

        // Duration should be None before completion
        assert!(execution.duration().is_none());

        // Complete the execution
        execution.complete_at(end_time);

        // Duration should now be available
        let duration = execution.duration();
        assert!(duration.is_some());
        // Duration should be approximately 1 hour
        let dur = duration.unwrap();
        assert!(
            dur.num_minutes() >= 59 && dur.num_minutes() <= 61,
            "Duration should be approximately 1 hour"
        );
    }

    #[test]
    fn test_step_execution_serialize() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let execution = StepExecution::new(task_id, workflow_id, "test_step");
        let value = serde_json::to_value(&execution).unwrap();

        // Check task_id is serialized (Thing serializes with table:id format)
        assert!(value.get("task_id").is_some(), "task_id should be present");
        assert!(
            value.get("workflow_id").is_some(),
            "workflow_id should be present"
        );
        assert_eq!(value["step_name"], "test_step");
        assert_eq!(value["status"], "in_progress");
        assert!(
            value.get("started_at").is_some(),
            "started_at should be present"
        );
        assert!(
            value.get("completed_at").is_none(),
            "completed_at should be omitted when None"
        );
        assert!(value.get("id").is_none(), "id should be omitted when None");
    }

    #[test]
    fn test_step_execution_serialize_with_completed_at() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let mut execution = StepExecution::new(task_id, workflow_id, "completed_step");
        execution.complete();

        let value = serde_json::to_value(&execution).unwrap();
        assert_eq!(value["status"], "completed");
        assert!(
            value.get("completed_at").is_some(),
            "completed_at should be present when set"
        );
    }

    #[test]
    fn test_step_execution_deserialize() {
        // Thing type requires object format with tb (table) and id fields
        let json = r#"{
            "task_id": {"tb": "task", "id": {"String": "task123"}},
            "workflow_id": {"tb": "workflow", "id": {"String": "wf456"}},
            "step_name": "review",
            "started_at": "2025-01-08T12:00:00Z",
            "status": "in_progress"
        }"#;

        let execution: StepExecution = serde_json::from_str(json).unwrap();
        assert_eq!(execution.step_name, "review");
        assert_eq!(execution.status, ExecutionStatus::InProgress);
        assert!(execution.completed_at.is_none());
    }

    #[test]
    fn test_step_execution_deserialize_with_completed() {
        // Thing type requires object format with tb (table) and id fields
        let json = r#"{
            "task_id": {"tb": "task", "id": {"String": "task123"}},
            "workflow_id": {"tb": "workflow", "id": {"String": "wf456"}},
            "step_name": "deploy",
            "started_at": "2025-01-08T12:00:00Z",
            "completed_at": "2025-01-08T13:30:00Z",
            "status": "completed"
        }"#;

        let execution: StepExecution = serde_json::from_str(json).unwrap();
        assert_eq!(execution.step_name, "deploy");
        assert_eq!(execution.status, ExecutionStatus::Completed);
        assert!(execution.completed_at.is_some());
    }

    #[test]
    fn test_step_execution_clone() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let execution = StepExecution::new(task_id, workflow_id, "clone_test");
        let cloned = execution.clone();

        assert_eq!(execution.task_id, cloned.task_id);
        assert_eq!(execution.workflow_id, cloned.workflow_id);
        assert_eq!(execution.step_name, cloned.step_name);
        assert_eq!(execution.status, cloned.status);
    }

    #[test]
    fn test_step_execution_eq_ignores_timestamps() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let execution1 = StepExecution::new(task_id.clone(), workflow_id.clone(), "step");
        // Create a second execution with a different started_at
        let execution2 = StepExecution::new(task_id, workflow_id, "step")
            .with_started_at(Utc::now() - chrono::Duration::days(1));

        // Should be equal because timestamps are ignored in PartialEq
        assert_eq!(execution1, execution2);
    }

    #[test]
    fn test_step_execution_serialize_roundtrip() {
        let task_id = Thing::from(("task", "task123"));
        let workflow_id = Thing::from(("workflow", "wf456"));

        let mut original = StepExecution::new(task_id, workflow_id, "roundtrip");
        original.complete();

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: StepExecution = serde_json::from_str(&json).unwrap();

        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_step_execution_all_statuses_serializable() {
        let task_id = Thing::from(("task", "t1"));
        let workflow_id = Thing::from(("workflow", "w1"));

        // Test InProgress
        let exec_ip = StepExecution::new(task_id.clone(), workflow_id.clone(), "step1");
        let json_ip = serde_json::to_string(&exec_ip).unwrap();
        assert!(json_ip.contains("in_progress"));

        // Test Completed
        let mut exec_c = StepExecution::new(task_id.clone(), workflow_id.clone(), "step2");
        exec_c.complete();
        let json_c = serde_json::to_string(&exec_c).unwrap();
        assert!(json_c.contains("completed"));

        // Test Failed
        let mut exec_f = StepExecution::new(task_id, workflow_id, "step3");
        exec_f.fail();
        let json_f = serde_json::to_string(&exec_f).unwrap();
        assert!(json_f.contains("failed"));
    }

    // ========================================
    // SessionLog tests
    // ========================================

    #[test]
    fn test_session_log_new() {
        let step_execution_id = Thing::from(("step_execution", "exec123"));
        let log = SessionLog::new(step_execution_id.clone(), "Test log content");

        assert!(log.id.is_none());
        assert_eq!(log.step_execution_id, step_execution_id);
        assert_eq!(log.content, "Test log content");
    }

    #[test]
    fn test_session_log_with_created_at() {
        let step_execution_id = Thing::from(("step_execution", "exec123"));
        let custom_time = Utc::now() - chrono::Duration::hours(2);

        let log = SessionLog::new(step_execution_id, "Content").with_created_at(custom_time);

        assert_eq!(log.created_at, custom_time);
    }

    #[test]
    fn test_session_log_clone() {
        let step_execution_id = Thing::from(("step_execution", "exec123"));
        let log = SessionLog::new(step_execution_id, "Clone test");
        let cloned = log.clone();

        assert_eq!(log.step_execution_id, cloned.step_execution_id);
        assert_eq!(log.content, cloned.content);
    }

    #[test]
    fn test_session_log_eq_ignores_timestamps() {
        let step_execution_id = Thing::from(("step_execution", "exec123"));

        let log1 = SessionLog::new(step_execution_id.clone(), "Same content");
        let log2 = SessionLog::new(step_execution_id, "Same content")
            .with_created_at(Utc::now() - chrono::Duration::days(1));

        // Should be equal because timestamps are ignored in PartialEq
        assert_eq!(log1, log2);
    }

    #[test]
    fn test_session_log_neq_different_content() {
        let step_execution_id = Thing::from(("step_execution", "exec123"));

        let log1 = SessionLog::new(step_execution_id.clone(), "Content A");
        let log2 = SessionLog::new(step_execution_id, "Content B");

        assert_ne!(log1, log2);
    }

    #[test]
    fn test_session_log_serialize() {
        let step_execution_id = Thing::from(("step_execution", "exec123"));
        let log = SessionLog::new(step_execution_id, "Serialize test");

        let value = serde_json::to_value(&log).unwrap();

        assert!(
            value.get("step_execution_id").is_some(),
            "step_execution_id should be present"
        );
        assert_eq!(value["content"], "Serialize test");
        assert!(
            value.get("created_at").is_some(),
            "created_at should be present"
        );
        assert!(value.get("id").is_none(), "id should be omitted when None");
    }

    #[test]
    fn test_session_log_deserialize() {
        // Thing type requires object format with tb (table) and id fields
        let json = r#"{
            "step_execution_id": {"tb": "step_execution", "id": {"String": "exec123"}},
            "content": "Deserialized content",
            "created_at": "2025-01-15T10:30:00Z"
        }"#;

        let log: SessionLog = serde_json::from_str(json).unwrap();

        assert_eq!(
            log.step_execution_id,
            Thing::from(("step_execution", "exec123"))
        );
        assert_eq!(log.content, "Deserialized content");
        assert!(log.id.is_none());
    }

    #[test]
    fn test_session_log_serialize_roundtrip() {
        let step_execution_id = Thing::from(("step_execution", "exec456"));
        let original = SessionLog::new(step_execution_id, "Roundtrip test content");

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: SessionLog = serde_json::from_str(&json).unwrap();

        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_session_log_stores_arbitrary_text() {
        let step_execution_id = Thing::from(("step_execution", "exec789"));

        // Test with various content types
        let logs = vec![
            SessionLog::new(step_execution_id.clone(), "Simple text"),
            SessionLog::new(step_execution_id.clone(), ""),
            SessionLog::new(
                step_execution_id.clone(),
                "Multi\nline\ncontent\nwith\nnewlines",
            ),
            SessionLog::new(
                step_execution_id.clone(),
                "Special chars: @#$%^&*()[]{}|\\<>?",
            ),
            SessionLog::new(step_execution_id.clone(), "Unicode: 日本語 🎉 émojis"),
            SessionLog::new(step_execution_id, "A".repeat(10000)), // Large content
        ];

        for log in logs {
            // All should serialize without error
            let json = serde_json::to_string(&log).unwrap();
            let deserialized: SessionLog = serde_json::from_str(&json).unwrap();
            assert_eq!(log.content, deserialized.content);
        }
    }

    #[test]
    fn test_session_log_debug() {
        let step_execution_id = Thing::from(("step_execution", "debug_test"));
        let log = SessionLog::new(step_execution_id, "Debug content");

        let debug_str = format!("{:?}", log);
        assert!(debug_str.contains("SessionLog"));
        assert!(debug_str.contains("Debug content"));
    }

    // ========================================
    // PermissionMode enum tests
    // ========================================

    #[test]
    fn test_permission_mode_as_str() {
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
    fn test_permission_mode_display() {
        assert_eq!(format!("{}", PermissionMode::AcceptEdits), "acceptEdits");
        assert_eq!(
            format!("{}", PermissionMode::BypassPermissions),
            "bypassPermissions"
        );
        assert_eq!(format!("{}", PermissionMode::Default), "default");
        assert_eq!(format!("{}", PermissionMode::Delegate), "delegate");
        assert_eq!(format!("{}", PermissionMode::DontAsk), "dontAsk");
        assert_eq!(format!("{}", PermissionMode::Plan), "plan");
    }

    #[test]
    fn test_permission_mode_parse() {
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

    #[test]
    fn test_permission_mode_serialize() {
        assert_eq!(
            serde_json::to_string(&PermissionMode::AcceptEdits).unwrap(),
            "\"acceptEdits\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionMode::BypassPermissions).unwrap(),
            "\"bypassPermissions\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionMode::Default).unwrap(),
            "\"default\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionMode::Delegate).unwrap(),
            "\"delegate\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionMode::DontAsk).unwrap(),
            "\"dontAsk\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionMode::Plan).unwrap(),
            "\"plan\""
        );
    }

    #[test]
    fn test_permission_mode_deserialize() {
        assert_eq!(
            serde_json::from_str::<PermissionMode>("\"acceptEdits\"").unwrap(),
            PermissionMode::AcceptEdits
        );
        assert_eq!(
            serde_json::from_str::<PermissionMode>("\"bypassPermissions\"").unwrap(),
            PermissionMode::BypassPermissions
        );
        assert_eq!(
            serde_json::from_str::<PermissionMode>("\"default\"").unwrap(),
            PermissionMode::Default
        );
        assert_eq!(
            serde_json::from_str::<PermissionMode>("\"delegate\"").unwrap(),
            PermissionMode::Delegate
        );
        assert_eq!(
            serde_json::from_str::<PermissionMode>("\"dontAsk\"").unwrap(),
            PermissionMode::DontAsk
        );
        assert_eq!(
            serde_json::from_str::<PermissionMode>("\"plan\"").unwrap(),
            PermissionMode::Plan
        );
    }

    #[test]
    fn test_permission_mode_clone_and_eq() {
        let mode = PermissionMode::AcceptEdits;
        let cloned = mode.clone();
        assert_eq!(mode, cloned);
    }

    // ========================================
    // AgentConfig struct tests
    // ========================================

    #[test]
    fn test_agent_config_new_creates_empty() {
        let config = AgentConfig::new();
        assert!(config.is_empty());
        assert_eq!(config.model, None);
        assert_eq!(config.fallback_model, None);
        assert_eq!(config.system_prompt, None);
        assert_eq!(config.append_system_prompt, None);
        assert_eq!(config.agents, None);
        assert!(config.tools.is_empty());
        assert!(config.allowed_tools.is_empty());
        assert!(config.disallowed_tools.is_empty());
        assert_eq!(config.permission_mode, None);
        assert_eq!(config.max_budget_usd, None);
        assert!(config.mcp_config.is_empty());
        assert!(config.plugin_dirs.is_empty());
        assert_eq!(config.json_schema, None);
    }

    #[test]
    fn test_agent_config_default_creates_empty() {
        let config = AgentConfig::default();
        assert!(config.is_empty());
    }

    #[test]
    fn test_agent_config_builder_methods() {
        let config = AgentConfig::new()
            .with_model("sonnet")
            .with_fallback_model("haiku")
            .with_system_prompt("You are helpful")
            .with_append_system_prompt("Be concise")
            .with_tools(vec!["Bash".to_string(), "Edit".to_string()])
            .with_allowed_tools(vec!["Bash(git:*)".to_string()])
            .with_disallowed_tools(vec!["Bash(rm:*)".to_string()])
            .with_permission_mode(PermissionMode::AcceptEdits)
            .with_max_budget_usd(10.5)
            .with_mcp_config(vec!["config.json".to_string()])
            .with_plugin_dirs(vec!["/plugins".to_string()]);

        assert_eq!(config.model, Some("sonnet".to_string()));
        assert_eq!(config.fallback_model, Some("haiku".to_string()));
        assert_eq!(config.system_prompt, Some("You are helpful".to_string()));
        assert_eq!(config.append_system_prompt, Some("Be concise".to_string()));
        assert_eq!(config.tools, vec!["Bash", "Edit"]);
        assert_eq!(config.allowed_tools, vec!["Bash(git:*)"]);
        assert_eq!(config.disallowed_tools, vec!["Bash(rm:*)"]);
        assert_eq!(config.permission_mode, Some(PermissionMode::AcceptEdits));
        assert_eq!(config.max_budget_usd, Some(10.5));
        assert_eq!(config.mcp_config, vec!["config.json"]);
        assert_eq!(config.plugin_dirs, vec!["/plugins"]);
    }

    #[test]
    fn test_agent_config_with_agents() {
        let agents_json = serde_json::json!({
            "reviewer": {
                "description": "Reviews code",
                "prompt": "You are a code reviewer"
            }
        });
        let config = AgentConfig::new().with_agents(agents_json.clone());
        assert_eq!(config.agents, Some(agents_json));
    }

    #[test]
    fn test_agent_config_with_json_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "name": {"type": "string"}
            },
            "required": ["name"]
        });
        let config = AgentConfig::new().with_json_schema(schema.clone());
        assert_eq!(config.json_schema, Some(schema));
    }

    #[test]
    fn test_agent_config_to_cli_args_empty() {
        let config = AgentConfig::new();
        let args = config.to_cli_args();
        assert!(args.is_empty());
    }

    #[test]
    fn test_agent_config_to_cli_args_model() {
        let config = AgentConfig::new().with_model("sonnet");
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--model", "sonnet"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_fallback_model() {
        let config = AgentConfig::new().with_fallback_model("haiku");
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--fallbackModel", "haiku"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_system_prompt() {
        let config = AgentConfig::new().with_system_prompt("You are helpful");
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--systemPrompt", "You are helpful"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_append_system_prompt() {
        let config = AgentConfig::new().with_append_system_prompt("Be concise");
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--appendSystemPrompt", "Be concise"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_agents() {
        let agents = serde_json::json!({"test": "value"});
        let config = AgentConfig::new().with_agents(agents);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--agents", "{\"test\":\"value\"}"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_tools() {
        let config = AgentConfig::new().with_tools(vec!["Bash".to_string(), "Edit".to_string()]);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--tools", "Bash", "Edit"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_allowed_tools() {
        let config = AgentConfig::new()
            .with_allowed_tools(vec!["Bash(git:*)".to_string(), "Read".to_string()]);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--allowedTools", "Bash(git:*)", "Read"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_disallowed_tools() {
        let config = AgentConfig::new().with_disallowed_tools(vec!["Bash(rm:*)".to_string()]);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--disallowedTools", "Bash(rm:*)"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_permission_mode() {
        let config = AgentConfig::new().with_permission_mode(PermissionMode::AcceptEdits);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--permissionMode", "acceptEdits"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_max_budget_whole_number() {
        let config = AgentConfig::new().with_max_budget_usd(5.0);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--maxBudgetUsd", "5"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_max_budget_decimal() {
        let config = AgentConfig::new().with_max_budget_usd(5.5);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--maxBudgetUsd", "5.5"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_mcp_config() {
        let config = AgentConfig::new()
            .with_mcp_config(vec!["config1.json".to_string(), "config2.json".to_string()]);
        let args = config.to_cli_args();
        assert_eq!(
            args,
            vec!["--mcpConfig", "config1.json", "--mcpConfig", "config2.json"]
        );
    }

    #[test]
    fn test_agent_config_to_cli_args_plugin_dirs() {
        let config = AgentConfig::new().with_plugin_dirs(vec!["/path/to/plugins".to_string()]);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--pluginDir", "/path/to/plugins"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_json_schema() {
        let schema = serde_json::json!({"type": "string"});
        let config = AgentConfig::new().with_json_schema(schema);
        let args = config.to_cli_args();
        assert_eq!(args, vec!["--json-schema", "{\"type\":\"string\"}"]);
    }

    #[test]
    fn test_agent_config_to_cli_args_multiple_fields() {
        let config = AgentConfig::new()
            .with_model("sonnet")
            .with_max_budget_usd(5.0)
            .with_permission_mode(PermissionMode::Default);
        let args = config.to_cli_args();
        assert_eq!(
            args,
            vec![
                "--model",
                "sonnet",
                "--permissionMode",
                "default",
                "--maxBudgetUsd",
                "5"
            ]
        );
    }

    #[test]
    fn test_agent_config_is_empty_false_with_model() {
        let config = AgentConfig::new().with_model("sonnet");
        assert!(!config.is_empty());
    }

    #[test]
    fn test_agent_config_is_empty_false_with_tools() {
        let config = AgentConfig::new().with_tools(vec!["Bash".to_string()]);
        assert!(!config.is_empty());
    }

    #[test]
    fn test_agent_config_merge_empty_configs() {
        let base = AgentConfig::new();
        let other = AgentConfig::new();
        let merged = base.merge(other);
        assert!(merged.is_empty());
    }

    #[test]
    fn test_agent_config_merge_other_takes_precedence() {
        let base = AgentConfig::new()
            .with_model("sonnet")
            .with_max_budget_usd(5.0);
        let other = AgentConfig::new()
            .with_model("opus")
            .with_system_prompt("New prompt");
        let merged = base.merge(other);
        assert_eq!(merged.model, Some("opus".to_string()));
        assert_eq!(merged.system_prompt, Some("New prompt".to_string()));
        assert_eq!(merged.max_budget_usd, Some(5.0)); // Preserved from base
    }

    #[test]
    fn test_agent_config_merge_vec_fields_replace() {
        let base = AgentConfig::new().with_tools(vec!["Bash".to_string(), "Edit".to_string()]);
        let other = AgentConfig::new().with_tools(vec!["Read".to_string()]);
        let merged = base.merge(other);
        assert_eq!(merged.tools, vec!["Read"]);
    }

    #[test]
    fn test_agent_config_merge_empty_vec_preserves_base() {
        let base = AgentConfig::new().with_tools(vec!["Bash".to_string(), "Edit".to_string()]);
        let other = AgentConfig::new(); // tools is empty
        let merged = base.merge(other);
        assert_eq!(merged.tools, vec!["Bash", "Edit"]);
    }

    #[test]
    fn test_agent_config_serialize_empty() {
        let config = AgentConfig::new();
        let json = serde_json::to_string(&config).unwrap();
        // Empty config should serialize to minimal JSON
        assert_eq!(json, "{}");
    }

    #[test]
    fn test_agent_config_serialize_with_values() {
        let config = AgentConfig::new()
            .with_model("sonnet")
            .with_permission_mode(PermissionMode::AcceptEdits);
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"model\":\"sonnet\""));
        assert!(json.contains("\"permission_mode\":\"acceptEdits\""));
    }

    #[test]
    fn test_agent_config_deserialize() {
        let json = r#"{"model":"sonnet","max_budget_usd":10.5}"#;
        let config: AgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.model, Some("sonnet".to_string()));
        assert_eq!(config.max_budget_usd, Some(10.5));
        assert!(config.system_prompt.is_none());
    }

    #[test]
    fn test_agent_config_deserialize_with_tools() {
        let json = r#"{"tools":["Bash","Edit"],"allowed_tools":["Read"]}"#;
        let config: AgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.tools, vec!["Bash", "Edit"]);
        assert_eq!(config.allowed_tools, vec!["Read"]);
    }

    #[test]
    fn test_agent_config_deserialize_with_permission_mode() {
        let json = r#"{"permission_mode":"dontAsk"}"#;
        let config: AgentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.permission_mode, Some(PermissionMode::DontAsk));
    }

    #[test]
    fn test_agent_config_roundtrip() {
        let original = AgentConfig::new()
            .with_model("sonnet")
            .with_fallback_model("haiku")
            .with_system_prompt("Test prompt")
            .with_append_system_prompt("Append")
            .with_tools(vec!["Bash".to_string()])
            .with_allowed_tools(vec!["Read".to_string()])
            .with_disallowed_tools(vec!["Write".to_string()])
            .with_permission_mode(PermissionMode::Plan)
            .with_max_budget_usd(25.5)
            .with_mcp_config(vec!["mcp.json".to_string()])
            .with_plugin_dirs(vec!["/plugins".to_string()])
            .with_agents(serde_json::json!({"test": "agent"}))
            .with_json_schema(serde_json::json!({"type": "object"}));

        let json = serde_json::to_string(&original).unwrap();
        let deserialized: AgentConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_agent_config_clone_and_eq() {
        let config = AgentConfig::new()
            .with_model("sonnet")
            .with_permission_mode(PermissionMode::Default);
        let cloned = config.clone();
        assert_eq!(config, cloned);
    }

    #[test]
    fn test_agent_config_debug() {
        let config = AgentConfig::new().with_model("sonnet");
        let debug_str = format!("{:?}", config);
        assert!(debug_str.contains("AgentConfig"));
        assert!(debug_str.contains("sonnet"));
    }

    #[test]
    fn test_format_float_whole_number() {
        assert_eq!(format_float(5.0), "5");
        assert_eq!(format_float(100.0), "100");
        assert_eq!(format_float(0.0), "0");
    }

    #[test]
    fn test_format_float_decimal() {
        assert_eq!(format_float(5.5), "5.5");
        assert_eq!(format_float(10.25), "10.25");
        assert_eq!(format_float(0.1), "0.1");
    }

    #[test]
    fn test_format_float_removes_trailing_zeros() {
        assert_eq!(format_float(5.50), "5.5");
        assert_eq!(format_float(10.100), "10.1");
    }

    // Step model tests
    #[test]
    fn test_step_new() {
        let workflow_id = Thing::from(("workflow", "test"));
        let step = Step::new("Review", workflow_id.clone());

        assert!(step.id.is_none());
        assert_eq!(step.name, "Review");
        assert_eq!(step.workflow_id, workflow_id);
        assert_eq!(step.agent_config, AgentConfig::default());
        assert!(!step.is_final);
        assert!(step.transitions_to.is_empty());
        assert_eq!(step.order, 0);
        assert!(step.created_at.is_none());
        assert!(step.updated_at.is_none());
    }

    #[test]
    fn test_step_builder_pattern() {
        let workflow_id = Thing::from(("workflow", "test"));
        let transition_id = Thing::from(("step", "next"));
        let agent_config = AgentConfig::new().with_model("opus");

        let step = Step::new("Build", workflow_id.clone())
            .with_agent_config(agent_config.clone())
            .with_is_final(true)
            .with_transition(transition_id.clone())
            .with_order(1);

        assert_eq!(step.name, "Build");
        assert_eq!(step.workflow_id, workflow_id);
        assert_eq!(step.agent_config, agent_config);
        assert!(step.is_final);
        assert_eq!(step.transitions_to.len(), 1);
        assert_eq!(step.transitions_to[0], transition_id);
        assert_eq!(step.order, 1);
    }

    #[test]
    fn test_step_equality_by_id() {
        let workflow_id = Thing::from(("workflow", "test"));

        let mut step1 = Step::new("Step 1", workflow_id.clone());
        step1.id = Some(Thing::from(("step", "same")));

        let mut step2 = Step::new("Step 2", workflow_id.clone());
        step2.id = Some(Thing::from(("step", "same")));

        // Same ID means equal, even if other fields differ
        assert_eq!(step1, step2);

        step2.id = Some(Thing::from(("step", "different")));
        assert_ne!(step1, step2);
    }

    #[test]
    fn test_step_serialization() {
        let workflow_id = Thing::from(("workflow", "test"));
        let step = Step::new("Test Step", workflow_id)
            .with_order(5)
            .with_is_final(true);

        let json = serde_json::to_string(&step).unwrap();
        assert!(json.contains("\"name\":\"Test Step\""));
        assert!(json.contains("\"is_final\":true"));
        assert!(json.contains("\"order\":5"));
    }
}
