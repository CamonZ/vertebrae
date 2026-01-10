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
}
