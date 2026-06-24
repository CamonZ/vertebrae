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
    BlockerNode, CodeRef, Level, Priority, Section, SectionType, TaskFilter, TaskRunControls,
};
use vertebrae_core::service::{CreateTaskOptions, TaskService, TaskShowBundle, UpdateTaskOptions};
use vertebrae_core::workflow_service::WorkflowInfo;

use crate::api_types::{
    CodeRefResponse, SectionResponse, ShortIdResponse, ShowTaskRelatedResponse, TaskResponse,
    TaskRunControlsResponse, TaskTitleResponse, WorkflowResponse,
};
use crate::client::{GraphqlClient, with_fragments};
use crate::execution_service::SacrumExecutionService;
use crate::queries::executions::TASK_RUN_FIELDS;
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

        Ok(Self::lookups_from_workflows(&workflows))
    }

    pub(crate) fn lookups_from_workflows(
        workflows: &[WorkflowResponse],
    ) -> (HashMap<String, String>, HashMap<String, String>) {
        let mut workflow_names = HashMap::new();
        let mut step_names = HashMap::new();

        for wf in workflows {
            for step in &wf.workflow_steps {
                step_names.insert(step.id.clone(), step.name.clone());
            }
            workflow_names.insert(wf.id.clone(), wf.name.clone());
        }

        (workflow_names, step_names)
    }

    fn workflow_info_from_response(
        workflow: &WorkflowResponse,
        current_step_id: Option<&str>,
    ) -> WorkflowInfo {
        let steps = &workflow.workflow_steps;
        let total_steps = steps.len();
        let current_step_index = current_step_id
            .and_then(|id| steps.iter().position(|step| step.id == id))
            .unwrap_or(0);

        let current_step_name = current_step_id
            .and_then(|id| steps.iter().find(|step| step.id == id))
            .map(|step| step.name.clone())
            .unwrap_or_default();

        WorkflowInfo {
            id: workflow.id.clone(),
            name: workflow.name.clone(),
            current_step_id: current_step_id.map(ToOwned::to_owned),
            current_step_name,
            current_step_index,
            total_steps,
            prev_step_name: current_step_index
                .checked_sub(1)
                .and_then(|index| steps.get(index))
                .map(|step| step.name.clone()),
            next_step_name: steps
                .get(current_step_index + 1)
                .map(|step| step.name.clone()),
        }
    }

    /// Convert Sacrum TaskResponse to vertebrae_core Task model
    #[cfg(test)]
    fn response_to_task(&self, response: &TaskResponse) -> ServiceResult<Task> {
        self.response_to_task_with_lookups(response, None, None)
    }

    /// Convert Sacrum TaskResponse to vertebrae_core Task model with optional lookups
    pub(crate) fn response_to_task_with_lookups(
        &self,
        response: &TaskResponse,
        workflow_names: Option<&HashMap<String, String>>,
        step_names: Option<&HashMap<String, String>>,
    ) -> ServiceResult<Task> {
        let level = response
            .level
            .as_deref()
            .and_then(parse_level)
            .unwrap_or(Level::Task);

        let priority = response.priority.as_deref().and_then(parse_priority);

        let sections: Vec<Section> = response
            .sections
            .iter()
            .map(section_response_to_section)
            .collect::<ServiceResult<Vec<_>>>()?;

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
        let blockers: Vec<Task> = response
            .blockers
            .iter()
            .map(|r| self.response_to_task_with_lookups(r, workflow_names, step_names))
            .collect::<ServiceResult<Vec<_>>>()?;
        let dependents: Vec<Task> = response
            .dependents
            .iter()
            .map(|r| self.response_to_task_with_lookups(r, workflow_names, step_names))
            .collect::<ServiceResult<Vec<_>>>()?;
        let children: Vec<Task> = response
            .children
            .iter()
            .map(|r| self.response_to_task_with_lookups(r, workflow_names, step_names))
            .collect::<ServiceResult<Vec<_>>>()?;

        Ok(Task {
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
            run_controls: response
                .run_controls
                .as_ref()
                .map(task_run_controls_response_to_controls),
            archived: response.archived,
            worktree: response.worktree.clone(),
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
        })
    }

    /// Fetch a single task by ID (internal helper, returns TaskResponse)
    async fn fetch_task_response(&self, id: &str) -> ServiceResult<TaskResponse> {
        let query = with_fragments(tasks::GET_TASK, &[tasks::TASK_FIELDS]);
        let variables = json!({ "id": id });
        let response: TaskResponse = self.client.execute(&query, variables, "task").await?;
        Ok(response)
    }

    async fn fetch_task_summary_response(&self, id: &str) -> ServiceResult<TaskResponse> {
        let query = with_fragments(tasks::GET_TASK_SUMMARY, &[tasks::TASK_SUMMARY_FIELDS]);
        let variables = json!({ "id": id });
        let response: TaskResponse = self.client.execute(&query, variables, "task").await?;
        Ok(response)
    }

    /// Build GraphQL variables from a TaskFilter
    fn filter_to_variables(&self, filter: &TaskFilter) -> Value {
        let mut variables = json!({
            "project_id": self.client.project_id,
        });

        if let Some(level) = filter.levels.first() {
            variables["level"] = json!(level.as_str());
        }
        if let Some(priority) = filter.priorities.first() {
            variables["priority"] = json!(priority.as_str());
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
        if let Some(ref step_id) = filter.step_id {
            variables["step_id"] = json!(step_id);
        }
        if filter.root_only {
            variables["root_only"] = json!(true);
        }
        if filter.include_archived {
            variables["includeArchived"] = json!(true);
        }

        variables
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

fn section_response_to_section(r: &SectionResponse) -> ServiceResult<Section> {
    let section_type = r.section_type.parse::<SectionType>().map_err(|_| {
        ServiceError::validation_failed(format!(
            "Unrecognized section type from API: '{}'",
            r.section_type
        ))
    })?;

    let done_at = r
        .done_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));

    let refs = r
        .code_refs
        .iter()
        .map(|cr| CodeRef {
            path: cr.path.clone(),
            line_start: cr.line_start.map(|v| v as u32),
            line_end: cr.line_end.map(|v| v as u32),
            name: cr.name.clone(),
            description: cr.description.clone(),
        })
        .collect();

    Ok(Section {
        section_type,
        content: r.content.clone(),
        order: r.section_order.map(|order| order as u32),
        done: r.done,
        done_at,
        refs,
    })
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

fn task_run_controls_response_to_controls(r: &TaskRunControlsResponse) -> TaskRunControls {
    TaskRunControls {
        runnable: r.runnable,
        stoppable: r.stoppable,
        disabled_reason_code: r.disabled_reason_code.clone(),
        disabled_reason: r.disabled_reason.clone(),
        active_run: r
            .active_run
            .as_ref()
            .map(SacrumExecutionService::response_to_task_run),
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
        if let Some(ref workflow_id) = options.workflow_id {
            variables["workflow_id"] = json!(workflow_id);
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

        // If there are dependencies, set them atomically after creation.
        if !options.depends_on.is_empty() {
            self.sync_dependencies(&task_id, &options.depends_on)
                .await?;
        }

        Ok(task_id)
    }

    async fn get_task(&self, id: &str) -> ServiceResult<Task> {
        let response = self.fetch_task_response(id).await?;

        // Fetch lookups to resolve workflow_name and step_name
        let (workflow_names, step_names) = self.fetch_lookups().await.unwrap_or_default();

        self.response_to_task_with_lookups(&response, Some(&workflow_names), Some(&step_names))
    }

    async fn get_task_summary(&self, id: &str) -> ServiceResult<Task> {
        let response = self.fetch_task_summary_response(id).await?;

        let (workflow_names, step_names) = self.fetch_lookups().await.unwrap_or_default();

        self.response_to_task_with_lookups(&response, Some(&workflow_names), Some(&step_names))
    }

    async fn get_task_title(&self, id: &str) -> ServiceResult<String> {
        let variables = json!({ "id": id });
        let response: TaskTitleResponse = self
            .client
            .execute(tasks::GET_TASK_TITLE, variables, "task")
            .await?;
        Ok(response.title)
    }

    async fn get_task_titles(&self, ids: &[String]) -> ServiceResult<Vec<(String, String)>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut variable_defs = Vec::with_capacity(ids.len());
        let mut roots = Vec::with_capacity(ids.len());
        let mut variables = serde_json::Map::new();

        for (index, id) in ids.iter().enumerate() {
            let variable = format!("id{index}");
            let alias = format!("task{index}");
            variable_defs.push(format!("${variable}: Uuid4!"));
            roots.push(format!("{alias}: task(id: ${variable}) {{ id title }}"));
            variables.insert(variable, json!(id));
        }

        let query = format!(
            "query TaskTitles({}) {{ {} }}",
            variable_defs.join(", "),
            roots.join(" ")
        );

        let response: HashMap<String, Option<TaskTitleResponse>> = self
            .client
            .execute_compound(&query, Value::Object(variables))
            .await?;

        ids.iter()
            .enumerate()
            .map(|(index, requested_id)| {
                let alias = format!("task{index}");
                let title = response
                    .get(&alias)
                    .and_then(|task| task.as_ref())
                    .ok_or_else(|| ServiceError::task_not_found(requested_id))?;
                Ok((requested_id.clone(), title.title.clone()))
            })
            .collect()
    }

    async fn get_task_show_bundle(&self, id: &str) -> ServiceResult<Option<TaskShowBundle>> {
        let task_response = self.fetch_task_response(id).await?;
        let include_parent = task_response.parent_id.is_some();
        let include_workflow = task_response.workflow_id.is_some();
        let parent_id = task_response
            .parent_id
            .clone()
            .unwrap_or_else(|| id.to_string());
        let workflow_id = task_response
            .workflow_id
            .clone()
            .unwrap_or_else(|| id.to_string());

        let query = with_fragments(
            tasks::SHOW_TASK_RELATED,
            &[
                tasks::TASK_SUMMARY_FIELDS,
                wf_queries::WORKFLOW_FIELDS,
                TASK_RUN_FIELDS,
            ],
        );
        let variables = json!({
            "project_id": self.client.project_id,
            "task_id": id,
            "parent_id": parent_id,
            "include_parent": include_parent,
            "workflow_id": workflow_id,
            "include_workflow": include_workflow,
        });

        let related: ShowTaskRelatedResponse =
            self.client.execute_compound(&query, variables).await?;
        let (workflow_names, step_names) = Self::lookups_from_workflows(&related.workflows);

        let task = self.response_to_task_with_lookups(
            &task_response,
            Some(&workflow_names),
            Some(&step_names),
        )?;
        let parent = related
            .parent
            .as_ref()
            .map(|parent| {
                self.response_to_task_with_lookups(parent, Some(&workflow_names), Some(&step_names))
            })
            .transpose()?;
        let workflow = related.workflow.as_ref().map(|workflow| {
            Self::workflow_info_from_response(workflow, task.current_step_id.as_deref())
        });
        let run_history = related
            .task_runs
            .iter()
            .map(SacrumExecutionService::response_to_task_run)
            .collect();

        Ok(Some(TaskShowBundle {
            task,
            parent,
            workflow,
            run_history,
        }))
    }

    async fn resolve_short_id(&self, prefix: &str) -> ServiceResult<String> {
        let variables = json!({
            "project_id": self.client.project_id,
            "prefix": prefix,
        });

        let response: ShortIdResponse = self
            .client
            .execute(tasks::RESOLVE_SHORT_ID, variables, "resolveShortId")
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

        if let Some(archived) = options.archived {
            variables["archived"] = json!(archived);
        }

        if let Some(ref parent_opt) = options.parent_id {
            match parent_opt {
                Some(parent_id) => variables["parent_id"] = json!(parent_id),
                None => variables["parent_id"] = Value::Null,
            }
        }

        if let Some(ref worktree_opt) = options.worktree {
            match worktree_opt {
                Some(worktree) => variables["worktree"] = json!(worktree),
                None => variables["worktree"] = Value::Null,
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

    async fn advance_to_step(&self, task_id: &str, step_id: &str) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
            "step_id": step_id,
        });
        self.client
            .execute_void(tasks::ADVANCE_TO_STEP, variables)
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
        let variables = self.filter_to_variables(filter);

        let query = with_fragments(tasks::LIST_TASKS, &[tasks::TASK_FIELDS]);
        let responses: Vec<TaskResponse> = self.client.execute(&query, variables, "tasks").await?;

        // Fetch lookups once for all tasks
        let (workflow_names, step_names) = self.fetch_lookups().await.unwrap_or_default();

        responses
            .iter()
            .map(|t| {
                self.response_to_task_with_lookups(t, Some(&workflow_names), Some(&step_names))
            })
            .collect()
    }

    async fn list_tasks_with_lookups(
        &self,
        filter: &TaskFilter,
        workflow_names: Option<&HashMap<String, String>>,
        step_names: Option<&HashMap<String, String>>,
    ) -> ServiceResult<Vec<Task>> {
        let variables = self.filter_to_variables(filter);

        let query = with_fragments(tasks::LIST_TASKS, &[tasks::TASK_FIELDS]);
        let responses: Vec<TaskResponse> = self.client.execute(&query, variables, "tasks").await?;

        responses
            .iter()
            .map(|t| self.response_to_task_with_lookups(t, workflow_names, step_names))
            .collect()
    }

    async fn list_ready(&self) -> ServiceResult<Vec<Task>> {
        let query = with_fragments(tasks::READY_TASKS, &[tasks::READY_TASK_FIELDS]);
        let variables = json!({
            "project_id": self.client.project_id,
        });

        let responses: Vec<TaskResponse> =
            self.client.execute(&query, variables, "list_ready").await?;

        // Fetch lookups once for all tasks
        let (workflow_names, step_names) = self.fetch_lookups().await.unwrap_or_default();

        responses
            .iter()
            .map(|t| {
                self.response_to_task_with_lookups(t, Some(&workflow_names), Some(&step_names))
            })
            .collect()
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

    async fn sync_dependencies(
        &self,
        task_id: &str,
        depends_on_ids: &[String],
    ) -> ServiceResult<()> {
        let variables = json!({
            "task_id": task_id,
            "depends_on_ids": depends_on_ids,
        });
        self.client
            .execute_void(tasks::SYNC_TASK_DEPENDENCIES, variables)
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

    async fn add_section(&self, id: &str, section: Section) -> ServiceResult<Section> {
        let mut variables = serde_json::Map::new();
        variables.insert("task_id".to_string(), json!(id));
        variables.insert(
            "section_type".to_string(),
            json!(section.section_type.as_str()),
        );
        variables.insert("content".to_string(), json!(section.content));
        variables.insert("done".to_string(), json!(section.done));
        if let Some(order) = section.order {
            variables.insert("section_order".to_string(), json!(order));
        }

        let created: SectionResponse = self
            .client
            .execute(
                tasks::CREATE_SECTION,
                Value::Object(variables),
                "create_section",
            )
            .await?;
        section_response_to_section(&created)
    }

    async fn upsert_section(&self, id: &str, section: Section) -> ServiceResult<Section> {
        let mut variables = serde_json::Map::new();
        variables.insert("task_id".to_string(), json!(id));
        variables.insert(
            "section_type".to_string(),
            json!(section.section_type.as_str()),
        );
        variables.insert("content".to_string(), json!(section.content));
        variables.insert("done".to_string(), json!(section.done));
        if let Some(order) = section.order {
            variables.insert("section_order".to_string(), json!(order));
        }

        let updated: SectionResponse = self
            .client
            .execute(
                tasks::UPSERT_SECTION,
                Value::Object(variables),
                "upsert_section",
            )
            .await?;
        section_response_to_section(&updated)
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
    ) -> ServiceResult<Section> {
        let response = self.fetch_task_response(task_id).await?;

        let section = response
            .sections
            .iter()
            .find(|s| {
                s.section_type == section_type.as_str() && s.section_order == Some(ordinal as i32)
            })
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
        let updated: SectionResponse = self
            .client
            .execute(tasks::UPDATE_SECTION, variables, "update_section")
            .await?;
        section_response_to_section(&updated)
    }

    async fn remove_section_by_ordinal(
        &self,
        task_id: &str,
        section_type: SectionType,
        ordinal: u32,
    ) -> ServiceResult<Section> {
        let response = self.fetch_task_response(task_id).await?;

        let section = response
            .sections
            .iter()
            .find(|s| {
                s.section_type == section_type.as_str() && s.section_order == Some(ordinal as i32)
            })
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "Section {} with order {} not found",
                    section_type.as_str(),
                    ordinal
                ))
            })?;
        let removed = section_response_to_section(section)?;

        let variables = json!({ "id": section.id });
        self.client
            .execute_void(tasks::DELETE_SECTION, variables)
            .await?;
        Ok(removed)
    }

    async fn mark_checklist_item_done(
        &self,
        id: &str,
        section_order: u32,
    ) -> ServiceResult<Section> {
        let response = self.fetch_task_response(id).await?;

        let section = response
            .sections
            .iter()
            .find(|s| {
                s.section_type == SectionType::ChecklistItem.as_str()
                    && s.section_order == Some(section_order as i32)
            })
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "Checklist item section with section_order {} not found",
                    section_order
                ))
            })?;

        let now = chrono::Utc::now().to_rfc3339();
        let variables = json!({
            "id": section.id,
            "done": true,
            "done_at": now,
        });
        let updated: SectionResponse = self
            .client
            .execute(tasks::UPDATE_SECTION, variables, "update_section")
            .await?;
        section_response_to_section(&updated)
    }

    async fn toggle_checklist_item_done(
        &self,
        id: &str,
        section_order: u32,
    ) -> ServiceResult<Section> {
        let response = self.fetch_task_response(id).await?;

        let section = response
            .sections
            .iter()
            .find(|s| {
                s.section_type == SectionType::ChecklistItem.as_str()
                    && s.section_order == Some(section_order as i32)
            })
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "Checklist item section with section_order {} not found",
                    section_order
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

        let updated: SectionResponse = self
            .client
            .execute(tasks::UPDATE_SECTION, variables, "update_section")
            .await?;
        section_response_to_section(&updated)
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
        match indices {
            Some(indices) => {
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
            None => {
                let variables = json!({ "task_id": id });
                self.client
                    .execute_void(tasks::DELETE_TASK_CODE_REFS, variables)
                    .await?;
            }
        }
        Ok(())
    }

    async fn set_code_refs(&self, id: &str, code_refs: &[CodeRef]) -> ServiceResult<()> {
        let refs: Vec<Value> = code_refs
            .iter()
            .enumerate()
            .map(|(order, code_ref)| {
                json!({
                    "path": &code_ref.path,
                    "line_start": code_ref.line_start,
                    "line_end": code_ref.line_end,
                    "name": &code_ref.name,
                    "description": &code_ref.description,
                    "order": order,
                })
            })
            .collect();

        let variables = json!({
            "task_id": id,
            "refs": refs,
        });

        let _updated: Vec<CodeRefResponse> = self
            .client
            .execute(tasks::SET_CODE_REFS, variables, "set_code_refs")
            .await?;
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
            project_id: "test-project".to_string(),
            title: title.to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            workflow_id: None,
            current_step_id: None,
            run_controls: None,
            archived: false,
            worktree: None,
            rejection_reason: None,
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
        response.description = Some("Task description".to_string());
        response.level = Some("ticket".to_string());
        response.priority = Some("high".to_string());
        response.tags = vec!["rust".to_string()];

        let task = service.response_to_task(&response).unwrap();

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

        let task = service.response_to_task(&response).unwrap();

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
            section_type: "checklist_item".to_string(),
            content: "Do this".to_string(),
            section_order: Some(1),
            done: Some(true),
            done_at: None,
            inserted_at: None,
            updated_at: None,
            code_refs: vec![],
        }];

        let task = service.response_to_task(&response).unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].section_type, SectionType::ChecklistItem);
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
        let task = service.response_to_task(&response).unwrap();
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

        let task = service.response_to_task(&response).unwrap();
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
            ("checklist_item", SectionType::ChecklistItem),
            ("testing_criterion", SectionType::TestingCriterion),
            ("constraint", SectionType::Constraint),
        ];

        for (type_str, expected_type) in types {
            let response = SectionResponse {
                id: "s-1".to_string(),
                section_type: type_str.to_string(),
                content: "content".to_string(),
                section_order: Some(0),
                done: None,
                done_at: None,
                inserted_at: None,
                updated_at: None,
                code_refs: vec![],
            };
            let section = section_response_to_section(&response).unwrap();
            assert_eq!(section.section_type, expected_type);
        }
    }

    #[test]
    fn test_create_section_query_requests_returned_order_fields() {
        assert!(tasks::CREATE_SECTION.contains("create_section("));
        assert!(tasks::CREATE_SECTION.contains(
            "id\n            section_type\n            content\n            section_order"
        ));
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
        response.rejection_reason = Some("reason".to_string());

        let task = service.response_to_task(&response).unwrap();

        assert_eq!(task.workflow_id.as_deref(), Some("wf-123"));
        assert_eq!(task.current_step_id.as_deref(), Some("step-456"));
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

        let task = service.response_to_task(&response).unwrap();
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

        let task = service.response_to_task(&response).unwrap();
        assert_eq!(task.id, "task-parent");
        assert_eq!(task.children.len(), 2);
        assert_eq!(task.children[0].id, "child-1");
        assert_eq!(task.children[1].id, "child-2");
    }

    #[test]
    fn test_response_to_task_with_worktree() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let mut response = make_task_response("task-wt", "Worktree Task");
        response.worktree = Some("/home/user/projects/my-worktree".to_string());

        let task = service.response_to_task(&response).unwrap();
        assert_eq!(task.id, "task-wt");
        assert_eq!(
            task.worktree.as_deref(),
            Some("/home/user/projects/my-worktree")
        );
    }

    #[test]
    fn test_response_to_task_without_worktree() {
        let client = create_test_client();
        let service = SacrumTaskService::new(client);

        let response = make_task_response("task-no-wt", "No Worktree");

        let task = service.response_to_task(&response).unwrap();
        assert!(task.worktree.is_none());
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

    async fn captured_variables(server: &MockServer) -> serde_json::Value {
        let received = server
            .received_requests()
            .await
            .expect("received_requests must be enabled");
        assert_eq!(
            received.len(),
            1,
            "expected exactly one GraphQL request, got {}",
            received.len()
        );
        let body: serde_json::Value =
            serde_json::from_slice(&received[0].body).expect("body must be valid JSON");
        body.get("variables")
            .cloned()
            .expect("graphql request must include `variables`")
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
    async fn test_sync_dependencies_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("SyncTaskDependencies"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "sync_task_dependencies": { "id": "task-1" } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let deps = vec!["task-2".to_string(), "task-3".to_string()];
        let result = service.sync_dependencies("task-1", &deps).await;

        assert!(result.is_ok());

        let variables = captured_variables(&server).await;
        assert_eq!(variables["task_id"], "task-1");
        assert_eq!(variables["depends_on_ids"], json!(["task-2", "task-3"]));
    }

    #[tokio::test]
    async fn test_get_blockers_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "My Task");
        task_data["blockers"] = json!([
            { "id": "task-2", "title": "Blocker" }
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
            { "id": "ticket-1", "title": "Child 1", "level": "ticket", "priority": "high" },
            { "id": "ticket-2", "title": "Child 2", "level": "ticket" }
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
                "data": {
                    "create_section": {
                        "id": "sec-new",
                        "section_type": "checklist_item",
                        "content": "Do this first",
                        "section_order": 1
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let section = Section {
            section_type: SectionType::ChecklistItem,
            content: "Do this first".to_string(),
            order: Some(1),
            done: None,
            done_at: None,
            refs: vec![],
        };
        let result = service.add_section("task-1", section).await;

        let created = result.unwrap();
        assert_eq!(created.section_type, SectionType::ChecklistItem);
        assert_eq!(created.content, "Do this first");
        assert_eq!(created.order, Some(1));
    }

    #[tokio::test]
    async fn test_add_section_omits_section_order_when_order_is_none() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateSection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "create_section": {
                        "id": "sec-new",
                        "section_type": "checklist_item",
                        "content": "Do this next",
                        "section_order": 7
                    }
                }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let section = Section {
            section_type: SectionType::ChecklistItem,
            content: "Do this next".to_string(),
            order: None,
            done: None,
            done_at: None,
            refs: vec![],
        };
        let created = service.add_section("task-1", section).await.unwrap();

        assert_eq!(created.order, Some(7));

        let variables = captured_variables(&server).await;
        assert_eq!(variables["task_id"], "task-1");
        assert_eq!(variables["section_type"], "checklist_item");
        assert_eq!(variables["content"], "Do this next");
        assert!(
            !variables
                .as_object()
                .expect("variables must be an object")
                .contains_key("section_order"),
            "section_order should be omitted when Section.order is None"
        );
    }

    #[tokio::test]
    async fn test_upsert_section_success() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("UpsertSection"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "upsert_section": {
                    "id": "sec-1",
                    "section_type": "goal",
                    "content": "Updated goal",
                    "section_order": null,
                    "done": null,
                    "done_at": null
                } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let section = Section {
            section_type: SectionType::Goal,
            content: "Updated goal".to_string(),
            order: None,
            done: None,
            done_at: None,
            refs: vec![],
        };
        let result = service.upsert_section("task-1", section).await.unwrap();

        assert_eq!(result.section_type, SectionType::Goal);
        assert_eq!(result.content, "Updated goal");

        let variables = captured_variables(&server).await;
        assert_eq!(variables["task_id"], "task-1");
        assert_eq!(variables["section_type"], "goal");
        assert_eq!(variables["content"], "Updated goal");
    }

    #[tokio::test]
    async fn test_edit_section_by_ordinal_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "checklist_item", "content": "old", "section_order": 1 }
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
                "data": { "update_section": {
                    "id": "sec-1",
                    "section_type": "checklist_item",
                    "content": "updated content",
                    "section_order": 1,
                    "done": false,
                    "done_at": null
                } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service
            .edit_section_by_ordinal("task-1", SectionType::ChecklistItem, 1, "updated content")
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
    async fn test_remove_all_code_refs() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("DeleteTaskCodeRefs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "deleteTaskCodeRefs": { "id": "task-1" } }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.remove_code_refs("task-1", None).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_set_code_refs_preserves_input_order() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("SetCodeRefs"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "set_code_refs": [
                    {
                        "id": "ref-1",
                        "task_id": "task-1",
                        "section_id": null,
                        "path": "src/a.rs",
                        "line_start": 10,
                        "line_end": null,
                        "name": null,
                        "description": null,
                        "order_index": 0
                    },
                    {
                        "id": "ref-2",
                        "task_id": "task-1",
                        "section_id": null,
                        "path": "src/b.rs",
                        "line_start": null,
                        "line_end": null,
                        "name": "module",
                        "description": "second",
                        "order_index": 1
                    }
                ] }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let refs = vec![
            CodeRef {
                path: "src/a.rs".to_string(),
                line_start: Some(10),
                line_end: None,
                name: None,
                description: None,
            },
            CodeRef {
                path: "src/b.rs".to_string(),
                line_start: None,
                line_end: None,
                name: Some("module".to_string()),
                description: Some("second".to_string()),
            },
        ];
        let result = service.set_code_refs("task-1", &refs).await;

        assert!(result.is_ok());

        let variables = captured_variables(&server).await;
        assert_eq!(variables["task_id"], "task-1");
        assert_eq!(variables["refs"][0]["path"], "src/a.rs");
        assert_eq!(variables["refs"][0]["order"], 0);
        assert_eq!(variables["refs"][1]["path"], "src/b.rs");
        assert_eq!(variables["refs"][1]["order"], 1);
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
            { "id": "sec-1", "section_type": "checklist_item", "content": "A", "section_order": 0 },
            { "id": "sec-2", "section_type": "checklist_item", "content": "B", "section_order": 1 },
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
            .remove_sections("task-1", SectionType::ChecklistItem, Some(vec![0]))
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_mark_checklist_item_done_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "checklist_item", "content": "First", "section_order": 0 },
            { "id": "sec-2", "section_type": "checklist_item", "content": "Second", "section_order": 1 }
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
                "data": { "update_section": {
                    "id": "sec-1",
                    "section_type": "checklist_item",
                    "content": "First",
                    "section_order": 0,
                    "done": true,
                    "done_at": "2024-01-01T00:00:00Z"
                } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        // mark_checklist_item_done uses section_order for lookup
        let result = service.mark_checklist_item_done("task-1", 0).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_toggle_checklist_item_done_success() {
        let server = MockServer::start().await;

        let mut task_data = gql_task_data("task-1", "Task");
        task_data["sections"] = json!([
            { "id": "sec-1", "section_type": "checklist_item", "content": "First", "section_order": 0, "done": false }
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
                "data": { "update_section": {
                    "id": "sec-1",
                    "section_type": "checklist_item",
                    "content": "First",
                    "section_order": 0,
                    "done": true,
                    "done_at": "2024-01-01T00:00:00Z"
                } }
            })))
            .mount(&server)
            .await;

        let service = create_wiremock_service(&server.uri());
        let result = service.toggle_checklist_item_done("task-1", 0).await;

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

    #[test]
    fn test_filter_to_variables_default_omits_step_id() {
        let service = SacrumTaskService::new(create_test_client());
        let vars = service.filter_to_variables(&TaskFilter::default());

        assert_eq!(vars["project_id"], json!("test-project"));
        assert!(vars.get("step_id").is_none());
    }

    #[test]
    fn test_filter_to_variables_includes_step_id_when_set() {
        let service = SacrumTaskService::new(create_test_client());
        let step_uuid = "11111111-2222-3333-4444-555555555555";
        let filter = TaskFilter::new().with_step_id(step_uuid);

        let vars = service.filter_to_variables(&filter);

        assert_eq!(vars["step_id"], json!(step_uuid));
    }

    #[test]
    fn test_filter_to_variables_step_id_does_not_set_status() {
        let service = SacrumTaskService::new(create_test_client());
        let filter = TaskFilter::new().with_step_id("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

        let vars = service.filter_to_variables(&filter);

        assert!(vars.get("status").is_none());
    }

    #[test]
    fn test_list_tasks_query_declares_step_id_argument() {
        assert!(crate::queries::tasks::LIST_TASKS.contains("$step_id: Uuid4"));
        assert!(crate::queries::tasks::LIST_TASKS.contains("step_id: $step_id"));
    }
}
