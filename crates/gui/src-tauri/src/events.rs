use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// Event payload for task changes.
/// Emitted when a task is created, updated, deleted, or its status changes.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TaskChangedEvent {
    pub task_id: String,
    pub change_type: TaskChangeType,
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
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct WorkflowChangedEvent {
    pub workflow_id: String,
    pub change_type: WorkflowChangeType,
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
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct StepChangedEvent {
    pub step_id: String,
    pub workflow_id: String,
    pub change_type: StepChangeType,
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
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct StepExecutionChangedEvent {
    pub execution_id: String,
    pub task_id: String,
    pub workflow_id: String,
    pub step_name: String,
    pub status: StepExecutionStatus,
    pub change_type: StepExecutionChangeType,
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

/// Event payload for session log creation.
/// Emitted when a new session log is created during step execution.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionLogCreatedEvent {
    pub log_id: String,
    pub execution_id: String,
}

/// Event payload for section changes.
/// Emitted when a section is created, updated, or deleted.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SectionChangedEvent {
    pub section_id: String,
    pub task_id: String,
    pub change_type: SectionChangeType,
}

/// The type of change that occurred on a section.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum SectionChangeType {
    Created,
    Updated,
    Deleted,
}
