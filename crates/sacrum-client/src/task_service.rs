//! TaskService implementation for Sacrum HTTP API
//!
//! Implements the TaskService trait by making HTTP calls to the Sacrum REST API.
//! Uses flat /api/... routes with project_id as a query parameter.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::json;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::Task;
use vertebrae_core::models::{
    BlockerNode, CodeRef, Level, Priority, Section, SectionType, TaskFilter,
};
use vertebrae_core::service::{
    CreateTaskOptions, TaskService, TaskTreeNode, TransitionResult, TreeFilterOptions,
    UpdateTaskOptions,
};

use crate::api_types::{CodeRefResponse, SectionResponse, TaskResponse};
use crate::client::SacrumClient;

/// Query param helper for project_id
#[derive(Serialize)]
struct ProjectQuery<'a> {
    project_id: &'a str,
}

/// TaskService implementation for Sacrum HTTP client
pub struct SacrumTaskService {
    client: SacrumClient,
}

impl SacrumTaskService {
    /// Create a new SacrumTaskService
    pub fn new(client: SacrumClient) -> Self {
        Self { client }
    }

    /// Convert Sacrum TaskResponse to vertebrae_core Task model
    fn response_to_task(&self, response: &TaskResponse) -> Task {
        let level = response
            .level
            .as_deref()
            .and_then(parse_level)
            .unwrap_or(Level::Task);

        let priority = response.priority.as_deref().and_then(parse_priority);

        let sections = response
            .sections
            .iter()
            .map(section_response_to_section)
            .collect();

        let code_refs = response
            .code_refs
            .iter()
            .map(code_ref_response_to_code_ref)
            .collect();

        let created_at = response
            .inserted_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));

        let updated_at = response
            .updated_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));

        let started_at = response
            .started_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));

        let completed_at = response
            .completed_at
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));

        Task {
            id: response.id.clone(),
            title: response.title.clone(),
            description: response.description.clone(),
            level,
            status: "backlog".to_string(),
            priority,
            tags: response.tags.clone(),
            workflow_id: response.workflow_id.clone(),
            current_step_id: response.current_step_id.clone(),
            workflow_name: None,
            step_name: None,
            needs_human_review: response.needs_human_review,
            review_comment: response.review_comment.clone(),
            revision_feedback: response.revision_feedback.clone(),
            rejection_reason: response.rejection_reason.clone(),
            parent_id: response.parent_id.clone(),
            dependency_ids: response.dependency_ids.clone(),
            sections,
            code_refs,
            created_at,
            updated_at,
            started_at,
            completed_at,
        }
    }
}

fn parse_level(s: &str) -> Option<Level> {
    match s {
        "epic" => Some(Level::Epic),
        "ticket" => Some(Level::Ticket),
        "task" => Some(Level::Task),
        _ => None,
    }
}

fn parse_priority(s: &str) -> Option<Priority> {
    match s {
        "low" => Some(Priority::Low),
        "medium" => Some(Priority::Medium),
        "high" => Some(Priority::High),
        "critical" => Some(Priority::Critical),
        _ => None,
    }
}

fn section_response_to_section(r: &SectionResponse) -> Section {
    let section_type = match r.section_type.as_str() {
        "goal" => SectionType::Goal,
        "context" => SectionType::Context,
        "current_behavior" => SectionType::CurrentBehavior,
        "desired_behavior" => SectionType::DesiredBehavior,
        "step" => SectionType::Step,
        "testing_criterion" => SectionType::TestingCriterion,
        "anti_pattern" => SectionType::AntiPattern,
        "failure_test" => SectionType::FailureTest,
        "constraint" => SectionType::Constraint,
        _ => SectionType::Step, // fallback
    };

    let done_at = r
        .done_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    Section {
        section_type,
        content: r.content.clone(),
        order: Some(r.section_order as u32),
        done: r.done,
        done_at,
        refs: Vec::new(),
    }
}

fn code_ref_response_to_code_ref(r: &CodeRefResponse) -> CodeRef {
    CodeRef {
        path: r.path.clone(),
        line_start: r.line_start.map(|v| v as u32),
        line_end: r.line_end.map(|v| v as u32),
        name: r.name.clone(),
        description: r.description.clone(),
    }
}

#[async_trait]
impl TaskService for SacrumTaskService {
    async fn create_task(&self, options: CreateTaskOptions) -> ServiceResult<String> {
        if options.title.trim().is_empty() {
            return Err(ServiceError::validation_failed("Title cannot be empty"));
        }

        let request = json!({
            "title": options.title,
            "description": options.description,
            "level": format!("{:?}", options.level),
            "priority": options.priority,
            "tags": options.tags,
            "parent_id": options.parent_id,
            "project_id": self.client.project_id(),
        });

        let response: TaskResponse = self.client.post("/api/tasks", &request).await?;

        Ok(response.id.clone())
    }

    async fn get_task(&self, id: &str) -> ServiceResult<Task> {
        let path = format!("/api/tasks/{}", id);
        let response: TaskResponse = self.client.get(&path, &()).await?;
        Ok(self.response_to_task(&response))
    }

    async fn get_derived_status(&self, _task: &Task) -> ServiceResult<String> {
        Ok("backlog".to_string())
    }

    async fn update_task(&self, id: &str, options: UpdateTaskOptions) -> ServiceResult<()> {
        let mut update_json = json!({});

        if let Some(title) = &options.title {
            update_json["title"] = json!(title);
        }

        if let Some(desc_opt) = &options.description {
            update_json["description"] = json!(desc_opt);
        }

        let path = format!("/api/tasks/{}", id);
        let _response: TaskResponse = self.client.put(&path, &update_json).await?;

        Ok(())
    }

    async fn set_current_step(&self, _task_id: &str, _step_id: &str) -> ServiceResult<()> {
        unimplemented!("Current step setting not yet implemented for Sacrum HTTP client")
    }

    async fn delete_task(&self, id: &str, _cascade: bool) -> ServiceResult<()> {
        let path = format!("/api/tasks/{}", id);
        self.client.delete(&path).await?;
        Ok(())
    }

    async fn task_exists(&self, id: &str) -> ServiceResult<bool> {
        match self.get_task(id).await {
            Ok(_) => Ok(true),
            Err(ServiceError::TaskNotFound { task_id: _ }) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn list_tasks(&self, _filter: &TaskFilter) -> ServiceResult<Vec<Task>> {
        let query = ProjectQuery {
            project_id: self.client.project_id(),
        };
        let tasks: Vec<TaskResponse> = self.client.get("/api/tasks", &query).await?;

        Ok(tasks.iter().map(|t| self.response_to_task(t)).collect())
    }

    async fn list_ready(&self, _status: &str) -> ServiceResult<Vec<Task>> {
        let query = ProjectQuery {
            project_id: self.client.project_id(),
        };
        let tasks: Vec<TaskResponse> = self.client.get("/api/tasks/ready", &query).await?;

        Ok(tasks.iter().map(|t| self.response_to_task(t)).collect())
    }

    async fn get_task_tree(&self, options: &TreeFilterOptions) -> ServiceResult<Vec<TaskTreeNode>> {
        let path = match &options.filter.children_of {
            Some(root_id) => format!("/api/tasks/{}/tree", root_id),
            None => "/api/tasks/tree".to_string(),
        };
        let query = ProjectQuery {
            project_id: self.client.project_id(),
        };
        Ok(self.client.get(&path, &query).await?)
    }

    async fn transition_to(&self, _id: &str, _target: &str) -> ServiceResult<TransitionResult> {
        unimplemented!("Task status transition not yet implemented for Sacrum HTTP client")
    }

    async fn set_parent(&self, _child_id: &str, _parent_id: &str) -> ServiceResult<()> {
        unimplemented!("Parent assignment not yet implemented for Sacrum HTTP client")
    }

    async fn remove_parent(&self, _child_id: &str) -> ServiceResult<()> {
        unimplemented!("Parent removal not yet implemented for Sacrum HTTP client")
    }

    async fn add_dependency(&self, _task_id: &str, _depends_on_id: &str) -> ServiceResult<()> {
        unimplemented!("Dependency creation not yet implemented for Sacrum HTTP client")
    }

    async fn remove_dependency(&self, _task_id: &str, _depends_on_id: &str) -> ServiceResult<()> {
        unimplemented!("Dependency removal not yet implemented for Sacrum HTTP client")
    }

    async fn get_blockers(&self, id: &str) -> ServiceResult<Vec<BlockerNode>> {
        let path = format!("/api/tasks/{}/blockers", id);
        Ok(self.client.get(&path, &()).await?)
    }

    async fn get_incomplete_blockers_with_details(&self, _id: &str) -> ServiceResult<Vec<Task>> {
        unimplemented!("Incomplete blocker retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn find_path(&self, from_id: &str, to_id: &str) -> ServiceResult<Option<Vec<String>>> {
        #[derive(Serialize)]
        struct PathQuery<'a> {
            to: &'a str,
        }
        let path = format!("/api/tasks/{}/path", from_id);
        let query = PathQuery { to: to_id };
        Ok(self.client.get(&path, &query).await?)
    }

    async fn get_parent(&self, _task_id: &str) -> ServiceResult<Option<String>> {
        unimplemented!("Parent retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn get_children(&self, _task_id: &str) -> ServiceResult<Vec<String>> {
        unimplemented!("Children retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn get_dependencies(&self, _task_id: &str) -> ServiceResult<Vec<String>> {
        unimplemented!("Dependencies retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn get_dependents(&self, _task_id: &str) -> ServiceResult<Vec<String>> {
        unimplemented!("Dependents retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn add_section(&self, _id: &str, _section: Section) -> ServiceResult<()> {
        unimplemented!("Section addition not yet implemented for Sacrum HTTP client")
    }

    async fn remove_sections(
        &self,
        _id: &str,
        _section_type: SectionType,
        _indices: Option<Vec<usize>>,
    ) -> ServiceResult<()> {
        unimplemented!("Section removal not yet implemented for Sacrum HTTP client")
    }

    async fn edit_section_by_ordinal(
        &self,
        _id: &str,
        _section_type: SectionType,
        _ordinal: u32,
        _new_content: &str,
    ) -> ServiceResult<()> {
        unimplemented!("Section editing not yet implemented for Sacrum HTTP client")
    }

    async fn remove_section_by_ordinal(
        &self,
        _id: &str,
        _section_type: SectionType,
        _ordinal: u32,
    ) -> ServiceResult<()> {
        unimplemented!("Section removal not yet implemented for Sacrum HTTP client")
    }

    async fn mark_step_done(&self, _id: &str, _step_index: usize) -> ServiceResult<()> {
        unimplemented!("Mark step done not yet implemented for Sacrum HTTP client")
    }

    async fn toggle_step_done(&self, _id: &str, _ordinal: u32) -> ServiceResult<()> {
        unimplemented!("Toggle step done not yet implemented for Sacrum HTTP client")
    }

    async fn add_code_ref(&self, id: &str, code_ref: CodeRef) -> ServiceResult<()> {
        let path = format!("/api/tasks/{}/refs", id);
        let request = json!({
            "path": code_ref.path,
            "line_start": code_ref.line_start,
            "line_end": code_ref.line_end,
            "name": code_ref.name,
            "description": code_ref.description,
        });
        let _response: serde_json::Value = self.client.post(&path, &request).await?;
        Ok(())
    }

    async fn remove_code_refs(&self, id: &str, indices: Option<Vec<usize>>) -> ServiceResult<()> {
        if let Some(indices) = indices {
            // Get current refs to find the ref IDs at the given indices
            let task_path = format!("/api/tasks/{}", id);
            let response: TaskResponse = self.client.get(&task_path, &()).await?;
            for idx in indices {
                if let Some(ref_response) = response.code_refs.get(idx) {
                    let path = format!("/api/tasks/{}/refs/{}", id, ref_response.id);
                    self.client.delete(&path).await?;
                }
            }
        }
        Ok(())
    }

    async fn append_ref(&self, id: &str, code_ref: &CodeRef) -> ServiceResult<()> {
        self.add_code_ref(id, code_ref.clone()).await
    }

    async fn append_section_ref(
        &self,
        _id: &str,
        _section_index: usize,
        _code_ref: &CodeRef,
    ) -> ServiceResult<()> {
        unimplemented!("Section code reference append not yet implemented for Sacrum HTTP client")
    }

    async fn assign_workflow(&self, _task_id: &str, _workflow_id: &str) -> ServiceResult<()> {
        unimplemented!("Workflow assignment not yet implemented for Sacrum HTTP client")
    }

    async fn unassign_workflow(&self, _task_id: &str) -> ServiceResult<()> {
        unimplemented!("Workflow unassignment not yet implemented for Sacrum HTTP client")
    }

    async fn export_all_tasks(&self) -> ServiceResult<Vec<(String, Task)>> {
        unimplemented!("Task export not yet implemented for Sacrum HTTP client")
    }

    async fn export_child_of_relations(&self) -> ServiceResult<Vec<(String, String)>> {
        unimplemented!("Child relation export not yet implemented for Sacrum HTTP client")
    }

    async fn export_depends_on_relations(&self) -> ServiceResult<Vec<(String, String)>> {
        unimplemented!("Dependency relation export not yet implemented for Sacrum HTTP client")
    }

    async fn create_task_raw(&self, _id: &str, task: &Task) -> ServiceResult<String> {
        let request = json!({
            "title": task.title,
            "description": task.description,
            "level": format!("{:?}", task.level),
            "project_id": self.client.project_id(),
        });

        let response: TaskResponse = self.client.post("/api/tasks", &request).await?;

        Ok(response.id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::TaskResponse;

    fn create_test_client() -> SacrumClient {
        crate::client::SacrumClient::new(crate::config::SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "token".to_string(),
            "test-project".to_string(),
        ))
    }

    fn make_task_response(id: &str, title: &str) -> TaskResponse {
        TaskResponse {
            id: id.to_string(),
            short_id: None,
            project_id: "test-project".to_string(),
            title: title.to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            workflow_id: None,
            current_step_id: None,
            needs_human_review: None,
            review_comment: None,
            rejection_reason: None,
            revision_feedback: None,
            parent_id: None,
            dependency_ids: vec![],
            sections: vec![],
            code_refs: vec![],
            started_at: None,
            completed_at: None,
            inserted_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn test_new_creates_service() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);
        assert!(!service.client.project_id().is_empty());
    }

    #[test]
    fn test_response_to_task_conversion() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let mut response = make_task_response("task-123", "Test Task");
        response.short_id = Some("t-123".to_string());
        response.description = Some("Task description".to_string());
        response.level = Some("ticket".to_string());
        response.priority = Some("high".to_string());
        response.tags = vec!["rust".to_string()];

        let task = service.response_to_task(&response);

        assert_eq!(task.id, "task-123");
        assert_eq!(task.title, "Test Task");
        assert_eq!(task.description, Some("Task description".to_string()));
        assert_eq!(task.level, Level::Ticket);
        assert_eq!(task.priority, Some(Priority::High));
        assert_eq!(task.tags, vec!["rust"]);
    }

    #[test]
    fn test_response_to_task_with_minimal_data() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = make_task_response("task-456", "Minimal Task");

        let task = service.response_to_task(&response);

        assert_eq!(task.id, "task-456");
        assert_eq!(task.title, "Minimal Task");
        assert_eq!(task.description, None);
        assert_eq!(task.priority, None);
        assert_eq!(task.level, Level::Task);
        assert!(task.tags.is_empty());
    }

    #[test]
    fn test_response_to_task_with_sections() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let mut response = make_task_response("task-sec", "With Sections");
        response.sections = vec![SectionResponse {
            id: "sec-1".to_string(),
            section_type: "step".to_string(),
            content: "Do this".to_string(),
            section_order: 1,
            done: Some(true),
            done_at: None,
            inserted_at: None,
            updated_at: None,
        }];

        let task = service.response_to_task(&response);
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].section_type, SectionType::Step);
        assert_eq!(task.sections[0].content, "Do this");
        assert_eq!(task.sections[0].done, Some(true));
    }

    #[test]
    fn test_response_to_task_with_code_refs() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let mut response = make_task_response("task-ref", "With Refs");
        response.code_refs = vec![CodeRefResponse {
            id: "ref-1".to_string(),
            task_id: "task-ref".to_string(),
            section_id: None,
            path: "src/main.rs".to_string(),
            line_start: Some(42),
            line_end: Some(50),
            name: Some("main_fn".to_string()),
            description: None,
            inserted_at: None,
            updated_at: None,
        }];

        let task = service.response_to_task(&response);
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");
        assert_eq!(task.code_refs[0].line_start, Some(42));
        assert_eq!(task.code_refs[0].line_end, Some(50));
    }

    #[test]
    fn test_response_to_task_with_timestamps() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let mut response = make_task_response("task-ts", "With Timestamps");
        response.inserted_at = Some("2024-01-01T00:00:00Z".to_string());
        response.updated_at = Some("2024-01-02T00:00:00Z".to_string());
        response.started_at = Some("2024-01-01T12:00:00Z".to_string());

        let task = service.response_to_task(&response);
        assert!(task.created_at.is_some());
        assert!(task.updated_at.is_some());
        assert!(task.started_at.is_some());
        assert!(task.completed_at.is_none());
    }

    #[test]
    fn test_parse_level() {
        assert_eq!(parse_level("epic"), Some(Level::Epic));
        assert_eq!(parse_level("ticket"), Some(Level::Ticket));
        assert_eq!(parse_level("task"), Some(Level::Task));
        assert_eq!(parse_level("unknown"), None);
    }

    #[test]
    fn test_parse_priority() {
        assert_eq!(parse_priority("low"), Some(Priority::Low));
        assert_eq!(parse_priority("medium"), Some(Priority::Medium));
        assert_eq!(parse_priority("high"), Some(Priority::High));
        assert_eq!(parse_priority("critical"), Some(Priority::Critical));
        assert_eq!(parse_priority("unknown"), None);
    }

    #[test]
    fn test_section_response_to_section_all_types() {
        let types = vec![
            ("goal", SectionType::Goal),
            ("context", SectionType::Context),
            ("step", SectionType::Step),
            ("testing_criterion", SectionType::TestingCriterion),
            ("constraint", SectionType::Constraint),
        ];

        for (type_str, expected_type) in types {
            let response = SectionResponse {
                id: "s-1".to_string(),
                section_type: type_str.to_string(),
                content: "content".to_string(),
                section_order: 0,
                done: None,
                done_at: None,
                inserted_at: None,
                updated_at: None,
            };
            let section = section_response_to_section(&response);
            assert_eq!(section.section_type, expected_type);
        }
    }

    #[test]
    fn test_multiple_service_instances() {
        let client1 = create_test_client();
        let client2 = create_test_client();

        let service1 = SacrumTaskService::new(client1);
        let service2 = SacrumTaskService::new(client2);

        assert_eq!(service1.client.project_id(), service2.client.project_id());
    }

    #[test]
    fn test_response_to_task_with_workflow_fields() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let mut response = make_task_response("task-wf", "Workflow Task");
        response.workflow_id = Some("wf-123".to_string());
        response.current_step_id = Some("step-456".to_string());
        response.needs_human_review = Some(false);
        response.revision_feedback = Some("feedback".to_string());
        response.rejection_reason = Some("reason".to_string());

        let task = service.response_to_task(&response);

        assert_eq!(task.workflow_id.as_deref(), Some("wf-123"));
        assert_eq!(task.current_step_id.as_deref(), Some("step-456"));
        assert_eq!(task.needs_human_review, Some(false));
        assert_eq!(task.revision_feedback.as_deref(), Some("feedback"));
        assert_eq!(task.rejection_reason.as_deref(), Some("reason"));
    }
}
