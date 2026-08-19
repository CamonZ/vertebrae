use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::types;

/// Progress emitted while the GUI-owned local Sacrum stack is provisioned.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct LocalBackendProgressEvent {
    pub stage: LocalBackendProgressStage,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LocalBackendProgressStage {
    Pulling,
    Migrating,
    Health,
    Seeding,
}

/// Complete artifact projection changed on the active Sacrum project.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ArtifactChangedEvent {
    pub artifact_id: String,
    pub task_id: Option<String>,
    pub change_type: ArtifactChangeType,
    pub artifact: Option<types::Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum ArtifactChangeType {
    Created,
    Updated,
    Deleted,
}

/// Event payload for task changes.
/// Emitted when a task is created, updated, deleted, or its status changes.
/// For create/update events, `task` carries the full deserialized entity.
///
/// `current_step_id`, `workflow_id`, `level`, and `archived` are hoisted from
/// the Sacrum CDC payload so the reducer can act on `Deleted` events (which
/// carry a before-image tombstone, not a full Task) without keeping a local
/// task-position cache. `previous` carries the sparse before-image bucket
/// identity published for `Updated` events.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TaskChangedEvent {
    pub task_id: String,
    pub change_type: TaskChangeType,
    pub task: Option<types::Task>,
    pub current_step_id: Option<String>,
    pub workflow_id: Option<String>,
    pub level: Option<types::TaskLevel>,
    pub archived: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<TaskPreviousBucketIdentity>,
}

/// Sparse before-image values for fields that can change a task's Atlas bucket.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct TaskPreviousBucketIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<Option<types::TaskLevel>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_step_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<Option<String>>,
}

/// The type of change that occurred on a task.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum TaskChangeType {
    Created,
    Updated,
    Deleted,
    StatusChanged,
}

/// Distinguishes a live controls payload from a deleted task and a malformed
/// controls payload. `Option<TaskRunControls>` cannot represent that contract:
/// both a JSON null and a failed deserialization otherwise become `None`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "controls", rename_all = "snake_case")]
pub enum TaskRunControlsPayload {
    Present(Box<types::TaskRunControls>),
    Deleted,
    Malformed,
}

/// Event payload for TaskRun changes.
/// Emitted when a TaskRun is created or updated.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TaskRunChangedEvent {
    pub task_run_id: String,
    pub task_id: String,
    pub status: types::TaskRunStatus,
    pub change_type: TaskRunChangeType,
    pub task_run: Option<types::TaskRun>,
    pub run_controls: TaskRunControlsPayload,
}

/// The type of change that occurred on a TaskRun.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum TaskRunChangeType {
    Created,
    Updated,
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

/// Event payload for manual task workflow step changes (no TaskRun involved).
///
/// Mirrors Sacrum's `task_step_changed` wire event. Fires for manual moves
/// (`assign_workflow`, `advance_to_step`, `move_to_step`) when no orchestrator
/// run exists for the task. Only emitted when `from_step_id != to_step_id`.
///
/// `from_step_id` may be `null` on the first workflow assignment. `to_step_id`
/// is always present on this event — run-end paths are reported through
/// `TaskRunStepChangedEvent` instead.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TaskStepChangedEvent {
    pub task_id: String,
    pub from_step_id: Option<String>,
    pub to_step_id: Option<String>,
    pub workflow_id: String,
    pub level: types::TaskLevel,
}

/// Event payload for orchestrator-driven task workflow step changes.
///
/// Mirrors Sacrum's `task_run_step_changed` wire event. Fires whenever a
/// task's `current_step_id` changes while a TaskRun exists, and at run-end
/// paths (completion, retry exhaustion, stop) where `to_step_id` will be
/// `null` because the run has left active statuses.
///
/// Disjoint with `TaskStepChangedEvent`: manual moves are blocked while an
/// orchestrator is active, so clients never receive both for the same
/// transition.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TaskRunStepChangedEvent {
    pub task_run_id: String,
    pub task_id: String,
    pub from_step_id: Option<String>,
    pub to_step_id: Option<String>,
    pub status: types::TaskRunStatus,
    pub level: types::TaskLevel,
}

/// Event payload for step execution changes.
/// Emitted when a step execution is created or its status changes.
/// For create/update events, `execution` carries the full deserialized entity.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct StepExecutionChangedEvent {
    pub execution_id: String,
    pub task_id: String,
    pub task_run_id: String,
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
///
/// `from_step_id` / `to_step_id` are hoisted from the Sacrum payload so the
/// pipeline reducer can update each step's `transitions_to[]` without a
/// refetch. Sacrum sends the full edge on both `Created` and `Deleted`
/// (before-image tombstone), so these endpoints are always populated under
/// the v1 CDC contract.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct StepTransitionChangedEvent {
    pub transition_id: String,
    pub from_step_id: Option<String>,
    pub to_step_id: Option<String>,
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
///
/// `target_step_id` and `label` are hoisted from the Sacrum payload so the
/// pipeline reducer can construct a complete `PipelineWorkflowTransition`
/// on `Created` without a refetch.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct WorkflowTransitionChangedEvent {
    pub transition_id: String,
    pub from_workflow_id: Option<String>,
    pub to_workflow_id: Option<String>,
    pub target_step_id: Option<String>,
    pub label: Option<String>,
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

/// Event payload for session log updates.
/// Emitted when an existing ephemeral session log snapshot is replaced.
/// `session_log` carries the full deserialized entity when available.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SessionLogUpdatedEvent {
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

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct UserQuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct UserQuestion {
    pub question: String,
    pub header: String,
    pub options: Vec<UserQuestionOption>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PermissionRequestEvent {
    pub request_id: String,
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub is_root: bool,
    pub tool_name: String,
    pub tool_use_id: String,
    pub input: serde_json::Value,
    pub message: Option<String>,
    #[serde(default)]
    pub questions: Option<Vec<UserQuestion>>,
    #[serde(default)]
    pub input_error: Option<String>,
}
