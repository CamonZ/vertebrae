//! Tauri commands for task and workflow data access
//!
//! Implements list_tasks, get_task, get_task_hierarchy, and workflow commands
//! using the vertebrae-core TaskService layer.

use crate::project_config::{ProjectConfig, SavedProject};
use crate::types::{
    SessionLog, Step, StepExecution, TaskFilterOptions, TaskHierarchyNode, TaskSummary,
    TaskWithRelations, Workflow, WorkflowWithTasks,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::RwLock;
use vertebrae_core::{DefaultTaskService, DefaultWorkflowService, TaskService, WorkflowService};

/// Application state holding the task service
pub struct AppState {
    /// Task service (None until a project is selected)
    pub service: RwLock<Option<DefaultTaskService>>,
    /// Project configuration manager
    pub project_config: ProjectConfig,
}

/// Error response type for commands - simple string wrapper with specta support
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CommandError {
    pub message: String,
}

impl From<vertebrae_db::DbError> for CommandError {
    fn from(err: vertebrae_db::DbError) -> Self {
        CommandError {
            message: err.to_string(),
        }
    }
}

impl From<vertebrae_core::ServiceError> for CommandError {
    fn from(err: vertebrae_core::ServiceError) -> Self {
        CommandError {
            message: err.to_string(),
        }
    }
}

impl CommandError {
    pub fn task_not_found(id: &str) -> Self {
        CommandError {
            message: format!("Task not found: {}", id),
        }
    }

    pub fn workflow_not_found(id: &str) -> Self {
        CommandError {
            message: format!("Workflow not found: {}", id),
        }
    }

    pub fn no_project_selected() -> Self {
        CommandError {
            message: "No project selected. Please select a project first.".to_string(),
        }
    }
}

// ============================================================================
// Project Management Commands
// ============================================================================

/// Get the list of saved projects
#[tauri::command]
#[specta::specta]
pub async fn get_projects(state: State<'_, AppState>) -> Result<Vec<SavedProject>, CommandError> {
    log::info!("get_projects called");
    Ok(state.project_config.get_projects())
}

/// Add a project to the saved list
///
/// If the project doesn't have a vtb database, one will be initialized.
#[tauri::command]
#[specta::specta]
pub async fn add_project(
    state: State<'_, AppState>,
    name: String,
    path: String,
) -> Result<SavedProject, CommandError> {
    log::info!("add_project called with name: {}, path: {}", name, path);

    // Add to config
    let mut project = state
        .project_config
        .add_project(name, path.clone())
        .map_err(|e| CommandError { message: e })?;

    // Initialize database if it doesn't exist
    if !project.has_database {
        log::info!("Initializing database at: {}", path);
        ProjectConfig::init_database(&path)
            .await
            .map_err(|e| CommandError { message: e })?;
        project.has_database = true;
    }

    Ok(project)
}

/// Remove a project from the saved list
#[tauri::command]
#[specta::specta]
pub async fn remove_project(state: State<'_, AppState>, path: String) -> Result<(), CommandError> {
    log::info!("remove_project called with path: {}", path);
    state
        .project_config
        .remove_project(&path)
        .map_err(|e| CommandError { message: e })
}

/// Get the currently selected project path
#[tauri::command]
#[specta::specta]
pub async fn get_current_project(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    log::info!("get_current_project called");
    Ok(state.project_config.get_current_project())
}

/// Set the current project and connect to its database
#[tauri::command]
#[specta::specta]
pub async fn set_current_project(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<(), CommandError> {
    log::info!("set_current_project called with path: {:?}", path);

    // Update config
    state
        .project_config
        .set_current_project(path.clone())
        .map_err(|e| CommandError { message: e })?;

    // Connect to database and create service if a project is selected
    if let Some(project_path) = path {
        let db_path = std::path::PathBuf::from(&project_path).join(".vtb/data");
        log::info!("Connecting to database at: {:?}", db_path);

        let db = vertebrae_db::Database::connect(&db_path)
            .await
            .map_err(|e| CommandError {
                message: format!("Failed to connect to database: {}", e),
            })?;

        db.init().await.map_err(|e| CommandError {
            message: format!("Failed to initialize database: {}", e),
        })?;

        let service = DefaultTaskService::new(db);
        let mut service_lock = state.service.write().await;
        *service_lock = Some(service);
    } else {
        let mut service_lock = state.service.write().await;
        *service_lock = None;
    }

    Ok(())
}

/// Check if a project is currently selected and database is connected
#[tauri::command]
#[specta::specta]
pub async fn has_project_selected(state: State<'_, AppState>) -> Result<bool, CommandError> {
    let service_lock = state.service.read().await;
    Ok(service_lock.is_some())
}

/// List tasks with optional filters
///
/// Returns a list of task summaries matching the filter criteria.
#[tauri::command]
#[specta::specta]
pub async fn list_tasks(
    state: State<'_, AppState>,
    filter: Option<TaskFilterOptions>,
) -> Result<Vec<TaskSummary>, CommandError> {
    log::info!("list_tasks called with filter: {:?}", filter);
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let db_filter: vertebrae_db::TaskFilter = filter.unwrap_or_default().into();
    match service.list_tasks(&db_filter).await {
        Ok(summaries) => {
            log::info!("list_tasks returned {} tasks", summaries.len());
            Ok(summaries.into_iter().map(Into::into).collect())
        }
        Err(e) => {
            log::error!("list_tasks error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Get a single task by ID with its relations
///
/// Returns the full task details along with parent, children, and dependency relations.
#[tauri::command]
#[specta::specta]
pub async fn get_task(
    state: State<'_, AppState>,
    id: String,
) -> Result<TaskWithRelations, CommandError> {
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Get the task with relations using the service
    let task_with_relations = service.get_task_with_relations(&id).await?;

    Ok(TaskWithRelations {
        task: task_with_relations.task.into(),
        parent_id: task_with_relations.parent_id,
        children_ids: task_with_relations.children_ids,
        depends_on_ids: task_with_relations.depends_on_ids,
        dependent_ids: task_with_relations.dependent_ids,
    })
}

/// Get task hierarchy starting from a root task
///
/// Returns a tree structure of tasks starting from the given root.
/// If no root_id is provided, returns all root-level tasks with their hierarchies.
#[tauri::command]
#[specta::specta]
pub async fn get_task_hierarchy(
    state: State<'_, AppState>,
    root_id: Option<String>,
    filter: Option<TaskFilterOptions>,
) -> Result<Vec<TaskHierarchyNode>, CommandError> {
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Convert filter options to db filter, applying all fields (statuses, levels, workflow_id, etc.)
    let db_filter: vertebrae_db::TaskFilter = match filter {
        Some(opts) => opts.into(),
        None => vertebrae_db::TaskFilter::new().include_done(),
    };

    let tree_options = vertebrae_core::TreeFilterOptions::new(db_filter);
    let tree = service.get_task_tree(&tree_options).await?;

    match root_id {
        Some(id) => {
            // Find the specific node in the tree
            fn find_node(
                nodes: &[vertebrae_core::TaskTreeNode],
                id: &str,
            ) -> Option<TaskHierarchyNode> {
                for node in nodes {
                    if node.id == id {
                        return Some(convert_tree_node(node));
                    }
                    if let Some(found) = find_node(&node.children, id) {
                        return Some(found);
                    }
                }
                None
            }

            match find_node(&tree, &id) {
                Some(node) => Ok(vec![node]),
                None => Err(CommandError::task_not_found(&id)),
            }
        }
        None => {
            // Return all root nodes converted to TaskHierarchyNode, sorted by newest first
            let mut nodes: Vec<TaskHierarchyNode> = tree.iter().map(convert_tree_node).collect();
            nodes.sort_by(|a, b| b.task.created_at.cmp(&a.task.created_at));
            Ok(nodes)
        }
    }
}

/// Helper function to convert TaskTreeNode to TaskHierarchyNode
/// Children are sorted by created_at descending (newest first)
fn convert_tree_node(node: &vertebrae_core::TaskTreeNode) -> TaskHierarchyNode {
    let mut children: Vec<TaskHierarchyNode> =
        node.children.iter().map(convert_tree_node).collect();
    children.sort_by(|a, b| b.task.created_at.cmp(&a.task.created_at));

    TaskHierarchyNode {
        task: TaskSummary {
            id: node.id.clone(),
            title: node.title.clone(),
            level: node.level.clone().into(),
            status: node.status.clone(),
            priority: node.priority.clone().map(Into::into),
            tags: node.tags.clone(),
            needs_human_review: node.needs_human_review,
            created_at: node.created_at.to_rfc3339(),
            workflow_name: node.workflow_name.clone(),
            step_name: node.step_name.clone(),
        },
        children,
    }
}

// ============================================================================
// Workflow Commands
// ============================================================================

/// List all workflows
///
/// Returns a list of all workflows in the database.
#[tauri::command]
#[specta::specta]
pub async fn list_workflows(state: State<'_, AppState>) -> Result<Vec<Workflow>, CommandError> {
    log::info!("list_workflows called");
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    #[allow(deprecated)]
    let db = service.database();
    let workflow_service = DefaultWorkflowService::new(db.clone());

    match workflow_service.list_workflows().await {
        Ok(summaries) => {
            log::info!("list_workflows returned {} workflows", summaries.len());
            // Convert summaries to full workflows for display
            // For now, we'll fetch the full workflows from the database if needed
            let mut workflows = Vec::new();
            for summary in summaries {
                if let Ok(workflow) = workflow_service.get_workflow(&summary.id).await {
                    workflows.push(workflow.into());
                }
            }
            Ok(workflows)
        }
        Err(e) => {
            log::error!("list_workflows error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Get a single workflow by ID
///
/// Returns the full workflow details including steps.
#[tauri::command]
#[specta::specta]
pub async fn get_workflow(
    state: State<'_, AppState>,
    id: String,
) -> Result<Workflow, CommandError> {
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    #[allow(deprecated)]
    let db = service.database();
    let workflow_service = DefaultWorkflowService::new(db.clone());

    let workflow = workflow_service.get_workflow(&id).await?;

    Ok(workflow.into())
}

/// List all workflow transitions
///
/// Returns all defined transitions between workflows, including workflow names.
#[tauri::command]
#[specta::specta]
pub async fn list_workflow_transitions(
    state: State<'_, AppState>,
) -> Result<Vec<crate::types::WorkflowTransition>, CommandError> {
    log::info!("list_workflow_transitions called");
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    #[allow(deprecated)]
    let db = service.database();
    let workflow_service = DefaultWorkflowService::new(db.clone());

    // Get all transitions
    let transitions = workflow_service.list_workflow_transitions(None).await?;

    // Build a cache of workflow names
    let workflows = workflow_service.list_workflows().await?;
    let workflow_names: std::collections::HashMap<String, String> = workflows
        .into_iter()
        .map(|w| (w.id.clone(), w.name))
        .collect();

    // Convert to GUI type with workflow names
    let result: Vec<crate::types::WorkflowTransition> = transitions
        .into_iter()
        .map(|t| {
            let from_id = t.from_workflow.id.to_raw();
            let to_id = t.to_workflow.id.to_raw();
            crate::types::WorkflowTransition {
                id: t.id.map(|thing| thing.id.to_raw()),
                from_workflow_id: from_id.clone(),
                from_workflow_name: workflow_names
                    .get(&from_id)
                    .cloned()
                    .unwrap_or_else(|| from_id.clone()),
                to_workflow_id: to_id.clone(),
                to_workflow_name: workflow_names
                    .get(&to_id)
                    .cloned()
                    .unwrap_or_else(|| to_id.clone()),
                label: t.label,
                target_step_id: t.target_step.map(|s| s.id.to_raw()),
            }
        })
        .collect();

    log::info!(
        "list_workflow_transitions returned {} transitions",
        result.len()
    );
    Ok(result)
}

/// Get a workflow with its associated tasks
///
/// Returns the workflow along with all tasks that reference this workflow.
#[tauri::command]
#[specta::specta]
pub async fn get_workflow_with_tasks(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowWithTasks, CommandError> {
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    #[allow(deprecated)]
    let db = service.database();
    let workflow_service = DefaultWorkflowService::new(db.clone());

    // Get the workflow
    let workflow = workflow_service.get_workflow(&id).await?;

    // Get tasks associated with this workflow using the service
    let filter = vertebrae_db::TaskFilter::new().include_done();
    let all_tasks = service.list_tasks(&filter).await?;

    // Filter tasks that have this workflow_id
    // Tasks store workflow_id as Thing, so we need to match the id portion
    let workflow_id_str = workflow
        .id
        .as_ref()
        .map(|t| t.id.to_raw())
        .unwrap_or_default();

    // We need to get full tasks to check workflow_id since TaskSummary doesn't include it
    let mut tasks = Vec::new();
    for summary in all_tasks {
        if let Ok(task) = service.get_task(&summary.id).await {
            if let Some(ref wf_id) = task.workflow_id {
                if wf_id.id.to_raw() == workflow_id_str {
                    tasks.push(summary.into());
                }
            }
        }
    }

    Ok(WorkflowWithTasks {
        workflow: workflow.into(),
        tasks,
    })
}

/// Get a workflow with its associated tasks including full details and relations
///
/// Returns the workflow along with all tasks that reference this workflow,
/// including full task details (sections, refs) and relations (parent, children, dependencies).
/// Uses optimized single-query database access via graph traversal.
#[tauri::command]
#[specta::specta]
pub async fn get_workflow_with_task_details(
    state: State<'_, AppState>,
    id: String,
) -> Result<crate::types::WorkflowWithTaskDetails, CommandError> {
    log::info!(
        "[get_workflow_with_task_details] Starting for workflow: {}",
        id
    );
    let start_time = std::time::Instant::now();

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    #[allow(deprecated)]
    let db = service.database();
    let workflow_service = DefaultWorkflowService::new(db.clone());

    // Get the workflow
    let wf_start = std::time::Instant::now();
    let workflow = workflow_service.get_workflow(&id).await?;
    log::info!(
        "[get_workflow_with_task_details] get_workflow took {}ms",
        wf_start.elapsed().as_millis()
    );

    // Get the workflow_id string for filtering
    let workflow_id_str = workflow
        .id
        .as_ref()
        .map(|t| t.id.to_raw())
        .unwrap_or_default();

    // Query tasks with relations in a single optimized query
    let query_start = std::time::Instant::now();
    let filter = vertebrae_db::TaskFilter::new()
        .include_done()
        .with_workflow_id(workflow_id_str);
    let tasks_with_relations_data = db.list_tasks().list_with_relations(&filter).await?;
    log::info!(
        "[get_workflow_with_task_details] Fetched {} tasks with relations in {}ms",
        tasks_with_relations_data.len(),
        query_start.elapsed().as_millis()
    );

    // Convert TaskWithRelationsData to TaskWithRelations for the GUI
    let convert_start = std::time::Instant::now();
    let mut tasks = Vec::new();
    for data in tasks_with_relations_data {
        // Reconstruct sections and refs from JSON
        let sections: Vec<vertebrae_db::Section> = data
            .sections
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();

        let code_refs: Vec<vertebrae_db::CodeRef> = data
            .refs
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();

        // Construct Task object
        // Note: status is now derived from workflow step, not stored
        let task = vertebrae_db::Task {
            id: Some(surrealdb::sql::Thing::from((
                "task".to_string(),
                data.id.clone(),
            ))),
            title: data.title,
            description: data.description,
            level: data.level,
            priority: data.priority,
            tags: data.tags,
            created_at: Some(data.created_at),
            updated_at: None,
            started_at: None,
            completed_at: None,
            sections,
            code_refs,
            needs_human_review: data.needs_human_review,
            revision_feedback: None,
            rejection_reason: None,
            workflow_id: data
                .workflow_id
                .map(|id| surrealdb::sql::Thing::from(("workflow".to_string(), id))),
            current_step_id: data
                .current_step_id
                .map(|id| surrealdb::sql::Thing::from(("step".to_string(), id))),
        };

        tasks.push(TaskWithRelations {
            task: task.into(),
            parent_id: data.parent_id,
            children_ids: data.children_ids,
            depends_on_ids: data.depends_on_ids,
            dependent_ids: data.dependent_ids,
        });
    }
    log::info!(
        "[get_workflow_with_task_details] Converted {} tasks to GUI types in {}ms",
        tasks.len(),
        convert_start.elapsed().as_millis()
    );

    log::info!(
        "[get_workflow_with_task_details] Total time: {}ms",
        start_time.elapsed().as_millis()
    );

    Ok(crate::types::WorkflowWithTaskDetails {
        workflow: workflow.into(),
        tasks,
    })
}

// ============================================================================
// Execution Commands
// ============================================================================

/// Get all step executions for a task
///
/// Returns a chronological list of all step executions for the given task.
/// This shows how the task has progressed through workflow steps over time.
#[tauri::command]
#[specta::specta]
pub async fn get_task_executions(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Vec<StepExecution>, CommandError> {
    log::info!("get_task_executions called for task: {}", task_id);
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service
        .database()
        .executions()
        .list_executions_for_task(&task_id)
        .await
    {
        Ok(executions) => {
            log::info!(
                "get_task_executions returned {} executions",
                executions.len()
            );
            Ok(executions.into_iter().map(Into::into).collect())
        }
        Err(e) => {
            log::error!("get_task_executions error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Get all session logs for a step execution
///
/// Returns a chronological list of all session logs for the given execution.
/// This shows the content recorded during the step execution.
#[tauri::command]
#[specta::specta]
pub async fn get_execution_logs(
    state: State<'_, AppState>,
    execution_id: String,
) -> Result<Vec<SessionLog>, CommandError> {
    log::info!("get_execution_logs called for execution: {}", execution_id);
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service
        .database()
        .executions()
        .list_logs_for_execution(&execution_id)
        .await
    {
        Ok(logs) => {
            log::info!("get_execution_logs returned {} logs", logs.len());
            Ok(logs.into_iter().map(Into::into).collect())
        }
        Err(e) => {
            log::error!("get_execution_logs error: {:?}", e);
            Err(e.into())
        }
    }
}

// ============================================================================
// Step Commands (First-Class Workflow Steps)
// ============================================================================

/// List all steps for a workflow
///
/// Returns all first-class Step entities associated with the given workflow ID.
#[tauri::command]
#[specta::specta]
pub async fn list_steps_for_workflow(
    state: State<'_, AppState>,
    workflow_id: String,
) -> Result<Vec<Step>, CommandError> {
    log::info!(
        "list_steps_for_workflow called for workflow: {}",
        workflow_id
    );
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    #[allow(deprecated)]
    let db = service.database();
    let workflow_thing = surrealdb::sql::Thing::from(("workflow", workflow_id.as_str()));

    match db.steps().list_by_workflow(&workflow_thing).await {
        Ok(steps) => {
            log::info!("list_steps_for_workflow returned {} steps", steps.len());
            Ok(steps.into_iter().map(Into::into).collect())
        }
        Err(e) => {
            log::error!("list_steps_for_workflow error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Get a single step by ID
///
/// Returns the Step entity with the given ID.
#[tauri::command]
#[specta::specta]
pub async fn get_step(
    state: State<'_, AppState>,
    step_id: String,
) -> Result<Option<Step>, CommandError> {
    log::info!("get_step called for step: {}", step_id);
    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    #[allow(deprecated)]
    let db = service.database();

    match db.steps().get(&step_id).await {
        Ok(step) => {
            log::info!("get_step returned: {:?}", step.is_some());
            Ok(step.map(Into::into))
        }
        Err(e) => {
            log::error!("get_step error: {:?}", e);
            Err(e.into())
        }
    }
}

// ============================================================================
// Workflow Execution Commands
// ============================================================================

/// Start a workflow execution for a task
#[tauri::command]
#[specta::specta]
pub async fn run_workflow(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), CommandError> {
    log::info!("run_workflow called for task: {}", task_id);

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Verify task has a workflow assigned
    let task = service
        .get_task(&task_id)
        .await
        .map_err(CommandError::from)?;

    if task.workflow_id.is_none() {
        return Err(CommandError {
            message: format!("Task {} has no assigned workflow", task_id),
        });
    }

    // Spawn execution in background
    let db = service.database().clone();
    let task_id_clone = task_id.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            crate::workflow_runner::execute_workflow(task_id_clone, db, app_handle).await
        {
            log::error!("Workflow execution failed: {}", e);
        }
    });

    log::info!("Workflow execution started for task: {}", task_id);
    Ok(())
}

// ============================================================================
// PTY Commands
// ============================================================================

/// Create a new PTY session with the user's default shell
///
/// Returns the session ID on success. The PTY will emit PtyOutputEvent for output
/// and PtyExitEvent when the session ends.
#[tauri::command]
#[specta::specta]
pub async fn create_pty_session(
    pty_manager: State<'_, crate::pty_manager::PtyManager>,
    app_handle: tauri::AppHandle,
    session_id: String,
    cols: u16,
    rows: u16,
    working_dir: Option<String>,
) -> Result<(), crate::pty_manager::PtyError> {
    log::info!(
        "create_pty_session called: session_id={}, cols={}, rows={}, working_dir={:?}",
        session_id,
        cols,
        rows,
        working_dir
    );

    pty_manager
        .spawn_shell_pty(session_id, cols, rows, working_dir, app_handle)
        .await
}

/// Write data to a PTY session
///
/// The data should be base64-encoded bytes.
#[tauri::command]
#[specta::specta]
pub async fn write_pty(
    pty_manager: State<'_, crate::pty_manager::PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), crate::pty_manager::PtyError> {
    use base64::Engine;
    let decoder = base64::engine::general_purpose::STANDARD;

    let bytes = decoder
        .decode(&data)
        .map_err(|e| crate::pty_manager::PtyError::WriteFailed(format!("Invalid base64: {}", e)))?;

    pty_manager.write_to_pty(&session_id, &bytes).await
}

/// Resize a PTY session
#[tauri::command]
#[specta::specta]
pub async fn resize_pty(
    pty_manager: State<'_, crate::pty_manager::PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), crate::pty_manager::PtyError> {
    log::info!(
        "resize_pty called: session_id={}, cols={}, rows={}",
        session_id,
        cols,
        rows
    );
    pty_manager.resize_pty(&session_id, cols, rows).await
}

/// Close a PTY session
#[tauri::command]
#[specta::specta]
pub async fn close_pty_session(
    pty_manager: State<'_, crate::pty_manager::PtyManager>,
    session_id: String,
) -> Result<(), crate::pty_manager::PtyError> {
    log::info!("close_pty_session called: session_id={}", session_id);
    pty_manager.close_session(&session_id).await
}

// ============================================================================
// Chat Session Management Commands
// ============================================================================

/// Create a new chat session
#[tauri::command]
#[specta::specta]
pub async fn create_chat_session(
    state: State<'_, AppState>,
    working_dir: Option<String>,
) -> Result<crate::types::ChatSession, CommandError> {
    log::info!(
        "create_chat_session called with working_dir: {:?}",
        working_dir
    );

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let db_session = vertebrae_db::ChatSession::new(working_dir);
    let created = service
        .database()
        .chat_sessions()
        .create_session(&db_session)
        .await?;

    Ok(created.into())
}

/// Get a chat session by ID
#[tauri::command]
#[specta::specta]
pub async fn get_chat_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<crate::types::ChatSession>, CommandError> {
    log::info!("get_chat_session called with session_id: {}", session_id);

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let session = service
        .database()
        .chat_sessions()
        .get_session(&session_id)
        .await?;

    Ok(session.map(|s| s.into()))
}

/// List chat sessions (most recent first)
#[tauri::command]
#[specta::specta]
pub async fn list_chat_sessions(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<crate::types::ChatSession>, CommandError> {
    log::info!("list_chat_sessions called with limit: {:?}", limit);

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let sessions = service
        .database()
        .chat_sessions()
        .list_sessions(limit.map(|l| l as usize))
        .await?;

    Ok(sessions.into_iter().map(|s| s.into()).collect())
}

/// End a chat session
#[tauri::command]
#[specta::specta]
pub async fn end_chat_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), CommandError> {
    log::info!("end_chat_session called with session_id: {}", session_id);

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let ended_at = chrono::Utc::now();
    service
        .database()
        .chat_sessions()
        .end_session(&session_id, ended_at)
        .await?;

    Ok(())
}

/// Update chat session title
#[tauri::command]
#[specta::specta]
pub async fn update_chat_session_title(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<(), CommandError> {
    log::info!(
        "update_chat_session_title called with session_id: {}, title: {}",
        session_id,
        title
    );

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .database()
        .chat_sessions()
        .update_title(&session_id, &title)
        .await?;

    Ok(())
}

/// Add a message to a chat session
#[tauri::command]
#[specta::specta]
pub async fn add_chat_message(
    state: State<'_, AppState>,
    session_id: String,
    content: String,
) -> Result<String, CommandError> {
    log::debug!(
        "add_chat_message called with session_id: {}, content length: {}",
        session_id,
        content.len()
    );

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let session_thing = surrealdb::sql::Thing::from(("chat_session", session_id.as_str()));
    let message = vertebrae_db::ChatMessage::new(session_thing, content);
    let id = service
        .database()
        .chat_sessions()
        .add_message(&message)
        .await?;

    Ok(id)
}

/// Get all messages for a chat session
#[tauri::command]
#[specta::specta]
pub async fn get_chat_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<crate::types::ChatMessage>, CommandError> {
    log::info!("get_chat_messages called with session_id: {}", session_id);

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let messages = service
        .database()
        .chat_sessions()
        .list_messages(&session_id)
        .await?;

    Ok(messages.into_iter().map(|m| m.into()).collect())
}

/// Get all message content concatenated for session replay
#[tauri::command]
#[specta::specta]
pub async fn get_chat_session_content(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, CommandError> {
    log::info!(
        "get_chat_session_content called with session_id: {}",
        session_id
    );

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let content = service
        .database()
        .chat_sessions()
        .get_session_content(&session_id)
        .await?;

    Ok(content)
}

/// Delete a chat session and all its messages
#[tauri::command]
#[specta::specta]
pub async fn delete_chat_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), CommandError> {
    log::info!("delete_chat_session called with session_id: {}", session_id);

    let guard = state.service.read().await;
    let service = guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .database()
        .chat_sessions()
        .delete_session(&session_id)
        .await?;

    Ok(())
}

// ============================================================================
// Task Relationship Commands
// ============================================================================

/// Set the parent task
///
/// Sets the parent of the given task. If the task already has a parent, it will be replaced.
/// Validates that both tasks exist.
#[tauri::command]
#[specta::specta]
pub async fn set_parent(
    state: State<'_, AppState>,
    task_id: String,
    parent_id: String,
) -> Result<(), CommandError> {
    log::info!(
        "set_parent called with task_id: {}, parent_id: {}",
        task_id,
        parent_id
    );

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.set_parent(&task_id, &parent_id).await?;

    log::info!("Successfully set parent for task {}", task_id);
    Ok(())
}

/// Remove the parent task
///
/// Removes the parent relationship from the given task, making it a root task.
#[tauri::command]
#[specta::specta]
pub async fn remove_parent(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), CommandError> {
    log::info!("remove_parent called with task_id: {}", task_id);

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.remove_parent(&task_id).await?;

    log::info!("Successfully removed parent for task {}", task_id);
    Ok(())
}

/// Add a dependency relationship
///
/// Makes the given task depend on another task (the task is blocked by the dependency).
/// Validates that both tasks exist and that adding the dependency won't create a cycle.
#[tauri::command]
#[specta::specta]
pub async fn add_dependency(
    state: State<'_, AppState>,
    task_id: String,
    depends_on_id: String,
) -> Result<(), CommandError> {
    log::info!(
        "add_dependency called with task_id: {}, depends_on_id: {}",
        task_id,
        depends_on_id
    );

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.add_dependency(&task_id, &depends_on_id).await?;

    log::info!("Successfully added dependency for task {}", task_id);
    Ok(())
}

/// Remove a dependency relationship
///
/// Removes a dependency from the given task (the task is no longer blocked by this dependency).
#[tauri::command]
#[specta::specta]
pub async fn remove_dependency(
    state: State<'_, AppState>,
    task_id: String,
    depends_on_id: String,
) -> Result<(), CommandError> {
    log::info!(
        "remove_dependency called with task_id: {}, depends_on_id: {}",
        task_id,
        depends_on_id
    );

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.remove_dependency(&task_id, &depends_on_id).await?;

    log::info!("Successfully removed dependency for task {}", task_id);
    Ok(())
}

// ============================================================================
// Task Mutation Commands (Create, Update, Assign Workflow)
// ============================================================================

/// Create a new task with the given title, optional description, level, and parent task
///
/// Returns the ID of the newly created task.
/// Validates that parent task exists if specified.
#[tauri::command]
#[specta::specta]
pub async fn create_task(
    state: State<'_, AppState>,
    title: String,
    description: Option<String>,
    level: Option<String>,
    parent_id: Option<String>,
) -> Result<String, CommandError> {
    log::info!(
        "create_task called with title: '{}', parent: {:?}",
        title,
        parent_id
    );

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse level if provided
    let parsed_level = if let Some(level_str) = level {
        match level_str.to_lowercase().as_str() {
            "epic" => Some(vertebrae_db::Level::Epic),
            "ticket" => Some(vertebrae_db::Level::Ticket),
            "task" => Some(vertebrae_db::Level::Task),
            _ => {
                return Err(CommandError {
                    message: format!("Invalid level: {}", level_str),
                })
            }
        }
    } else {
        None
    };

    // Build creation options
    let mut options = vertebrae_core::CreateTaskOptions::new(title);
    if let Some(desc) = description {
        options = options.with_description(desc);
    }
    if let Some(lv) = parsed_level {
        options = options.with_level(lv);
    }
    if let Some(parent) = parent_id {
        options.parent_id = Some(parent);
    }

    let task_id = service.create_task(options).await?;
    log::info!("Successfully created task with ID: {}", task_id);
    Ok(task_id)
}

/// Update task fields like title, description, and priority
///
/// Specify only the fields you want to update. Omitted fields remain unchanged.
#[tauri::command]
#[specta::specta]
pub async fn update_task(
    state: State<'_, AppState>,
    task_id: String,
    title: Option<String>,
    description: Option<Option<String>>,
    priority: Option<Option<String>>,
) -> Result<(), CommandError> {
    log::info!(
        "update_task called with task_id: '{}', title: {:?}",
        task_id,
        title
    );

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Build update options
    let mut options = vertebrae_core::UpdateTaskOptions::new();

    if let Some(new_title) = title {
        options = options.with_title(new_title);
    }

    if let Some(new_desc) = description {
        options.description = Some(new_desc);
    }

    if let Some(new_priority) = priority {
        options.priority = Some(new_priority.map(|p| {
            match p.to_lowercase().as_str() {
                "high" => vertebrae_db::Priority::High,
                "medium" => vertebrae_db::Priority::Medium,
                "low" => vertebrae_db::Priority::Low,
                _ => vertebrae_db::Priority::Medium, // Default to medium if invalid
            }
        }));
    }

    service.update_task(&task_id, options).await?;
    log::info!("Successfully updated task: {}", task_id);
    Ok(())
}

/// Assign a workflow to a task
///
/// Associates the given workflow with the task for workflow state management.
#[tauri::command]
#[specta::specta]
pub async fn assign_workflow(
    state: State<'_, AppState>,
    task_id: String,
    workflow_id: String,
) -> Result<(), CommandError> {
    log::info!(
        "assign_workflow called with task_id: '{}', workflow_id: '{}'",
        task_id,
        workflow_id
    );

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Create a Thing reference for the workflow using the From trait
    let workflow_thing = vertebrae_db::Thing::from(("workflow", workflow_id.as_str()));

    service.assign_workflow(&task_id, &workflow_thing).await?;
    log::info!("Successfully assigned workflow to task: {}", task_id);
    Ok(())
}

/// Delete a task with optional cascade delete for child tasks
///
/// When cascade is true, deletes the task and all its descendants.
/// When cascade is false, deletes the task but orphans its children (they lose their parent).
///
/// This operation is atomic - either fully succeeds or fully fails.
#[tauri::command]
#[specta::specta]
pub async fn delete_task(
    state: State<'_, AppState>,
    task_id: String,
    cascade: bool,
) -> Result<(), CommandError> {
    log::info!(
        "delete_task called with task_id: {}, cascade: {}",
        task_id,
        cascade
    );

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.delete_task(&task_id, cascade).await?;

    log::info!("Successfully deleted task: {}", task_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::{CreateTaskOptions, DefaultTaskService};
    use vertebrae_db::{Database, Level};

    /// Helper to create an AppState with an in-memory database for testing
    async fn create_test_app_state() -> AppState {
        let db = Database::connect_mem()
            .await
            .expect("Failed to create in-memory database");
        db.init().await.expect("Failed to initialize database");
        let service = DefaultTaskService::new(db);

        // Create a temporary project config for testing
        let temp_dir = std::env::temp_dir().join(format!(
            "vtb-gui-cmd-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).ok();
        let project_config = ProjectConfig::with_path(temp_dir.join("projects.json"));

        AppState {
            service: RwLock::new(Some(service)),
            project_config,
        }
    }

    /// Helper to create an AppState without a connected project
    async fn create_disconnected_app_state() -> AppState {
        let temp_dir = std::env::temp_dir().join(format!(
            "vtb-gui-cmd-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).ok();
        let project_config = ProjectConfig::with_path(temp_dir.join("projects.json"));

        AppState {
            service: RwLock::new(None),
            project_config,
        }
    }

    /// Helper to get a State wrapper for testing
    /// Tauri's State is just a wrapper around &T, so we simulate it with Arc
    fn mock_state<T>(state: &T) -> State<'_, T>
    where
        T: Send + Sync + 'static,
    {
        // SAFETY: State is just a newtype wrapper around &T
        // This is a test-only helper to avoid needing full Tauri runtime
        unsafe { std::mem::transmute(state) }
    }

    // ========================================================================
    // Project Management Tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_projects_returns_empty_list_initially() {
        let state = create_test_app_state().await;
        let result = get_projects(mock_state(&state)).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_current_project_returns_none_initially() {
        let state = create_test_app_state().await;
        let result = get_current_project(mock_state(&state)).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_has_project_selected_true_when_connected() {
        let state = create_test_app_state().await;
        let result = has_project_selected(mock_state(&state)).await;
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[tokio::test]
    async fn test_has_project_selected_false_when_disconnected() {
        let state = create_disconnected_app_state().await;
        let result = has_project_selected(mock_state(&state)).await;
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    // ========================================================================
    // Task Command Tests
    // ========================================================================

    #[tokio::test]
    async fn test_list_tasks_returns_empty_list_initially() {
        let state = create_test_app_state().await;
        let result = list_tasks(mock_state(&state), None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_list_tasks_fails_without_project() {
        let state = create_disconnected_app_state().await;
        let result = list_tasks(mock_state(&state), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No project selected"));
    }

    #[tokio::test]
    async fn test_get_task_fails_for_nonexistent_task() {
        let state = create_test_app_state().await;
        let result = get_task(mock_state(&state), "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_task_hierarchy_returns_empty_initially() {
        let state = create_test_app_state().await;
        let result = get_task_hierarchy(mock_state(&state), None, None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_list_tasks_with_filter() {
        let state = create_test_app_state().await;
        let filter = TaskFilterOptions {
            statuses: Some(vec!["backlog".to_string()]),
            levels: None,
            tags: None,
            root_only: Some(true),
            children_of: None,
            include_done: None,
            search: None,
            workflow_id: None,
        };
        let result = list_tasks(mock_state(&state), Some(filter)).await;
        assert!(result.is_ok());
    }

    // ========================================================================
    // Workflow Command Tests
    // ========================================================================

    #[tokio::test]
    async fn test_list_workflows_returns_default_workflow() {
        let state = create_test_app_state().await;
        let result = list_workflows(mock_state(&state)).await;
        assert!(result.is_ok());
        let workflows = result.unwrap();
        // Database init creates a default workflow
        assert!(!workflows.is_empty());
    }

    #[tokio::test]
    async fn test_list_workflows_fails_without_project() {
        let state = create_disconnected_app_state().await;
        let result = list_workflows(mock_state(&state)).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No project selected"));
    }

    #[tokio::test]
    async fn test_get_workflow_returns_default() {
        let state = create_test_app_state().await;
        let result = get_workflow(mock_state(&state), "default".to_string()).await;
        assert!(result.is_ok());
        let workflow = result.unwrap();
        assert_eq!(workflow.name, "Default Workflow");
    }

    #[tokio::test]
    async fn test_get_workflow_fails_for_nonexistent() {
        let state = create_test_app_state().await;
        let result = get_workflow(mock_state(&state), "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_workflow_with_tasks_empty() {
        let state = create_test_app_state().await;
        let result = get_workflow_with_tasks(mock_state(&state), "default".to_string()).await;
        assert!(result.is_ok());
        let wf_with_tasks = result.unwrap();
        assert_eq!(wf_with_tasks.workflow.name, "Default Workflow");
        assert!(wf_with_tasks.tasks.is_empty());
    }

    #[tokio::test]
    async fn test_get_workflow_with_task_details_empty() {
        let state = create_test_app_state().await;
        let result =
            get_workflow_with_task_details(mock_state(&state), "default".to_string()).await;
        assert!(result.is_ok());
        let wf_with_tasks = result.unwrap();
        assert_eq!(wf_with_tasks.workflow.name, "Default Workflow");
        assert!(wf_with_tasks.tasks.is_empty());
    }

    // ========================================================================
    // Step Command Tests
    // ========================================================================

    #[tokio::test]
    async fn test_list_steps_for_default_workflow() {
        let state = create_test_app_state().await;
        let result = list_steps_for_workflow(mock_state(&state), "default".to_string()).await;
        assert!(result.is_ok());
        let steps = result.unwrap();
        // Default workflow should have steps (backlog, implementation, review, done)
        assert!(!steps.is_empty());
    }

    #[tokio::test]
    async fn test_list_steps_fails_without_project() {
        let state = create_disconnected_app_state().await;
        let result = list_steps_for_workflow(mock_state(&state), "default".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_step_returns_none_for_nonexistent() {
        let state = create_test_app_state().await;
        let result = get_step(mock_state(&state), "nonexistent".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    // ========================================================================
    // Execution Command Tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_task_executions_empty_for_nonexistent() {
        let state = create_test_app_state().await;
        let result = get_task_executions(mock_state(&state), "nonexistent".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_task_executions_fails_without_project() {
        let state = create_disconnected_app_state().await;
        let result = get_task_executions(mock_state(&state), "task1".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_execution_logs_empty_for_nonexistent() {
        let state = create_test_app_state().await;
        let result = get_execution_logs(mock_state(&state), "nonexistent".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    // ========================================================================
    // Chat Session Command Tests
    // ========================================================================

    #[tokio::test]
    async fn test_create_chat_session() {
        let state = create_test_app_state().await;
        let result = create_chat_session(mock_state(&state), Some("/tmp".to_string())).await;
        assert!(result.is_ok());
        let session = result.unwrap();
        assert_eq!(session.working_dir, Some("/tmp".to_string()));
        assert!(session.id.is_some());
    }

    #[tokio::test]
    async fn test_create_chat_session_without_working_dir() {
        let state = create_test_app_state().await;
        let result = create_chat_session(mock_state(&state), None).await;
        assert!(result.is_ok());
        let session = result.unwrap();
        assert!(session.working_dir.is_none());
    }

    #[tokio::test]
    async fn test_chat_session_fails_without_project() {
        let state = create_disconnected_app_state().await;
        let result = create_chat_session(mock_state(&state), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No project selected"));
    }

    #[tokio::test]
    async fn test_list_chat_sessions_empty_initially() {
        let state = create_test_app_state().await;
        let result = list_chat_sessions(mock_state(&state), None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_get_chat_session_none_for_nonexistent() {
        let state = create_test_app_state().await;
        let result = get_chat_session(mock_state(&state), "nonexistent".to_string()).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_chat_session_roundtrip() {
        let state = create_test_app_state().await;

        // Create session
        let create_result =
            create_chat_session(mock_state(&state), Some("/test".to_string())).await;
        assert!(create_result.is_ok());
        let session = create_result.unwrap();
        let session_id = session.id.unwrap();

        // Get session
        let get_result = get_chat_session(mock_state(&state), session_id.clone()).await;
        assert!(get_result.is_ok());
        let retrieved = get_result.unwrap().unwrap();
        assert_eq!(retrieved.working_dir, Some("/test".to_string()));

        // Update title
        let update_result = update_chat_session_title(
            mock_state(&state),
            session_id.clone(),
            "Test Session".to_string(),
        )
        .await;
        assert!(update_result.is_ok());

        // Verify title updated
        let get_result2 = get_chat_session(mock_state(&state), session_id.clone()).await;
        assert!(get_result2.is_ok());
        let retrieved2 = get_result2.unwrap().unwrap();
        assert_eq!(retrieved2.title, Some("Test Session".to_string()));

        // List sessions
        let list_result = list_chat_sessions(mock_state(&state), None).await;
        assert!(list_result.is_ok());
        assert_eq!(list_result.unwrap().len(), 1);

        // End session
        let end_result = end_chat_session(mock_state(&state), session_id.clone()).await;
        assert!(end_result.is_ok());

        // Verify session ended
        let get_result3 = get_chat_session(mock_state(&state), session_id.clone()).await;
        assert!(get_result3.is_ok());
        let retrieved3 = get_result3.unwrap().unwrap();
        assert!(retrieved3.ended_at.is_some());

        // Delete session
        let delete_result = delete_chat_session(mock_state(&state), session_id.clone()).await;
        assert!(delete_result.is_ok());

        // Verify deleted
        let get_result4 = get_chat_session(mock_state(&state), session_id).await;
        assert!(get_result4.is_ok());
        assert!(get_result4.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_add_and_get_chat_messages() {
        let state = create_test_app_state().await;

        // Create session
        let session = create_chat_session(mock_state(&state), None).await.unwrap();
        let session_id = session.id.unwrap();

        // Add messages
        let msg1_id = add_chat_message(mock_state(&state), session_id.clone(), "Hello".to_string())
            .await
            .unwrap();
        assert!(!msg1_id.is_empty());

        let msg2_id = add_chat_message(mock_state(&state), session_id.clone(), "World".to_string())
            .await
            .unwrap();
        assert!(!msg2_id.is_empty());

        // Get messages
        let messages = get_chat_messages(mock_state(&state), session_id.clone())
            .await
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "Hello");
        assert_eq!(messages[1].content, "World");

        // Get session content (concatenated)
        let content = get_chat_session_content(mock_state(&state), session_id)
            .await
            .unwrap();
        assert!(content.contains("Hello"));
        assert!(content.contains("World"));
    }

    // ========================================================================
    // Integration Tests with Task Creation
    // ========================================================================

    #[tokio::test]
    async fn test_tasks_with_workflow_filter() {
        let state = create_test_app_state().await;

        // Create a task using the service directly
        {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let options = CreateTaskOptions::new("Test Task").with_level(Level::Task);
            service.create_task(options).await.unwrap();
        }

        // List all tasks
        let result = list_tasks(mock_state(&state), None).await;
        assert!(result.is_ok());
        let tasks = result.unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "Test Task");
    }

    #[tokio::test]
    async fn test_get_task_with_relations() {
        let state = create_test_app_state().await;

        // Create parent and child tasks
        let (parent_id, child_id) = {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let parent_options = CreateTaskOptions::new("Parent").with_level(Level::Epic);
            let parent_id = service.create_task(parent_options).await.unwrap();

            let child_options = CreateTaskOptions::new("Child").with_level(Level::Task);
            let child_id = service.create_task(child_options).await.unwrap();

            service.set_parent(&child_id, &parent_id).await.unwrap();

            (parent_id, child_id)
        };

        // Get parent with relations
        let result = get_task(mock_state(&state), parent_id.clone()).await;
        assert!(result.is_ok());
        let parent_with_relations = result.unwrap();
        assert_eq!(parent_with_relations.task.title, "Parent");
        assert!(parent_with_relations.parent_id.is_none());
        assert_eq!(parent_with_relations.children_ids.len(), 1);
        assert!(parent_with_relations.children_ids.contains(&child_id));

        // Get child with relations
        let result2 = get_task(mock_state(&state), child_id.clone()).await;
        assert!(result2.is_ok());
        let child_with_relations = result2.unwrap();
        assert_eq!(child_with_relations.task.title, "Child");
        assert_eq!(child_with_relations.parent_id, Some(parent_id));
        assert!(child_with_relations.children_ids.is_empty());
    }

    #[tokio::test]
    async fn test_task_hierarchy() {
        let state = create_test_app_state().await;

        // Create hierarchy: Epic -> Ticket -> Task
        {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let epic_options = CreateTaskOptions::new("Epic").with_level(Level::Epic);
            let epic_id = service.create_task(epic_options).await.unwrap();

            let ticket_options = CreateTaskOptions::new("Ticket").with_level(Level::Ticket);
            let ticket_id = service.create_task(ticket_options).await.unwrap();
            service.set_parent(&ticket_id, &epic_id).await.unwrap();

            let task_options = CreateTaskOptions::new("Task").with_level(Level::Task);
            let task_id = service.create_task(task_options).await.unwrap();
            service.set_parent(&task_id, &ticket_id).await.unwrap();
        }

        // Get hierarchy
        let result = get_task_hierarchy(mock_state(&state), None, None).await;
        assert!(result.is_ok());
        let hierarchy = result.unwrap();

        // Should have one root (Epic)
        assert_eq!(hierarchy.len(), 1);
        assert_eq!(hierarchy[0].task.title, "Epic");

        // Epic should have one child (Ticket)
        assert_eq!(hierarchy[0].children.len(), 1);
        assert_eq!(hierarchy[0].children[0].task.title, "Ticket");

        // Ticket should have one child (Task)
        assert_eq!(hierarchy[0].children[0].children.len(), 1);
        assert_eq!(hierarchy[0].children[0].children[0].task.title, "Task");
    }

    #[tokio::test]
    async fn test_workflow_with_tasks_integration() {
        let state = create_test_app_state().await;

        // Create a task assigned to default workflow
        {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let task_options = CreateTaskOptions::new("Workflow Task").with_level(Level::Task);
            let task_id = service.create_task(task_options).await.unwrap();

            // Transition to in_progress to assign workflow
            service
                .transition_to(&task_id, "in_progress")
                .await
                .unwrap();
        }

        // Get workflow with tasks
        let result = get_workflow_with_tasks(mock_state(&state), "default".to_string()).await;
        assert!(result.is_ok());
        let wf_with_tasks = result.unwrap();
        assert_eq!(wf_with_tasks.tasks.len(), 1);
        assert_eq!(wf_with_tasks.tasks[0].title, "Workflow Task");
    }

    // ========================================================================
    // Task Relationship Mutation Tests
    // ========================================================================

    #[tokio::test]
    async fn test_set_parent_creates_relationship() {
        let state = create_test_app_state().await;

        let (parent_id, child_id) = {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let parent_options = CreateTaskOptions::new("Parent").with_level(Level::Epic);
            let parent_id = service.create_task(parent_options).await.unwrap();

            let child_options = CreateTaskOptions::new("Child").with_level(Level::Task);
            let child_id = service.create_task(child_options).await.unwrap();

            service.set_parent(&child_id, &parent_id).await.unwrap();
            (parent_id, child_id)
        };

        // Set parent via command
        let result = set_parent(mock_state(&state), child_id.clone(), parent_id.clone()).await;
        assert!(result.is_ok());

        // Verify relationship was created
        let child_result = get_task(mock_state(&state), child_id.clone()).await;
        assert!(child_result.is_ok());
        let child_with_relations = child_result.unwrap();
        assert_eq!(child_with_relations.parent_id, Some(parent_id));
    }

    #[tokio::test]
    async fn test_remove_parent_deletes_relationship() {
        let state = create_test_app_state().await;

        let (parent_id, child_id) = {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let parent_options = CreateTaskOptions::new("Parent").with_level(Level::Epic);
            let parent_id = service.create_task(parent_options).await.unwrap();

            let child_options = CreateTaskOptions::new("Child").with_level(Level::Task);
            let child_id = service.create_task(child_options).await.unwrap();

            service.set_parent(&child_id, &parent_id).await.unwrap();
            (parent_id, child_id)
        };

        // Remove parent via command
        let result = remove_parent(mock_state(&state), child_id.clone()).await;
        assert!(result.is_ok());

        // Verify relationship was removed
        let child_result = get_task(mock_state(&state), child_id.clone()).await;
        assert!(child_result.is_ok());
        let child_with_relations = child_result.unwrap();
        assert!(child_with_relations.parent_id.is_none());
    }

    #[tokio::test]
    async fn test_add_dependency_creates_relationship() {
        let state = create_test_app_state().await;

        let (task_a_id, task_b_id) = {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let task_a_options = CreateTaskOptions::new("Task A").with_level(Level::Task);
            let task_a_id = service.create_task(task_a_options).await.unwrap();

            let task_b_options = CreateTaskOptions::new("Task B").with_level(Level::Task);
            let task_b_id = service.create_task(task_b_options).await.unwrap();

            service
                .add_dependency(&task_b_id, &task_a_id)
                .await
                .unwrap();
            (task_a_id, task_b_id)
        };

        // Add dependency via command (B depends on A)
        let result = add_dependency(mock_state(&state), task_b_id.clone(), task_a_id.clone()).await;
        assert!(result.is_ok());

        // Verify dependency was created
        let task_b_result = get_task(mock_state(&state), task_b_id.clone()).await;
        assert!(task_b_result.is_ok());
        let task_b_with_relations = task_b_result.unwrap();
        assert!(task_b_with_relations.depends_on_ids.contains(&task_a_id));
    }

    #[tokio::test]
    async fn test_remove_dependency_deletes_relationship() {
        let state = create_test_app_state().await;

        let (task_a_id, task_b_id) = {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let task_a_options = CreateTaskOptions::new("Task A").with_level(Level::Task);
            let task_a_id = service.create_task(task_a_options).await.unwrap();

            let task_b_options = CreateTaskOptions::new("Task B").with_level(Level::Task);
            let task_b_id = service.create_task(task_b_options).await.unwrap();

            service
                .add_dependency(&task_b_id, &task_a_id)
                .await
                .unwrap();
            (task_a_id, task_b_id)
        };

        // Remove dependency via command
        let result =
            remove_dependency(mock_state(&state), task_b_id.clone(), task_a_id.clone()).await;
        assert!(result.is_ok());

        // Verify dependency was removed
        let task_b_result = get_task(mock_state(&state), task_b_id.clone()).await;
        assert!(task_b_result.is_ok());
        let task_b_with_relations = task_b_result.unwrap();
        assert!(!task_b_with_relations.depends_on_ids.contains(&task_a_id));
    }

    #[tokio::test]
    async fn test_add_dependency_prevents_cycles() {
        let state = create_test_app_state().await;

        let (task_a_id, task_b_id) = {
            let guard = state.service.read().await;
            let service = guard.as_ref().unwrap();

            let task_a_options = CreateTaskOptions::new("Task A").with_level(Level::Task);
            let task_a_id = service.create_task(task_a_options).await.unwrap();

            let task_b_options = CreateTaskOptions::new("Task B").with_level(Level::Task);
            let task_b_id = service.create_task(task_b_options).await.unwrap();

            service
                .add_dependency(&task_b_id, &task_a_id)
                .await
                .unwrap();
            (task_a_id, task_b_id)
        };

        // Try to add reverse dependency (A depends on B) - should fail
        let result = add_dependency(mock_state(&state), task_a_id.clone(), task_b_id.clone()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_set_parent_fails_without_project() {
        let state = create_disconnected_app_state().await;
        let result = set_parent(mock_state(&state), "task1".to_string(), "task2".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No project selected"));
    }

    #[tokio::test]
    async fn test_add_dependency_fails_without_project() {
        let state = create_disconnected_app_state().await;
        let result =
            add_dependency(mock_state(&state), "task1".to_string(), "task2".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No project selected"));
    }
}
