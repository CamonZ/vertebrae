//! In-memory mock implementations of service traits for GUI command testing.
//!
//! These mocks store data in `Arc<Mutex<...>>` collections, providing realistic
//! behavior for testing Tauri commands without a remote backend.

use async_trait::async_trait;
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::execution_service::{ExecutionService, StopRunTarget};
use vertebrae_core::models::*;
use vertebrae_core::service::*;
use vertebrae_core::step_service::StepService;
use vertebrae_core::workflow_service::*;
use vertebrae_core::VertebraeServices;

// ============================================================================
// Internal state shared across mock services
// ============================================================================

#[derive(Default)]
struct MockState {
    tasks: HashMap<String, Task>,
    parents: HashMap<String, String>,
    dependencies: HashMap<String, HashSet<String>>,
    workflows: HashMap<String, Workflow>,
    executions: HashMap<String, StepExecution>,
    task_runs: HashMap<String, TaskRun>,
    logs: HashMap<String, SessionLog>,
    steps: HashMap<String, Step>,
    next_section_orders: HashMap<(String, SectionType), u32>,
    next_id: u64,
}

impl MockState {
    fn gen_id(&mut self) -> String {
        self.next_id += 1;
        format!("mock{:04}", self.next_id)
    }
}

type State = Arc<Mutex<MockState>>;

// ============================================================================
// MockTaskService
// ============================================================================

pub struct MockTaskService {
    state: State,
}

impl MockTaskService {
    fn new(state: State) -> Self {
        Self { state }
    }
}

#[async_trait]
impl TaskService for MockTaskService {
    async fn create_task(&self, options: CreateTaskOptions) -> ServiceResult<String> {
        let mut s = self.state.lock().unwrap();
        let id = options.id.clone().unwrap_or_else(|| s.gen_id());
        let task = Task {
            id: id.clone(),
            title: options.title.clone(),
            description: options.description.clone(),
            level: options.level.clone().unwrap_or(Level::Task),
            priority: options.priority.clone(),
            tags: options.tags.clone(),
            created_at: Some(Utc::now()),
            updated_at: Some(Utc::now()),
            started_at: None,
            completed_at: None,
            sections: vec![],
            code_refs: vec![],
            blockers: vec![],
            dependents: vec![],
            children: vec![],
            archived: false,
            worktree: None,
            rejection_reason: None,
            workflow_id: options.workflow_id.clone(),
            current_step_id: None,
            parent_id: None,
            dependency_ids: vec![],
            workflow_name: None,
            step_name: None,
            run_controls: None,
        };
        s.tasks.insert(id.clone(), task);

        if let Some(parent_id) = &options.parent_id {
            if !s.tasks.contains_key(parent_id) {
                s.tasks.remove(&id);
                return Err(ServiceError::task_not_found(parent_id));
            }
            s.parents.insert(id.clone(), parent_id.clone());
        }

        for dep_id in &options.depends_on {
            if !s.tasks.contains_key(dep_id) {
                s.tasks.remove(&id);
                return Err(ServiceError::task_not_found(dep_id));
            }
            s.dependencies
                .entry(id.clone())
                .or_default()
                .insert(dep_id.clone());
        }

        Ok(id)
    }

    async fn get_task(&self, id: &str) -> ServiceResult<Task> {
        let s = self.state.lock().unwrap();
        let mut task = s
            .tasks
            .get(id)
            .cloned()
            .ok_or_else(|| ServiceError::task_not_found(id))?;

        // Populate children from parent relationships
        task.children = s
            .parents
            .iter()
            .filter(|(_, p)| *p == id)
            .filter_map(|(c, _)| s.tasks.get(c).cloned())
            .collect();

        // Populate blockers from dependencies
        if let Some(blocker_ids) = s.dependencies.get(id) {
            task.blockers = blocker_ids
                .iter()
                .filter_map(|bid| s.tasks.get(bid).cloned())
                .collect();
        }

        // Populate dependents (tasks that depend on this one)
        task.dependents = s
            .dependencies
            .iter()
            .filter(|(_, blockers)| blockers.contains(id))
            .filter_map(|(tid, _)| s.tasks.get(tid).cloned())
            .collect();

        Ok(task)
    }

    async fn resolve_short_id(&self, prefix: &str) -> ServiceResult<String> {
        let s = self.state.lock().unwrap();
        let matches: Vec<&String> = s.tasks.keys().filter(|id| id.starts_with(prefix)).collect();
        match matches.len() {
            0 => Err(ServiceError::task_not_found(prefix)),
            1 => Ok(matches[0].clone()),
            _ => Err(ServiceError::validation_failed(format!(
                "Prefix '{}' matches multiple tasks",
                prefix
            ))),
        }
    }

    async fn update_task(&self, id: &str, options: UpdateTaskOptions) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        if let Some(title) = &options.title {
            task.title = title.clone();
        }
        if let Some(desc) = &options.description {
            task.description = desc.clone();
        }
        if let Some(pri) = &options.priority {
            task.priority = pri.clone();
        }
        if let Some(archived) = options.archived {
            task.archived = archived;
        }
        if let Some(worktree) = &options.worktree {
            task.worktree = worktree.clone();
        }
        task.updated_at = Some(Utc::now());
        Ok(())
    }

    async fn set_current_step(&self, task_id: &str, step_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?;
        task.current_step_id = Some(step_id.to_string());
        Ok(())
    }

    async fn advance_to_step(&self, task_id: &str, step_id: &str) -> ServiceResult<()> {
        self.set_current_step(task_id, step_id).await
    }

    async fn delete_task(&self, id: &str, cascade: bool) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        if !s.tasks.contains_key(id) {
            return Err(ServiceError::task_not_found(id));
        }
        if cascade {
            let children: Vec<String> = s
                .parents
                .iter()
                .filter(|(_, p)| *p == id)
                .map(|(c, _)| c.clone())
                .collect();
            for child_id in children {
                s.tasks.remove(&child_id);
                s.parents.remove(&child_id);
                s.dependencies.remove(&child_id);
            }
        }
        s.tasks.remove(id);
        s.parents.remove(id);
        s.dependencies.remove(id);
        for deps in s.dependencies.values_mut() {
            deps.remove(id);
        }
        Ok(())
    }

    async fn task_exists(&self, id: &str) -> ServiceResult<bool> {
        let s = self.state.lock().unwrap();
        Ok(s.tasks.contains_key(id))
    }

    async fn list_tasks(&self, filter: &TaskFilter) -> ServiceResult<Vec<Task>> {
        let s = self.state.lock().unwrap();
        let tasks: Vec<Task> = s
            .tasks
            .values()
            .filter(|t| {
                if !filter.levels.is_empty() && !filter.levels.contains(&t.level) {
                    return false;
                }
                if let Some(workflow_id) = &filter.workflow_id {
                    if t.workflow_id.as_deref() != Some(workflow_id.as_str()) {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect();
        Ok(tasks)
    }

    async fn list_ready(&self) -> ServiceResult<Vec<Task>> {
        let all = self.list_tasks(&TaskFilter::default()).await?;
        let s = self.state.lock().unwrap();
        Ok(all
            .into_iter()
            .filter(|t| {
                s.dependencies
                    .get(&t.id)
                    .map(|d| d.is_empty())
                    .unwrap_or(true)
            })
            .collect())
    }

    async fn set_parent(&self, child_id: &str, parent_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        if !s.tasks.contains_key(child_id) {
            return Err(ServiceError::task_not_found(child_id));
        }
        if !s.tasks.contains_key(parent_id) {
            return Err(ServiceError::task_not_found(parent_id));
        }
        s.parents
            .insert(child_id.to_string(), parent_id.to_string());
        if let Some(task) = s.tasks.get_mut(child_id) {
            task.parent_id = Some(parent_id.to_string());
        }
        Ok(())
    }

    async fn remove_parent(&self, child_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        s.parents.remove(child_id);
        if let Some(task) = s.tasks.get_mut(child_id) {
            task.parent_id = None;
        }
        Ok(())
    }

    async fn add_dependency(&self, task_id: &str, depends_on_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        if !s.tasks.contains_key(task_id) {
            return Err(ServiceError::task_not_found(task_id));
        }
        if !s.tasks.contains_key(depends_on_id) {
            return Err(ServiceError::task_not_found(depends_on_id));
        }
        s.dependencies
            .entry(task_id.to_string())
            .or_default()
            .insert(depends_on_id.to_string());
        if let Some(task) = s.tasks.get_mut(task_id) {
            if !task.dependency_ids.contains(&depends_on_id.to_string()) {
                task.dependency_ids.push(depends_on_id.to_string());
            }
        }
        Ok(())
    }

    async fn remove_dependency(&self, task_id: &str, depends_on_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        if let Some(deps) = s.dependencies.get_mut(task_id) {
            deps.remove(depends_on_id);
        }
        if let Some(task) = s.tasks.get_mut(task_id) {
            task.dependency_ids.retain(|d| d != depends_on_id);
        }
        Ok(())
    }

    async fn get_blockers(&self, id: &str) -> ServiceResult<Vec<BlockerNode>> {
        let s = self.state.lock().unwrap();
        if !s.tasks.contains_key(id) {
            return Err(ServiceError::task_not_found(id));
        }
        let blockers = s
            .dependencies
            .get(id)
            .map(|deps| {
                deps.iter()
                    .filter_map(|dep_id| {
                        s.tasks.get(dep_id).map(|t| BlockerNode {
                            id: dep_id.clone(),
                            title: t.title.clone(),
                            level: t.level.as_str().to_string(),
                            step_name: None,
                            children: vec![],
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(blockers)
    }

    async fn get_incomplete_blockers_with_details(&self, id: &str) -> ServiceResult<Vec<Task>> {
        let blockers = self.get_blockers(id).await?;
        let s = self.state.lock().unwrap();
        Ok(blockers
            .iter()
            .filter_map(|b| s.tasks.get(&b.id).cloned())
            .collect())
    }

    async fn find_path(&self, from_id: &str, to_id: &str) -> ServiceResult<Option<Vec<String>>> {
        let s = self.state.lock().unwrap();
        if !s.tasks.contains_key(from_id) {
            return Err(ServiceError::task_not_found(from_id));
        }
        if !s.tasks.contains_key(to_id) {
            return Err(ServiceError::task_not_found(to_id));
        }
        if from_id == to_id {
            return Ok(Some(vec![from_id.to_string()]));
        }
        Ok(None)
    }

    async fn get_parent(&self, task_id: &str) -> ServiceResult<Option<String>> {
        let s = self.state.lock().unwrap();
        Ok(s.parents.get(task_id).cloned())
    }

    async fn get_children(&self, task_id: &str) -> ServiceResult<Vec<String>> {
        let s = self.state.lock().unwrap();
        Ok(s.parents
            .iter()
            .filter(|(_, p)| *p == task_id)
            .map(|(c, _)| c.clone())
            .collect())
    }

    async fn get_dependencies(&self, task_id: &str) -> ServiceResult<Vec<String>> {
        let s = self.state.lock().unwrap();
        Ok(s.dependencies
            .get(task_id)
            .map(|d| d.iter().cloned().collect())
            .unwrap_or_default())
    }

    async fn get_dependents(&self, task_id: &str) -> ServiceResult<Vec<String>> {
        let s = self.state.lock().unwrap();
        Ok(s.dependencies
            .iter()
            .filter(|(_, blockers)| blockers.contains(task_id))
            .map(|(tid, _)| tid.clone())
            .collect())
    }

    async fn add_section(&self, id: &str, mut section: Section) -> ServiceResult<Section> {
        let mut s = self.state.lock().unwrap();
        if !s.tasks.contains_key(id) {
            return Err(ServiceError::task_not_found(id));
        }

        let key = (id.to_string(), section.section_type.clone());
        let assigned_order = match section.order {
            Some(order) => {
                let next_order = s.next_section_orders.entry(key).or_insert(0);
                *next_order = (*next_order).max(order + 1);
                Some(order)
            }
            None => {
                let next_order = s.next_section_orders.entry(key).or_insert(0);
                let order = *next_order;
                *next_order += 1;
                Some(order)
            }
        };
        section.order = assigned_order;

        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        task.sections.push(section.clone());
        Ok(section)
    }

    async fn remove_sections(
        &self,
        id: &str,
        section_type: SectionType,
        _indices: Option<Vec<usize>>,
    ) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        task.sections.retain(|s| s.section_type != section_type);
        Ok(())
    }

    async fn edit_section_by_ordinal(
        &self,
        id: &str,
        section_type: SectionType,
        ordinal: u32,
        new_content: &str,
    ) -> ServiceResult<Section> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        for sec in &mut task.sections {
            if sec.section_type == section_type && sec.order == Some(ordinal) {
                sec.content = new_content.to_string();
                return Ok(sec.clone());
            }
        }
        Err(ServiceError::validation_failed("Section not found"))
    }

    async fn remove_section_by_ordinal(
        &self,
        id: &str,
        section_type: SectionType,
        ordinal: u32,
    ) -> ServiceResult<Section> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        let index = task
            .sections
            .iter()
            .position(|s| s.section_type == section_type && s.order == Some(ordinal))
            .ok_or_else(|| ServiceError::validation_failed("Section not found"))?;
        Ok(task.sections.remove(index))
    }

    async fn mark_checklist_item_done(
        &self,
        id: &str,
        section_order: u32,
    ) -> ServiceResult<Section> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        for sec in &mut task.sections {
            if sec.section_type == SectionType::ChecklistItem && sec.order == Some(section_order) {
                sec.mark_done();
                return Ok(sec.clone());
            }
        }
        Err(ServiceError::validation_failed("Checklist item not found"))
    }

    async fn toggle_checklist_item_done(&self, id: &str, ordinal: u32) -> ServiceResult<Section> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        for sec in &mut task.sections {
            if sec.section_type == SectionType::ChecklistItem && sec.order == Some(ordinal) {
                let currently_done = sec.done.unwrap_or(false);
                if currently_done {
                    sec.done = Some(false);
                    sec.done_at = None;
                } else {
                    sec.mark_done();
                }
                return Ok(sec.clone());
            }
        }
        Err(ServiceError::validation_failed("Checklist item not found"))
    }

    async fn add_code_ref(&self, id: &str, code_ref: CodeRef) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        task.code_refs.push(code_ref);
        Ok(())
    }

    async fn remove_code_refs(&self, id: &str, indices: Option<Vec<usize>>) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        if let Some(indices) = indices {
            let mut sorted_indices = indices;
            sorted_indices.sort_by(|a, b| b.cmp(a));
            for idx in sorted_indices {
                if idx < task.code_refs.len() {
                    task.code_refs.remove(idx);
                }
            }
        } else {
            task.code_refs.clear();
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
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        if section_index < task.sections.len() {
            task.sections[section_index].refs.push(code_ref.clone());
        }
        Ok(())
    }

    async fn assign_workflow(&self, task_id: &str, workflow_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?;
        task.workflow_id = Some(workflow_id.to_string());
        Ok(())
    }

    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?;
        task.workflow_id = None;
        task.current_step_id = None;
        Ok(())
    }
}

// ============================================================================
// MockWorkflowService
// ============================================================================

pub struct MockWorkflowService {
    state: State,
}

impl MockWorkflowService {
    fn new(state: State) -> Self {
        Self { state }
    }
}

#[async_trait]
impl WorkflowService for MockWorkflowService {
    async fn create_workflow(&self, options: CreateWorkflowOptions) -> ServiceResult<String> {
        let mut s = self.state.lock().unwrap();
        let id = s.gen_id();
        let wf = Workflow {
            id: Some(id.clone()),
            name: options.name.clone(),
            description: options.description.clone(),
            initial_step: None,
            metadata: std::collections::HashMap::new(),
            order: options.order,
            is_default: options.is_default,
            is_final: options.is_final,
            kanban_column: options.kanban_column.clone(),
            transitions: Vec::new(),
            created_at: Some(Utc::now()),
            updated_at: Some(Utc::now()),
        };
        s.workflows.insert(id.clone(), wf);
        Ok(id)
    }

    async fn get_workflow(&self, id: &str) -> ServiceResult<Workflow> {
        let s = self.state.lock().unwrap();
        s.workflows
            .get(id)
            .cloned()
            .ok_or_else(|| ServiceError::validation_failed(format!("Workflow not found: {}", id)))
    }

    async fn resolve_short_id(&self, prefix: &str) -> ServiceResult<String> {
        let s = self.state.lock().unwrap();
        let prefix_lower = prefix.to_lowercase();
        let matches: Vec<String> = s
            .workflows
            .keys()
            .filter(|id| id.to_lowercase().starts_with(&prefix_lower))
            .cloned()
            .collect();
        match matches.len() {
            0 => Err(ServiceError::validation_failed(format!(
                "workflow with prefix '{}' not found",
                prefix
            ))),
            1 => Ok(matches.into_iter().next().unwrap()),
            _ => Err(ServiceError::validation_failed(format!(
                "ambiguous prefix '{}': multiple workflows match: {}",
                prefix,
                matches.join(", ")
            ))),
        }
    }

    async fn list_workflows(&self) -> ServiceResult<Vec<WorkflowSummary>> {
        let s = self.state.lock().unwrap();
        Ok(s.workflows
            .values()
            .map(|w| WorkflowSummary {
                id: w.id.clone().unwrap_or_default(),
                name: w.name.clone(),
                description: w.description.clone(),
                step_count: 0,
                is_default: w.is_default,
            })
            .collect())
    }

    async fn list_workflows_full(&self) -> ServiceResult<Vec<Workflow>> {
        let s = self.state.lock().unwrap();
        Ok(s.workflows.values().cloned().collect())
    }

    async fn update_workflow(&self, id: &str, options: UpdateWorkflowOptions) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let wf = s.workflows.get_mut(id).ok_or_else(|| {
            ServiceError::validation_failed(format!("Workflow not found: {}", id))
        })?;
        if let Some(name) = &options.name {
            wf.name = name.clone();
        }
        if let Some(description) = &options.description {
            wf.description = description.clone();
        }
        if let Some(is_default) = options.is_default {
            wf.is_default = is_default;
        }
        if let Some(is_final) = options.is_final {
            wf.is_final = is_final;
        }
        if let Some(kanban_column) = &options.kanban_column {
            wf.kanban_column = kanban_column.clone();
        }
        Ok(())
    }

    async fn delete_workflow(&self, id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        s.workflows.remove(id);
        Ok(())
    }

    async fn workflow_exists(&self, id: &str) -> ServiceResult<bool> {
        let s = self.state.lock().unwrap();
        Ok(s.workflows.contains_key(id))
    }

    async fn assign_workflow(
        &self,
        task_id: &str,
        workflow_id: &str,
    ) -> ServiceResult<AssignResult> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?;
        task.workflow_id = Some(workflow_id.to_string());
        Ok(AssignResult {
            task_id: task_id.to_string(),
            workflow_id: workflow_id.to_string(),
            first_step_name: "step1".to_string(),
        })
    }

    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?;
        task.workflow_id = None;
        task.current_step_id = None;
        Ok(())
    }

    async fn get_workflow_info(
        &self,
        workflow_id: &str,
        _current_step_id: Option<&str>,
    ) -> ServiceResult<WorkflowInfo> {
        let s = self.state.lock().unwrap();
        let wf = s.workflows.get(workflow_id);
        Ok(WorkflowInfo {
            id: workflow_id.to_string(),
            name: wf.map(|w| w.name.clone()).unwrap_or_default(),
            current_step_id: None,
            current_step_name: "step1".to_string(),
            current_step_index: 0,
            total_steps: 1,
            prev_step_name: None,
            next_step_name: None,
        })
    }

    async fn create_workflow_transition(
        &self,
        _from_workflow_id: &str,
        _to_workflow_id: &str,
        _label: &str,
        _target_step_id: Option<&str>,
    ) -> ServiceResult<WorkflowTransition> {
        Ok(WorkflowTransition {
            id: Some("mock-transition".to_string()),
            from_workflow: "a".to_string(),
            to_workflow: "b".to_string(),
            label: "test".to_string(),
            target_step: None,
            created_at: Some(Utc::now()),
        })
    }

    async fn list_workflow_transitions(
        &self,
        _from_workflow_id: Option<&str>,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        Ok(vec![])
    }

    async fn list_workflow_transitions_with_names(
        &self,
        from_workflow_id: Option<&str>,
    ) -> ServiceResult<(
        Vec<WorkflowTransition>,
        std::collections::HashMap<String, String>,
    )> {
        let transitions = self.list_workflow_transitions(from_workflow_id).await?;
        let workflow_names = self
            .list_workflows()
            .await?
            .into_iter()
            .map(|workflow| (workflow.id, workflow.name))
            .collect();
        Ok((transitions, workflow_names))
    }

    async fn get_transitions_from_workflow(
        &self,
        _workflow_id: &str,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        Ok(vec![])
    }

    async fn get_transitions_to_workflow(
        &self,
        _workflow_id: &str,
    ) -> ServiceResult<Vec<WorkflowTransition>> {
        Ok(vec![])
    }

    async fn delete_workflow_transition(
        &self,
        _from_workflow_id: &str,
        _to_workflow_id: &str,
    ) -> ServiceResult<()> {
        Ok(())
    }

    async fn workflow_transition_exists(
        &self,
        _from_workflow_id: &str,
        _to_workflow_id: &str,
    ) -> ServiceResult<bool> {
        Ok(false)
    }
}

// ============================================================================
// MockExecutionService
// ============================================================================

pub struct MockExecutionService {
    state: State,
}

impl MockExecutionService {
    fn new(state: State) -> Self {
        Self { state }
    }
}

fn task_run_controls(active_run: Option<TaskRun>, has_workflow: bool) -> TaskRunControls {
    match active_run {
        Some(run) => TaskRunControls {
            runnable: false,
            stoppable: run.is_stoppable(),
            disabled_reason_code: Some(
                if run.is_stoppable() {
                    "active_run"
                } else {
                    "stopping"
                }
                .to_string(),
            ),
            disabled_reason: Some("Task already has an active run".to_string()),
            active_run: Some(run),
        },
        None => TaskRunControls {
            runnable: has_workflow,
            stoppable: false,
            disabled_reason_code: (!has_workflow).then(|| "missing_workflow".to_string()),
            disabled_reason: (!has_workflow).then(|| "Task has no workflow assigned".to_string()),
            active_run: None,
        },
    }
}

fn active_run_for_task(s: &MockState, task_id: &str) -> Option<TaskRun> {
    s.task_runs
        .values()
        .filter(|run| run.task_id == task_id && run.is_active())
        .max_by(|a, b| a.inserted_at.cmp(&b.inserted_at))
        .cloned()
}

fn sync_task_run_controls(s: &mut MockState, task_id: &str) {
    let active_run = active_run_for_task(s, task_id);
    if let Some(task) = s.tasks.get_mut(task_id) {
        task.run_controls = Some(task_run_controls(active_run, task.workflow_id.is_some()));
    }
}

#[async_trait]
impl ExecutionService for MockExecutionService {
    async fn create_execution(&self, mut execution: StepExecution) -> ServiceResult<String> {
        let mut s = self.state.lock().unwrap();
        let id = s.gen_id();
        execution.id = Some(id.clone());
        s.executions.insert(id.clone(), execution);
        Ok(id)
    }

    async fn get_execution(&self, id: &str) -> ServiceResult<Option<StepExecution>> {
        let s = self.state.lock().unwrap();
        Ok(s.executions.get(id).cloned())
    }

    async fn list_executions_for_task(&self, task_id: &str) -> ServiceResult<Vec<StepExecution>> {
        let s = self.state.lock().unwrap();
        let mut executions: Vec<StepExecution> = s
            .executions
            .values()
            .filter(|e| e.task_id == task_id)
            .cloned()
            .collect();
        executions.sort_by_key(|e| e.started_at);
        Ok(executions)
    }

    async fn add_log(&self, mut log: SessionLog) -> ServiceResult<String> {
        let mut s = self.state.lock().unwrap();
        let id = s.gen_id();
        log.id = Some(id.clone());
        s.logs.insert(id.clone(), log);
        Ok(id)
    }

    async fn list_logs_for_execution(&self, execution_id: &str) -> ServiceResult<Vec<SessionLog>> {
        let s = self.state.lock().unwrap();
        let mut logs: Vec<SessionLog> = s
            .logs
            .values()
            .filter(|l| l.step_execution_id == execution_id)
            .cloned()
            .collect();
        logs.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(logs)
    }

    async fn get_latest_execution_for_task(
        &self,
        task_id: &str,
    ) -> ServiceResult<Option<StepExecution>> {
        let s = self.state.lock().unwrap();
        let mut executions: Vec<StepExecution> = s
            .executions
            .values()
            .filter(|e| e.task_id == task_id)
            .cloned()
            .collect();
        executions.sort_by_key(|e| e.started_at);
        Ok(executions.pop())
    }

    async fn update_execution(
        &self,
        execution_id: &str,
        output: Option<String>,
        transition_result: Option<String>,
    ) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let execution = s.executions.get_mut(execution_id).ok_or_else(|| {
            ServiceError::validation_failed(format!("execution not found: {}", execution_id))
        })?;
        if let Some(out) = output {
            execution.output = Some(out);
        }
        if let Some(result) = transition_result {
            execution.transition_result = Some(result);
        }
        Ok(())
    }

    async fn run_step(&self, task_id: &str, _step_id: &str) -> ServiceResult<StepExecution> {
        let mut s = self.state.lock().unwrap();
        let id = s.gen_id();
        let mut execution = StepExecution::new(task_id, "mock_workflow", "mock_step")
            .with_prompt("mock prompt")
            .with_output("mock output")
            .with_context(r#"{"mock":"context"}"#)
            .with_transition_result("mock_next_step")
            .with_model_used("claude-opus-4")
            .with_model_provider("anthropic")
            .with_session_id("mock-session-id")
            .with_token_usage(vertebrae_core::TokenUsage::new(123, 45))
            .with_cost_usd(0.001)
            .with_duration_ms(250)
            .with_handoff(r#"{"to":"mock_next_step"}"#);
        execution.id = Some(id.clone());
        s.executions.insert(id, execution.clone());
        Ok(execution)
    }

    async fn update_execution_status(
        &self,
        execution_id: &str,
        params: vertebrae_core::execution_service::UpdateExecutionStatusParams,
    ) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let execution = s.executions.get_mut(execution_id).ok_or_else(|| {
            ServiceError::validation_failed(format!("execution not found: {}", execution_id))
        })?;
        execution.status = params.status;
        if let Some(out) = params.output {
            execution.output = Some(out);
        }
        if let Some(model) = params.model {
            execution.model_used = Some(model);
        }
        if let Some(provider) = params.model_provider {
            execution.model_provider = Some(provider);
        }
        Ok(())
    }

    async fn orchestrate_task(&self, task_id: &str) -> ServiceResult<()> {
        let s = self.state.lock().unwrap();
        let task = s.tasks.values().find(|t| t.id == task_id).ok_or_else(|| {
            ServiceError::validation_failed(format!("task not found: {}", task_id))
        })?;
        if task.workflow_id.is_none() {
            return Err(ServiceError::validation_failed(format!(
                "Task {} has no workflow assigned",
                task_id
            )));
        }
        Ok(())
    }

    async fn stop_orchestrator(&self, _task_id: &str) -> ServiceResult<()> {
        Ok(())
    }

    async fn active_run(&self, task_id: &str) -> ServiceResult<Option<TaskRun>> {
        let s = self.state.lock().unwrap();
        Ok(active_run_for_task(&s, task_id))
    }

    async fn task_runs(&self, task_id: &str) -> ServiceResult<Vec<TaskRun>> {
        let s = self.state.lock().unwrap();
        let mut runs: Vec<TaskRun> = s
            .task_runs
            .values()
            .filter(|run| run.task_id == task_id)
            .cloned()
            .collect();
        runs.sort_by_key(|run| run.inserted_at);
        Ok(runs)
    }

    async fn task_run(&self, task_run_id: &str) -> ServiceResult<Option<TaskRun>> {
        let s = self.state.lock().unwrap();
        Ok(s.task_runs.get(task_run_id).cloned())
    }

    async fn task_run_trace(&self, root_task_run_id: &str) -> ServiceResult<TaskRunTrace> {
        let s = self.state.lock().unwrap();
        match s.task_runs.get(root_task_run_id) {
            Some(run)
                if run.parent_task_run_id.is_none()
                    && run
                        .root_task_run_id
                        .as_deref()
                        .is_none_or(|id| id == root_task_run_id) => {}
            Some(_) => {
                return Err(ServiceError::validation_failed(format!(
                    "task run trace must be requested by root TaskRun ID: {}",
                    root_task_run_id
                )));
            }
            None => {
                return Err(ServiceError::validation_failed(format!(
                    "task run not found: {}",
                    root_task_run_id
                )));
            }
        }
        let runs: Vec<TaskRun> = s
            .task_runs
            .values()
            .filter(|run| {
                run.id == root_task_run_id
                    || run.root_task_run_id.as_deref() == Some(root_task_run_id)
            })
            .cloned()
            .collect();
        if runs.is_empty() {
            return Err(ServiceError::validation_failed(format!(
                "task run not found: {}",
                root_task_run_id
            )));
        }
        let run_ids: HashSet<&str> = runs.iter().map(|run| run.id.as_str()).collect();
        let step_executions: Vec<StepExecution> = s
            .executions
            .values()
            .filter(|execution| {
                execution
                    .task_run_id
                    .as_ref()
                    .is_some_and(|id| run_ids.contains(id.as_str()))
            })
            .cloned()
            .collect();
        let session_logs = {
            let execution_ids: HashSet<&str> = step_executions
                .iter()
                .filter_map(|execution| execution.id.as_deref())
                .collect();
            s.logs
                .values()
                .filter(|log| execution_ids.contains(log.step_execution_id.as_str()))
                .cloned()
                .collect()
        };

        Ok(TaskRunTrace {
            root_task_run_id: root_task_run_id.to_string(),
            task_runs: runs,
            step_executions,
            session_logs,
        })
    }

    async fn run_workflow(&self, task_id: &str) -> ServiceResult<TaskRun> {
        let mut s = self.state.lock().unwrap();
        let has_workflow = s
            .tasks
            .get(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?
            .workflow_id
            .is_some();
        if !has_workflow {
            return Err(ServiceError::validation_failed(format!(
                "Task {} has no assigned workflow",
                task_id
            )));
        }

        let run_id = s.gen_id();
        let execution_id = s.gen_id();
        let now = Utc::now();
        let mut execution = StepExecution::new(task_id, "mock_workflow", "mock_step")
            .with_task_run_id(run_id.clone());
        execution.id = Some(execution_id.clone());
        s.executions.insert(execution_id.clone(), execution);

        let run = TaskRun {
            id: run_id.clone(),
            task_id: task_id.to_string(),
            project_id: "mock-project".to_string(),
            user_id: None,
            status: TaskRunStatus::Executing,
            started_at: Some(now),
            ended_at: None,
            stop_requested_at: None,
            latest_step_execution_id: Some(execution_id),
            outcome_kind: None,
            outcome_context: None,
            parent_task_run_id: None,
            root_task_run_id: None,
            triggered_by_step_execution_id: None,
            inserted_at: Some(now),
            updated_at: Some(now),
        };
        s.task_runs.insert(run_id, run.clone());
        sync_task_run_controls(&mut s, task_id);
        Ok(run)
    }

    async fn stop_run(&self, target: StopRunTarget) -> ServiceResult<Option<TaskRun>> {
        let mut s = self.state.lock().unwrap();
        let run_id = match target {
            StopRunTarget::TaskRunId(task_run_id) => Some(task_run_id),
            StopRunTarget::TaskId(task_id) => active_run_for_task(&s, &task_id).map(|run| run.id),
        };

        let Some(run_id) = run_id else {
            return Ok(None);
        };

        let now = Utc::now();
        let stopped = {
            let run = s.task_runs.get_mut(&run_id).ok_or_else(|| {
                ServiceError::validation_failed(format!("task run not found: {}", run_id))
            })?;
            run.status = TaskRunStatus::Stopping;
            run.stop_requested_at = Some(now);
            run.updated_at = Some(now);
            run.clone()
        };
        sync_task_run_controls(&mut s, &stopped.task_id);
        Ok(Some(stopped))
    }
}

// ============================================================================
// MockStepService
// ============================================================================

pub struct MockStepService {
    state: State,
}

impl MockStepService {
    fn new(state: State) -> Self {
        Self { state }
    }
}

#[async_trait]
impl StepService for MockStepService {
    async fn create_step(&self, step: &Step) -> ServiceResult<Step> {
        let mut s = self.state.lock().unwrap();
        let id = step.id.clone().unwrap_or_else(|| s.gen_id());
        let mut stored = step.clone();
        stored.id = Some(id.clone());
        s.steps.insert(id, stored.clone());
        Ok(stored)
    }
    async fn create_step_with_id(&self, id: &str, step: &Step) -> ServiceResult<Step> {
        let mut s = self.state.lock().unwrap();
        let mut stored = step.clone();
        stored.id = Some(id.to_string());
        s.steps.insert(id.to_string(), stored.clone());
        Ok(stored)
    }
    async fn get_step(&self, id: &str) -> ServiceResult<Option<Step>> {
        let s = self.state.lock().unwrap();
        Ok(s.steps.get(id).cloned())
    }
    async fn step_exists(&self, id: &str) -> ServiceResult<bool> {
        let s = self.state.lock().unwrap();
        Ok(s.steps.contains_key(id))
    }
    async fn resolve_short_id(
        &self,
        prefix: &str,
        workflow_id: Option<&str>,
    ) -> ServiceResult<String> {
        let s = self.state.lock().unwrap();
        let prefix_lower = prefix.to_lowercase();
        let matches: Vec<String> = s
            .steps
            .iter()
            .filter(|(_, step)| match workflow_id {
                Some(wf) => step.workflow_id == wf,
                None => true,
            })
            .filter(|(id, _)| id.to_lowercase().starts_with(&prefix_lower))
            .map(|(id, _)| id.clone())
            .collect();
        match matches.len() {
            0 => Err(ServiceError::validation_failed(format!(
                "step with prefix '{}' not found",
                prefix
            ))),
            1 => Ok(matches.into_iter().next().unwrap()),
            _ => Err(ServiceError::validation_failed(format!(
                "ambiguous prefix '{}': multiple steps match: {}",
                prefix,
                matches.join(", ")
            ))),
        }
    }
    async fn get_step_by_id(&self, id: &str) -> ServiceResult<Option<Step>> {
        let s = self.state.lock().unwrap();
        Ok(s.steps.get(id).cloned())
    }
    async fn list_steps_for_workflow(&self, workflow_id: &str) -> ServiceResult<Vec<Step>> {
        let s = self.state.lock().unwrap();
        Ok(s.steps
            .values()
            .filter(|step| step.workflow_id == workflow_id)
            .cloned()
            .collect())
    }
    async fn update_step(&self, id: &str, _updates: &StepUpdate) -> ServiceResult<String> {
        let s = self.state.lock().unwrap();
        let step = s
            .steps
            .get(id)
            .ok_or_else(|| ServiceError::validation_failed(format!("Step not found: {}", id)))?;
        Ok(step.workflow_id.clone())
    }
    async fn delete_step(&self, id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        s.steps.remove(id);
        Ok(())
    }
    async fn get_initial_step(&self, workflow_id: &str) -> ServiceResult<Option<Step>> {
        let s = self.state.lock().unwrap();
        Ok(s.steps
            .values()
            .filter(|step| step.workflow_id == workflow_id)
            .min_by_key(|step| step.order)
            .cloned())
    }
    async fn get_transitions(&self, _step_id: &str) -> ServiceResult<Vec<Step>> {
        Ok(vec![])
    }
    async fn get_final_steps(&self, workflow_id: &str) -> ServiceResult<Vec<Step>> {
        let s = self.state.lock().unwrap();
        Ok(s.steps
            .values()
            .filter(|step| step.workflow_id == workflow_id && step.is_final)
            .cloned()
            .collect())
    }
    async fn list_all_steps(&self) -> ServiceResult<Vec<Step>> {
        let s = self.state.lock().unwrap();
        Ok(s.steps.values().cloned().collect())
    }
}

// ============================================================================
// Factory function
// ============================================================================

/// Create a `VertebraeServices` instance backed by in-memory mocks.
pub fn mock_services() -> VertebraeServices {
    let state: State = Arc::new(Mutex::new(MockState::default()));
    VertebraeServices::from_services(
        Arc::new(MockTaskService::new(state.clone())),
        Arc::new(MockWorkflowService::new(state.clone())),
        Arc::new(MockExecutionService::new(state.clone())),
        Arc::new(MockStepService::new(state)),
    )
}
