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

/// Event payload for workflow execution progress.
/// Emitted during workflow step execution to track progress.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct WorkflowExecutionEvent {
    pub task_id: String,
    pub workflow_id: String,
    pub event_type: WorkflowExecutionEventType,
}

/// The type of execution event that occurred.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum WorkflowExecutionEventType {
    /// Workflow execution started
    Started,
    /// Orchestrator phase started
    OrchestratorStarted {
        execution_id: String,
        step_name: String,
    },
    /// Orchestrator phase completed, prompt ready
    OrchestratorCompleted { execution_id: String },
    /// Orchestrator phase failed
    OrchestratorFailed { execution_id: String, error: String },
    /// A step execution started (execution phase)
    StepStarted {
        execution_id: String,
        step_name: String,
    },
    /// Step produced output
    StepProgress {
        execution_id: String,
        output_lines: Vec<String>,
    },
    /// A step completed successfully
    StepCompleted { execution_id: String },
    /// A step failed
    StepFailed { execution_id: String, error: String },
    /// Entire workflow completed successfully
    Completed,
    /// Workflow failed
    Failed { error: String },
}
