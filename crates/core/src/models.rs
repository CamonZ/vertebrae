//! Domain models for Vertebrae
//!
//! These are database-agnostic domain models with String IDs.
//! Types that don't depend on database-specific types (like `Thing`)
//! are re-exported directly from `vertebrae_db`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// Re-export types that are already DB-agnostic (no Thing fields)
pub use vertebrae_db::models::TokenUsage;
pub use vertebrae_db::{
    AgentConfig, BlockerNode, CodeRef, ExecutionStatus, Level, PermissionMode, Priority, Section,
    SectionType, TaskFilter, TaskSummary,
};

/// A task in the Vertebrae task management system (domain model)
///
/// All IDs are plain strings rather than database-specific record types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    /// Unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,

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

    /// Embedded sections
    #[serde(default)]
    pub sections: Vec<Section>,

    /// Embedded code references
    #[serde(default, rename = "refs")]
    pub code_refs: Vec<CodeRef>,

    /// Whether this task needs human review
    #[serde(default)]
    pub needs_human_review: Option<bool>,

    /// Feedback for revision
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_feedback: Option<String>,

    /// Rejection reason
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,

    /// Workflow ID (as string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,

    /// Current step ID (as string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step_id: Option<String>,
}

impl Task {
    /// Create a new task with required fields
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

/// Helper to extract string ID from a Thing
fn thing_to_id(thing: &surrealdb::sql::Thing) -> String {
    thing.id.to_raw()
}

/// Helper to extract optional string ID from an optional Thing
fn option_thing_to_id(thing: &Option<surrealdb::sql::Thing>) -> Option<String> {
    thing.as_ref().map(|t| t.id.to_raw())
}

impl From<vertebrae_db::Task> for Task {
    fn from(db: vertebrae_db::Task) -> Self {
        Self {
            id: db.id.as_ref().map(thing_to_id),
            title: db.title,
            description: db.description,
            level: db.level,
            priority: db.priority,
            tags: db.tags,
            created_at: db.created_at,
            updated_at: db.updated_at,
            started_at: db.started_at,
            completed_at: db.completed_at,
            sections: db.sections,
            code_refs: db.code_refs,
            needs_human_review: db.needs_human_review,
            revision_feedback: db.revision_feedback,
            rejection_reason: db.rejection_reason,
            workflow_id: option_thing_to_id(&db.workflow_id),
            current_step_id: option_thing_to_id(&db.current_step_id),
        }
    }
}

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

impl From<vertebrae_db::Step> for Step {
    fn from(db: vertebrae_db::Step) -> Self {
        Self {
            id: db.id.as_ref().map(thing_to_id),
            name: db.name,
            workflow_id: thing_to_id(&db.workflow_id),
            goal: db.goal,
            agents: db.agents,
            skills: db.skills,
            agent_config: db.agent_config,
            is_final: db.is_final,
            transitions_to: db.transitions_to.iter().map(thing_to_id).collect(),
            order: db.order,
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}

impl Step {
    /// Convert domain Step to database Step
    pub fn to_db(&self) -> vertebrae_db::Step {
        vertebrae_db::Step {
            id: self
                .id
                .as_ref()
                .map(|id| surrealdb::sql::Thing::from(("step", id.as_str()))),
            name: self.name.clone(),
            workflow_id: surrealdb::sql::Thing::from(("workflow", self.workflow_id.as_str())),
            goal: self.goal.clone(),
            agents: self.agents.clone(),
            skills: self.skills.clone(),
            agent_config: self.agent_config.clone(),
            is_final: self.is_final,
            transitions_to: self
                .transitions_to
                .iter()
                .map(|id| surrealdb::sql::Thing::from(("step", id.as_str())))
                .collect(),
            order: self.order,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

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

impl From<vertebrae_db::Workflow> for Workflow {
    fn from(db: vertebrae_db::Workflow) -> Self {
        Self {
            id: db.id.as_ref().map(thing_to_id),
            name: db.name,
            description: db.description,
            initial_step: db.initial_step.as_ref().map(thing_to_id),
            metadata: db.metadata,
            auto_advance: db.auto_advance,
            order: db.order,
            created_at: db.created_at,
            updated_at: db.updated_at,
        }
    }
}

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

impl From<vertebrae_db::StepExecution> for StepExecution {
    fn from(db: vertebrae_db::StepExecution) -> Self {
        Self {
            id: db.id.as_ref().map(thing_to_id),
            task_id: thing_to_id(&db.task_id),
            workflow_id: thing_to_id(&db.workflow_id),
            step_name: db.step_name,
            started_at: db.started_at,
            completed_at: db.completed_at,
            status: db.status,
            context: db.context,
            prompt: db.prompt,
            output: db.output,
            transition_result: db.transition_result,
            model_used: db.model_used,
            session_id: db.session_id,
            token_usage: db.token_usage,
            cost_usd: db.cost_usd,
            duration_ms: db.duration_ms,
        }
    }
}

impl StepExecution {
    /// Convert domain StepExecution to database StepExecution
    pub fn to_db(&self) -> vertebrae_db::StepExecution {
        vertebrae_db::StepExecution {
            id: self
                .id
                .as_ref()
                .map(|id| surrealdb::sql::Thing::from(("step_execution", id.as_str()))),
            task_id: surrealdb::sql::Thing::from(("task", self.task_id.as_str())),
            workflow_id: surrealdb::sql::Thing::from(("workflow", self.workflow_id.as_str())),
            step_name: self.step_name.clone(),
            started_at: self.started_at,
            completed_at: self.completed_at,
            status: self.status.clone(),
            context: self.context.clone(),
            prompt: self.prompt.clone(),
            output: self.output.clone(),
            transition_result: self.transition_result.clone(),
            model_used: self.model_used.clone(),
            session_id: self.session_id.clone(),
            token_usage: self.token_usage.clone(),
            cost_usd: self.cost_usd,
            duration_ms: self.duration_ms,
        }
    }
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

impl From<vertebrae_db::SessionLog> for SessionLog {
    fn from(db: vertebrae_db::SessionLog) -> Self {
        Self {
            id: db.id.as_ref().map(thing_to_id),
            step_execution_id: thing_to_id(&db.step_execution_id),
            content: db.content,
            created_at: db.created_at,
        }
    }
}

impl SessionLog {
    /// Convert domain SessionLog to database SessionLog
    pub fn to_db(&self) -> vertebrae_db::SessionLog {
        vertebrae_db::SessionLog {
            id: self
                .id
                .as_ref()
                .map(|id| surrealdb::sql::Thing::from(("session_log", id.as_str()))),
            step_execution_id: surrealdb::sql::Thing::from((
                "step_execution",
                self.step_execution_id.as_str(),
            )),
            content: self.content.clone(),
            created_at: self.created_at,
        }
    }
}

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

impl From<vertebrae_db::WorkflowTransition> for WorkflowTransition {
    fn from(db: vertebrae_db::WorkflowTransition) -> Self {
        Self {
            id: db.id.as_ref().map(thing_to_id),
            from_workflow: thing_to_id(&db.from_workflow),
            to_workflow: thing_to_id(&db.to_workflow),
            label: db.label,
            target_step: db.target_step.as_ref().map(thing_to_id),
            created_at: db.created_at,
        }
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

impl StepUpdate {
    /// Convert domain StepUpdate to database StepUpdate
    pub fn to_db(&self) -> vertebrae_db::StepUpdate {
        vertebrae_db::StepUpdate {
            name: self.name.clone(),
            goal: self.goal.clone(),
            agents: self.agents.clone(),
            skills: self.skills.clone(),
            agent_config: self.agent_config.clone(),
            is_final: self.is_final,
            transitions_to: self.transitions_to.as_ref().map(|trans| {
                trans
                    .iter()
                    .map(|id| surrealdb::sql::Thing::from(("step", id.as_str())))
                    .collect()
            }),
            order: self.order,
        }
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
        assert!(task.id.is_none());
        assert!(task.description.is_none());
        assert!(task.priority.is_none());
        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
        assert!(task.workflow_id.is_none());
        assert!(task.current_step_id.is_none());
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
            section_type: SectionType::Step,
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
}
