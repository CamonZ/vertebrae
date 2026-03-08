//! TaskService implementation for Sacrum GraphQL API
//!
//! Implements the TaskService trait by making GraphQL calls to the Sacrum API.
//! Uses the GraphqlClient for all communication.

use async_trait::async_trait;
use serde_json::{Value, json};
use std::collections::HashMap;
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::models::Task;
use vertebrae_core::models::{
    BlockerNode, CodeRef, Level, Priority, Section, SectionType, TaskFilter,
};
use vertebrae_core::service::{CreateTaskOptions, TaskService, UpdateTaskOptions};

use crate::api_types::{CodeRefResponse, SectionResponse, TaskResponse, WorkflowResponse};
use crate::client::{GraphqlClient, with_fragments};
use crate::queries::tasks;
use crate::queries::workflows as wf_queries;

/// TaskService implementation for Sacrum GraphQL client
pub struct SacrumTaskService {
    client: GraphqlClient,
}

impl SacrumTaskService {
    /// Create a new SacrumTaskService
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }

    /// Fetch all workflows (with embedded steps) in a single query and return
    /// both workflow_id → workflow_name and step_id → step_name maps.
    async fn fetch_lookups(
        &self,
    ) -> ServiceResult<(HashMap<String, String>, HashMap<String, String>)> {
        let query = with_fragments(wf_queries::LIST_WORKFLOWS, &[wf_queries::WORKFLOW_FIELDS]);
        let variables = json!({ "project_id": self.client.project_id });
        let workflows: Vec<WorkflowResponse> =
            self.client.execute(&query, variables, "workflows").await?;

        let mut workflow_names = HashMap::new();
        let mut step_names = HashMap::new();

        for wf in workflows {
            for step in &wf.workflow_steps {
                step_names.insert(step.id.clone(), step.name.clone());
            }
            workflow_names.insert(wf.id, wf.name);
        }

        Ok((workflow_names, step_names))
    }

    /// Convert Sacrum TaskResponse to vertebrae_core Task model
    #[cfg(test)]
    fn response_to_task(&self, response: &TaskResponse) -> Task {
        self.response_to_task_with_lookups(response, None, None)
    }

    /// Convert Sacrum TaskResponse to vertebrae_core Task model with optional lookups
    fn response_to_task_with_lookups(
        &self,
        response: &TaskResponse,
        workflow_names: Option<&HashMap<String, String>>,
        step_names: Option<&HashMap<String, String>>,
    ) -> Task {
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

        // Resolve workflow_name from lookup or default to None
        let workflow_name = response
            .workflow_id
            .as_ref()
            .and_then(|wf_id| workflow_names.and_then(|m| m.get(wf_id).cloned()));

        // Resolve step_name from lookup or default to None
        let step_name = response
            .current_step_id
            .as_ref()
            .and_then(|step_id| step_names.and_then(|m| m.get(step_id).cloned()));

        // Extract dependency_ids from blockers if available, otherwise from dependency_ids field
        let dependency_ids = if !response.blockers.is_empty() {
            response.blockers.iter().map(|b| b.id.clone()).collect()
        } else {
            response.dependency_ids.clone()
        };

        // Convert nested relationship responses to Task models (1 level deep only)
        let blockers = response
            .blockers
            .iter()
            .map(|r| self.response_to_task_with_lookups(r, workflow_names, step_names))
            .collect();
        let dependents = response
            .dependents
            .iter()
            .map(|r| self.response_to_task_with_lookups(r, workflow_names, step_names))
            .collect();
        let children = response
            .children
            .iter()
            .map(|r| self.response_to_task_with_lookups(r, workflow_names, step_names))
            .collect();

        Task {
            id: response.id.clone(),
            title: response.title.clone(),
            description: response.description.clone(),
            level,
            priority,
            tags: response.tags.clone(),
            workflow_id: response.workflow_id.clone(),
            current_step_id: response.current_step_id.clone(),
            workflow_name,
            step_name,
            needs_human_review: response.needs_human_review,
            archived: response.archived,
            review_comment: response.review_comment.clone(),
            revision_feedback: response.revision_feedback.clone(),
            rejection_reason: response.rejection_reason.clone(),
            parent_id: response.parent_id.clone(),
            dependency_ids,
            sections,
            code_refs,
            blockers,
            dependents,
            children,
            created_at,
            updated_at,
            started_at,
            completed_at,
        }
    }

    /// Fetch a single task by ID (internal helper, returns TaskResponse)
    async fn fetch_task_response(&self, id: &str) -> ServiceResult<TaskResponse> {
        let query = with_fragments(tasks::GET_TASK, &[tasks::TASK_FIELDS]);
        let variables = json!({ "id": id });
        let response: TaskResponse = self.client.execute(&query, variables, "task").await?;
        Ok(response)
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

        let level_str = options.level.as_ref().map(|l| l.as_str().to_string());
        let priority_str = options.priority.as_ref().map(|p| p.as_str().to_string());

        let mut variables = json!({
            "project_id": self.client.project_id,
            "title": options.title,
        });

        if let Some(ref desc) = options.description {
            variables["description"] = json!(desc);
        }
        if let Some(ref level) = level_str {
            variables["level"] = json!(level);
        }
        if let Some(ref priority) = priority_str {
            variables["priority"] = json!(priority);
        }
        if !options.tags.is_empty() {
            variables["tags"] = json!(options.tags);
        }
        if let Some(ref parent_id) = options.parent_id {
            variables["parent_id"] = json!(parent_id);
        }

        #[derive(serde::Deserialize)]
        struct IdResponse {
            id: String,
        }

        let result: IdResponse = self
            .client
            .execute(tasks::CREATE_TASK, variables, "create_task")
            .await?;

        let task_id = result.id;

        // If there are dependencies, set them via update
        if !options.depends_on.is_empty() {
            let update_vars = json!({
                "id": task_id,
                "depends_on_ids": options.depends_on,
            });
            self.client
                .execute_void(tasks::UPDATE_TASK, update_vars)
                .await?;
        }

        Ok(task_id)
    }

    async fn get_task(&self, id: &str) -> ServiceResult<Task> {
        let response = self.fetch_task_response(id).await?;

        // Fetch lookups to resolve workflow_name and step_name
        let (workflow_names, step_names) = self.fetch_lookups().await.unwrap_or_default();

        Ok(self.response_to_task_with_lookups(&response, Some(&workflow_names), Some(&step_names)))
    }

    async fn resolve_short_id(&self, prefix: &str) -> ServiceResult<String> {
        let query = with_fragments(tasks::RESOLVE_SHORT_ID, &[tasks::TASK_FIELDS]);
        let variables = json!({
            "project_id": self.client.project_id,
            "prefix": prefix,
        });

        let response: TaskResponse = self
            .client
            .execute(&query, variables, "resolveShortId")
            .await
            .map_err(|_| ServiceError::task_not_found(prefix))?;

        Ok(response.id)
    }

    async fn update_task(&self, id: &str, options: UpdateTaskOptions) -> ServiceResult<()> {
        let mut variables = json!({ "id": id });

        if let Some(ref title) = options.title {
            variables["title"] = json!(title);
        }

        if let Some(ref desc_opt) = options.description {
            match desc_opt {
                Some(desc) => variables["description"] = json!(desc),
                None => variables["description"] = Value::Null,
            }
        }

        if let Some(ref priority_opt) = options.priority {
            match priority_opt {
                Some(p) => variables["priority"] = json!(p.as_str()),
                None => variables["priority"] = Value::Null,
            }
        }

        if let Some(ref level) = options.level {
            variables["level"] = json!(level);
        }

        if let Some(needs_review) = options.needs_human_review {
            variables["needs_human_review"] = json!(needs_review);
        }

        if let Some(archived) = options.archived {
            variables["archived"] = json!(archived);
        }

        if let Some(ref revision_feedback_opt) = options.revision_feedback {
            match revision_feedback_opt {
                Some(feedback) => variables["revision_feedback"] = json!(feedback),
                None => variables["revision_feedback"] = Value::Null,
            }
        }

        if let Some(ref parent_opt) = options.parent_id {
            match parent_opt {
                Some(parent_id) => variables["parent_id"] = json!(parent_id),
                None => variables["parent_id"] = Value::Null,
            }
        }

        // Handle tags: fetch current task, compute new tag set
        if !options.add_tags.is_empty() || !options.remove_tags.is_empty() {
            let task_response = self.fetch_task_response(id).await?;
            let mut tags: Vec<String> = task_response.tags;
            for tag in &options.add_tags {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            tags.retain(|t| !options.remove_tags.contains(t));
            variables["tags"] = json!(tags);
        }

        self.client
            .execute_void(tasks::UPDATE_TASK, variables)
            .await?;
        Ok(())
    }

    async fn set_current_step(&self, task_id: &str, step_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
            "step_id": step_id,
        });
        self.client
            .execute_void(tasks::MOVE_TO_STEP, variables)
            .await?;
        Ok(())
    }

    async fn start_step(&self, task_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
        });
        self.client
            .execute_void(tasks::START_STEP, variables)
            .await?;
        Ok(())
    }

    async fn complete_step(&self, task_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
        });
        self.client
            .execute_void(tasks::COMPLETE_STEP, variables)
            .await?;
        Ok(())
    }

    async fn reject_step(
        &self,
        task_id: &str,
        target_step_id: &str,
        feedback: Option<&str>,
    ) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
            "target_step_id": target_step_id,
            "feedback": feedback,
        });
        self.client
            .execute_void(tasks::REJECT_STEP, variables)
            .await?;
        Ok(())
    }

    async fn delete_task(&self, id: &str, cascade: bool) -> ServiceResult<()> {
        let variables = json!({
            "id": id,
            "cascade": cascade,
        });
        self.client
            .execute_void(tasks::DELETE_TASK, variables)
            .await?;
        Ok(())
    }

    async fn task_exists(&self, id: &str) -> ServiceResult<bool> {
        match self.fetch_task_response(id).await {
            Ok(_) => Ok(true),
            Err(ServiceError::TaskNotFound { task_id: _ }) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn list_tasks(&self, filter: &TaskFilter) -> ServiceResult<Vec<Task>> {
        let query = with_fragments(tasks::LIST_TASKS, &[tasks::TASK_FIELDS]);

        let mut variables = json!({
            "project_id": self.client.project_id,
        });

        // Apply filter fields as GQL variables
        if let Some(level) = filter.levels.first() {
            variables["level"] = json!(level.as_str());
        }
        if let Some(ref parent_id) = filter.children_of {
            variables["parent_id"] = json!(parent_id);
        }
        if let Some(ref step_name) = filter.step_names.first() {
            variables["status"] = json!(step_name);
        }
        if !filter.tags.is_empty() {
            variables["tags"] = json!(filter.tags);
        }
        if let Some(ref search) = filter.search {
            variables["search"] = json!(search);
        }
        if let Some(ref workflow_id) = filter.workflow_id {
            variables["workflow_id"] = json!(workflow_id);
        }
        if filter.root_only {
            variables["root_only"] = json!(true);
        }
        if filter.include_archived {
            variables["includeArchived"] = json!(true);
        }

        let responses: Vec<TaskResponse> = self.client.execute(&query, variables, "tasks").await?;

        // Fetch lookups once for all tasks
        let (workflow_names, step_names) = self.fetch_lookups().await.unwrap_or_default();

        Ok(responses
            .iter()
            .map(|t| {
                self.response_to_task_with_lookups(t, Some(&workflow_names), Some(&step_names))
            })
            .collect())
    }

    async fn list_tasks_with_lookups(
        &self,
        filter: &TaskFilter,
        workflow_names: Option<&HashMap<String, String>>,
        step_names: Option<&HashMap<String, String>>,
    ) -> ServiceResult<Vec<Task>> {
        let query = with_fragments(tasks::LIST_TASKS, &[tasks::TASK_FIELDS]);

        let mut variables = json!({
            "project_id": self.client.project_id,
        });

        if let Some(level) = filter.levels.first() {
            variables["level"] = json!(level.as_str());
        }
        if let Some(ref parent_id) = filter.children_of {
            variables["parent_id"] = json!(parent_id);
        }
        if let Some(ref step_name) = filter.step_names.first() {
            variables["status"] = json!(step_name);
        }
        if !filter.tags.is_empty() {
            variables["tags"] = json!(filter.tags);
        }
        if let Some(ref search) = filter.search {
            variables["search"] = json!(search);
        }
        if let Some(ref workflow_id) = filter.workflow_id {
            variables["workflow_id"] = json!(workflow_id);
        }
        if filter.root_only {
            variables["root_only"] = json!(true);
        }
        if filter.include_archived {
            variables["includeArchived"] = json!(true);
        }

        let responses: Vec<TaskResponse> = self.client.execute(&query, variables, "tasks").await?;

        Ok(responses
            .iter()
            .map(|t| self.response_to_task_with_lookups(t, workflow_names, step_names))
            .collect())
    }

    async fn list_ready(&self) -> ServiceResult<Vec<Task>> {
        let query = with_fragments(tasks::READY_TASKS, &[tasks::TASK_FIELDS]);
        let variables = json!({
            "project_id": self.client.project_id,
        });

        let responses: Vec<TaskResponse> =
            self.client.execute(&query, variables, "list_ready").await?;

        // Fetch lookups once for all tasks
        let (workflow_names, step_names) = self.fetch_lookups().await.unwrap_or_default();

        Ok(responses
            .iter()
            .map(|t| {
                self.response_to_task_with_lookups(t, Some(&workflow_names), Some(&step_names))
            })
            .collect())
    }

    async fn set_parent(&self, child_id: &str, parent_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "id": child_id,
            "parent_id": parent_id,
        });
        self.client
            .execute_void(tasks::UPDATE_TASK, variables)
            .await?;
        Ok(())
    }

    async fn remove_parent(&self, child_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "id": child_id,
            "parent_id": Value::Null,
        });
        self.client
            .execute_void(tasks::UPDATE_TASK, variables)
            .await?;
        Ok(())
    }

    async fn add_dependency(&self, task_id: &str, depends_on_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
            "depends_on_id": depends_on_id,
        });
        self.client
            .execute_void(tasks::CREATE_DEPENDENCY, variables)
            .await?;
        Ok(())
    }

    async fn remove_dependency(&self, task_id: &str, depends_on_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
            "depends_on_id": depends_on_id,
        });
        self.client
            .execute_void(tasks::DELETE_DEPENDENCY, variables)
            .await?;
        Ok(())
    }

    async fn get_blockers(&self, id: &str) -> ServiceResult<Vec<BlockerNode>> {
        // Use GET_TASK which returns nested blockers, then convert to BlockerNode
        let response = self.fetch_task_response(id).await?;
        let blockers = response
            .blockers
            .iter()
            .map(|b| BlockerNode {
                id: b.id.clone(),
                title: b.title.clone(),
                level: "task".to_string(),
                step_name: None,
                children: vec![],
            })
            .collect();
        Ok(blockers)
    }

    async fn get_incomplete_blockers_with_details(&self, id: &str) -> ServiceResult<Vec<Task>> {
        let task = self.get_task(id).await?;
        let mut blockers = Vec::new();
        for dep_id in task.dependency_ids {
            if let Ok(blocker) = self.get_task(&dep_id).await
                && blocker.step_name.as_deref() != Some("done")
            {
                blockers.push(blocker);
            }
        }
        Ok(blockers)
    }

    async fn find_path(&self, from_id: &str, to_id: &str) -> ServiceResult<Option<Vec<String>>> {
        let variables = json!({
            "from_id": from_id,
            "to_id": to_id,
        });
        let path: Vec<String> = self
            .client
            .execute(tasks::FIND_PATH, variables, "find_path")
            .await?;
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    }

    async fn get_parent(&self, task_id: &str) -> ServiceResult<Option<String>> {
        let response = self.fetch_task_response(task_id).await?;
        Ok(response.parent_id)
    }

    async fn get_children(&self, task_id: &str) -> ServiceResult<Vec<String>> {
        // Use GET_TASK which returns nested children
        let response = self.fetch_task_response(task_id).await?;
        Ok(response.children.iter().map(|c| c.id.clone()).collect())
    }

    async fn get_dependencies(&self, task_id: &str) -> ServiceResult<Vec<String>> {
        let response = self.fetch_task_response(task_id).await?;
        Ok(response.blockers.iter().map(|b| b.id.clone()).collect())
    }

    async fn get_dependents(&self, task_id: &str) -> ServiceResult<Vec<String>> {
        let response = self.fetch_task_response(task_id).await?;
        Ok(response.dependents.iter().map(|d| d.id.clone()).collect())
    }

    async fn add_section(&self, id: &str, section: Section) -> ServiceResult<()> {
        let variables = json!({
            "task_id": id,
            "section_type": section.section_type.as_str(),
            "content": section.content,
            "section_order": section.order.unwrap_or(0),
            "done": section.done,
        });
        self.client
            .execute_void(tasks::CREATE_SECTION, variables)
            .await?;
        Ok(())
    }

    async fn remove_sections(
        &self,
        id: &str,
        section_type: SectionType,
        indices: Option<Vec<usize>>,
    ) -> ServiceResult<()> {
        let response = self.fetch_task_response(id).await?;
        let matching_sections: Vec<&SectionResponse> = response
            .sections
            .iter()
            .filter(|s| s.section_type == section_type.as_str())
            .collect();

        match indices {
            Some(indices) => {
                for idx in indices {
                    if let Some(section) = matching_sections.get(idx) {
                        let vars = json!({ "id": section.id });
                        self.client
                            .execute_void(tasks::DELETE_SECTION, vars)
                            .await?;
                    }
                }
            }
            None => {
                // Remove all sections of this type
                for section in matching_sections {
                    let vars = json!({ "id": section.id });
                    self.client
                        .execute_void(tasks::DELETE_SECTION, vars)
                        .await?;
                }
            }
        }
        Ok(())
    }

    async fn edit_section_by_ordinal(
        &self,
        task_id: &str,
        section_type: SectionType,
        ordinal: u32,
        new_content: &str,
    ) -> ServiceResult<()> {
        let response = self.fetch_task_response(task_id).await?;

        let section = response
            .sections
            .iter()
            .find(|s| s.section_type == section_type.as_str() && s.section_order == ordinal as i32)
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "Section {} with order {} not found",
                    section_type.as_str(),
                    ordinal
                ))
            })?;

        let variables = json!({
            "id": section.id,
            "content": new_content,
        });
        self.client
            .execute_void(tasks::UPDATE_SECTION, variables)
            .await?;
        Ok(())
    }

    async fn remove_section_by_ordinal(
        &self,
        task_id: &str,
        section_type: SectionType,
        ordinal: u32,
    ) -> ServiceResult<()> {
        let response = self.fetch_task_response(task_id).await?;

        let section = response
            .sections
            .iter()
            .find(|s| s.section_type == section_type.as_str() && s.section_order == ordinal as i32)
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "Section {} with order {} not found",
                    section_type.as_str(),
                    ordinal
                ))
            })?;

        let variables = json!({ "id": section.id });
        self.client
            .execute_void(tasks::DELETE_SECTION, variables)
            .await?;
        Ok(())
    }

    async fn mark_step_done(&self, id: &str, step_index: usize) -> ServiceResult<()> {
        let response = self.fetch_task_response(id).await?;
        let step_sections: Vec<&SectionResponse> = response
            .sections
            .iter()
            .filter(|s| s.section_type == "step")
            .collect();

        // step_index is 1-based
        let section = step_sections.get(step_index - 1).ok_or_else(|| {
            ServiceError::validation_failed(format!(
                "Step section at index {} not found",
                step_index
            ))
        })?;

        let now = chrono::Utc::now().to_rfc3339();
        let variables = json!({
            "id": section.id,
            "done": true,
            "done_at": now,
        });
        self.client
            .execute_void(tasks::UPDATE_SECTION, variables)
            .await?;
        Ok(())
    }

    async fn toggle_step_done(&self, id: &str, ordinal: u32) -> ServiceResult<()> {
        let response = self.fetch_task_response(id).await?;
        let step_sections: Vec<&SectionResponse> = response
            .sections
            .iter()
            .filter(|s| s.section_type == "step")
            .collect();

        // ordinal is 0-based
        let section = step_sections.get(ordinal as usize).ok_or_else(|| {
            ServiceError::validation_failed(format!(
                "Step section at ordinal {} not found",
                ordinal
            ))
        })?;

        let currently_done = section.done.unwrap_or(false);
        let new_done = !currently_done;

        let mut variables = json!({
            "id": section.id,
            "done": new_done,
        });

        if new_done {
            let now = chrono::Utc::now().to_rfc3339();
            variables["done_at"] = json!(now);
        } else {
            variables["done_at"] = Value::Null;
        }

        self.client
            .execute_void(tasks::UPDATE_SECTION, variables)
            .await?;
        Ok(())
    }

    async fn add_code_ref(&self, id: &str, code_ref: CodeRef) -> ServiceResult<()> {
        let variables = json!({
            "task_id": id,
            "path": code_ref.path,
            "line_start": code_ref.line_start,
            "line_end": code_ref.line_end,
            "name": code_ref.name,
            "description": code_ref.description,
        });
        self.client
            .execute_void(tasks::CREATE_CODE_REF, variables)
            .await?;
        Ok(())
    }

    async fn remove_code_refs(&self, id: &str, indices: Option<Vec<usize>>) -> ServiceResult<()> {
        if let Some(indices) = indices {
            let response = self.fetch_task_response(id).await?;
            for idx in indices {
                if let Some(ref_response) = response.code_refs.get(idx) {
                    let variables = json!({ "id": ref_response.id });
                    self.client
                        .execute_void(tasks::DELETE_CODE_REF, variables)
                        .await?;
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
        id: &str,
        section_index: usize,
        code_ref: &CodeRef,
    ) -> ServiceResult<()> {
        let response = self.fetch_task_response(id).await?;
        let section = response.sections.get(section_index).ok_or_else(|| {
            ServiceError::validation_failed(format!("Section at index {} not found", section_index))
        })?;

        let variables = json!({
            "section_id": section.id,
            "path": code_ref.path,
            "line_start": code_ref.line_start,
            "line_end": code_ref.line_end,
            "name": code_ref.name,
            "description": code_ref.description,
        });
        self.client
            .execute_void(tasks::CREATE_CODE_REF, variables)
            .await?;
        Ok(())
    }

    async fn assign_workflow(&self, task_id: &str, workflow_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
            "workflow_id": workflow_id,
        });
        self.client
            .execute_void(tasks::ASSIGN_WORKFLOW, variables)
            .await?;
        Ok(())
    }

    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()> {
        let variables = json!({ "task_id": task_id });
        self.client
            .execute_void(tasks::UNASSIGN_WORKFLOW, variables)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::TaskResponse;

    fn create_test_client() -> GraphqlClient {
        GraphqlClient::new(crate::config::SacrumConfig::new(
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
            archived: false,
            review_comment: None,
            rejection_reason: None,
            revision_feedback: None,
            parent_id: None,
            dependency_ids: vec![],
            sections: vec![],
            code_refs: vec![],
            blockers: vec![],
            dependents: vec![],
            children: vec![],
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

    #[test]
    fn test_response_to_task_dependency_ids_from_blockers() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let mut response = make_task_response("task-deps", "With Blockers");
        response.blockers = vec![
            make_task_response("blocker-1", "Blocker 1"),
            make_task_response("blocker-2", "Blocker 2"),
        ];

        let task = service.response_to_task(&response);
        assert_eq!(task.dependency_ids, vec!["blocker-1", "blocker-2"]);
    }

    #[test]
    fn test_response_to_task_children_populated() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let mut response = make_task_response("task-parent", "Parent Task");
        let mut child1 = make_task_response("child-1", "Child 1");
        child1.level = Some("task".to_string());
        let child2 = make_task_response("child-2", "Child 2");
        response.children = vec![child1, child2];

        let task = service.response_to_task(&response);
        assert_eq!(task.id, "task-parent");
        assert_eq!(task.children.len(), 2);
        assert_eq!(task.children[0].id, "child-1");
        assert_eq!(task.children[1].id, "child-2");
    }

    // =========================================================================
    // Wiremock integration tests for task service GraphQL methods
    // =========================================================================

    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn create_wiremock_service(server_url: &str) -> SacrumTaskService {
        let client = GraphqlClient::new(crate::config::SacrumConfig::new(
            server_url.to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        ));
        SacrumTaskService::new(client)
    }

    fn gql_task_data(id: &str, title: &str) -> serde_json::Value {
        json!({
            "id": id,
            "project_id": "test-project",
            "title": title,
            "tags": [],
            "dependency_ids": [],
            "sections": [],
            "code_refs": [],
            "blockers": [],
            "dependents": [],
            "children": []
        })
    }

    /// Mount empty workflow lookup mocks for GraphQL
    async fn mount_empty_lookups(server: &MockServer) {
        // Mock for LIST_WORKFLOWS
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("ListWorkflows"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "workflows": [] }
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn test_create_task_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "create_task": { "id": "task-new" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let id = service
            .create_task(CreateTaskOptions::new("New Task"))
            .await
            .unwrap();

        assert_eq!(id, "task-new");
    }

    #[tokio::test]
    async fn test_create_task_empty_title_rejected() {
        let server = MockServer::start().await;
        let service = create_wiremock_service(&server.uri());

        let result = service.create_task(CreateTaskOptions::new("  ")).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_task_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": gql_task_data("task-1", "My Task") }
            })))
            .mount(&server)
            .await;
        mount_empty_lookups(&server).await;

        let service = create_wiremock_service(&server.uri());
        let task = service.get_task("task-1").await.unwrap();

        assert_eq!(task.id, "task-1");
        assert_eq!(task.title, "My Task");
    }

    #[tokio::test]
    async fn test_update_task_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpdateTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "update_task": { "id": "task-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let opts = UpdateTaskOptions::new().with_title("Updated");
        let result = service.update_task("task-1", opts).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_delete_task_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("DeleteTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "delete_task": { "id": "task-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.delete_task("task-1", false).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_set_current_step_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("MoveToStep"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "move_to_step": { "id": "task-1", "current_step_id": "step-2" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.set_current_step("task-1", "step-2").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_list_tasks_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("ListTasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "tasks": [
                        gql_task_data("task-1", "First"),
                        gql_task_data("task-2", "Second")
                    ]
                }
            })))
            .mount(&server)
            .await;
        mount_empty_lookups(&server).await;

        let service = create_wiremock_service(&server.uri());
        let tasks = service.list_tasks(&TaskFilter::default()).await.unwrap();

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].title, "First");
        assert_eq!(tasks[1].title, "Second");
    }

    #[tokio::test]
    async fn test_list_ready_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("ReadyTasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "list_ready": [gql_task_data("task-1", "Ready Task")]
                }
            })))
            .mount(&server)
            .await;
        mount_empty_lookups(&server).await;

        let service = create_wiremock_service(&server.uri());
        let tasks = service.list_ready().await.unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "Ready Task");
    }

    #[tokio::test]
    async fn test_add_dependency_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateTaskDependency"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "create_task_dependency": { "id": "dep-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.add_dependency("task-1", "task-2").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_remove_dependency_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("DeleteTaskDependency"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "delete_task_dependency": { "id": "dep-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.remove_dependency("task-1", "task-2").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_blockers_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "My Task");
        task_data["blockers"] = json!([
            { "id": "task-2", "short_id": "t-2", "title": "Blocker" }
        ]);

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let blockers = service.get_blockers("task-1").await.unwrap();

        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].id, "task-2");
    }

    #[tokio::test]
    async fn test_find_path_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("FindPath"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "find_path": ["task-1", "task-2", "task-3"] }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let path_result = service.find_path("task-1", "task-3").await.unwrap();

        assert_eq!(
            path_result,
            Some(vec![
                "task-1".to_string(),
                "task-2".to_string(),
                "task-3".to_string()
            ])
        );
    }

    #[tokio::test]
    async fn test_find_path_empty_returns_none() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("FindPath"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "find_path": [] }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let path_result = service.find_path("task-1", "task-3").await.unwrap();

        assert_eq!(path_result, None);
    }

    #[tokio::test]
    async fn test_get_children_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("epic-1", "Epic");
        task_data["children"] = json!([
            { "id": "ticket-1", "short_id": "t-1", "title": "Child 1", "level": "ticket", "priority": "high" },
            { "id": "ticket-2", "short_id": "t-2", "title": "Child 2", "level": "ticket" }
        ]);

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let children = service.get_children("epic-1").await.unwrap();

        assert_eq!(children, vec!["ticket-1", "ticket-2"]);
    }

    #[tokio::test]
    async fn test_get_dependents_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "My Task");
        task_data["dependents"] = json!([
            { "id": "t-1", "title": "Dep A" },
            { "id": "t-3", "title": "Dep C" }
        ]);

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let dependents = service.get_dependents("task-1").await.unwrap();

        assert_eq!(dependents, vec!["t-1", "t-3"]);
    }

    #[tokio::test]
    async fn test_get_dependencies_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "My Task");
        task_data["blockers"] = json!([
            { "id": "blocker-1", "title": "B1" },
            { "id": "blocker-2", "title": "B2" }
        ]);

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let deps = service.get_dependencies("task-1").await.unwrap();

        assert_eq!(deps, vec!["blocker-1", "blocker-2"]);
    }

    #[tokio::test]
    async fn test_add_section_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateSection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "create_section": { "id": "sec-new" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let section = Section {
            section_type: SectionType::Step,
            content: "Do this first".to_string(),
            order: Some(1),
            done: None,
            done_at: None,
            refs: vec![],
        };
        let result = service.add_section("task-1", section).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "step", "content": "old", "section_order": 1 }
        ]);

        // GET_TASK mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        // UPDATE_SECTION mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpdateSection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "update_section": { "id": "sec-1", "done": false, "done_at": null } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .edit_section_by_ordinal("task-1", SectionType::Step, 1, "updated content")
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_remove_section_by_ordinal_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "constraint", "content": "old", "section_order": 0 }
        ]);

        // GET_TASK mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        // DELETE_SECTION mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("DeleteSection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "delete_section": { "id": "sec-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .remove_section_by_ordinal("task-1", SectionType::Constraint, 0)
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_add_code_ref_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateCodeRef"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "create_code_ref": { "id": "ref-new" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let code_ref = CodeRef {
            path: "src/main.rs".to_string(),
            line_start: Some(10),
            line_end: Some(20),
            name: Some("main".to_string()),
            description: None,
        };
        let result = service.add_code_ref("task-1", code_ref).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_remove_code_refs_by_index() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["code_refs"] = json!([
            { "id": "ref-0", "task_id": "task-1", "path": "a.rs" },
            { "id": "ref-1", "task_id": "task-1", "path": "b.rs" }
        ]);

        // GET_TASK mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        // DELETE_CODE_REF mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("DeleteCodeRef"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "delete_code_ref": { "id": "ref-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.remove_code_refs("task-1", Some(vec![1])).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_set_parent_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpdateTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "update_task": { "id": "child-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.set_parent("child-1", "parent-1").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_remove_parent_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpdateTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "update_task": { "id": "child-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.remove_parent("child-1").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_assign_workflow_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("AssignWorkflow"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "assign_workflow": { "id": "task-1", "workflow_id": "wf-1", "current_step_id": "step-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.assign_workflow("task-1", "wf-1").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_unassign_workflow_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UnassignWorkflow"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "unassign_workflow": { "id": "task-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.unassign_workflow("task-1").await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_remove_sections_by_type() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "step", "content": "A", "section_order": 0 },
            { "id": "sec-2", "section_type": "step", "content": "B", "section_order": 1 },
            { "id": "sec-3", "section_type": "constraint", "content": "C", "section_order": 0 }
        ]);

        // GET_TASK mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        // DELETE_SECTION mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("DeleteSection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "delete_section": { "id": "sec-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        // Remove only the first step section (index 0)
        let result = service
            .remove_sections("task-1", SectionType::Step, Some(vec![0]))
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_mark_step_done_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "step", "content": "First", "section_order": 0 },
            { "id": "sec-2", "section_type": "step", "content": "Second", "section_order": 1 }
        ]);

        // GET_TASK mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        // UPDATE_SECTION mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpdateSection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "update_section": { "id": "sec-1", "done": true, "done_at": "2024-01-01T00:00:00Z" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        // mark_step_done uses 1-based indexing
        let result = service.mark_step_done("task-1", 1).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_toggle_step_done_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "step", "content": "First", "section_order": 0, "done": false }
        ]);

        // GET_TASK mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        // UPDATE_SECTION mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpdateSection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "update_section": { "id": "sec-1", "done": true, "done_at": "2024-01-01T00:00:00Z" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.toggle_step_done("task-1", 0).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_append_section_ref_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "testing_criterion", "content": "Verify X", "section_order": 0 }
        ]);

        // GET_TASK mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("GetTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "task": task_data }
            })))
            .mount(&server)
            .await;

        // CREATE_CODE_REF mock
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateCodeRef"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "create_code_ref": { "id": "ref-new" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let code_ref = CodeRef::file("tests/test.rs");
        let result = service.append_section_ref("task-1", 0, &code_ref).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_delete_task_with_cascade() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("DeleteTask"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "delete_task": { "id": "task-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.delete_task("task-1", true).await;

        assert!(result.is_ok());
    }
}
