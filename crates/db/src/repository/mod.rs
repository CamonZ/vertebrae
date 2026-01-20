//! Repository modules for database operations
//!
//! Provides repository pattern implementations for task, workflow, step, relationship,
//! chat, validation_gate, and execution operations, encapsulating database queries.

mod chat;
mod execution;
mod filter;
mod graph;
mod relationship;
mod step;
mod task;
mod validation;
mod validation_gate;
mod workflow;
mod workflow_transition;

pub use chat::ChatSessionRepository;
pub use execution::StepExecutionRepository;
pub use filter::{TaskFilter, TaskLister, TaskSummary, TaskWithRelationsData};
pub use graph::{BlockerNode, GraphQueries, Progress};
pub use relationship::RelationshipRepository;
pub use step::{StepRepository, StepUpdate};
pub use task::{TaskRepository, TaskUpdate};
pub use validation::{
    SectionRule, TriageValidationConfig, TriageValidationResult, TriageValidator, ValidationIssue,
    ValidationSeverity,
};
pub use validation_gate::{ValidationGateRepository, ValidationGateUpdate};
pub use workflow::{
    DEFAULT_WORKFLOW_ID, MigrationResult, StepMigrationResult, WorkflowRepository, WorkflowUpdate,
};
pub use workflow_transition::WorkflowTransitionRepository;
