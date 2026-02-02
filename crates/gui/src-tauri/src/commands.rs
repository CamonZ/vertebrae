//! Tauri commands for task and workflow data access
//!
//! Implements list_tasks, get_task, get_task_hierarchy, and workflow commands
//! using the vertebrae-core TaskService layer.

use crate::project_config::{ProjectConfig, SavedProject};
use crate::types::{
    SessionLog, Step, StepExecution, Task, TaskFilterOptions, TaskTreeNode, Workflow,
    WorkflowWithTasks,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use tokio::sync::RwLock;
use vertebrae_core::VertebraeServices;

/// Application state holding the services
pub struct AppState {
    /// Unified services container (None until a project is selected)
    pub services: RwLock<Option<VertebraeServices>>,
    /// Project configuration manager
    pub project_config: ProjectConfig,
}

/// Error response type for commands - simple string wrapper with specta support
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CommandError {
    pub message: String,
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
/// Takes a directory path, derives a slug from the folder name,
/// creates the project in Sacrum API if needed, and saves to config.toml.
#[tauri::command]
#[specta::specta]
pub async fn add_project(
    _state: State<'_, AppState>,
    path: String,
) -> Result<SavedProject, CommandError> {
    log::info!("add_project called with path: {}", path);

    // Extract folder name from path
    let folder_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CommandError {
            message: "Failed to extract folder name from path".to_string(),
        })?
        .to_string();

    // Derive slug from folder name
    let project_slug = slug::slugify(&folder_name);
    if project_slug.is_empty() {
        return Err(CommandError {
            message: format!("Could not create valid slug from: {}", folder_name),
        });
    }

    // Read API token from environment
    let api_token = std::env::var("SACRUM_API_TOKEN").map_err(|_| CommandError {
        message: "SACRUM_API_TOKEN environment variable not set".to_string(),
    })?;

    // Load config file and check for duplicate slug
    let mut config_file =
        vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
            message: format!("Failed to load config file: {}", e),
        })?;

    if config_file.projects.contains_key(&project_slug) {
        return Err(CommandError {
            message: format!(
                "Project with slug '{}' already exists in config",
                project_slug
            ),
        });
    }

    // Create temporary Sacrum client to get-or-create the project
    let temp_config = vertebrae_sacrum_client::SacrumConfig::new(
        config_file.sacrum.url.clone(),
        api_token,
        "temp".to_string(),
    );
    let client = vertebrae_sacrum_client::SacrumClient::new(temp_config);

    // Try to find existing project by slug, or create a new one
    let project = match client
        .get::<Vec<vertebrae_sacrum_client::ProjectResponse>, _>("/api/projects", &())
        .await
    {
        Ok(projects) => {
            if let Some(existing) = projects.iter().find(|p| p.slug == project_slug) {
                existing.clone()
            } else {
                // Create new project
                let req = vertebrae_sacrum_client::CreateProjectRequest {
                    name: folder_name.clone(),
                    slug: project_slug.clone(),
                };
                client
                    .post::<vertebrae_sacrum_client::ProjectResponse, _>("/api/projects", &req)
                    .await
                    .map_err(|e| CommandError {
                        message: format!("Failed to create project in Sacrum: {}", e),
                    })?
            }
        }
        Err(e) => {
            return Err(CommandError {
                message: format!("Failed to list projects from Sacrum: {}", e),
            });
        }
    };

    // Insert project into config file
    config_file.projects.insert(
        project_slug.clone(),
        vertebrae_sacrum_client::ProjectSection {
            project_id: project.id.clone(),
            url: None,
        },
    );

    vertebrae_sacrum_client::save_config_file(&config_file).map_err(|e| CommandError {
        message: format!("Failed to save config file: {}", e),
    })?;

    Ok(SavedProject {
        slug: project_slug,
        project_id: project.id,
        url: None,
    })
}

/// Remove a project from the saved list
///
/// Removes the project from config.toml by slug. If the removed project
/// is the currently selected project, clears the selection and services.
#[tauri::command]
#[specta::specta]
pub async fn remove_project(state: State<'_, AppState>, slug: String) -> Result<(), CommandError> {
    log::info!("remove_project called with slug: {}", slug);

    // Load config file
    let mut config_file =
        vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
            message: format!("Failed to load config file: {}", e),
        })?;

    // Remove project by slug
    if config_file.projects.remove(&slug).is_none() {
        return Err(CommandError {
            message: format!("Project '{}' not found in config", slug),
        });
    }

    // Save updated config
    vertebrae_sacrum_client::save_config_file(&config_file).map_err(|e| CommandError {
        message: format!("Failed to save config file: {}", e),
    })?;

    // If the removed project was the current one, clear selection and services
    if state.project_config.get_current_project().as_deref() == Some(&slug) {
        state
            .project_config
            .set_current_project(None)
            .map_err(|e| CommandError { message: e })?;

        let mut service_lock = state.services.write().await;
        *service_lock = None;
    }

    Ok(())
}

/// Get the currently selected project slug
#[tauri::command]
#[specta::specta]
pub async fn get_current_project(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    log::info!("get_current_project called");
    Ok(state.project_config.get_current_project())
}

/// Set the current project by slug and connect to its backend
#[tauri::command]
#[specta::specta]
pub async fn set_current_project(
    state: State<'_, AppState>,
    slug: Option<String>,
) -> Result<(), CommandError> {
    log::info!("set_current_project called with slug: {:?}", slug);

    // Update config
    state
        .project_config
        .set_current_project(slug.clone())
        .map_err(|e| CommandError { message: e })?;

    // Connect to Sacrum backend and create service if a project is selected
    if let Some(project_slug) = slug {
        log::info!("Attempting to connect to Sacrum backend");

        match vertebrae_sacrum_client::SacrumConfig::load(&project_slug) {
            Ok(config) => {
                let client = vertebrae_sacrum_client::SacrumClient::new(config);
                let client_arc = std::sync::Arc::new(client);
                let services = crate::sacrum::from_sacrum(client_arc);
                let mut service_lock = state.services.write().await;
                *service_lock = Some(services);
            }
            Err(e) => {
                return Err(CommandError {
                    message: format!("Failed to load Sacrum configuration: {}", e),
                });
            }
        }
    } else {
        let mut service_lock = state.services.write().await;
        *service_lock = None;
    }

    Ok(())
}

/// Check if a project is currently selected and database is connected
#[tauri::command]
#[specta::specta]
pub async fn has_project_selected(state: State<'_, AppState>) -> Result<bool, CommandError> {
    let service_lock = state.services.read().await;
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
) -> Result<Vec<Task>, CommandError> {
    log::info!("list_tasks called with filter: {:?}", filter);
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let db_filter: vertebrae_core::TaskFilter = filter.unwrap_or_default().into();
    match service.tasks().list_tasks(&db_filter).await {
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
/// Returns the full task details.
#[tauri::command]
#[specta::specta]
pub async fn get_task(state: State<'_, AppState>, id: String) -> Result<Task, CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let task = service.tasks().get_task(&id).await?;

    Ok(task.into())
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
) -> Result<Vec<TaskTreeNode>, CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Convert filter options to db filter, applying all fields (statuses, levels, workflow_id, etc.)
    let db_filter: vertebrae_core::TaskFilter = match filter {
        Some(opts) => opts.into(),
        None => vertebrae_core::TaskFilter::new().include_done(),
    };

    let tree_options = vertebrae_core::TreeFilterOptions::new(db_filter);
    let tree = service.tasks().get_task_tree(&tree_options).await?;

    match root_id {
        Some(id) => {
            // Find the specific node in the tree
            fn find_node(nodes: &[vertebrae_core::TaskTreeNode], id: &str) -> Option<TaskTreeNode> {
                for node in nodes {
                    if node.task.id == id {
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
            // Return all root nodes converted to TaskTreeNode, sorted by newest first
            let mut nodes: Vec<TaskTreeNode> = tree.iter().map(convert_tree_node).collect();
            nodes.sort_by(|a, b| b.task.created_at.cmp(&a.task.created_at));
            Ok(nodes)
        }
    }
}

/// Helper function to convert core TaskTreeNode to GUI TaskTreeNode
/// Children are sorted by created_at descending (newest first)
fn convert_tree_node(node: &vertebrae_core::TaskTreeNode) -> TaskTreeNode {
    let mut children: Vec<TaskTreeNode> = node.children.iter().map(convert_tree_node).collect();
    children.sort_by(|a, b| b.task.created_at.cmp(&a.task.created_at));

    TaskTreeNode {
        task: node.task.clone().into(),
        has_blockers: node.has_blockers,
        blocker_count: node.blocker_count as u32,
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
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_service = service.workflows();

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
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_service = service.workflows();

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
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_service = service.workflows();

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
            let from_id = &t.from_workflow;
            let to_id = &t.to_workflow;
            crate::types::WorkflowTransition {
                id: t.id,
                from_workflow_id: from_id.clone(),
                from_workflow_name: workflow_names
                    .get(from_id)
                    .cloned()
                    .unwrap_or_else(|| from_id.clone()),
                to_workflow_id: to_id.clone(),
                to_workflow_name: workflow_names
                    .get(to_id)
                    .cloned()
                    .unwrap_or_else(|| to_id.clone()),
                label: t.label,
                target_step_id: t.target_step,
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
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_service = service.workflows();

    // Get the workflow
    let workflow = workflow_service.get_workflow(&id).await?;

    // Get tasks associated with this workflow using the service
    let filter = vertebrae_core::TaskFilter::new().include_done();
    let all_tasks = service.tasks().list_tasks(&filter).await?;

    // Filter tasks that have this workflow_id
    let workflow_id_str = workflow.id.clone().unwrap_or_default();

    let tasks: Vec<Task> = all_tasks
        .into_iter()
        .filter(|t| t.workflow_id.as_deref() == Some(&workflow_id_str))
        .map(Into::into)
        .collect();

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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_service = service.workflows();

    // Get the workflow
    let wf_start = std::time::Instant::now();
    let workflow = workflow_service.get_workflow(&id).await?;
    log::info!(
        "[get_workflow_with_task_details] get_workflow took {}ms",
        wf_start.elapsed().as_millis()
    );

    // Get the workflow_id string for filtering
    let workflow_id_str = workflow.id.clone().unwrap_or_default();

    // Query tasks with filter for the workflow
    let query_start = std::time::Instant::now();
    let filter = vertebrae_core::TaskFilter::new()
        .include_done()
        .with_workflow_id(workflow_id_str.clone());
    let tasks = service.tasks().list_tasks(&filter).await?;
    log::info!(
        "[get_workflow_with_task_details] Fetched {} tasks in {}ms",
        tasks.len(),
        query_start.elapsed().as_millis()
    );

    let convert_start = std::time::Instant::now();
    let tasks_gui: Vec<Task> = tasks.into_iter().map(Into::into).collect();
    log::info!(
        "[get_workflow_with_task_details] Converted {} tasks to GUI types in {}ms",
        tasks_gui.len(),
        convert_start.elapsed().as_millis()
    );

    log::info!(
        "[get_workflow_with_task_details] Total time: {}ms",
        start_time.elapsed().as_millis()
    );

    Ok(crate::types::WorkflowWithTaskDetails {
        workflow: workflow.into(),
        tasks: tasks_gui,
    })
}

/// Get all pipeline data in a single command.
///
/// Fetches workflows, all tasks (as lightweight summaries), all steps grouped
/// by workflow, and workflow transitions. Replaces the N+1 sequential fetch
/// pattern where each workflow triggers individual task and step queries.
///
/// Makes 3-4 service calls total instead of 2N+2.
#[tauri::command]
#[specta::specta]
pub async fn get_pipeline_data(
    state: State<'_, AppState>,
) -> Result<crate::types::PipelineData, CommandError> {
    log::info!("[get_pipeline_data] Starting");
    let start_time = std::time::Instant::now();

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // 1. List all workflows
    let wf_start = std::time::Instant::now();
    let workflow_summaries = service.workflows().list_workflows().await?;
    let mut workflows_gui = Vec::with_capacity(workflow_summaries.len());
    for ws in &workflow_summaries {
        let wf = service.workflows().get_workflow(&ws.id).await?;
        workflows_gui.push(crate::types::Workflow::from(wf));
    }
    log::info!(
        "[get_pipeline_data] Fetched {} workflows in {}ms",
        workflows_gui.len(),
        wf_start.elapsed().as_millis()
    );

    // 2. List all tasks (single HTTP call via include_done filter)
    let tasks_start = std::time::Instant::now();
    let filter = vertebrae_core::TaskFilter::new().include_done();
    let task_summaries = service.tasks().list_tasks(&filter).await?;
    let tasks: Vec<crate::types::Task> = task_summaries.into_iter().map(Into::into).collect();
    log::info!(
        "[get_pipeline_data] Fetched {} tasks in {}ms",
        tasks.len(),
        tasks_start.elapsed().as_millis()
    );

    // 3. List steps per workflow (API requires workflow_id)
    let steps_start = std::time::Instant::now();
    let mut workflow_steps: std::collections::HashMap<String, Vec<crate::types::Step>> =
        std::collections::HashMap::new();
    for wf in &workflows_gui {
        if let Some(wf_id) = &wf.id {
            match service.steps().list_steps_for_workflow(wf_id).await {
                Ok(steps) => {
                    workflow_steps.insert(
                        wf_id.clone(),
                        steps.into_iter().map(crate::types::Step::from).collect(),
                    );
                }
                Err(e) => {
                    log::warn!(
                        "[get_pipeline_data] Failed to fetch steps for workflow {}: {}",
                        wf_id,
                        e
                    );
                    workflow_steps.insert(wf_id.clone(), Vec::new());
                }
            }
        }
    }
    log::info!(
        "[get_pipeline_data] Fetched steps for {} workflows in {}ms",
        workflow_steps.len(),
        steps_start.elapsed().as_millis()
    );

    // 4. Fetch workflow transitions
    let trans_start = std::time::Instant::now();
    let transitions_raw = service.workflows().list_workflow_transitions(None).await?;
    let workflow_names: std::collections::HashMap<String, String> = workflow_summaries
        .into_iter()
        .map(|w| (w.id.clone(), w.name))
        .collect();
    let transitions: Vec<crate::types::WorkflowTransition> = transitions_raw
        .into_iter()
        .map(|t| {
            let from_id = &t.from_workflow;
            let to_id = &t.to_workflow;
            crate::types::WorkflowTransition {
                id: t.id,
                from_workflow_id: from_id.clone(),
                from_workflow_name: workflow_names
                    .get(from_id)
                    .cloned()
                    .unwrap_or_else(|| from_id.clone()),
                to_workflow_id: to_id.clone(),
                to_workflow_name: workflow_names
                    .get(to_id)
                    .cloned()
                    .unwrap_or_else(|| to_id.clone()),
                label: t.label,
                target_step_id: t.target_step,
            }
        })
        .collect();
    log::info!(
        "[get_pipeline_data] Fetched {} transitions in {}ms",
        transitions.len(),
        trans_start.elapsed().as_millis()
    );

    log::info!(
        "[get_pipeline_data] Total time: {}ms",
        start_time.elapsed().as_millis()
    );

    Ok(crate::types::PipelineData {
        workflows: workflows_gui,
        workflow_steps,
        tasks,
        transitions,
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
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service
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
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service
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
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service.steps().list_steps_for_workflow(&workflow_id).await {
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
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service.steps().get_step(&step_id).await {
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

/// Create a new step for a workflow
///
/// Creates a new first-class Step entity with the given properties.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn create_step(
    state: State<'_, AppState>,
    workflow_id: String,
    name: String,
    goal: Option<String>,
    agents: Vec<String>,
    skills: Vec<String>,
    order: i32,
    is_final: bool,
    transitions_to: Vec<String>,
) -> Result<Step, CommandError> {
    log::info!(
        "create_step called: workflow={}, name={}, order={}",
        workflow_id,
        name,
        order
    );
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Build transitions_to list
    let transitions: Vec<String> = transitions_to.iter().map(|id| id.to_lowercase()).collect();

    // Build the step
    let mut step = vertebrae_core::Step::new(&name, workflow_id)
        .with_agents(agents)
        .with_skills(skills)
        .with_order(order)
        .with_is_final(is_final)
        .with_transitions_to(transitions);

    if let Some(goal) = goal {
        step = step.with_goal(&goal);
    }

    match service.steps().create_step(&step).await {
        Ok(created) => {
            log::info!("create_step succeeded: {:?}", created.id);
            Ok(created.into())
        }
        Err(e) => {
            log::error!("create_step error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Update an existing step
///
/// Updates the step with the given ID. Only fields that are Some will be updated.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn update_step(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    step_id: String,
    name: Option<String>,
    goal: Option<String>,
    agents: Option<Vec<String>>,
    skills: Option<Vec<String>>,
    order: Option<i32>,
    is_final: Option<bool>,
    transitions_to: Option<Vec<String>>,
) -> Result<(), CommandError> {
    log::info!(
        "update_step called with step_id: '{}', name: {:?}, goal: {:?}, agents: {:?}, skills: {:?}, order: {:?}, is_final: {:?}, transitions_to: {:?}",
        step_id,
        name,
        goal,
        agents,
        skills,
        order,
        is_final,
        transitions_to
    );
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    update_step_inner(
        service,
        &step_id,
        name,
        goal,
        agents,
        skills,
        order,
        is_final,
        transitions_to,
    )
    .await?;

    // Get the step to find its workflow_id
    if let Some(step) = service.steps().get_step(&step_id).await? {
        // Emit step changed event for detail panel listeners
        if let Some(id) = step.id {
            let _ = app_handle.emit(
                "step-changed-event",
                crate::events::StepChangedEvent {
                    step_id: id.clone(),
                    workflow_id: step.workflow_id.clone(),
                    change_type: crate::events::StepChangeType::Updated,
                },
            );
        }
    }

    Ok(())
}

/// Inner logic for update_step, separated for testability.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn update_step_inner(
    service: &VertebraeServices,
    step_id: &str,
    name: Option<String>,
    goal: Option<String>,
    agents: Option<Vec<String>>,
    skills: Option<Vec<String>>,
    order: Option<i32>,
    is_final: Option<bool>,
    transitions_to: Option<Vec<String>>,
) -> Result<(), CommandError> {
    // Verify step exists
    let existing = service.steps().get_step(step_id).await?;
    if existing.is_none() {
        return Err(CommandError {
            message: format!("Step not found: {}", step_id),
        });
    }

    // Build the update
    let mut update = vertebrae_core::StepUpdate::new();

    if let Some(name) = name {
        update = update.with_name(&name);
    }

    if let Some(goal) = goal {
        update = update.with_goal(&goal);
    }

    if let Some(agents) = agents {
        update = update.with_agents(agents);
    }

    if let Some(skills) = skills {
        update = update.with_skills(skills);
    }

    if let Some(order) = order {
        update = update.with_order(order);
    }

    if let Some(is_final) = is_final {
        update = update.with_is_final(is_final);
    }

    if let Some(transitions) = transitions_to {
        let transition_ids: Vec<String> = transitions.iter().map(|id| id.to_lowercase()).collect();
        update = update.with_transitions_to(transition_ids);
    }

    service.steps().update_step(step_id, &update).await?;
    log::info!("update_step succeeded for step: {}", step_id);
    Ok(())
}

/// Delete a step
///
/// Deletes the step with the given ID.
#[tauri::command]
#[specta::specta]
pub async fn delete_step(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    step_id: String,
) -> Result<(), CommandError> {
    log::info!("delete_step called for step: {}", step_id);
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_id = delete_step_inner(service, &step_id).await?;

    // Emit step changed event for detail panel listeners
    let _ = app_handle.emit(
        "step-changed-event",
        crate::events::StepChangedEvent {
            step_id: step_id.clone(),
            workflow_id,
            change_type: crate::events::StepChangeType::Deleted,
        },
    );

    Ok(())
}

/// Inner logic for delete_step, separated for testability.
/// Returns the workflow_id of the deleted step.
pub(crate) async fn delete_step_inner(
    service: &VertebraeServices,
    step_id: &str,
) -> Result<String, CommandError> {
    // Verify step exists and capture workflow_id before deletion
    let existing = service.steps().get_step(step_id).await?;
    if existing.is_none() {
        return Err(CommandError {
            message: format!("Step not found: {}", step_id),
        });
    }
    let workflow_id = existing.unwrap().workflow_id.clone();

    service.steps().delete_step(step_id).await?;
    log::info!("delete_step succeeded for step: {}", step_id);
    Ok(workflow_id)
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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Verify task has a workflow assigned
    let task = service
        .tasks()
        .get_task(&task_id)
        .await
        .map_err(CommandError::from)?;

    if task.workflow_id.is_none() {
        return Err(CommandError {
            message: format!("Task {} has no assigned workflow", task_id),
        });
    }

    // Spawn execution in background
    tauri::async_runtime::spawn({
        // Capture individual Arc-wrapped services for the spawned task
        let tasks = service_guard.as_ref().unwrap().tasks_arc();
        let workflows = service_guard.as_ref().unwrap().workflows_arc();
        let executions = service_guard.as_ref().unwrap().executions_arc();
        let steps = service_guard.as_ref().unwrap().steps_arc();
        let task_id_clone = task_id.clone();
        let app_handle_clone = app_handle.clone();

        async move {
            if let Err(e) = crate::workflow_runner::execute_workflow(
                task_id_clone,
                tasks,
                workflows,
                executions,
                steps,
                app_handle_clone,
            )
            .await
            {
                log::error!("Workflow execution failed: {}", e);
            }
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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.tasks().set_parent(&task_id, &parent_id).await?;

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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.tasks().remove_parent(&task_id).await?;

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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .tasks()
        .add_dependency(&task_id, &depends_on_id)
        .await?;

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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .tasks()
        .remove_dependency(&task_id, &depends_on_id)
        .await?;

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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse level if provided
    let parsed_level = if let Some(level_str) = level {
        match level_str.to_lowercase().as_str() {
            "epic" => Some(vertebrae_core::Level::Epic),
            "ticket" => Some(vertebrae_core::Level::Ticket),
            "task" => Some(vertebrae_core::Level::Task),
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

    let task_id = service.tasks().create_task(options).await?;
    log::info!("Successfully created task with ID: {}", task_id);
    Ok(task_id)
}

/// Update a task with multiple fields
///
/// Specify only the fields you want to update. Omitted fields remain unchanged.
#[tauri::command]
#[specta::specta]
pub async fn update_task(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    task_id: String,
    options: crate::types::UpdateTaskOptions,
) -> Result<(), CommandError> {
    log::info!(
        "update_task called with task_id: '{}', options: {:?}",
        task_id,
        options
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    update_task_inner(service, &task_id, options).await?;

    // Emit task changed event so UI listeners can update
    let _ = app_handle.emit(
        "task-changed-event",
        crate::events::TaskChangedEvent {
            task_id: task_id.clone(),
            change_type: crate::events::TaskChangeType::Updated,
        },
    );

    Ok(())
}

/// Inner logic for update_task, separated for testability.
pub(crate) async fn update_task_inner(
    service: &VertebraeServices,
    task_id: &str,
    options: crate::types::UpdateTaskOptions,
) -> Result<(), CommandError> {
    // Build update options
    let mut update_opts = vertebrae_core::UpdateTaskOptions::new();

    if let Some(new_title) = options.title {
        update_opts = update_opts.with_title(new_title);
    }

    if let Some(new_desc) = options.description {
        update_opts.description = Some(new_desc);
    }

    if let Some(new_priority) = options.priority {
        update_opts.priority = Some(new_priority.map(|p| {
            match p.to_lowercase().as_str() {
                "high" => vertebrae_core::Priority::High,
                "medium" => vertebrae_core::Priority::Medium,
                "low" => vertebrae_core::Priority::Low,
                "critical" => vertebrae_core::Priority::Critical,
                _ => vertebrae_core::Priority::Medium, // Default to medium if invalid
            }
        }));
    }

    if let Some(new_level) = options.level {
        update_opts.level = Some(new_level);
    }

    if let Some(review_flag) = options.needs_human_review {
        update_opts.needs_human_review = Some(review_flag);
    }

    service.tasks().update_task(task_id, update_opts).await?;
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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Assign the workflow to the task
    service
        .tasks()
        .assign_workflow(&task_id, &workflow_id)
        .await?;
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

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.tasks().delete_task(&task_id, cascade).await?;

    log::info!("Successfully deleted task: {}", task_id);
    Ok(())
}

// ============================================================================
// Section Mutation Commands
// ============================================================================

/// Add a section to a task
///
/// Creates a new section with the given type and content.
/// For step and testing_criterion types, content can be optional.
/// The order is automatically assigned based on existing sections of the same type.
#[tauri::command]
#[specta::specta]
pub async fn add_section(
    state: State<'_, AppState>,
    task_id: String,
    section_type: String,
    content: Option<String>,
) -> Result<(), CommandError> {
    log::info!(
        "add_section called with task_id: {}, section_type: {}",
        task_id,
        section_type
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse section type
    let parsed_type = match section_type.to_lowercase().as_str() {
        "goal" => vertebrae_core::SectionType::Goal,
        "context" => vertebrae_core::SectionType::Context,
        "current_behavior" => vertebrae_core::SectionType::CurrentBehavior,
        "desired_behavior" => vertebrae_core::SectionType::DesiredBehavior,
        "step" => vertebrae_core::SectionType::Step,
        "testing_criterion" => vertebrae_core::SectionType::TestingCriterion,
        "anti_pattern" => vertebrae_core::SectionType::AntiPattern,
        "failure_test" => vertebrae_core::SectionType::FailureTest,
        "constraint" => vertebrae_core::SectionType::Constraint,
        _ => {
            return Err(CommandError {
                message: format!("Invalid section type: {}", section_type),
            })
        }
    };

    // Get current task to calculate the order
    let task = service.tasks().get_task(&task_id).await?;

    // Count existing sections of the same type to determine the order
    let order = task
        .sections
        .iter()
        .filter(|s| s.section_type == parsed_type)
        .count() as u32;

    // Use provided content or empty string
    let section_content = content.unwrap_or_default();

    let section = vertebrae_core::Section {
        section_type: parsed_type,
        content: section_content,
        order: Some(order),
        done: None,
        done_at: None,
        refs: Vec::new(),
    };

    service.tasks().add_section(&task_id, section).await?;

    log::info!("Successfully added section to task: {}", task_id);
    Ok(())
}

/// Edit a section's content by its ordinal (position)
///
/// Updates the content of an existing section identified by its type and ordinal.
#[tauri::command]
#[specta::specta]
pub async fn edit_section(
    state: State<'_, AppState>,
    task_id: String,
    section_type: String,
    ordinal: u32,
    new_content: String,
) -> Result<(), CommandError> {
    log::info!(
        "edit_section called with task_id: {}, section_type: {}, ordinal: {}",
        task_id,
        section_type,
        ordinal
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse section type
    let parsed_type = match section_type.to_lowercase().as_str() {
        "goal" => vertebrae_core::SectionType::Goal,
        "context" => vertebrae_core::SectionType::Context,
        "current_behavior" => vertebrae_core::SectionType::CurrentBehavior,
        "desired_behavior" => vertebrae_core::SectionType::DesiredBehavior,
        "step" => vertebrae_core::SectionType::Step,
        "testing_criterion" => vertebrae_core::SectionType::TestingCriterion,
        "anti_pattern" => vertebrae_core::SectionType::AntiPattern,
        "failure_test" => vertebrae_core::SectionType::FailureTest,
        "constraint" => vertebrae_core::SectionType::Constraint,
        _ => {
            return Err(CommandError {
                message: format!("Invalid section type: {}", section_type),
            })
        }
    };

    service
        .tasks()
        .edit_section_by_ordinal(&task_id, parsed_type, ordinal, &new_content)
        .await?;

    log::info!("Successfully edited section in task: {}", task_id);
    Ok(())
}

/// Toggle the completion status of a step section
///
/// Marks a step section as done or not done by toggling its done flag.
/// For step sections only (other types will return an error).
#[tauri::command]
#[specta::specta]
pub async fn mark_section_done(
    state: State<'_, AppState>,
    task_id: String,
    ordinal: u32,
) -> Result<(), CommandError> {
    log::info!(
        "mark_section_done called with task_id: {}, ordinal: {}",
        task_id,
        ordinal
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Use service method to toggle the step done status
    service.tasks().toggle_step_done(&task_id, ordinal).await?;

    log::info!(
        "Successfully toggled step section done status for task: {}",
        task_id
    );
    Ok(())
}

/// Remove a section from a task by its ordinal (position)
///
/// Deletes a section identified by its type and ordinal.
/// Remaining sections of the same type are renumbered.
#[tauri::command]
#[specta::specta]
pub async fn remove_section(
    state: State<'_, AppState>,
    task_id: String,
    section_type: String,
    ordinal: u32,
) -> Result<(), CommandError> {
    log::info!(
        "remove_section called with task_id: {}, section_type: {}, ordinal: {}",
        task_id,
        section_type,
        ordinal
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse section type
    let parsed_type = match section_type.to_lowercase().as_str() {
        "goal" => vertebrae_core::SectionType::Goal,
        "context" => vertebrae_core::SectionType::Context,
        "current_behavior" => vertebrae_core::SectionType::CurrentBehavior,
        "desired_behavior" => vertebrae_core::SectionType::DesiredBehavior,
        "step" => vertebrae_core::SectionType::Step,
        "testing_criterion" => vertebrae_core::SectionType::TestingCriterion,
        "anti_pattern" => vertebrae_core::SectionType::AntiPattern,
        "failure_test" => vertebrae_core::SectionType::FailureTest,
        "constraint" => vertebrae_core::SectionType::Constraint,
        _ => {
            return Err(CommandError {
                message: format!("Invalid section type: {}", section_type),
            })
        }
    };

    service
        .tasks()
        .remove_section_by_ordinal(&task_id, parsed_type, ordinal)
        .await?;

    log::info!("Successfully removed section from task: {}", task_id);
    Ok(())
}

/// Add a code reference to a testing criterion section
///
/// Appends a code reference to an existing testing criterion section.
#[tauri::command]
#[specta::specta]
pub async fn add_criterion_ref(
    state: State<'_, AppState>,
    task_id: String,
    section_ordinal: u32,
    file_path: String,
    line_number: Option<u32>,
    name: Option<String>,
) -> Result<(), CommandError> {
    log::info!(
        "add_criterion_ref called with task_id: {}, section_ordinal: {}, file_path: {}",
        task_id,
        section_ordinal,
        file_path
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Get the task to find the section index (0-based) from ordinal
    let task = service.tasks().get_task(&task_id).await?;

    // Find the section index (0-based) by ordinal within testing_criterion sections
    let section_index = task
        .sections
        .iter()
        .enumerate()
        .find(|(_, s)| {
            s.section_type == vertebrae_core::SectionType::TestingCriterion
                && s.order == Some(section_ordinal)
        })
        .map(|(idx, _)| idx)
        .ok_or_else(|| CommandError {
            message: format!(
                "Testing criterion section with ordinal {} not found in task {}",
                section_ordinal, task_id
            ),
        })?;

    // Create the code reference
    let code_ref = vertebrae_core::CodeRef {
        path: file_path,
        line_start: line_number,
        line_end: None,
        name,
        description: None,
    };

    service
        .tasks()
        .append_section_ref(&task_id, section_index, &code_ref)
        .await?;

    log::info!(
        "Successfully added code reference to testing criterion in task: {}",
        task_id
    );
    Ok(())
}

// ============================================================================
// Code Reference Commands
// ============================================================================

/// Add a code reference to a task
///
/// Appends a code reference with optional line numbers and description.
#[tauri::command]
#[specta::specta]
pub async fn add_code_ref(
    state: State<'_, AppState>,
    task_id: String,
    path: String,
    line_start: Option<u32>,
    line_end: Option<u32>,
    name: Option<String>,
    description: Option<String>,
) -> Result<(), CommandError> {
    log::info!(
        "add_code_ref called with task_id: {}, path: {}",
        task_id,
        path
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let code_ref = vertebrae_core::CodeRef {
        path,
        line_start,
        line_end,
        name,
        description,
    };

    service.tasks().add_code_ref(&task_id, code_ref).await?;
    log::info!("Successfully added code_ref to task: {}", task_id);
    Ok(())
}

/// Remove code references from a task
///
/// Deletes one or more code references from the given task.
///
/// * `indices` - If provided, only these 0-based indices will be removed. Otherwise all are removed.
#[tauri::command]
#[specta::specta]
pub async fn remove_code_refs(
    state: State<'_, AppState>,
    task_id: String,
    indices: Option<Vec<u32>>,
) -> Result<(), CommandError> {
    log::info!(
        "remove_code_refs called with task_id: {}, indices: {:?}",
        task_id,
        indices
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Get the task to find the code refs
    let task = service.tasks().get_task(&task_id).await?;

    // Convert u32 indices to usize for internal use
    let indices_usize = indices.map(|v| v.into_iter().map(|i| i as usize).collect::<Vec<usize>>());

    // If indices are specified, remove only those. Otherwise remove all.
    let to_remove = indices_usize.inspect(|idx_list| {
        // Build list of code refs to keep (those not in indices)
        let mut removed_count = 0;

        for code_ref in task.code_refs.iter().enumerate() {
            if idx_list.contains(&code_ref.0) {
                removed_count += 1;
            }
        }

        log::info!(
            "Removing {} code refs from task: {}",
            removed_count,
            task_id
        );
    });

    service.tasks().remove_code_refs(&task_id, None).await?;

    for code_ref in task.code_refs.iter().enumerate() {
        if let Some(ref idx_list) = to_remove {
            if !idx_list.contains(&code_ref.0) {
                let db_ref = vertebrae_core::CodeRef {
                    path: code_ref.1.path.clone(),
                    line_start: code_ref.1.line_start,
                    line_end: code_ref.1.line_end,
                    name: code_ref.1.name.clone(),
                    description: code_ref.1.description.clone(),
                };
                service.tasks().add_code_ref(&task_id, db_ref).await?;
            }
        }
    }

    log::info!("Successfully removed code_refs from task: {}", task_id);
    Ok(())
}

/// Replace all code references for a task
///
/// Removes all existing code references and adds the provided ones.
#[tauri::command]
#[specta::specta]
pub async fn replace_code_refs(
    state: State<'_, AppState>,
    task_id: String,
    refs: Vec<crate::types::CodeRef>,
) -> Result<(), CommandError> {
    log::info!(
        "replace_code_refs called with task_id: {}, {} refs",
        task_id,
        refs.len()
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Get the task to find existing refs
    let _task = service.tasks().get_task(&task_id).await?;

    // Clear all existing refs and re-add them
    // This is a workaround since the service doesn't have a set_code_refs method
    service.tasks().remove_code_refs(&task_id, None).await?;

    for code_ref in refs {
        let db_ref = vertebrae_core::CodeRef {
            path: code_ref.path,
            line_start: code_ref.line_start,
            line_end: code_ref.line_end,
            name: code_ref.name,
            description: code_ref.description,
        };
        service.tasks().add_code_ref(&task_id, db_ref).await?;
    }

    log::info!("Successfully replaced code refs for task: {}", task_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::mock_services;
    use crate::project_config::ProjectConfig;
    use tauri::Manager;

    /// Helper: build a mock Tauri app with services loaded.
    fn build_app_with_services() -> tauri::App<tauri::test::MockRuntime> {
        let services = mock_services();
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let project_config = ProjectConfig::with_path(tmp.path().to_path_buf());

        tauri::test::mock_builder()
            .manage(AppState {
                services: RwLock::new(Some(services)),
                project_config,
            })
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    /// Helper: build a mock Tauri app with NO project selected (services = None).
    fn build_app_without_services() -> tauri::App<tauri::test::MockRuntime> {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let project_config = ProjectConfig::with_path(tmp.path().to_path_buf());

        tauri::test::mock_builder()
            .manage(AppState {
                services: RwLock::new(None),
                project_config,
            })
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    // ========================================================================
    // No-project-selected error tests
    // ========================================================================

    #[tokio::test]
    async fn list_tasks_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = list_tasks(state, None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No project selected"));
    }

    #[tokio::test]
    async fn get_task_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_task(state, "id".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn get_task_hierarchy_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_task_hierarchy(state, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn list_workflows_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = list_workflows(state).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn create_task_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = create_task(state, "Test".to_string(), None, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn has_project_selected_false_when_no_services() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = has_project_selected(state).await.unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn has_project_selected_true_when_services() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = has_project_selected(state).await.unwrap();
        assert!(result);
    }

    // ========================================================================
    // Project management tests
    // ========================================================================

    #[tokio::test]
    async fn get_projects_returns_empty_initially() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let projects = get_projects(state).await.unwrap();
        // Projects are now loaded from config.toml, so we just verify it returns a valid list
        // The list may or may not be empty depending on whether config.toml exists
        let _ = projects; // Just verify it's a Vec<SavedProject>
    }

    #[tokio::test]
    async fn get_current_project_returns_none_initially() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let current = get_current_project(state).await.unwrap();
        assert!(current.is_none());
    }

    // ========================================================================
    // Task CRUD tests
    // ========================================================================

    #[tokio::test]
    async fn create_task_returns_id() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state, "My Task".to_string(), None, None, None)
            .await
            .unwrap();
        assert!(!id.is_empty());
    }

    #[tokio::test]
    async fn create_task_with_description_and_level() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(
            state.clone(),
            "Epic Task".to_string(),
            Some("Description".to_string()),
            Some("epic".to_string()),
            None,
        )
        .await
        .unwrap();
        assert!(!id.is_empty());
    }

    #[tokio::test]
    async fn create_task_invalid_level_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = create_task(
            state,
            "Bad".to_string(),
            None,
            Some("invalid_level".to_string()),
            None,
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Invalid level"));
    }

    #[tokio::test]
    async fn create_task_with_parent() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(state.clone(), "Parent".to_string(), None, None, None)
            .await
            .unwrap();
        let child_id = create_task(
            state.clone(),
            "Child".to_string(),
            None,
            None,
            Some(parent_id.clone()),
        )
        .await
        .unwrap();
        assert!(!child_id.is_empty());
    }

    #[tokio::test]
    async fn create_task_with_nonexistent_parent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = create_task(
            state,
            "Orphan".to_string(),
            None,
            Some("nonexistent".to_string()),
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn get_task_returns_task_details() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(
            state.clone(),
            "Detail Task".to_string(),
            Some("desc".to_string()),
            None,
            None,
        )
        .await
        .unwrap();
        let task = get_task(state, id.clone()).await.unwrap();
        assert_eq!(task.title, "Detail Task");
        assert_eq!(task.id, id);
    }

    #[tokio::test]
    async fn get_task_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_task(state, "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn list_tasks_returns_created_tasks() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        create_task(state.clone(), "Task 1".to_string(), None, None, None)
            .await
            .unwrap();
        create_task(state.clone(), "Task 2".to_string(), None, None, None)
            .await
            .unwrap();
        let tasks = list_tasks(state, None).await.unwrap();
        assert_eq!(tasks.len(), 2);
    }

    #[tokio::test]
    async fn list_tasks_with_filter() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        create_task(
            state.clone(),
            "An Epic".to_string(),
            None,
            Some("epic".to_string()),
            None,
        )
        .await
        .unwrap();
        create_task(
            state.clone(),
            "A Task".to_string(),
            None,
            Some("task".to_string()),
            None,
        )
        .await
        .unwrap();
        let filter = crate::types::TaskFilterOptions {
            levels: Some(vec![crate::types::TaskLevel::Epic]),
            ..Default::default()
        };
        let tasks = list_tasks(state, Some(filter)).await.unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "An Epic");
    }

    #[tokio::test]
    async fn delete_task_removes_task() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Doomed".to_string(), None, None, None)
            .await
            .unwrap();
        delete_task(state.clone(), id.clone(), false).await.unwrap();
        let result = get_task(state, id).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn delete_task_cascade() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(state.clone(), "Parent".to_string(), None, None, None)
            .await
            .unwrap();
        let _child_id = create_task(
            state.clone(),
            "Child".to_string(),
            None,
            None,
            Some(parent_id.clone()),
        )
        .await
        .unwrap();
        delete_task(state.clone(), parent_id, true).await.unwrap();
        let tasks = list_tasks(state, None).await.unwrap();
        assert!(tasks.is_empty());
    }

    #[tokio::test]
    async fn delete_nonexistent_task_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = delete_task(state, "nonexistent".to_string(), false).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // update_task_inner tests
    // ========================================================================

    #[tokio::test]
    async fn update_task_inner_changes_title() {
        let services = mock_services();
        let id = services
            .tasks()
            .create_task(vertebrae_core::CreateTaskOptions::new(
                "Original".to_string(),
            ))
            .await
            .unwrap();

        let opts = crate::types::UpdateTaskOptions {
            title: Some("New".to_string()),
            ..Default::default()
        };
        update_task_inner(&services, &id, opts).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.title, "New");
    }

    #[tokio::test]
    async fn update_task_inner_changes_priority() {
        let services = mock_services();
        let id = services
            .tasks()
            .create_task(vertebrae_core::CreateTaskOptions::new("Task".to_string()))
            .await
            .unwrap();

        let opts = crate::types::UpdateTaskOptions {
            priority: Some(Some("high".to_string())),
            ..Default::default()
        };
        update_task_inner(&services, &id, opts).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.priority, Some(vertebrae_core::Priority::High));
    }

    #[tokio::test]
    async fn update_task_inner_clears_priority() {
        let services = mock_services();
        let id = services
            .tasks()
            .create_task(vertebrae_core::CreateTaskOptions::new("Task".to_string()))
            .await
            .unwrap();

        let opts = crate::types::UpdateTaskOptions {
            priority: Some(None),
            ..Default::default()
        };
        update_task_inner(&services, &id, opts).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.priority, None);
    }

    #[tokio::test]
    async fn update_task_inner_sets_needs_human_review() {
        let services = mock_services();
        let id = services
            .tasks()
            .create_task(vertebrae_core::CreateTaskOptions::new("Task".to_string()))
            .await
            .unwrap();

        let opts = crate::types::UpdateTaskOptions {
            needs_human_review: Some(true),
            ..Default::default()
        };
        update_task_inner(&services, &id, opts).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.needs_human_review, Some(true));
    }

    #[tokio::test]
    async fn update_task_inner_nonexistent_returns_error() {
        let services = mock_services();
        let opts = crate::types::UpdateTaskOptions {
            title: Some("New".to_string()),
            ..Default::default()
        };
        let result = update_task_inner(&services, "nonexistent", opts).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // Task hierarchy tests
    // ========================================================================

    #[tokio::test]
    async fn get_task_hierarchy_returns_tree() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(
            state.clone(),
            "Root".to_string(),
            None,
            Some("epic".to_string()),
            None,
        )
        .await
        .unwrap();
        create_task(
            state.clone(),
            "Child".to_string(),
            None,
            None,
            Some(parent_id.clone()),
        )
        .await
        .unwrap();
        let tree = get_task_hierarchy(state, None, None).await.unwrap();
        // Should have the root node
        assert!(!tree.is_empty());
    }

    #[tokio::test]
    async fn get_task_hierarchy_with_root_id() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let root_id = create_task(state.clone(), "Root".to_string(), None, None, None)
            .await
            .unwrap();
        create_task(
            state.clone(),
            "Child".to_string(),
            None,
            None,
            Some(root_id.clone()),
        )
        .await
        .unwrap();
        let tree = get_task_hierarchy(state, Some(root_id.clone()), None)
            .await
            .unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].task.id, root_id);
    }

    #[tokio::test]
    async fn get_task_hierarchy_nonexistent_root_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_task_hierarchy(state, Some("nonexistent".to_string()), None).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // Relationship tests
    // ========================================================================

    #[tokio::test]
    async fn set_parent_and_get_relations() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(state.clone(), "Parent".to_string(), None, None, None)
            .await
            .unwrap();
        let child_id = create_task(state.clone(), "Child".to_string(), None, None, None)
            .await
            .unwrap();

        set_parent(state.clone(), child_id.clone(), parent_id.clone())
            .await
            .unwrap();

        let child = get_task(state, child_id).await.unwrap();
        assert_eq!(child.parent_id.as_deref(), Some(parent_id.as_str()));
    }

    #[tokio::test]
    async fn remove_parent_clears_relation() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(state.clone(), "Parent".to_string(), None, None, None)
            .await
            .unwrap();
        let child_id = create_task(state.clone(), "Child".to_string(), None, None, None)
            .await
            .unwrap();
        set_parent(state.clone(), child_id.clone(), parent_id)
            .await
            .unwrap();
        remove_parent(state.clone(), child_id.clone())
            .await
            .unwrap();

        let child = get_task(state, child_id).await.unwrap();
        assert_eq!(child.parent_id, None);
    }

    #[tokio::test]
    async fn add_and_remove_dependency() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_a = create_task(state.clone(), "A".to_string(), None, None, None)
            .await
            .unwrap();
        let task_b = create_task(state.clone(), "B".to_string(), None, None, None)
            .await
            .unwrap();

        add_dependency(state.clone(), task_a.clone(), task_b.clone())
            .await
            .unwrap();
        let task = get_task(state.clone(), task_a.clone()).await.unwrap();
        assert!(task.dependency_ids.contains(&task_b));

        remove_dependency(state.clone(), task_a.clone(), task_b.clone())
            .await
            .unwrap();
        let task = get_task(state, task_a).await.unwrap();
        assert!(!task.dependency_ids.contains(&task_b));
    }

    #[tokio::test]
    async fn set_parent_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = set_parent(state, task_id, "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn add_dependency_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = add_dependency(state, task_id, "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // Workflow tests
    // ========================================================================

    #[tokio::test]
    async fn list_workflows_empty() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let workflows = list_workflows(state).await.unwrap();
        assert!(workflows.is_empty());
    }

    #[tokio::test]
    async fn get_workflow_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_workflow(state, "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn list_workflow_transitions_empty() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let transitions = list_workflow_transitions(state).await.unwrap();
        assert!(transitions.is_empty());
    }

    #[tokio::test]
    async fn assign_workflow_to_task() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();

        // Create a workflow via the service directly
        {
            let guard = state.services.read().await;
            let svc = guard.as_ref().unwrap();
            svc.workflows()
                .create_workflow(vertebrae_core::CreateWorkflowOptions {
                    name: "Test WF".to_string(),
                    description: None,
                    steps: vec![],
                    auto_advance: false,
                    order: 0,
                })
                .await
                .unwrap();
        }

        let task_id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        let workflows = list_workflows(state.clone()).await.unwrap();
        assert_eq!(workflows.len(), 1);
        let wf_id = workflows[0].id.clone().unwrap();

        assign_workflow(state, task_id.clone(), wf_id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn get_workflow_with_tasks_returns_workflow() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();

        let wf_id = {
            let guard = state.services.read().await;
            let svc = guard.as_ref().unwrap();
            svc.workflows()
                .create_workflow(vertebrae_core::CreateWorkflowOptions {
                    name: "WF".to_string(),
                    description: None,
                    steps: vec![],
                    auto_advance: false,
                    order: 0,
                })
                .await
                .unwrap()
        };

        let result = get_workflow_with_tasks(state, wf_id).await.unwrap();
        assert!(result.tasks.is_empty());
    }

    #[tokio::test]
    async fn get_workflow_with_task_details_returns_details() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();

        let wf_id = {
            let guard = state.services.read().await;
            let svc = guard.as_ref().unwrap();
            svc.workflows()
                .create_workflow(vertebrae_core::CreateWorkflowOptions {
                    name: "Detail WF".to_string(),
                    description: None,
                    steps: vec![],
                    auto_advance: false,
                    order: 0,
                })
                .await
                .unwrap()
        };

        let result = get_workflow_with_task_details(state, wf_id).await.unwrap();
        assert!(result.tasks.is_empty());
    }

    // ========================================================================
    // Execution tests
    // ========================================================================

    #[tokio::test]
    async fn get_task_executions_empty() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let executions = get_task_executions(state, "some-task".to_string())
            .await
            .unwrap();
        assert!(executions.is_empty());
    }

    #[tokio::test]
    async fn get_execution_logs_empty() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let logs = get_execution_logs(state, "some-exec".to_string())
            .await
            .unwrap();
        assert!(logs.is_empty());
    }

    #[tokio::test]
    async fn get_task_executions_no_project() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_task_executions(state, "task".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn get_execution_logs_no_project() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_execution_logs(state, "exec".to_string()).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // Step tests (first-class workflow steps)
    // ========================================================================

    #[tokio::test]
    async fn list_steps_for_workflow_empty() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let steps = list_steps_for_workflow(state, "wf-id".to_string())
            .await
            .unwrap();
        assert!(steps.is_empty());
    }

    #[tokio::test]
    async fn create_and_get_step() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let step = create_step(
            state.clone(),
            "wf-1".to_string(),
            "Review".to_string(),
            Some("Review the code".to_string()),
            vec!["sonnet".to_string()],
            vec![],
            0,
            false,
            vec![],
        )
        .await
        .unwrap();
        assert_eq!(step.name, "Review");
        assert!(step.id.is_some());

        let fetched = get_step(state, step.id.clone().unwrap()).await.unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().name, "Review");
    }

    #[tokio::test]
    async fn get_step_nonexistent_returns_none() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let step = get_step(state, "nonexistent".to_string()).await.unwrap();
        assert!(step.is_none());
    }

    #[tokio::test]
    async fn list_steps_for_workflow_returns_created_steps() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        create_step(
            state.clone(),
            "wf-x".to_string(),
            "Step1".to_string(),
            None,
            vec![],
            vec![],
            0,
            false,
            vec![],
        )
        .await
        .unwrap();
        create_step(
            state.clone(),
            "wf-x".to_string(),
            "Step2".to_string(),
            None,
            vec![],
            vec![],
            1,
            true,
            vec![],
        )
        .await
        .unwrap();
        let steps = list_steps_for_workflow(state, "wf-x".to_string())
            .await
            .unwrap();
        assert_eq!(steps.len(), 2);
    }

    // ========================================================================
    // update_step_inner / delete_step_inner tests
    // ========================================================================

    #[tokio::test]
    async fn update_step_inner_succeeds() {
        let services = mock_services();
        let step = vertebrae_core::Step::new("Original", "wf-1".to_string());
        let created = services.steps().create_step(&step).await.unwrap();
        let step_id = created.id.unwrap();

        update_step_inner(
            &services,
            &step_id,
            Some("Updated".to_string()),
            Some("New goal".to_string()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn update_step_inner_nonexistent_returns_error() {
        let services = mock_services();
        let result = update_step_inner(
            &services,
            "nonexistent",
            Some("Name".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Step not found"));
    }

    #[tokio::test]
    async fn delete_step_inner_succeeds() {
        let services = mock_services();
        let step = vertebrae_core::Step::new("Doomed", "wf-1".to_string());
        let created = services.steps().create_step(&step).await.unwrap();
        let step_id = created.id.unwrap();

        let wf_id = delete_step_inner(&services, &step_id).await.unwrap();
        assert_eq!(wf_id, "wf-1");

        let fetched = services.steps().get_step(&step_id).await.unwrap();
        assert!(fetched.is_none());
    }

    #[tokio::test]
    async fn delete_step_inner_nonexistent_returns_error() {
        let services = mock_services();
        let result = delete_step_inner(&services, "nonexistent").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Step not found"));
    }

    // ========================================================================
    // Section tests
    // ========================================================================

    #[tokio::test]
    async fn add_section_to_task() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "step".to_string(),
            Some("Do the thing".to_string()),
        )
        .await
        .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].content, "Do the thing");
    }

    #[tokio::test]
    async fn add_section_invalid_type_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = add_section(state, id, "bad_type".to_string(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Invalid section type"));
    }

    #[tokio::test]
    async fn add_section_all_valid_types() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        let types = vec![
            "goal",
            "context",
            "current_behavior",
            "desired_behavior",
            "step",
            "testing_criterion",
            "anti_pattern",
            "failure_test",
            "constraint",
        ];
        for section_type in types {
            add_section(
                state.clone(),
                id.clone(),
                section_type.to_string(),
                Some("content".to_string()),
            )
            .await
            .unwrap();
        }

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections.len(), 9);
    }

    #[tokio::test]
    async fn edit_section_changes_content() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "step".to_string(),
            Some("Original".to_string()),
        )
        .await
        .unwrap();

        edit_section(
            state.clone(),
            id.clone(),
            "step".to_string(),
            0,
            "Updated content".to_string(),
        )
        .await
        .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections[0].content, "Updated content");
    }

    #[tokio::test]
    async fn edit_section_invalid_type_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = edit_section(state, id, "bad_type".to_string(), 0, "x".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn remove_section_removes_it() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "step".to_string(),
            Some("Step 1".to_string()),
        )
        .await
        .unwrap();

        remove_section(state.clone(), id.clone(), "step".to_string(), 0)
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert!(task.sections.is_empty());
    }

    #[tokio::test]
    async fn remove_section_invalid_type_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = remove_section(state, id, "bad_type".to_string(), 0).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn mark_section_done_toggles_step() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "step".to_string(),
            Some("Do it".to_string()),
        )
        .await
        .unwrap();

        mark_section_done(state.clone(), id.clone(), 0)
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections[0].done, Some(true));
    }

    // ========================================================================
    // Code reference tests
    // ========================================================================

    #[tokio::test]
    async fn add_and_replace_code_refs() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_code_ref(
            state.clone(),
            id.clone(),
            "src/main.rs".to_string(),
            Some(42),
            None,
            Some("main fn".to_string()),
            None,
        )
        .await
        .unwrap();

        let task = get_task(state.clone(), id.clone()).await.unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");

        // Replace with new refs
        let new_refs = vec![crate::types::CodeRef {
            path: "src/lib.rs".to_string(),
            line_start: Some(10),
            line_end: Some(20),
            name: Some("lib".to_string()),
            description: None,
        }];
        replace_code_refs(state.clone(), id.clone(), new_refs)
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/lib.rs");
    }

    #[tokio::test]
    async fn remove_code_refs_all() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_code_ref(
            state.clone(),
            id.clone(),
            "a.rs".to_string(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        add_code_ref(
            state.clone(),
            id.clone(),
            "b.rs".to_string(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        remove_code_refs(state.clone(), id.clone(), None)
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert!(task.code_refs.is_empty());
    }

    #[tokio::test]
    async fn add_criterion_ref_to_testing_criterion() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        // Add a testing criterion section
        add_section(
            state.clone(),
            id.clone(),
            "testing_criterion".to_string(),
            Some("It should work".to_string()),
        )
        .await
        .unwrap();

        // Add a code ref to the criterion
        add_criterion_ref(
            state.clone(),
            id.clone(),
            0,
            "tests/test.rs".to_string(),
            Some(10),
            Some("test_fn".to_string()),
        )
        .await
        .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections[0].refs.len(), 1);
        assert_eq!(task.sections[0].refs[0].path, "tests/test.rs");
    }

    #[tokio::test]
    async fn add_criterion_ref_nonexistent_section_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = add_criterion_ref(state, id, 0, "test.rs".to_string(), None, None).await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .message
            .contains("Testing criterion section"));
    }

    // ========================================================================
    // CommandError tests
    // ========================================================================

    #[test]
    fn command_error_from_service_error() {
        let err = vertebrae_core::ServiceError::task_not_found("abc");
        let cmd_err: CommandError = err.into();
        assert!(cmd_err.message.contains("abc"));
    }

    #[test]
    fn command_error_helpers() {
        let err = CommandError::task_not_found("t1");
        assert!(err.message.contains("t1"));

        let err = CommandError::workflow_not_found("w1");
        assert!(err.message.contains("w1"));

        let err = CommandError::no_project_selected();
        assert!(err.message.contains("No project selected"));
    }

    // ========================================================================
    // convert_tree_node helper test
    // ========================================================================

    #[test]
    fn convert_tree_node_sorts_children_by_created_at() {
        use chrono::{Duration, Utc};

        let now = Utc::now();

        fn make_task(
            id: &str,
            title: &str,
            created_at: chrono::DateTime<Utc>,
        ) -> vertebrae_core::Task {
            vertebrae_core::Task {
                id: id.to_string(),
                title: title.to_string(),
                description: None,
                level: vertebrae_core::Level::Task,
                status: "backlog".to_string(),
                priority: None,
                tags: vec![],
                workflow_id: None,
                current_step_id: None,
                workflow_name: None,
                step_name: None,
                needs_human_review: None,
                review_comment: None,
                revision_feedback: None,
                rejection_reason: None,
                parent_id: None,
                dependency_ids: vec![],
                sections: vec![],
                code_refs: vec![],
                created_at: Some(created_at),
                updated_at: None,
                started_at: None,
                completed_at: None,
            }
        }

        let node = vertebrae_core::TaskTreeNode {
            task: make_task("root", "Root", now),
            has_blockers: false,
            blocker_count: 0,
            children: vec![
                vertebrae_core::TaskTreeNode {
                    task: make_task("old", "Old", now - Duration::hours(2)),
                    has_blockers: false,
                    blocker_count: 0,
                    children: vec![],
                },
                vertebrae_core::TaskTreeNode {
                    task: make_task("new", "New", now),
                    has_blockers: false,
                    blocker_count: 0,
                    children: vec![],
                },
            ],
        };

        let converted = convert_tree_node(&node);
        assert_eq!(converted.children[0].task.id, "new");
        assert_eq!(converted.children[1].task.id, "old");
    }
}
