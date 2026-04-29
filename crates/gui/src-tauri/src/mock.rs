//! In-memory mock implementations of service traits for GUI command testing.
//!
//! These mocks store data in `Arc<Mutex<...>>` collections, providing realistic
//! behavior for testing Tauri commands without a remote backend.

use async_trait::async_trait;
use chrono::Utc;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use vertebrae_core::error::{ServiceError, ServiceResult};
use vertebrae_core::execution_service::ExecutionService;
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
    logs: HashMap<String, SessionLog>,
    steps: HashMap<String, Step>,
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
            needs_human_review: if options.needs_review {
                Some(true)
            } else {
                None
            },
            archived: false,
            worktree: None,
            revision_feedback: None,
            rejection_reason: None,
            review_comment: None,
            workflow_id: None,
            current_step_id: None,
            parent_id: None,
            dependency_ids: vec![],
            workflow_name: None,
            step_name: None,
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
        if let Some(review) = options.needs_human_review {
            task.needs_human_review = Some(review);
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

    async fn start_step(&self, task_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?;
        task.updated_at = Some(Utc::now());
        Ok(())
    }

    async fn complete_step(&self, task_id: &str) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?;
        task.updated_at = Some(Utc::now());
        Ok(())
    }

    async fn reject_step(
        &self,
        task_id: &str,
        _target_step_id: &str,
        _feedback: Option<&str>,
    ) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| ServiceError::task_not_found(task_id))?;
        task.updated_at = Some(Utc::now());
        Ok(())
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

    async fn add_section(&self, id: &str, section: Section) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        task.sections.push(section);
        Ok(())
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
    ) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        for sec in &mut task.sections {
            if sec.section_type == section_type && sec.order == Some(ordinal) {
                sec.content = new_content.to_string();
                return Ok(());
            }
        }
        Err(ServiceError::validation_failed("Section not found"))
    }

    async fn remove_section_by_ordinal(
        &self,
        id: &str,
        section_type: SectionType,
        ordinal: u32,
    ) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        task.sections
            .retain(|s| !(s.section_type == section_type && s.order == Some(ordinal)));
        Ok(())
    }

    async fn mark_checklist_item_done(&self, id: &str, section_order: u32) -> ServiceResult<()> {
        let mut s = self.state.lock().unwrap();
        let task = s
            .tasks
            .get_mut(id)
            .ok_or_else(|| ServiceError::task_not_found(id))?;
        for sec in &mut task.sections {
            if sec.section_type == SectionType::ChecklistItem && sec.order == Some(section_order) {
                sec.mark_done();
                return Ok(());
            }
        }
        Ok(())
    }

    async fn toggle_checklist_item_done(&self, id: &str, ordinal: u32) -> ServiceResult<()> {
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
                return Ok(());
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
            auto_advance: options.auto_advance,
            order: options.order,
            is_default: options.is_default,
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
        if let Some(auto_advance) = options.auto_advance {
            wf.auto_advance = auto_advance;
        }
        if let Some(is_default) = options.is_default {
            wf.is_default = is_default;
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
    async fn update_step(&self, id: &str, _updates: &StepUpdate) -> ServiceResult<()> {
        let s = self.state.lock().unwrap();
        if s.steps.contains_key(id) {
            Ok(())
        } else {
            Err(ServiceError::task_not_found(id))
        }
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
