//! TaskService implementation for Sacrum HTTP API - Stub
//!
//! Implements the TaskService trait by making HTTP calls to the Sacrum REST API.
//! Many methods are currently unimplemented as they require additional API endpoints
//! to be defined in the Sacrum backend.

use async_trait::async_trait;
use serde_json::json;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::Task;
use vertebrae_core::models::{
    BlockerNode, CodeRef, Level, Section, SectionType, TaskFilter, TaskSummary,
};
use vertebrae_core::service::{
    CreateTaskOptions, TaskService, TaskTreeNode, TaskWithRelations, TransitionResult,
    TreeFilterOptions, UpdateTaskOptions,
};

use crate::api_types::TaskResponse;
use crate::client::SacrumClient;

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
        Task {
            id: Some(response.id.clone()),
            title: response.subject.clone(),
            description: response.description.clone(),
            level: Level::Task, // Default level - real implementation would determine this
            priority: None,     // Would be mapped from response
            tags: vec![],       // Would be mapped from response
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
            sections: vec![],
            code_refs: vec![],
            needs_human_review: None,
            revision_feedback: None,
            rejection_reason: None,
            workflow_id: None,
            current_step_id: None,
        }
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

        let path = format!("/projects/{}/tasks", self.client.project_id());
        let response: TaskResponse = self.client.post(&path, &request).await?;

        Ok(response.id.clone())
    }

    async fn get_task(&self, id: &str) -> ServiceResult<Task> {
        let path = format!("/projects/{}/tasks/{}", self.client.project_id(), id);
        let response: TaskResponse = self.client.get(&path).await?;
        Ok(self.response_to_task(&response))
    }

    async fn get_task_with_relations(&self, id: &str) -> ServiceResult<TaskWithRelations> {
        let task = self.get_task(id).await?;
        let parent_id = self.get_parent(id).await?;
        let children_ids = self.get_children(id).await?;
        let depends_on_ids = self.get_dependencies(id).await?;
        let dependent_ids = self.get_dependents(id).await?;

        Ok(TaskWithRelations {
            task,
            parent_id,
            children_ids,
            depends_on_ids,
            dependent_ids,
        })
    }

    async fn get_derived_status(&self, _task: &Task) -> ServiceResult<String> {
        // Return default status - in real implementation would derive from workflow
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

        let path = format!("/projects/{}/tasks/{}", self.client.project_id(), id);
        let _response: TaskResponse = self.client.put(&path, &update_json).await?;

        Ok(())
    }

    async fn set_current_step(&self, _task_id: &str, _step_id: &str) -> ServiceResult<()> {
        unimplemented!("Current step setting not yet implemented for Sacrum HTTP client")
    }

    async fn delete_task(&self, id: &str, _cascade: bool) -> ServiceResult<()> {
        let path = format!("/projects/{}/tasks/{}", self.client.project_id(), id);
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

    async fn list_tasks(&self, _filter: &TaskFilter) -> ServiceResult<Vec<TaskSummary>> {
        let path = format!("/projects/{}/tasks", self.client.project_id());
        let response: serde_json::Value = self.client.get(&path).await?;

        let tasks = response
            .get("tasks")
            .and_then(|v| v.as_array())
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|t| {
                let task_response: TaskResponse = serde_json::from_value(t.clone()).ok()?;
                Some(TaskSummary {
                    id: task_response.id,
                    title: task_response.subject,
                    level: Level::Task,
                    status: "backlog".to_string(),
                    priority: None,
                    tags: vec![],
                    needs_human_review: None,
                    created_at: chrono::Utc::now(),
                    workflow_id: None,
                    current_step_id: None,
                    workflow_name: None,
                    step_name: None,
                })
            })
            .collect();

        Ok(tasks)
    }

    async fn list_tasks_with_relations(
        &self,
        filter: &TaskFilter,
    ) -> ServiceResult<Vec<TaskWithRelations>> {
        let tasks = self.list_tasks(filter).await?;
        let mut results = Vec::new();

        for task_summary in tasks {
            if let Ok(with_relations) = self.get_task_with_relations(&task_summary.id).await {
                results.push(with_relations);
            }
        }

        Ok(results)
    }

    async fn list_ready(&self, _status: &str) -> ServiceResult<Vec<TaskSummary>> {
        unimplemented!("Ready task listing not yet implemented for Sacrum HTTP client")
    }

    async fn get_task_tree(
        &self,
        _options: &TreeFilterOptions,
    ) -> ServiceResult<Vec<TaskTreeNode>> {
        unimplemented!("Task tree retrieval not yet implemented for Sacrum HTTP client")
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

    async fn get_blockers(&self, _id: &str) -> ServiceResult<Vec<BlockerNode>> {
        unimplemented!("Blocker retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn get_incomplete_blockers_with_details(
        &self,
        _id: &str,
    ) -> ServiceResult<Vec<TaskSummary>> {
        unimplemented!("Incomplete blocker retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn find_path(&self, _from_id: &str, _to_id: &str) -> ServiceResult<Option<Vec<String>>> {
        unimplemented!("Path finding not yet implemented for Sacrum HTTP client")
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

    async fn add_code_ref(&self, _id: &str, _code_ref: CodeRef) -> ServiceResult<()> {
        unimplemented!("Code reference addition not yet implemented for Sacrum HTTP client")
    }

    async fn remove_code_refs(&self, _id: &str, _indices: Option<Vec<usize>>) -> ServiceResult<()> {
        unimplemented!("Code reference removal not yet implemented for Sacrum HTTP client")
    }

    async fn append_ref(&self, _id: &str, _code_ref: &CodeRef) -> ServiceResult<()> {
        unimplemented!("Code reference append not yet implemented for Sacrum HTTP client")
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

        let path = format!("/projects/{}/tasks", self.client.project_id());
        let response: TaskResponse = self.client.post(&path, &request).await?;

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

        let response = TaskResponse {
            id: "task-123".to_string(),
            short_id: Some("t-123".to_string()),
            subject: "Test Task".to_string(),
            description: Some("Task description".to_string()),
            status: "backlog".to_string(),
            priority: Some("high".to_string()),
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(task.id, Some("task-123".to_string()));
        assert_eq!(task.title, "Test Task");
        assert_eq!(task.description, Some("Task description".to_string()));
        assert_eq!(task.level, Level::Task);
        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
        assert!(task.workflow_id.is_none());
        assert!(task.current_step_id.is_none());
    }

    #[test]
    fn test_response_to_task_with_minimal_data() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "task-456".to_string(),
            short_id: None,
            subject: "Minimal Task".to_string(),
            description: None,
            status: "in_progress".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(task.id, Some("task-456".to_string()));
        assert_eq!(task.title, "Minimal Task");
        assert_eq!(task.description, None);
        assert_eq!(task.priority, None);
        assert_eq!(task.level, Level::Task);
    }

    #[test]
    fn test_response_to_task_with_parent() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "child-task".to_string(),
            short_id: None,
            subject: "Child Task".to_string(),
            description: Some("A child task".to_string()),
            status: "todo".to_string(),
            priority: Some("medium".to_string()),
            parent_id: Some("parent-task".to_string()),
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(task.id, Some("child-task".to_string()));
        assert_eq!(task.title, "Child Task");
        assert_eq!(task.description, Some("A child task".to_string()));
    }

    #[test]
    fn test_response_to_task_empty_subject() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "task-789".to_string(),
            short_id: None,
            subject: String::new(),
            description: None,
            status: "done".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(task.id, Some("task-789".to_string()));
        assert_eq!(task.title, "");
        assert_eq!(task.level, Level::Task);
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
    fn test_response_to_task_with_all_fields() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "complete-task".to_string(),
            short_id: Some("ct-1".to_string()),
            subject: "Complete Task".to_string(),
            description: Some("Detailed description here".to_string()),
            status: "pending_review".to_string(),
            priority: Some("critical".to_string()),
            parent_id: Some("parent-1".to_string()),
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(task.id, Some("complete-task".to_string()));
        assert_eq!(task.title, "Complete Task");
        assert_eq!(
            task.description,
            Some("Detailed description here".to_string())
        );
        assert_eq!(task.level, Level::Task);
        assert!(task.priority.is_none());
        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
        assert_eq!(task.needs_human_review, None);
        assert_eq!(task.revision_feedback, None);
        assert_eq!(task.rejection_reason, None);
    }

    #[test]
    fn test_response_with_special_characters_in_subject() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "special-task".to_string(),
            short_id: None,
            subject: "Task with \"quotes\" and 'apostrophes' & symbols".to_string(),
            description: Some("Description with émojis and ünicode".to_string()),
            status: "done".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(
            task.title,
            "Task with \"quotes\" and 'apostrophes' & symbols"
        );
        assert_eq!(
            task.description,
            Some("Description with émojis and ünicode".to_string())
        );
    }

    #[test]
    fn test_response_preserves_all_id_formats() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "uuid-style-id-12345678901234567890".to_string(),
            short_id: Some("short-id".to_string()),
            subject: "ID Test".to_string(),
            description: None,
            status: "backlog".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(
            task.id,
            Some("uuid-style-id-12345678901234567890".to_string())
        );
    }

    #[test]
    fn test_level_always_task() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        for status in &["backlog", "todo", "in_progress", "in_review", "done"] {
            let response = TaskResponse {
                id: format!("task-{}", status),
                short_id: None,
                subject: format!("Task with status {}", status),
                description: None,
                status: status.to_string(),
                priority: None,
                parent_id: None,
                project_id: "test-project".to_string(),
            };

            let task = service.response_to_task(&response);
            assert_eq!(task.level, Level::Task);
        }
    }

    #[test]
    fn test_response_fields_always_none() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "test-id".to_string(),
            short_id: None,
            subject: "Test".to_string(),
            description: None,
            status: "backlog".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert!(task.created_at.is_none());
        assert!(task.updated_at.is_none());
        assert!(task.started_at.is_none());
        assert!(task.completed_at.is_none());
        assert!(task.workflow_id.is_none());
        assert!(task.current_step_id.is_none());
        assert!(task.needs_human_review.is_none());
        assert!(task.revision_feedback.is_none());
        assert!(task.rejection_reason.is_none());
    }

    #[test]
    fn test_task_conversion_preserves_id_exactly() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let ids = vec![
            "simple",
            "with-dashes",
            "with_underscores",
            "123456",
            "mixed-Case_123",
        ];

        for id in ids {
            let response = TaskResponse {
                id: id.to_string(),
                short_id: None,
                subject: "Test".to_string(),
                description: None,
                status: "backlog".to_string(),
                priority: None,
                parent_id: None,
                project_id: "test-project".to_string(),
            };

            let task = service.response_to_task(&response);
            assert_eq!(task.id, Some(id.to_string()));
        }
    }

    #[test]
    fn test_task_conversion_preserves_title_exactly() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let titles = vec![
            "Simple Title",
            "Title with numbers 123",
            "Title with special chars !@#$%",
            "   Title with spaces   ",
            "UPPERCASE TITLE",
            "lowercase title",
            "MiXeD CaSe TiTlE",
        ];

        for title in titles {
            let response = TaskResponse {
                id: "test-id".to_string(),
                short_id: None,
                subject: title.to_string(),
                description: None,
                status: "backlog".to_string(),
                priority: None,
                parent_id: None,
                project_id: "test-project".to_string(),
            };

            let task = service.response_to_task(&response);
            assert_eq!(task.title, title.to_string());
        }
    }

    #[test]
    fn test_task_conversion_preserves_description_exactly() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let descriptions = vec![
            Some("Simple description".to_string()),
            Some("Description with\nmultiple\nlines".to_string()),
            Some("Description with \"quotes\"".to_string()),
            Some("Description with 'apostrophes'".to_string()),
            Some("Description with émojis 🚀 café".to_string()),
        ];

        for desc in descriptions {
            let response = TaskResponse {
                id: "test-id".to_string(),
                short_id: None,
                subject: "Test".to_string(),
                description: desc.clone(),
                status: "backlog".to_string(),
                priority: None,
                parent_id: None,
                project_id: "test-project".to_string(),
            };

            let task = service.response_to_task(&response);
            assert_eq!(task.description, desc);
        }
    }

    #[test]
    fn test_task_always_has_empty_collections() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "test-id".to_string(),
            short_id: None,
            subject: "Test".to_string(),
            description: None,
            status: "backlog".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
    }

    #[test]
    fn test_response_with_long_text_values() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let long_text = "a".repeat(1000);
        let response = TaskResponse {
            id: "test-id".to_string(),
            short_id: None,
            subject: long_text.clone(),
            description: Some(long_text.clone()),
            status: "backlog".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(task.title.len(), 1000);
        assert_eq!(task.description.unwrap().len(), 1000);
    }

    #[test]
    fn test_new_service_can_access_client_project_id() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let project_id = service.client.project_id();
        assert_eq!(project_id, "test-project");
    }

    #[test]
    fn test_service_client_project_id_consistency() {
        let client1 = create_test_client();
        let client2 = create_test_client();

        let service1 = SacrumTaskService::new(client1);
        let service2 = SacrumTaskService::new(client2);

        assert_eq!(service1.client.project_id(), service2.client.project_id());
        assert_eq!(service1.client.project_id(), "test-project");
    }

    #[test]
    fn test_response_to_task_with_various_statuses() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let statuses = vec![
            "backlog",
            "todo",
            "in_progress",
            "in_review",
            "done",
            "archived",
        ];

        for status in statuses {
            let response = TaskResponse {
                id: format!("task-{}", status),
                short_id: None,
                subject: "Test".to_string(),
                description: None,
                status: status.to_string(),
                priority: None,
                parent_id: None,
                project_id: "test-project".to_string(),
            };

            let task = service.response_to_task(&response);
            assert_eq!(task.id, Some(format!("task-{}", status)));
            assert_eq!(task.level, Level::Task);
        }
    }

    #[test]
    fn test_response_with_none_and_some_optionals() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response_all_some = TaskResponse {
            id: "id1".to_string(),
            short_id: Some("short1".to_string()),
            subject: "Subject 1".to_string(),
            description: Some("Desc 1".to_string()),
            status: "backlog".to_string(),
            priority: Some("high".to_string()),
            parent_id: Some("parent1".to_string()),
            project_id: "test-project".to_string(),
        };

        let response_all_none = TaskResponse {
            id: "id2".to_string(),
            short_id: None,
            subject: "Subject 2".to_string(),
            description: None,
            status: "backlog".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task1 = service.response_to_task(&response_all_some);
        let task2 = service.response_to_task(&response_all_none);

        assert_eq!(task1.id, Some("id1".to_string()));
        assert_eq!(task1.description, Some("Desc 1".to_string()));
        assert_eq!(task1.title, "Subject 1");
        assert!(task1.priority.is_none());
        assert!(task1.tags.is_empty());

        assert_eq!(task2.id, Some("id2".to_string()));
        assert_eq!(task2.description, None);
        assert_eq!(task2.title, "Subject 2");
        assert!(task2.priority.is_none());
        assert!(task2.tags.is_empty());
    }

    #[test]
    fn test_conversion_always_initializes_empty_collections() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "test-id".to_string(),
            short_id: None,
            subject: "Test".to_string(),
            description: None,
            status: "backlog".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
        assert!(task.tags.is_empty());
        assert_eq!(task.sections.len(), 0);
        assert_eq!(task.code_refs.len(), 0);
        assert_eq!(task.tags.len(), 0);
    }

    #[test]
    fn test_task_fields_mapping_accuracy() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "acc-id".to_string(),
            short_id: Some("short".to_string()),
            subject: "Accuracy Test".to_string(),
            description: Some("Testing field mappings".to_string()),
            status: "in_progress".to_string(),
            priority: Some("medium".to_string()),
            parent_id: Some("parent-id".to_string()),
            project_id: "test-project".to_string(),
        };

        let task = service.response_to_task(&response);

        assert_eq!(task.id, Some("acc-id".to_string()));
        assert_eq!(task.title, "Accuracy Test");
        assert_eq!(task.description, Some("Testing field mappings".to_string()));
        assert!(task.priority.is_none());
        assert!(task.needs_human_review.is_none());
        assert!(task.revision_feedback.is_none());
        assert!(task.rejection_reason.is_none());
    }

    #[test]
    fn test_multiple_conversions_consistency() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = TaskResponse {
            id: "consistency-id".to_string(),
            short_id: None,
            subject: "Consistency Test".to_string(),
            description: Some("Testing consistency".to_string()),
            status: "done".to_string(),
            priority: None,
            parent_id: None,
            project_id: "test-project".to_string(),
        };

        let task1 = service.response_to_task(&response);
        let task2 = service.response_to_task(&response);

        assert_eq!(task1.id, task2.id);
        assert_eq!(task1.title, task2.title);
        assert_eq!(task1.description, task2.description);
        assert_eq!(task1.level, task2.level);
    }
}
