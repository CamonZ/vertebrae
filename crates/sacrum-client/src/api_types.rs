//! API types for Sacrum responses
//!
//! Defines structures for deserializing Sacrum API responses.

use serde::{Deserialize, Deserializer, Serialize};

/// Deserialize a value that may be either a number or a string representation of a number.
fn deserialize_optional_f64_from_string<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de;

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrNumber {
        Number(f64),
        String(String),
        Null,
    }

    match StringOrNumber::deserialize(deserializer)? {
        StringOrNumber::Number(n) => Ok(Some(n)),
        StringOrNumber::String(s) => s
            .parse::<f64>()
            .map(Some)
            .map_err(|_| de::Error::custom(format!("cannot parse '{s}' as f64"))),
        StringOrNumber::Null => Ok(None),
    }
}

/// Task response from Sacrum API (matches TaskJSON.data/1)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResponse {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub workflow_id: Option<String>,
    #[serde(default)]
    pub current_step_id: Option<String>,
    #[serde(default)]
    pub run_controls: Option<TaskRunControlsResponse>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub rejection_reason: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub dependency_ids: Vec<String>,
    #[serde(default)]
    pub sections: Vec<SectionResponse>,
    #[serde(default)]
    pub code_refs: Vec<CodeRefResponse>,
    #[serde(default)]
    pub blockers: Vec<TaskResponse>,
    #[serde(default)]
    pub dependents: Vec<TaskResponse>,
    #[serde(default)]
    pub children: Vec<TaskResponse>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Minimal response for resolveShortId — only the `id` is read by callers,
/// so we avoid pulling the full TaskFields payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortIdResponse {
    pub id: String,
}

/// Minimal task title response for display-only batch lookups.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskTitleResponse {
    pub id: String,
    pub title: String,
}

/// Section response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionResponse {
    pub id: String,
    pub section_type: String,
    pub content: String,
    #[serde(default)]
    pub section_order: Option<i32>,
    #[serde(default)]
    pub done: Option<bool>,
    #[serde(default)]
    pub done_at: Option<String>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub code_refs: Vec<SectionCodeRefResponse>,
}

/// A code reference nested inside a section response (no task_id — section-scoped)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionCodeRefResponse {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub line_start: Option<i32>,
    #[serde(default)]
    pub line_end: Option<i32>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// Code reference response from Sacrum API (matches CodeRefJSON)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRefResponse {
    pub id: String,
    pub task_id: String,
    #[serde(default)]
    pub section_id: Option<String>,
    pub path: String,
    #[serde(default)]
    pub line_start: Option<i32>,
    #[serde(default)]
    pub line_end: Option<i32>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Workflow step summary returned by the WORKFLOW_FIELDS fragment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStepSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub step_type: Option<String>,
    #[serde(default)]
    pub step_order: i32,
}

/// Workflow response from Sacrum API (matches WorkflowJSON.data/1)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowResponse {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub display_order: Option<i32>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub initial_step_id: Option<String>,
    #[serde(default)]
    pub kanban_column: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub workflow_steps: Vec<WorkflowStepSummary>,
    #[serde(default)]
    pub transitions: Option<Vec<WorkflowTransitionResponse>>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Workflow transition response (cross-workflow transitions)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTransitionResponse {
    pub id: String,
    pub to_workflow_id: String,
    #[serde(default)]
    pub target_step_id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// Workflow step response from Sacrum API (matches WorkflowStepJSON)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStepResponse {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub agent_config: Option<serde_json::Value>,
    #[serde(default)]
    pub step_type: Option<String>,
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
    #[serde(default)]
    pub step_order: i32,
    pub workflow_id: String,
    #[serde(default)]
    pub transitions: Option<Vec<StepTransitionResponse>>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Step transition response (within a workflow)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepTransitionResponse {
    pub id: String,
    pub to_step_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// Step execution response from Sacrum API (matches StepExecutionJSON)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepExecutionResponse {
    pub id: String,
    pub task_id: String,
    #[serde(default)]
    pub task_run_id: Option<String>,
    pub workflow_id: String,
    pub step_name: String,
    #[serde(default)]
    pub step_type: Option<String>,
    pub status: String,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub transition_result: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub model_provider: Option<String>,
    #[serde(default)]
    pub input_tokens: Option<i64>,
    #[serde(default)]
    pub output_tokens: Option<i64>,
    #[serde(default)]
    pub session_input_tokens: Option<i64>,
    #[serde(default)]
    pub session_cache_read_input_tokens: Option<i64>,
    #[serde(default)]
    pub session_output_tokens: Option<i64>,
    #[serde(default)]
    pub session_total_tokens: Option<i64>,
    #[serde(default)]
    pub context_window_input_tokens: Option<i64>,
    #[serde(default)]
    pub context_window_cache_read_input_tokens: Option<i64>,
    #[serde(default)]
    pub context_window_total_tokens: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_f64_from_string")]
    pub cost: Option<f64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub handoff: Option<serde_json::Value>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl StepExecutionResponse {
    pub fn effective_input_tokens(&self) -> Option<i64> {
        self.input_tokens
            .or(self.session_input_tokens)
            .or(self.context_window_input_tokens)
            .or_else(|| {
                match (
                    self.session_total_tokens,
                    self.session_output_tokens,
                    self.context_window_total_tokens,
                    self.context_window_cache_read_input_tokens,
                ) {
                    (Some(total), Some(output), _, _) => Some(total - output),
                    (None, None, Some(total), Some(cached)) => Some(total - cached),
                    (None, None, Some(total), None) => Some(total),
                    _ => None,
                }
            })
    }

    pub fn effective_output_tokens(&self) -> Option<i64> {
        self.output_tokens
            .or(self.session_output_tokens)
            .or_else(|| {
                match (
                    self.context_window_total_tokens,
                    self.context_window_input_tokens,
                    self.context_window_cache_read_input_tokens,
                ) {
                    (Some(total), Some(input), Some(cached)) => Some(total - input - cached),
                    (Some(total), Some(input), None) => Some(total - input),
                    _ => None,
                }
            })
    }

    /// Cache-read ("cache hit") input tokens for this execution.
    ///
    /// There is no per-step cache column, so we read the session-cumulative
    /// figure (preferred) and fall back to the context-window snapshot. Because
    /// the session figure is cumulative across the provider session, callers
    /// aggregating per TaskRun should take the run's *latest* execution value
    /// rather than summing across attempts.
    pub fn effective_cache_read_tokens(&self) -> Option<i64> {
        self.session_cache_read_input_tokens
            .or(self.context_window_cache_read_input_tokens)
    }
}

/// TaskRun response from Sacrum API (matches TaskRun GraphQL fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRunResponse {
    pub id: String,
    pub task_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    pub status: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub stop_requested_at: Option<String>,
    #[serde(default)]
    pub latest_step_execution_id: Option<String>,
    #[serde(default)]
    pub outcome_kind: Option<String>,
    #[serde(default)]
    pub outcome_context: Option<serde_json::Value>,
    #[serde(default)]
    pub parent_task_run_id: Option<String>,
    #[serde(default)]
    pub root_task_run_id: Option<String>,
    #[serde(default)]
    pub triggered_by_step_execution_id: Option<String>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Task run controls response from Sacrum API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRunControlsResponse {
    #[serde(default)]
    pub runnable: bool,
    #[serde(default)]
    pub stoppable: bool,
    #[serde(default)]
    pub disabled_reason_code: Option<String>,
    #[serde(default)]
    pub disabled_reason: Option<String>,
    #[serde(default)]
    pub active_run: Option<TaskRunResponse>,
}

/// TaskRun trace response from Sacrum API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRunTraceResponse {
    pub root_task_run_id: String,
    #[serde(default)]
    pub task_runs: Vec<TaskRunResponse>,
    #[serde(default)]
    pub step_executions: Vec<StepExecutionResponse>,
    #[serde(default)]
    pub session_logs: Vec<SessionLogResponse>,
}

/// Compound response for `vtb show` related roots.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShowTaskRelatedResponse {
    #[serde(default)]
    pub parent: Option<TaskResponse>,
    #[serde(default)]
    pub workflow: Option<WorkflowResponse>,
    #[serde(default)]
    pub task_runs: Vec<TaskRunResponse>,
    #[serde(default)]
    pub workflows: Vec<WorkflowResponse>,
}

/// Compound response for GUI workflow board loading.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTasksCompoundResponse {
    pub workflow: WorkflowResponse,
    #[serde(default)]
    pub tasks: Vec<TaskResponse>,
    #[serde(default)]
    pub workflows: Vec<WorkflowResponse>,
}

/// Session log response from Sacrum API (matches SessionLogJSON)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLogResponse {
    pub id: String,
    pub step_execution_id: String,
    pub content: String,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub logical_key: Option<String>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Error response from Sacrum API
///
/// The API returns errors in two shapes:
/// - `{"errors": {"detail": "message"}}` — from FallbackController
/// - `{"errors": {"field": ["error msg"]}}` — from ChangesetJSON
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub errors: serde_json::Value,
}

/// Per-step task counts grouped by hierarchy level.
///
/// Returned by `pipelineSummary.workflow_steps[].task_counts`. Counts only
/// include non-archived tasks whose `current_step_id` matches the step.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PipelineTaskCountsResponse {
    #[serde(default)]
    pub epic: i32,
    #[serde(default)]
    pub ticket: i32,
    #[serde(default)]
    pub task: i32,
}

/// Canonical per-step pipeline counts grouped by hierarchy level plus active
/// TaskRun-backed work.
///
/// Returned by `pipelineSummary.workflow_steps[].pipeline_counts`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PipelineStepCountsResponse {
    #[serde(default)]
    pub epic: i32,
    #[serde(default)]
    pub ticket: i32,
    #[serde(default)]
    pub task: i32,
    #[serde(default)]
    pub active: i32,
}

/// Inter-workflow transition as returned by `pipelineSummary` (preloaded).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineWorkflowTransitionResponse {
    pub id: String,
    pub from_workflow_id: String,
    pub to_workflow_id: String,
    #[serde(default)]
    pub target_step_id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// Intra-workflow step transition as returned nested under each workflow step
/// in `pipelineSummary`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineStepTransitionResponse {
    pub id: String,
    pub from_step_id: String,
    pub to_step_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// Workflow step entry in the `pipelineSummary` payload — includes the
/// aggregates computed by the resolver and the preloaded list of intra-workflow
/// transitions out of this step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineStepResponse {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub step_order: i32,
    #[serde(default)]
    pub step_type: Option<String>,
    pub workflow_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub task_counts: PipelineTaskCountsResponse,
    #[serde(default)]
    pub pipeline_counts: Option<PipelineStepCountsResponse>,
    #[serde(default)]
    pub active_count: Option<i32>,
    #[serde(default)]
    pub running_count: Option<i32>,
    #[serde(default)]
    pub transitions: Vec<PipelineStepTransitionResponse>,
}

impl PipelineStepResponse {
    /// Canonical active count for the pipeline view.
    ///
    /// Prefer the new `pipeline_counts.active` contract, then the convenience
    /// `active_count` alias. `running_count` is a deprecated compatibility
    /// field whose backend semantics now match active TaskRun count.
    pub fn effective_active_count(&self) -> i32 {
        self.pipeline_counts
            .as_ref()
            .map(|counts| counts.active)
            .or(self.active_count)
            .or(self.running_count)
            .unwrap_or_default()
    }

    /// Canonical per-level task counts for the pipeline view.
    ///
    /// New Sacrum payloads include these under `pipeline_counts`; older
    /// compatibility payloads only include `task_counts`.
    pub fn effective_task_counts(&self) -> PipelineTaskCountsResponse {
        self.pipeline_counts
            .as_ref()
            .map(|counts| PipelineTaskCountsResponse {
                epic: counts.epic,
                ticket: counts.ticket,
                task: counts.task,
            })
            .unwrap_or_else(|| self.task_counts.clone())
    }
}

/// Workflow entry in the `pipelineSummary` payload. Carries preloaded
/// `workflow_steps` (with aggregates) and inter-workflow `transitions`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineWorkflowResponse {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub display_order: Option<i32>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub initial_step_id: Option<String>,
    #[serde(default)]
    pub kanban_column: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub workflow_steps: Vec<PipelineStepResponse>,
    #[serde(default)]
    pub transitions: Vec<PipelineWorkflowTransitionResponse>,
}

/// Project response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectResponse {
    pub id: String,
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// Request to create a new project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub slug: String,
}

/// Project list response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectListResponse {
    pub projects: Vec<ProjectResponse>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_response_deserialization() {
        let json = r#"{
            "id": "task-uuid-123",
            "title": "Test Task",
            "description": "Test description",
            "priority": "high",
            "parent_id": null,
            "project_id": "proj-123"
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(task.id, "task-uuid-123");
        assert_eq!(task.title, "Test Task");
    }

    #[test]
    fn test_task_response_with_all_fields() {
        let json = r#"{
            "id": "task-123",
            "title": "Full Task",
            "description": "Complete description",
            "level": "ticket",
            "priority": "low",
            "tags": ["rust", "cli"],
            "workflow_id": "wf-1",
            "current_step_id": "step-1",
            "parent_id": "epic-456",
            "project_id": "proj-789",
            "dependency_ids": ["dep-1", "dep-2"],
            "sections": [],
            "code_refs": [],
            "started_at": "2024-01-01T00:00:00Z",
            "completed_at": null,
            "inserted_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z"
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(task.id, "task-123");
        assert_eq!(task.title, "Full Task");
        assert_eq!(task.description.as_deref(), Some("Complete description"));
        assert_eq!(task.level.as_deref(), Some("ticket"));
        assert_eq!(task.priority.as_deref(), Some("low"));
        assert_eq!(task.tags, vec!["rust", "cli"]);
        assert_eq!(task.workflow_id.as_deref(), Some("wf-1"));
        assert_eq!(task.current_step_id.as_deref(), Some("step-1"));
        assert_eq!(task.parent_id.as_deref(), Some("epic-456"));
        assert_eq!(task.project_id, "proj-789");
        assert_eq!(task.dependency_ids, vec!["dep-1", "dep-2"]);
    }

    #[test]
    fn test_task_response_minimal() {
        let json = r#"{
            "id": "task-min",
            "title": "Minimal",
            "project_id": "proj-1"
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(task.id, "task-min");
        assert_eq!(task.title, "Minimal");
        assert!(task.description.is_none());
        assert!(task.level.is_none());
        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.dependency_ids.is_empty());
        assert!(task.worktree.is_none());
    }

    #[test]
    fn test_task_response_with_worktree() {
        let json = r#"{
            "id": "task-wt",
            "title": "Worktree Task",
            "project_id": "proj-1",
            "worktree": "/path/to/worktree"
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(task.id, "task-wt");
        assert_eq!(task.worktree.as_deref(), Some("/path/to/worktree"));
    }

    #[test]
    fn test_task_response_with_null_worktree() {
        let json = r#"{
            "id": "task-wt-null",
            "title": "No Worktree",
            "project_id": "proj-1",
            "worktree": null
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert!(task.worktree.is_none());
    }

    #[test]
    fn test_workflow_response_deserialization() {
        let json = r#"{
            "id": "wf-123",
            "name": "Review Workflow",
            "description": "Multi-step review process",
            "is_default": false,
            "display_order": 1,
            "initial_step_id": "step-1",
            "project_id": "proj-1",
            "transitions": [
                {"id": "t-1", "to_workflow_id": "wf-2", "target_step_id": "s-1", "label": "on_done"}
            ]
        }"#;

        let workflow: WorkflowResponse = serde_json::from_str(json).unwrap();
        assert_eq!(workflow.id, "wf-123");
        assert_eq!(workflow.name, "Review Workflow");
        assert_eq!(workflow.initial_step_id.as_deref(), Some("step-1"));
        assert_eq!(workflow.transitions.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_workflow_step_response_deserialization() {
        let json = r#"{
            "id": "step-1",
            "name": "Review",
            "goal": "Review the code",
            "agents": ["claude"],
            "skills": ["code-review"],
            "agent_config": {"model": "opus"},
            "step_type": "finish",
            "step_order": 0,
            "workflow_id": "wf-1",
            "transitions": [
                {"id": "t-1", "to_step_id": "step-2", "label": "next"}
            ]
        }"#;

        let step: WorkflowStepResponse = serde_json::from_str(json).unwrap();
        assert_eq!(step.id, "step-1");
        assert_eq!(step.name, "Review");
        assert_eq!(step.goal.as_deref(), Some("Review the code"));
        assert_eq!(step.agents, vec!["claude"]);
        assert_eq!(step.skills, vec!["code-review"]);
        assert_eq!(step.step_type.as_deref(), Some("finish"));
        assert_eq!(step.step_order, 0);
        assert_eq!(step.workflow_id, "wf-1");
        assert_eq!(step.transitions.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_step_execution_response_deserialization() {
        let json = r#"{
            "id": "exec-1",
            "task_id": "task-1",
            "workflow_id": "wf-1",
            "step_name": "review",
            "status": "completed",
            "context": "some context",
            "output": "result",
            "model": "claude-opus",
            "input_tokens": 1000,
            "output_tokens": 500,
            "cost": 0.05,
            "duration_ms": 1500
        }"#;

        let exec: StepExecutionResponse = serde_json::from_str(json).unwrap();
        assert_eq!(exec.id, "exec-1");
        assert_eq!(exec.task_id, "task-1");
        assert_eq!(exec.task_run_id, None);
        assert_eq!(exec.status, "completed");
        assert_eq!(exec.input_tokens, Some(1000));
        assert_eq!(exec.output_tokens, Some(500));
        assert_eq!(exec.cost, Some(0.05));
    }

    #[test]
    fn test_step_execution_response_deserializes_task_run_id() {
        let json = r#"{
            "id": "exec-1",
            "task_id": "task-1",
            "task_run_id": "run-1",
            "workflow_id": "wf-1",
            "step_name": "review",
            "status": "completed"
        }"#;

        let exec: StepExecutionResponse = serde_json::from_str(json).unwrap();
        assert_eq!(exec.id, "exec-1");
        assert_eq!(exec.task_run_id.as_deref(), Some("run-1"));
    }

    #[test]
    fn test_task_run_response_deserialization() {
        let json = r#"{
            "id": "run-1",
            "task_id": "task-1",
            "project_id": "project-1",
            "status": "waiting",
            "started_at": "2026-05-07T12:00:00Z",
            "latest_step_execution_id": "exec-1",
            "outcome_context": {"retry_count": 2},
            "parent_task_run_id": "run-parent",
            "root_task_run_id": "run-root",
            "triggered_by_step_execution_id": "exec-parent",
            "inserted_at": "2026-05-07T12:00:00Z",
            "updated_at": "2026-05-07T12:01:00Z"
        }"#;

        let run: TaskRunResponse = serde_json::from_str(json).unwrap();
        assert_eq!(run.id, "run-1");
        assert_eq!(run.task_id, "task-1");
        assert_eq!(run.project_id.as_deref(), Some("project-1"));
        assert_eq!(run.status, "waiting");
        assert_eq!(run.latest_step_execution_id.as_deref(), Some("exec-1"));
        assert_eq!(
            run.outcome_context
                .as_ref()
                .and_then(|context| context.get("retry_count"))
                .and_then(serde_json::Value::as_i64),
            Some(2)
        );
        assert_eq!(run.parent_task_run_id.as_deref(), Some("run-parent"));
        assert_eq!(run.root_task_run_id.as_deref(), Some("run-root"));
        assert_eq!(
            run.triggered_by_step_execution_id.as_deref(),
            Some("exec-parent")
        );
    }

    #[test]
    fn test_task_run_trace_response_deserialization() {
        let json = r#"{
            "root_task_run_id": "run-root",
            "task_runs": [
                {
                    "id": "run-root",
                    "task_id": "task-root",
                    "project_id": "project-1",
                    "status": "executing",
                    "parent_task_run_id": null,
                    "root_task_run_id": null,
                    "triggered_by_step_execution_id": null
                },
                {
                    "id": "run-child",
                    "task_id": "task-child",
                    "project_id": "project-1",
                    "status": "queued",
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
                    "status": "completed"
                }
            ],
            "session_logs": [
                {
                    "id": "log-1",
                    "step_execution_id": "exec-root",
                    "content": "child scheduled"
                }
            ]
        }"#;

        let trace: TaskRunTraceResponse = serde_json::from_str(json).unwrap();
        assert_eq!(trace.root_task_run_id, "run-root");
        assert_eq!(trace.task_runs.len(), 2);
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
        assert_eq!(trace.session_logs[0].content, "child scheduled");
    }

    #[test]
    fn test_session_log_response_deserialization() {
        let json = r#"{
            "id": "log-1",
            "step_execution_id": "exec-1",
            "content": "Log entry content",
            "inserted_at": "2024-01-01T00:00:00Z"
        }"#;

        let log: SessionLogResponse = serde_json::from_str(json).unwrap();
        assert_eq!(log.id, "log-1");
        assert_eq!(log.step_execution_id, "exec-1");
        assert_eq!(log.content, "Log entry content");
    }

    #[test]
    fn test_section_response_deserialization() {
        let json = r#"{
            "id": "sec-1",
            "section_type": "checklist_item",
            "content": "Do this first",
            "section_order": 1,
            "done": true,
            "done_at": "2024-01-01T00:00:00Z"
        }"#;

        let section: SectionResponse = serde_json::from_str(json).unwrap();
        assert_eq!(section.id, "sec-1");
        assert_eq!(section.section_type, "checklist_item");
        assert_eq!(section.content, "Do this first");
        assert_eq!(section.section_order, Some(1));
        assert_eq!(section.done, Some(true));
    }

    #[test]
    fn test_code_ref_response_deserialization() {
        let json = r#"{
            "id": "ref-1",
            "task_id": "task-1",
            "section_id": null,
            "path": "src/main.rs",
            "line_start": 42,
            "line_end": 50,
            "name": "main_fn",
            "description": "Entry point"
        }"#;

        let code_ref: CodeRefResponse = serde_json::from_str(json).unwrap();
        assert_eq!(code_ref.id, "ref-1");
        assert_eq!(code_ref.path, "src/main.rs");
        assert_eq!(code_ref.line_start, Some(42));
        assert_eq!(code_ref.line_end, Some(50));
        assert_eq!(code_ref.name.as_deref(), Some("main_fn"));
    }

    #[test]
    fn test_error_response_detail_format() {
        let json = r#"{"errors": {"detail": "Not Found"}}"#;
        let error: ErrorResponse = serde_json::from_str(json).unwrap();
        assert_eq!(error.errors["detail"], "Not Found");
    }

    #[test]
    fn test_error_response_changeset_format() {
        let json = r#"{"errors": {"title": ["can't be blank"], "project_id": ["is required"]}}"#;
        let error: ErrorResponse = serde_json::from_str(json).unwrap();
        assert!(error.errors["title"].is_array());
        assert!(error.errors["project_id"].is_array());
    }

    #[test]
    fn test_project_response_complete() {
        let json = r#"{
            "id": "proj-123",
            "name": "My Project",
            "slug": "my-project",
            "description": "A test project"
        }"#;

        let project: ProjectResponse = serde_json::from_str(json).unwrap();
        assert_eq!(project.id, "proj-123");
        assert_eq!(project.name, "My Project");
        assert_eq!(project.slug, "my-project");
        assert_eq!(project.description.as_deref(), Some("A test project"));
    }

    #[test]
    fn test_create_project_request() {
        let request = CreateProjectRequest {
            name: "New Project".to_string(),
            slug: "new-project".to_string(),
        };

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("New Project"));
        assert!(json.contains("new-project"));
    }

    #[test]
    fn test_task_response_with_nested_relations() {
        let json = r#"{
            "id": "task-rel",
            "title": "Task with relations",
            "project_id": "proj-1",
            "blockers": [
                {"id": "b-1", "title": "Blocker 1"}
            ],
            "dependents": [
                {"id": "d-1", "title": "Dependent 1"}
            ],
            "children": [
                {"id": "c-1", "title": "Child 1", "level": "task", "priority": "medium"}
            ]
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(task.blockers.len(), 1);
        assert_eq!(task.blockers[0].id, "b-1");
        assert_eq!(task.blockers[0].title, "Blocker 1");
        assert_eq!(task.dependents.len(), 1);
        assert_eq!(task.dependents[0].id, "d-1");
        assert_eq!(task.children.len(), 1);
        assert_eq!(task.children[0].id, "c-1");
        assert_eq!(task.children[0].level.as_deref(), Some("task"));
    }

    #[test]
    fn test_workflow_response_with_kanban_column() {
        let json = r#"{
            "id": "wf-kanban",
            "name": "Kanban Workflow",
            "kanban_column": "In Progress"
        }"#;

        let workflow: WorkflowResponse = serde_json::from_str(json).unwrap();
        assert_eq!(workflow.kanban_column.as_deref(), Some("In Progress"));
    }

    #[test]
    fn test_workflow_response_without_kanban_column() {
        let json = r#"{
            "id": "wf-nokanban",
            "name": "No Kanban Workflow"
        }"#;

        let workflow: WorkflowResponse = serde_json::from_str(json).unwrap();
        assert!(workflow.kanban_column.is_none());
    }

    #[test]
    fn test_workflow_response_with_is_default_true() {
        let json = r#"{
            "id": "wf-default",
            "name": "Default Workflow",
            "is_default": true
        }"#;

        let workflow: WorkflowResponse = serde_json::from_str(json).unwrap();
        assert_eq!(workflow.is_default, Some(true));
    }

    #[test]
    fn test_workflow_response_with_is_default_false() {
        let json = r#"{
            "id": "wf-nondefault",
            "name": "Non-Default Workflow",
            "is_default": false
        }"#;

        let workflow: WorkflowResponse = serde_json::from_str(json).unwrap();
        assert_eq!(workflow.is_default, Some(false));
    }

    #[test]
    fn test_pipeline_summary_response_deserialization() {
        let json = r#"[
            {
                "id": "wf-1",
                "name": "Backlog",
                "description": null,
                "is_default": true,
                "display_order": 0,
                "metadata": null,
                "initial_step_id": "step-1",
                "kanban_column": null,
                "project_id": "proj-1",
                "inserted_at": "2026-04-25T00:00:00Z",
                "updated_at": "2026-04-25T00:00:00Z",
                "workflow_steps": [
                    {
                        "id": "step-1",
                        "name": "todo",
                        "goal": null,
                        "step_order": 0,
                        "step_type": "execute",
                        "workflow_id": "wf-1",
                        "project_id": "proj-1",
                        "inserted_at": null,
                        "updated_at": null,
                        "task_counts": { "epic": 1, "ticket": 4, "task": 9 },
                        "pipeline_counts": { "epic": 2, "ticket": 5, "task": 10, "active": 3 },
                        "active_count": 3,
                        "running_count": 3,
                        "transitions": [
                            { "id": "t-1", "from_step_id": "step-1", "to_step_id": "step-2", "label": "next" }
                        ]
                    }
                ],
                "transitions": [
                    {
                        "id": "wt-1",
                        "from_workflow_id": "wf-1",
                        "to_workflow_id": "wf-2",
                        "target_step_id": "step-x",
                        "label": "promote"
                    }
                ]
            }
        ]"#;

        let workflows: Vec<PipelineWorkflowResponse> = serde_json::from_str(json).unwrap();
        assert_eq!(workflows.len(), 1);
        let wf = &workflows[0];
        assert_eq!(wf.id, "wf-1");
        assert_eq!(wf.name, "Backlog");
        assert_eq!(wf.is_default, Some(true));
        assert_eq!(wf.workflow_steps.len(), 1);

        let step = &wf.workflow_steps[0];
        assert_eq!(step.id, "step-1");
        assert_eq!(step.name, "todo");
        assert_eq!(step.workflow_id, "wf-1");
        assert_eq!(step.task_counts.epic, 1);
        assert_eq!(step.task_counts.ticket, 4);
        assert_eq!(step.task_counts.task, 9);
        assert_eq!(step.pipeline_counts.as_ref().unwrap().epic, 2);
        assert_eq!(step.pipeline_counts.as_ref().unwrap().ticket, 5);
        assert_eq!(step.pipeline_counts.as_ref().unwrap().task, 10);
        assert_eq!(step.pipeline_counts.as_ref().unwrap().active, 3);
        assert_eq!(step.active_count, Some(3));
        assert_eq!(step.running_count, Some(3));
        assert_eq!(step.effective_task_counts().epic, 2);
        assert_eq!(step.effective_task_counts().ticket, 5);
        assert_eq!(step.effective_task_counts().task, 10);
        assert_eq!(step.effective_active_count(), 3);
        assert_eq!(step.transitions.len(), 1);
        assert_eq!(step.transitions[0].from_step_id, "step-1");
        assert_eq!(step.transitions[0].to_step_id, "step-2");
        assert_eq!(step.transitions[0].label.as_deref(), Some("next"));

        assert_eq!(wf.transitions.len(), 1);
        assert_eq!(wf.transitions[0].from_workflow_id, "wf-1");
        assert_eq!(wf.transitions[0].to_workflow_id, "wf-2");
        assert_eq!(wf.transitions[0].target_step_id.as_deref(), Some("step-x"));
        assert_eq!(wf.transitions[0].label.as_deref(), Some("promote"));
    }

    #[test]
    fn test_pipeline_summary_step_with_zero_aggregates() {
        let json = r#"{
            "id": "step-empty",
            "name": "review",
            "step_order": 1,
            "workflow_id": "wf-1"
        }"#;

        let step: PipelineStepResponse = serde_json::from_str(json).unwrap();
        assert_eq!(step.id, "step-empty");
        assert_eq!(step.task_counts, PipelineTaskCountsResponse::default());
        assert_eq!(
            step.effective_task_counts(),
            PipelineTaskCountsResponse::default()
        );
        assert_eq!(step.task_counts.epic, 0);
        assert_eq!(step.active_count, None);
        assert_eq!(step.running_count, None);
        assert_eq!(step.effective_active_count(), 0);
        assert!(step.transitions.is_empty());
    }

    #[test]
    fn test_pipeline_summary_compat_running_count_deserialization() {
        let json = r#"{
            "id": "step-compat",
            "name": "running alias",
            "step_order": 1,
            "workflow_id": "wf-1",
            "task_counts": { "epic": 0, "ticket": 2, "task": 0 },
            "running_count": 7
        }"#;

        let step: PipelineStepResponse = serde_json::from_str(json).unwrap();
        assert_eq!(
            step.effective_task_counts(),
            PipelineTaskCountsResponse {
                epic: 0,
                ticket: 2,
                task: 0,
            }
        );
        assert_eq!(step.effective_active_count(), 7);
    }

    #[test]
    fn test_workflow_response_without_is_default() {
        let json = r#"{
            "id": "wf-noisdefault",
            "name": "No IsDefault Workflow"
        }"#;

        let workflow: WorkflowResponse = serde_json::from_str(json).unwrap();
        assert!(workflow.is_default.is_none());
    }
}
