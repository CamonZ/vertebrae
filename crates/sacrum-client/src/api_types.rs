//! API types for Sacrum responses
//!
//! Defines structures for deserializing Sacrum API responses.

use serde::{Deserialize, Serialize};

/// Task response from Sacrum API (matches TaskJSON.data/1)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResponse {
    pub id: String,
    #[serde(default)]
    pub short_id: Option<String>,
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
    pub needs_human_review: Option<bool>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub review_comment: Option<String>,
    #[serde(default)]
    pub rejection_reason: Option<String>,
    #[serde(default)]
    pub revision_feedback: Option<String>,
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

/// Section response from Sacrum API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionResponse {
    pub id: String,
    pub section_type: String,
    pub content: String,
    #[serde(default)]
    pub section_order: i32,
    #[serde(default)]
    pub done: Option<bool>,
    #[serde(default)]
    pub done_at: Option<String>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
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
}

/// Workflow response from Sacrum API (matches WorkflowJSON.data/1)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowResponse {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub auto_advance: Option<bool>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub display_order: Option<i32>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub initial_step_id: Option<String>,
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
    pub agents: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub agent_config: Option<serde_json::Value>,
    #[serde(default)]
    pub is_final: bool,
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
    pub workflow_id: String,
    pub step_name: String,
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
    pub cost: Option<f64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Session log response from Sacrum API (matches SessionLogJSON)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLogResponse {
    pub id: String,
    pub step_execution_id: String,
    pub content: String,
    #[serde(default)]
    pub inserted_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Blocker/dependent task summary from GraphQL nested fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockerTaskResponse {
    pub id: String,
    #[serde(default)]
    pub short_id: Option<String>,
    pub title: String,
}

/// Child task summary from GraphQL nested fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildTaskResponse {
    pub id: String,
    #[serde(default)]
    pub short_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
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
            "short_id": "task-123",
            "title": "Test Task",
            "description": "Test description",
            "priority": "high",
            "parent_id": null,
            "project_id": "proj-123"
        }"#;

        let task: TaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(task.id, "task-uuid-123");
        assert_eq!(task.short_id, Some("task-123".to_string()));
        assert_eq!(task.title, "Test Task");
    }

    #[test]
    fn test_task_response_with_all_fields() {
        let json = r#"{
            "id": "task-123",
            "short_id": "t-123",
            "title": "Full Task",
            "description": "Complete description",
            "level": "ticket",
            "priority": "low",
            "tags": ["rust", "cli"],
            "workflow_id": "wf-1",
            "current_step_id": "step-1",
            "needs_human_review": true,
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
        assert_eq!(task.short_id.as_deref(), Some("t-123"));
        assert_eq!(task.title, "Full Task");
        assert_eq!(task.description.as_deref(), Some("Complete description"));
        assert_eq!(task.level.as_deref(), Some("ticket"));
        assert_eq!(task.priority.as_deref(), Some("low"));
        assert_eq!(task.tags, vec!["rust", "cli"]);
        assert_eq!(task.workflow_id.as_deref(), Some("wf-1"));
        assert_eq!(task.current_step_id.as_deref(), Some("step-1"));
        assert_eq!(task.needs_human_review, Some(true));
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
        assert!(task.short_id.is_none());
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
            "auto_advance": true,
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
        assert_eq!(workflow.auto_advance, Some(true));
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
            "is_final": false,
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
        assert!(!step.is_final);
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
        assert_eq!(exec.status, "completed");
        assert_eq!(exec.input_tokens, Some(1000));
        assert_eq!(exec.output_tokens, Some(500));
        assert_eq!(exec.cost, Some(0.05));
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
        assert_eq!(section.section_order, 1);
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
    fn test_blocker_task_response_deserialization() {
        let json = r#"{
            "id": "blocker-1",
            "short_id": "b-1",
            "title": "Blocking Task"
        }"#;

        let blocker: BlockerTaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(blocker.id, "blocker-1");
        assert_eq!(blocker.short_id.as_deref(), Some("b-1"));
        assert_eq!(blocker.title, "Blocking Task");
    }

    #[test]
    fn test_blocker_task_response_minimal() {
        let json = r#"{
            "id": "blocker-2",
            "title": "Minimal Blocker"
        }"#;

        let blocker: BlockerTaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(blocker.id, "blocker-2");
        assert!(blocker.short_id.is_none());
        assert_eq!(blocker.title, "Minimal Blocker");
    }

    #[test]
    fn test_child_task_response_deserialization() {
        let json = r#"{
            "id": "child-1",
            "short_id": "c-1",
            "title": "Child Task",
            "level": "ticket",
            "priority": "high"
        }"#;

        let child: ChildTaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(child.id, "child-1");
        assert_eq!(child.short_id.as_deref(), Some("c-1"));
        assert_eq!(child.title, "Child Task");
        assert_eq!(child.level.as_deref(), Some("ticket"));
        assert_eq!(child.priority.as_deref(), Some("high"));
    }

    #[test]
    fn test_child_task_response_minimal() {
        let json = r#"{
            "id": "child-2",
            "title": "Minimal Child"
        }"#;

        let child: ChildTaskResponse = serde_json::from_str(json).unwrap();
        assert_eq!(child.id, "child-2");
        assert!(child.short_id.is_none());
        assert_eq!(child.title, "Minimal Child");
        assert!(child.level.is_none());
        assert!(child.priority.is_none());
    }

    #[test]
    fn test_task_response_with_nested_relations() {
        let json = r#"{
            "id": "task-rel",
            "title": "Task with relations",
            "project_id": "proj-1",
            "blockers": [
                {"id": "b-1", "short_id": "s-1", "title": "Blocker 1"}
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
}
