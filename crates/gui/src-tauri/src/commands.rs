//! Tauri commands for task and workflow data access
//!
//! Implements list_tasks, get_task, get_task_hierarchy, and workflow commands
//! using the vertebrae-core TaskService layer.

use crate::project_config::{ProjectConfig, SavedProject};
use crate::types::{
    SessionLog, StepExecution, TaskFilterOptions, TaskHierarchyNode, TaskSummary,
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
            status: node.status.clone().into(),
            priority: node.priority.clone().map(Into::into),
            tags: node.tags.clone(),
            needs_human_review: node.needs_human_review,
            created_at: node.created_at.to_rfc3339(),
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
        let task = vertebrae_db::Task {
            id: Some(surrealdb::sql::Thing::from((
                "task".to_string(),
                data.id.clone(),
            ))),
            title: data.title,
            description: data.description,
            level: data.level,
            status: data.status,
            priority: data.priority,
            tags: data.tags,
            created_at: Some(data.created_at),
            updated_at: None,
            started_at: None,
            completed_at: None,
            sections,
            code_refs,
            needs_human_review: data.needs_human_review,
            workflow_id: None,
            current_step: None,
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
