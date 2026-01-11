//! Tauri commands for task and workflow data access
//!
//! Implements list_tasks, get_task, get_task_hierarchy, and workflow commands
//! using the vertebrae-db repository pattern.

use crate::project_config::{ProjectConfig, SavedProject};
use crate::types::{
    SessionLog, StepExecution, TaskFilterOptions, TaskHierarchyNode, TaskSummary,
    TaskWithRelations, Workflow, WorkflowWithTasks,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::RwLock;

/// Application state holding the database connection
pub struct AppState {
    /// Database connection (None until a project is selected)
    pub db: RwLock<Option<vertebrae_db::Database>>,
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

    // Connect to database if a project is selected
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

        let mut db_lock = state.db.write().await;
        *db_lock = Some(db);
    } else {
        let mut db_lock = state.db.write().await;
        *db_lock = None;
    }

    Ok(())
}

/// Check if a project is currently selected and database is connected
#[tauri::command]
#[specta::specta]
pub async fn has_project_selected(state: State<'_, AppState>) -> Result<bool, CommandError> {
    let db_lock = state.db.read().await;
    Ok(db_lock.is_some())
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
    let db_guard = state.db.read().await;
    let db = db_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let db_filter: vertebrae_db::TaskFilter = filter.unwrap_or_default().into();
    match db.list_tasks().list(&db_filter).await {
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
    let db_guard = state.db.read().await;
    let db = db_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Get the task
    let task = db
        .tasks()
        .get(&id)
        .await?
        .ok_or_else(|| CommandError::task_not_found(&id))?;

    // Get relations
    let parent_id = db.relationships().get_parent(&id).await?;
    let children_ids = db.relationships().get_children(&id).await?;
    let depends_on_ids = db.relationships().get_dependencies(&id).await?;
    let dependent_ids = db.relationships().get_dependents(&id).await?;

    Ok(TaskWithRelations {
        task: task.into(),
        parent_id,
        children_ids,
        depends_on_ids,
        dependent_ids,
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
) -> Result<Vec<TaskHierarchyNode>, CommandError> {
    let db_guard = state.db.read().await;
    let db = db_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match root_id {
        Some(id) => {
            // Build hierarchy from a specific root
            let node = build_hierarchy_node(db, &id).await?;
            match node {
                Some(n) => Ok(vec![n]),
                None => Err(CommandError::task_not_found(&id)),
            }
        }
        None => {
            // Get all root tasks and build their hierarchies
            let root_filter = vertebrae_db::TaskFilter::new().root_only();
            let roots = db.list_tasks().list(&root_filter).await?;

            let mut nodes = Vec::with_capacity(roots.len());
            for root in roots {
                if let Some(node) = build_hierarchy_node(db, &root.id).await? {
                    nodes.push(node);
                }
            }
            Ok(nodes)
        }
    }
}

/// Helper function to recursively build a hierarchy node
async fn build_hierarchy_node(
    db: &vertebrae_db::Database,
    task_id: &str,
) -> Result<Option<TaskHierarchyNode>, CommandError> {
    // Get task summary via filter
    let filter = vertebrae_db::TaskFilter::new().include_done();
    let summaries = db.list_tasks().list(&filter).await?;

    // Find the task in the results
    let task_summary = summaries.into_iter().find(|s| s.id == task_id);

    match task_summary {
        Some(summary) => {
            // Get children
            let children_ids = db.relationships().get_children(task_id).await?;

            // Recursively build child nodes
            let mut children = Vec::with_capacity(children_ids.len());
            for child_id in children_ids {
                if let Some(child_node) = Box::pin(build_hierarchy_node(db, &child_id)).await? {
                    children.push(child_node);
                }
            }

            Ok(Some(TaskHierarchyNode {
                task: summary.into(),
                children,
            }))
        }
        None => Ok(None),
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
    let db_guard = state.db.read().await;
    let db = db_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match db.workflows().list().await {
        Ok(workflows) => {
            log::info!("list_workflows returned {} workflows", workflows.len());
            Ok(workflows.into_iter().map(Into::into).collect())
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
    let db_guard = state.db.read().await;
    let db = db_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow = db
        .workflows()
        .get(&id)
        .await?
        .ok_or_else(|| CommandError::workflow_not_found(&id))?;

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
    let db_guard = state.db.read().await;
    let db = db_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Get the workflow
    let workflow = db
        .workflows()
        .get(&id)
        .await?
        .ok_or_else(|| CommandError::workflow_not_found(&id))?;

    // Get tasks associated with this workflow
    // Use include_done to get all tasks regardless of status
    let filter = vertebrae_db::TaskFilter::new().include_done();
    let all_tasks = db.list_tasks().list(&filter).await?;

    // Filter tasks that have this workflow_id
    // Tasks store workflow_id as Thing, so we need to match the id portion
    let workflow_id_str = workflow
        .id
        .as_ref()
        .map(|t| t.id.to_string())
        .unwrap_or_default();

    // We need to get full tasks to check workflow_id since TaskSummary doesn't include it
    let mut tasks = Vec::new();
    for summary in all_tasks {
        if let Ok(Some(task)) = db.tasks().get(&summary.id).await {
            if let Some(ref wf_id) = task.workflow_id {
                if wf_id.id.to_string() == workflow_id_str {
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
    let db_guard = state.db.read().await;
    let db = db_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match db.executions().list_executions_for_task(&task_id).await {
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
    let db_guard = state.db.read().await;
    let db = db_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match db.executions().list_logs_for_execution(&execution_id).await {
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
