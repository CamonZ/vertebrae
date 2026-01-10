//! Tauri commands for task and workflow data access
//!
//! Implements list_tasks, get_task, get_task_hierarchy, and workflow commands
//! using the vertebrae-db repository pattern.

use crate::types::{
    StepExecution, TaskFilterOptions, TaskHierarchyNode, TaskSummary, TaskWithRelations, Workflow,
    WorkflowWithTasks,
};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Application state holding the database connection
pub struct AppState {
    pub db: vertebrae_db::Database,
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
    let db_filter: vertebrae_db::TaskFilter = filter.unwrap_or_default().into();
    match state.db.list_tasks().list(&db_filter).await {
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
    // Get the task
    let task = state
        .db
        .tasks()
        .get(&id)
        .await?
        .ok_or_else(|| CommandError::task_not_found(&id))?;

    // Get relations
    let parent_id = state.db.relationships().get_parent(&id).await?;
    let children_ids = state.db.relationships().get_children(&id).await?;
    let depends_on_ids = state.db.relationships().get_dependencies(&id).await?;
    let dependent_ids = state.db.relationships().get_dependents(&id).await?;

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
    match root_id {
        Some(id) => {
            // Build hierarchy from a specific root
            let node = build_hierarchy_node(&state.db, &id).await?;
            match node {
                Some(n) => Ok(vec![n]),
                None => Err(CommandError::task_not_found(&id)),
            }
        }
        None => {
            // Get all root tasks and build their hierarchies
            let root_filter = vertebrae_db::TaskFilter::new().root_only();
            let roots = state.db.list_tasks().list(&root_filter).await?;

            let mut nodes = Vec::with_capacity(roots.len());
            for root in roots {
                if let Some(node) = build_hierarchy_node(&state.db, &root.id).await? {
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
    match state.db.workflows().list().await {
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
    let workflow = state
        .db
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
    // Get the workflow
    let workflow = state
        .db
        .workflows()
        .get(&id)
        .await?
        .ok_or_else(|| CommandError::workflow_not_found(&id))?;

    // Get tasks associated with this workflow
    // Use include_done to get all tasks regardless of status
    let filter = vertebrae_db::TaskFilter::new().include_done();
    let all_tasks = state.db.list_tasks().list(&filter).await?;

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
        if let Ok(Some(task)) = state.db.tasks().get(&summary.id).await {
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
    match state
        .db
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
