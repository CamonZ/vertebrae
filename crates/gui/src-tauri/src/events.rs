use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::types;

/// Event payload for task changes.
/// Emitted when a task is created, updated, deleted, or its status changes.
/// For create/update events, `task` carries the full deserialized entity.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TaskChangedEvent {
    pub task_id: String,
    pub change_type: TaskChangeType,
    pub task: Option<types::Task>,
}

/// The type of change that occurred on a task.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum TaskChangeType {
    Created,
    Updated,
    Deleted,
    StatusChanged,
}

/// Event payload for workflow changes.
/// Emitted when a workflow is created, updated, or deleted.
/// For create/update events, `workflow` carries the full deserialized entity.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct WorkflowChangedEvent {
    pub workflow_id: String,
    pub change_type: WorkflowChangeType,
    pub workflow: Option<types::Workflow>,
}

/// The type of change that occurred on a workflow.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum WorkflowChangeType {
    Created,
    Updated,
    Deleted,
    /// A task was assigned to this workflow
    TaskAssigned,
    /// A task was unassigned from a workflow
    TaskUnassigned,
}

/// Event payload for step changes.
/// Emitted when a step is created, updated, or deleted.
/// For create/update events, `step` carries the full deserialized entity.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct StepChangedEvent {
    pub step_id: String,
    pub workflow_id: String,
    pub change_type: StepChangeType,
    pub step: Option<types::Step>,
}

/// The type of change that occurred on a step.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum StepChangeType {
    Created,
    Updated,
    Deleted,
}

/// Event payload for task current step changes.
/// Emitted when a task's current_step_id is updated during workflow execution.
/// Includes the new step info so frontend can update directly without refetching.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TaskStepChangedEvent {
    pub task_id: String,
    pub step_id: String,
    pub step_name: String,
}

/// Event payload for step execution changes.
/// Emitted when a step execution is created or its status changes.
/// For create/update events, `execution` carries the full deserialized entity.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct StepExecutionChangedEvent {
    pub execution_id: String,
    pub task_id: String,
    pub workflow_id: String,
    pub step_name: String,
    pub status: StepExecutionStatus,
    pub change_type: StepExecutionChangeType,
    pub execution: Option<types::StepExecution>,
}

/// Status of a step execution (mirrors db::ExecutionStatus for frontend)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum StepExecutionStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

/// The type of change that occurred on a step execution.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum StepExecutionChangeType {
    Created,
    StatusChanged,
}

/// Event payload for step transition changes.
/// Emitted when a step transition is created or deleted.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct StepTransitionChangedEvent {
    pub transition_id: String,
    pub change_type: StepTransitionChangeType,
}

/// The type of change that occurred on a step transition.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum StepTransitionChangeType {
    Created,
    Deleted,
}

/// Event payload for workflow transition changes.
/// Emitted when a workflow-to-workflow transition is created or deleted.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct WorkflowTransitionChangedEvent {
    pub transition_id: String,
    pub from_workflow_id: Option<String>,
    pub to_workflow_id: Option<String>,
    pub change_type: WorkflowTransitionChangeType,
}

/// The type of change that occurred on a workflow transition.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum WorkflowTransitionChangeType {
    Created,
    Deleted,
}

/// Event payload for session log creation.
/// Emitted when a new session log is created during step execution.
/// `session_log` carries the full deserialized entity when available.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionLogCreatedEvent {
    pub log_id: String,
    pub step_execution_id: String,
    pub session_log: Option<types::SessionLog>,
}

/// Event payload for section changes.
/// Emitted when a section is created, updated, or deleted.
/// For create/update events, `section` carries the full deserialized entity.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SectionChangedEvent {
    pub section_id: String,
    pub task_id: String,
    pub change_type: SectionChangeType,
    pub section: Option<types::Section>,
}

/// The type of change that occurred on a section.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum SectionChangeType {
    Created,
    Updated,
    Deleted,
}
