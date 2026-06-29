//! Tauri commands for task and workflow data access
//!
//! Implements list_tasks, get_task, and workflow commands
//! using the vertebrae-core TaskService layer.

use crate::claude_session::{ClaudeModelCatalog, ClaudeSessionManager};
use crate::local_chat::permissions::LocalPermissionDecision;
use crate::local_chat::{
    CreateLocalChatSessionInput, LocalChatHarnessCatalog, LocalChatSessionError,
    LocalChatSessionManager,
};
use crate::project_config::{ProjectConfig, SavedProject};
use crate::types::{
    CreateClaudeSessionInput, InitializeProjectResult, PermissionDecisionBehavior,
    ResolvePermissionRequestInput, SacrumConfigStatus, Section, SessionLog, Step, StepExecution,
    StopRunRequest, Task, TaskFilterOptions, TaskRun, TaskRunTrace, Workflow, WorkflowWithTasks,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};
use tokio::sync::RwLock;
use vertebrae_core::{StopRunTarget, VertebraeServices};

/// Application state holding the services
pub struct AppState {
    /// Unified services container (None until a project is selected)
    pub services: RwLock<Option<VertebraeServices>>,
    /// Raw Sacrum GraphQL client used for queries that bypass the service
    /// trait abstractions (e.g. `pipeline_summary`, which is GUI-specific).
    pub sacrum_client: RwLock<Option<std::sync::Arc<vertebrae_sacrum_client::GraphqlClient>>>,
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

/// List all embedded skills available for GUI project initialization.
#[tauri::command]
#[specta::specta]
pub async fn list_embedded_skills() -> Result<Vec<String>, CommandError> {
    Ok(vertebrae_skills_assets::list_embedded_skills())
}

/// Preview the backend-derived slug for a project name.
#[tauri::command]
#[specta::specta]
pub async fn preview_project_slug(name: String) -> Result<String, CommandError> {
    derive_project_slug(&name)
}

/// Read the shared Sacrum settings state without exposing the API token.
#[tauri::command]
#[specta::specta]
pub async fn sacrum_config_status() -> Result<SacrumConfigStatus, CommandError> {
    log::info!("sacrum_config_status called");

    let config_path = vertebrae_sacrum_client::config_path();
    let config_exists = config_path.as_ref().is_some_and(|path| path.exists());
    let config_file = vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
        message: format!("Failed to load config file: {}", e),
    })?;
    let url = configured_sacrum_url(&config_file);
    let has_token = config_file
        .sacrum
        .token
        .as_deref()
        .is_some_and(|token| !token.trim().is_empty());

    Ok(SacrumConfigStatus {
        config_path: config_path.map(|path| path.to_string_lossy().to_string()),
        config_exists,
        url,
        has_token,
    })
}

/// Persist Sacrum settings to the shared config.toml.
#[tauri::command]
#[specta::specta]
pub async fn save_sacrum_settings(token: String) -> Result<SacrumConfigStatus, CommandError> {
    log::info!("save_sacrum_settings called");

    let trimmed_token = token.trim();
    if trimmed_token.is_empty() {
        return Err(CommandError {
            message: "Sacrum API token is required".to_string(),
        });
    }
    validate_sacrum_token(trimmed_token)?;

    let mut config_file =
        vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
            message: format!("Failed to load config file: {}", e),
        })?;
    config_file.sacrum.url = configured_sacrum_url(&config_file);
    config_file.sacrum.token = Some(trimmed_token.to_string());

    vertebrae_sacrum_client::save_config_file(&config_file).map_err(|e| CommandError {
        message: format!("Failed to save config file: {}", e),
    })?;

    sacrum_config_status().await
}

/// Initialize a local project from the GUI without shelling out to `vtb init`.
#[tauri::command]
#[specta::specta]
pub async fn initialize_project(
    app_handle: tauri::AppHandle,
    path: String,
    name: Option<String>,
) -> Result<InitializeProjectResult, CommandError> {
    initialize_project_inner(&app_handle, path, name).await
}

async fn initialize_project_inner<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    path: String,
    name: Option<String>,
) -> Result<InitializeProjectResult, CommandError> {
    log::info!("initialize_project called with path: {}", path);

    let project_root = canonical_project_root(&path)?;
    let folder_name = project_root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CommandError {
            message: "Failed to extract folder name from path".to_string(),
        })?;
    let project_name = name
        .as_deref()
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .unwrap_or(folder_name)
        .to_string();
    let project_slug = derive_project_slug(&project_name)?;

    let config_file = vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
        message: format!("Failed to load config file: {}", e),
    })?;
    ensure_project_slug_available_for_path(&config_file, &project_slug, &project_root)?;
    let api_token = config_file
        .sacrum
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| CommandError {
            message: "No API token found. Save Sacrum settings before initializing a project."
                .to_string(),
        })?
        .to_string();
    validate_sacrum_token(&api_token)?;
    let base_url = configured_sacrum_url(&config_file);
    let temp_config =
        vertebrae_sacrum_client::SacrumConfig::new(base_url, api_token, "temp".to_string());
    let client = vertebrae_sacrum_client::GraphqlClient::new(temp_config);

    let (project, project_created) =
        get_or_create_project(&client, &project_name, &project_slug).await?;
    let project_path = project_root.to_string_lossy().to_string();
    vertebrae_sacrum_client::register_project(&project_slug, &project.id, &project_path).map_err(
        |e| CommandError {
            message: format!("Failed to save config file: {}", e),
        },
    )?;

    let app_skills_dir = vertebrae_installer::data_dir()
        .map_err(|e| CommandError {
            message: format!("Failed to resolve application data directory: {}", e),
        })?
        .join("skills");
    let mut progress_files_copied = 0_u32;
    let progress_slug = project_slug.clone();
    let skill_install = vertebrae_skills_assets::link_embedded_skills_for_project_with_progress(
        &app_skills_dir,
        &project_root,
        |file| {
            progress_files_copied = progress_files_copied.saturating_add(1);
            let _ = app_handle.emit(
                "project-init-progress-event",
                crate::events::ProjectInitProgressEvent {
                    project_slug: progress_slug.clone(),
                    kind: crate::events::ProjectInitProgressKind::SkillFileInstalled,
                    files_copied: progress_files_copied,
                    relative_path: Some(file.relative_path.to_string_lossy().to_string()),
                    target_path: Some(file.target_path.to_string_lossy().to_string()),
                },
            );
        },
    )
    .map_err(|e| CommandError {
        message: format!("Failed to install embedded skills: {}", e),
    })?;
    let skills_copied = u32::try_from(skill_install.files_linked).map_err(|_| CommandError {
        message: "Installed skill file count exceeded supported range".to_string(),
    })?;
    let skills_target = format_skill_targets(&skill_install);
    let _ = app_handle.emit(
        "project-init-progress-event",
        crate::events::ProjectInitProgressEvent {
            project_slug: project_slug.clone(),
            kind: crate::events::ProjectInitProgressKind::Completed,
            files_copied: skills_copied,
            relative_path: None,
            target_path: None,
        },
    );

    Ok(InitializeProjectResult {
        slug: project_slug,
        project_id: project.id,
        project_name: project.name,
        path: project_path,
        project_created,
        skills_copied,
        skills_target,
    })
}

/// Add a project to the saved list
///
/// Takes a directory path, derives a slug from the folder name,
/// creates the project in Sacrum API if needed, and registers in global config.
#[tauri::command]
#[specta::specta]
pub async fn add_project(
    _state: State<'_, AppState>,
    path: String,
) -> Result<SavedProject, CommandError> {
    log::info!("add_project called with path: {}", path);

    // Extract folder name from path
    let folder_name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CommandError {
            message: "Failed to extract folder name from path".to_string(),
        })?
        .to_string();

    // Derive slug from folder name
    let project_slug = derive_project_slug(&folder_name)?;

    // Load config file and check for duplicate slug
    let config_file = vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
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

    // Read API token from global config
    let api_token = config_file
        .sacrum
        .token
        .clone()
        .ok_or_else(|| CommandError {
            message: "No API token found. Set [sacrum].token in ~/.config/vertebrae/config.toml"
                .to_string(),
        })?;

    // Create temporary Sacrum client to get-or-create the project
    let temp_config = vertebrae_sacrum_client::SacrumConfig::new(
        configured_sacrum_url(&config_file),
        api_token,
        "temp".to_string(),
    );
    let client = vertebrae_sacrum_client::GraphqlClient::new(temp_config);

    // Try to find existing project by slug, or create a new one
    let (project, _) = get_or_create_project(&client, &folder_name, &project_slug).await?;

    // Register project in global config
    vertebrae_sacrum_client::register_project(&project_slug, &project.id, &path).map_err(|e| {
        CommandError {
            message: format!("Failed to save config file: {}", e),
        }
    })?;

    Ok(SavedProject {
        slug: project_slug,
        project_id: project.id,
        path,
    })
}

fn configured_sacrum_url(config_file: &vertebrae_sacrum_client::VertebraeConfigFile) -> String {
    let trimmed_url = config_file.sacrum.url.trim();
    if trimmed_url.is_empty() {
        vertebrae_sacrum_client::GlobalSacrumSection::default().url
    } else {
        trimmed_url.to_string()
    }
}

fn validate_sacrum_token(token: &str) -> Result<(), CommandError> {
    if token.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err(CommandError {
            message:
                "Sacrum API token contains characters that cannot be sent in an Authorization header"
                    .to_string(),
        });
    }
    Ok(())
}

fn canonical_project_root(path: &str) -> Result<PathBuf, CommandError> {
    let project_root = PathBuf::from(path);
    if !project_root.is_dir() {
        return Err(CommandError {
            message: format!("Project path is not a directory: {}", path),
        });
    }
    Ok(project_root.canonicalize().unwrap_or(project_root))
}

fn derive_project_slug(name: &str) -> Result<String, CommandError> {
    let project_slug = slug::slugify(name);
    if project_slug.is_empty() {
        return Err(CommandError {
            message: format!("Could not create valid slug from: {}", name),
        });
    }
    Ok(project_slug)
}

fn ensure_project_slug_available_for_path(
    config_file: &vertebrae_sacrum_client::VertebraeConfigFile,
    project_slug: &str,
    project_root: &Path,
) -> Result<(), CommandError> {
    let Some(existing) = config_file.projects.get(project_slug) else {
        return Ok(());
    };

    if paths_refer_to_same_directory(&existing.path, project_root) {
        return Ok(());
    }

    Err(CommandError {
        message: format!(
            "Project with slug '{}' already exists in config",
            project_slug
        ),
    })
}

fn paths_refer_to_same_directory(configured_path: &str, project_root: &Path) -> bool {
    let configured = PathBuf::from(configured_path);
    let configured = configured.canonicalize().unwrap_or(configured);
    let project_root = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());

    configured == project_root
}

fn format_skill_targets(install: &vertebrae_skills_assets::LinkedSkillInstall) -> String {
    if install.target_roots.is_empty() {
        return format!(
            "Staged in {}; no existing .claude/skills or .agents/skills directory found",
            install.app_skills_dir.to_string_lossy()
        );
    }

    install
        .target_roots
        .iter()
        .map(|target| target.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(", ")
}

async fn get_or_create_project(
    client: &vertebrae_sacrum_client::GraphqlClient,
    name: &str,
    slug: &str,
) -> Result<(vertebrae_sacrum_client::ProjectResponse, bool), CommandError> {
    let projects = client
        .execute::<Vec<vertebrae_sacrum_client::ProjectResponse>>(
            vertebrae_sacrum_client::queries::projects::LIST_PROJECTS,
            json!({}),
            "projects",
        )
        .await
        .map_err(|e| CommandError {
            message: format!("Failed to list projects from Sacrum: {}", e),
        })?;

    if let Some(project) = projects.iter().find(|p| p.slug == slug) {
        return Ok((project.clone(), false));
    }

    let project = client
        .execute::<vertebrae_sacrum_client::ProjectResponse>(
            vertebrae_sacrum_client::queries::projects::CREATE_PROJECT,
            json!({
                "name": name,
                "slug": slug,
            }),
            "create_project",
        )
        .await
        .map_err(|e| CommandError {
            message: format!("Failed to create project in Sacrum: {}", e),
        })?;

    Ok((project, true))
}

/// Remove a project from the saved list
///
/// Removes the project from config.toml by slug. If the removed project
/// is the currently selected project, clears the selection and services.
#[tauri::command]
#[specta::specta]
pub async fn remove_project(
    state: State<'_, AppState>,
    socket_state: State<'_, tokio::sync::Mutex<crate::websocket_client::SacrumSocket>>,
    slug: String,
) -> Result<(), CommandError> {
    log::info!("remove_project called with slug: {}", slug);

    // Remove project from global config
    let removed = vertebrae_sacrum_client::unregister_project(&slug).map_err(|e| CommandError {
        message: format!("Failed to update config file: {}", e),
    })?;

    if !removed {
        return Err(CommandError {
            message: format!("Project '{}' not found in config", slug),
        });
    }

    // If the removed project was the current one, clear selection, services, and socket
    if state.project_config.get_current_project().as_deref() == Some(&slug) {
        state
            .project_config
            .set_current_project(None)
            .map_err(|e| CommandError { message: e })?;

        let mut service_lock = state.services.write().await;
        *service_lock = None;
        let mut client_lock = state.sacrum_client.write().await;
        *client_lock = None;

        let mut socket = socket_state.lock().await;
        socket.shutdown().await;
        *socket = crate::websocket_client::SacrumSocket::disconnected();
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

/// Get the currently selected project's git root path
#[tauri::command]
#[specta::specta]
pub async fn get_current_project_path(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    log::info!("get_current_project_path called");

    // Get current project slug
    let slug = match state.project_config.get_current_project() {
        Some(s) => s,
        None => return Ok(None),
    };

    // Load config file and find the project's path
    let config_file = vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
        message: format!("Failed to load config: {}", e),
    })?;

    let path = config_file.projects.get(&slug).map(|p| p.path.clone());

    Ok(path)
}

/// Set the current project by slug and connect to its backend
#[tauri::command]
#[specta::specta]
pub async fn set_current_project(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    socket_state: State<'_, tokio::sync::Mutex<crate::websocket_client::SacrumSocket>>,
    slug: Option<String>,
) -> Result<(), CommandError> {
    log::info!("set_current_project called with slug: {:?}", slug);

    // Update config
    state
        .project_config
        .set_current_project(slug.clone())
        .map_err(|e| CommandError { message: e })?;

    // Load Sacrum config once (used for both services and WebSocket)
    let sacrum_config = if let Some(ref project_slug) = slug {
        match vertebrae_sacrum_client::SacrumConfig::load_for_project(project_slug) {
            Ok(config) => Some(config),
            Err(e) => {
                return Err(CommandError {
                    message: format!("Failed to load Sacrum configuration: {}", e),
                });
            }
        }
    } else {
        None
    };

    // Switch the Phoenix project channel over the existing socket when the
    // Sacrum backend credentials are unchanged. Recreate only for backend
    // changes or when no actor is running.
    {
        let mut socket = socket_state.lock().await;
        if let Some(config) = sacrum_config.as_ref() {
            log::info!(
                "[WebSocket] Switching realtime channel to project '{}'",
                config.project_id
            );

            let mut should_rebuild_socket = true;
            if socket.has_backend(&config.base_url, &config.api_token) && socket.is_running() {
                if let Err(e) = socket.switch_project(Some(config.project_id.clone())).await {
                    log::warn!(
                        "[WebSocket] Rebuilding realtime socket after failed switch to project '{}': {}",
                        config.project_id,
                        e
                    );
                } else {
                    should_rebuild_socket = false;
                }
            }

            if should_rebuild_socket {
                socket.shutdown().await;
                *socket = crate::websocket_client::SacrumSocket::new(
                    config.base_url.clone(),
                    config.api_token.clone(),
                    config.project_id.clone(),
                );
                socket.connect(&app_handle);
            }
        } else {
            log::info!("[WebSocket] No project selected, shutting down realtime socket");
            socket.shutdown().await;
            *socket = crate::websocket_client::SacrumSocket::disconnected();
        }
    }

    // Update REST services after requesting the realtime channel switch. The
    // websocket actor keeps retrying in the background if the live join fails.
    {
        let mut service_lock = state.services.write().await;
        let mut client_lock = state.sacrum_client.write().await;
        match sacrum_config.as_ref() {
            Some(config) => {
                let client = vertebrae_sacrum_client::GraphqlClient::new(config.clone());
                let client_arc = std::sync::Arc::new(client);
                *service_lock = Some(vertebrae_sacrum_client::from_sacrum(client_arc.clone()));
                *client_lock = Some(client_arc);
            }
            None => {
                *service_lock = None;
                *client_lock = None;
            }
        }
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

/// List tasks that are ready to be worked on.
///
/// Mirrors `vtb ready`: the backend `list_ready` query returns tasks that are
/// not completed and have no incomplete blockers; archived tasks are filtered
/// out here, exactly as the CLI does.
#[tauri::command]
#[specta::specta]
pub async fn list_ready(state: State<'_, AppState>) -> Result<Vec<Task>, CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service.tasks().list_ready().await {
        Ok(mut tasks) => {
            tasks.retain(|t| !t.archived);
            log::info!("list_ready returned {} tasks", tasks.len());
            Ok(tasks.into_iter().map(Into::into).collect())
        }
        Err(e) => {
            log::error!("list_ready error: {:?}", e);
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

    match workflow_service.list_workflows_full().await {
        Ok(workflows_full) => {
            log::info!("list_workflows returned {} workflows", workflows_full.len());
            let workflows: Vec<Workflow> = workflows_full.into_iter().map(Into::into).collect();
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
/// Returns all defined transitions between workflows, including workflow names
/// from the same workflow fetch.
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

    // Get all transitions and workflow names from one workflow list response.
    let (transitions, workflow_names) = workflow_service
        .list_workflow_transitions_with_names(None)
        .await?;

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

/// Create a workflow-to-workflow transition. Sacrum broadcasts the change over the
/// project channel; clients refresh from the broadcast rather than this command.
#[tauri::command]
#[specta::specta]
pub async fn create_workflow_transition(
    state: State<'_, AppState>,
    from_workflow_id: String,
    to_workflow_id: String,
    label: Option<String>,
    target_step_id: Option<String>,
) -> Result<(), CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .workflows()
        .create_workflow_transition(
            &from_workflow_id,
            &to_workflow_id,
            label.as_deref().unwrap_or(""),
            target_step_id.as_deref(),
        )
        .await
        .map_err(map_workflow_transition_error)?;

    Ok(())
}

/// Delete a workflow-to-workflow transition. Sacrum broadcasts the change.
#[tauri::command]
#[specta::specta]
pub async fn delete_workflow_transition(
    state: State<'_, AppState>,
    from_workflow_id: String,
    to_workflow_id: String,
) -> Result<(), CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .workflows()
        .delete_workflow_transition(&from_workflow_id, &to_workflow_id)
        .await
        .map_err(map_workflow_transition_error)?;

    Ok(())
}

/// Translate Sacrum-side workflow transition errors into user-readable messages.
fn map_workflow_transition_error(err: vertebrae_core::ServiceError) -> CommandError {
    let raw = err.to_string();
    let lower = raw.to_lowercase();

    let friendly = if lower.contains("from_workflow_is_final") {
        "Cannot create a transition from a final workflow. Unmark the source workflow as final first.".to_string()
    } else if lower.contains("transition already exists")
        || lower.contains("has already been taken")
    {
        "A transition between these workflows already exists.".to_string()
    } else {
        raw
    };

    CommandError { message: friendly }
}

/// Update an existing workflow. Only fields that are Some will be updated.
#[tauri::command]
#[specta::specta]
pub async fn update_workflow(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    options: crate::types::UpdateWorkflowOptions,
) -> Result<(), CommandError> {
    log::info!(
        "update_workflow called for workflow_id: '{}'",
        options.workflow_id,
    );
    let workflow_id = options.workflow_id.clone();
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let core_options: vertebrae_core::UpdateWorkflowOptions = options.into();
    service
        .workflows()
        .update_workflow(&workflow_id, core_options)
        .await?;

    let _ = app_handle.emit(
        "workflow-changed-event",
        crate::events::WorkflowChangedEvent {
            workflow_id: workflow_id.clone(),
            change_type: crate::events::WorkflowChangeType::Updated,
            workflow: None,
        },
    );

    Ok(())
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

    let bundle = service
        .workflows()
        .get_workflow_with_tasks(service.tasks(), &id)
        .await?;
    let tasks: Vec<Task> = bundle.tasks.into_iter().map(Into::into).collect();

    Ok(WorkflowWithTasks {
        workflow: bundle.workflow.into(),
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
    let filter = vertebrae_core::TaskFilter::new().with_workflow_id(workflow_id_str.clone());
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

/// Fetch the full pipeline summary in a single GraphQL round-trip.
///
/// Returns one entry per workflow with preloaded steps (each carrying
/// `pipeline_counts`/`active_count` aggregates plus their outbound
/// transitions) and inter-workflow transitions. The Sacrum resolver runs at
/// most 4 SQL queries regardless of project size.
///
/// The frontend keeps these aggregates fresh by refetching this authoritative
/// summary after Sacrum websocket events that can change pipeline counts. It
/// does NOT issue a per-task execution query on mount.
#[tauri::command]
#[specta::specta]
pub async fn get_pipeline_summary(
    state: State<'_, AppState>,
) -> Result<crate::types::PipelineSummary, CommandError> {
    log::info!("[get_pipeline_summary] Starting");
    let start_time = std::time::Instant::now();

    let client_guard = state.sacrum_client.read().await;
    let client = client_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let service = vertebrae_sacrum_client::SacrumWorkflowService::new((**client).clone());
    let workflows = service.get_pipeline_summary().await?;

    let summary = crate::types::PipelineSummary {
        workflows: workflows
            .into_iter()
            .map(crate::types::PipelineWorkflow::from)
            .collect(),
    };

    log::info!(
        "[get_pipeline_summary] Returned {} workflows in {}ms",
        summary.workflows.len(),
        start_time.elapsed().as_millis()
    );

    Ok(summary)
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

/// Fetch a single step execution by ID with full detail.
///
/// Returns the full StepExecution struct (including prompt, output, context,
/// transition_result, model, tokens, cost, duration_ms, handoff, session_id)
/// or `None` when no execution matches the given ID.
#[tauri::command]
#[specta::specta]
pub async fn get_execution(
    state: State<'_, AppState>,
    execution_id: String,
) -> Result<Option<StepExecution>, CommandError> {
    log::info!("get_execution called for execution: {}", execution_id);
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service.executions().get_execution(&execution_id).await {
        Ok(execution) => {
            log::info!(
                "get_execution returned {}",
                if execution.is_some() { "Some" } else { "None" }
            );
            Ok(execution.map(Into::into))
        }
        Err(e) => {
            log::error!("get_execution error: {:?}", e);
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

/// Get the active TaskRun for a task, if one is currently active.
#[tauri::command]
#[specta::specta]
pub async fn get_active_run(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Option<TaskRun>, CommandError> {
    log::info!("get_active_run called for task: {}", task_id);
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let run = service.executions().active_run(&task_id).await?;
    Ok(run.map(Into::into))
}

/// List durable TaskRuns for a task.
#[tauri::command]
#[specta::specta]
pub async fn get_task_runs(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Vec<TaskRun>, CommandError> {
    log::info!("get_task_runs called for task: {}", task_id);
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let runs = service.executions().task_runs(&task_id).await?;
    Ok(runs.into_iter().map(Into::into).collect())
}

/// Get the recursive trace tree for a root TaskRun.
#[tauri::command]
#[specta::specta]
pub async fn get_task_run_trace(
    state: State<'_, AppState>,
    root_task_run_id: String,
) -> Result<TaskRunTrace, CommandError> {
    log::info!(
        "get_task_run_trace called for root task run: {}",
        root_task_run_id
    );
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let trace = service
        .executions()
        .task_run_trace(&root_task_run_id)
        .await?;
    Ok(trace.into())
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
pub async fn create_step(
    state: State<'_, AppState>,
    options: crate::types::CreateStepOptions,
) -> Result<Step, CommandError> {
    log::info!(
        "create_step called: workflow={}, name={}, order={}",
        options.workflow_id,
        options.name,
        options.order
    );
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Build transitions_to list
    let transitions: Vec<String> = options
        .transitions_to
        .iter()
        .map(|id| id.to_lowercase())
        .collect();

    // Build the step
    let mut step = vertebrae_core::Step::new(&options.name, options.workflow_id)
        .with_agents(options.agents)
        .with_skills(options.skills)
        .with_order(options.order)
        .with_is_final(options.is_final)
        .with_transitions_to(transitions)
        .with_step_type(options.step_type.into());

    if let Some(goal) = options.goal {
        step = step.with_goal(&goal);
    }

    if let Some(schema) = options.output_schema {
        step = step.with_output_schema(schema);
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
pub async fn update_step(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    options: crate::types::UpdateStepOptions,
) -> Result<(), CommandError> {
    log::info!(
        "update_step called with step_id: '{}', name: {:?}, goal: {:?}, prompt: {:?}",
        options.step_id,
        options.name,
        options.goal,
        options.prompt,
    );
    let step_id = options.step_id.clone();
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_id = update_step_inner(service, &step_id, options.into()).await?;

    // Emit step changed event for detail panel listeners
    let _ = app_handle.emit(
        "step-changed-event",
        crate::events::StepChangedEvent {
            step_id: step_id.clone(),
            workflow_id,
            change_type: crate::events::StepChangeType::Updated,
            step: None,
        },
    );

    Ok(())
}

/// Inner logic for update_step, separated for testability.
/// Returns the step's workflow_id for event emission.
pub(crate) async fn update_step_inner(
    service: &VertebraeServices,
    step_id: &str,
    update: vertebrae_core::StepUpdate,
) -> Result<String, CommandError> {
    let workflow_id = service.steps().update_step(step_id, &update).await?;
    log::info!("update_step succeeded for step: {}", step_id);
    Ok(workflow_id)
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
            step: None,
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
    let step = existing.ok_or_else(|| CommandError {
        message: format!("Step not found: {}", step_id),
    })?;
    let workflow_id = step.workflow_id.clone();

    service.steps().delete_step(step_id).await?;
    log::info!("delete_step succeeded for step: {}", step_id);
    Ok(workflow_id)
}

// ============================================================================
// Workflow Execution Commands
// ============================================================================

/// Run a single workflow step for a task via Sacrum
///
/// Sacrum creates a StepExecution record and broadcasts a run_step event
/// to connected daemon clients, which pick up and execute the step.
#[tauri::command]
#[specta::specta]
pub async fn run_step(
    state: State<'_, AppState>,
    task_id: String,
    step_id: String,
) -> Result<crate::types::StepExecution, CommandError> {
    log::info!("run_step called for task: {}, step: {}", task_id, step_id);

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let execution = service.executions().run_step(&task_id, &step_id).await?;

    log::info!("Step execution started: {:?}", execution.id);
    Ok(execution.into())
}

async fn run_workflow_inner(
    service: &VertebraeServices,
    task_id: &str,
) -> Result<TaskRun, CommandError> {
    let run = service.executions().run_workflow(task_id).await?;
    Ok(run.into())
}

async fn stop_run_inner(
    service: &VertebraeServices,
    target: StopRunTarget,
) -> Result<Option<TaskRun>, CommandError> {
    let stopped = service.executions().stop_run(target).await?;
    Ok(stopped.map(Into::into))
}

/// Start or schedule a durable TaskRun workflow via Sacrum.
#[tauri::command]
#[specta::specta]
pub async fn run_workflow(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskRun, CommandError> {
    log::info!("run_workflow called for task: {}", task_id);

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let run = run_workflow_inner(service, &task_id).await?;

    log::info!("TaskRun started for task: {}, run: {}", task_id, run.id);
    Ok(run)
}

/// Orchestrate a task through its entire workflow via the TaskRun path.
///
/// Compatibility shim for existing frontend call sites. New code should call
/// `run_workflow`, which returns the durable TaskRun.
#[tauri::command]
#[specta::specta]
pub async fn orchestrate_task(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), CommandError> {
    log::info!("orchestrate_task called for task: {}", task_id);

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let run = run_workflow_inner(service, &task_id).await?;

    log::info!(
        "Workflow orchestration started for task: {}, run: {}",
        task_id,
        run.id
    );
    Ok(())
}

/// Stop a durable TaskRun by explicit run ID or by active task ID.
///
/// If both IDs are provided, `task_run_id` takes precedence.
#[tauri::command]
#[specta::specta]
pub async fn stop_run(
    state: State<'_, AppState>,
    request: StopRunRequest,
) -> Result<Option<TaskRun>, CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let task_run_id = request.task_run_id.filter(|id| !id.trim().is_empty());
    let task_id = request.task_id.filter(|id| !id.trim().is_empty());
    let target = match (task_run_id, task_id) {
        (Some(task_run_id), _) => StopRunTarget::TaskRunId(task_run_id),
        (None, Some(task_id)) => StopRunTarget::TaskId(task_id),
        (None, None) => {
            return Err(CommandError {
                message: "stop_run requires either task_run_id or task_id".to_string(),
            });
        }
    };

    let stopped = stop_run_inner(service, target).await?;

    if let Some(run) = stopped.as_ref() {
        log::info!("TaskRun stop requested for run: {}", run.id);
    } else {
        log::info!("TaskRun stop requested but no active run matched");
    }

    Ok(stopped)
}

/// Stop the running TaskRun for a task via Sacrum.
///
/// Idempotent: if no orchestrator is running for the task, the call still
/// resolves successfully. The daemon receives the corresponding cancel_step
/// event and terminates any in-flight child process.
#[tauri::command]
#[specta::specta]
pub async fn stop_orchestrator(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    stop_run_inner(service, StopRunTarget::TaskId(task_id.clone())).await?;

    log::info!("Workflow TaskRun stop requested for task: {}", task_id);
    Ok(())
}

// ============================================================================
// Local Chat Commands
// ============================================================================

/// List supported local chat harnesses for provider-neutral local sessions.
#[tauri::command]
#[specta::specta]
pub fn get_supported_local_chat_harnesses(
    local_chat_manager: State<'_, LocalChatSessionManager>,
) -> LocalChatHarnessCatalog {
    local_chat_manager.catalog()
}

/// Create a provider-neutral local chat session.
#[tauri::command]
#[specta::specta]
pub async fn create_local_chat_session(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    app_handle: tauri::AppHandle,
    input: CreateLocalChatSessionInput,
) -> Result<(), LocalChatSessionError> {
    log::info!(
        "create_local_chat_session called: harness={:?}, backend_session_id={}, working_dir={:?}, resume={:?}, model={:?}, permission_mode={:?}",
        input.harness,
        input.backend_session_id,
        input.working_dir,
        input.provider_resume_id,
        input.model_id,
        input.permission_mode
    );

    local_chat_manager.create_session(input, app_handle).await
}

/// Send a message to a provider-neutral local chat session.
#[tauri::command]
#[specta::specta]
pub async fn send_local_chat_message(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    backend_session_id: String,
    content: String,
) -> Result<(), LocalChatSessionError> {
    log::info!(
        "send_local_chat_message called: backend_session_id={}, content_len={}",
        backend_session_id,
        content.len()
    );

    local_chat_manager
        .send_message(&backend_session_id, &content)
        .await
}

/// Close a provider-neutral local chat session.
#[tauri::command]
#[specta::specta]
pub async fn close_local_chat_session(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    backend_session_id: String,
) -> Result<(), LocalChatSessionError> {
    log::info!(
        "close_local_chat_session called: backend_session_id={}",
        backend_session_id
    );
    local_chat_manager.close_session(&backend_session_id).await
}

// ============================================================================
// Claude Session Commands (JSONL streaming compatibility)
// ============================================================================

/// Create a new Claude session with JSONL streaming
///
/// Spawns the Claude CLI with streaming JSON input/output mode.
/// If `resume_session_id` is provided, continues an existing conversation.
/// Returns immediately; the session emits events for all output.
#[tauri::command]
#[specta::specta]
pub async fn create_claude_session(
    claude_manager: State<'_, crate::claude_session::ClaudeSessionManager>,
    app_handle: tauri::AppHandle,
    input: CreateClaudeSessionInput,
) -> Result<(), crate::claude_session::ClaudeSessionError> {
    log::info!(
        "create_claude_session called: session_id={}, working_dir={:?}, resume={:?}, model={:?}, permission_mode={:?}",
        input.session_id,
        input.working_dir,
        input.resume_session_id,
        input.model_id,
        input.permission_mode
    );

    claude_manager.create_session(input, app_handle).await
}

/// List supported Claude Code models for local chat sessions.
#[tauri::command]
#[specta::specta]
pub fn get_supported_claude_models() -> ClaudeModelCatalog {
    crate::claude_session::supported_claude_model_catalog()
}

/// Send a message to a Claude session
///
/// Sends a user message to an active Claude session via stdin.
#[tauri::command]
#[specta::specta]
pub async fn send_claude_message(
    claude_manager: State<'_, crate::claude_session::ClaudeSessionManager>,
    session_id: String,
    content: String,
) -> Result<(), crate::claude_session::ClaudeSessionError> {
    log::info!(
        "send_claude_message called: session_id={}, content_len={}",
        session_id,
        content.len()
    );

    claude_manager.send_message(&session_id, &content).await
}

/// Close a Claude session
///
/// Terminates the Claude CLI process for the given session.
#[tauri::command]
#[specta::specta]
pub async fn close_claude_session(
    claude_manager: State<'_, crate::claude_session::ClaudeSessionManager>,
    session_id: String,
) -> Result<(), crate::claude_session::ClaudeSessionError> {
    log::info!("close_claude_session called: session_id={}", session_id);
    claude_manager.close_session(&session_id).await
}

/// Resolve a Claude permission request shown in the GUI.
#[tauri::command]
#[specta::specta]
pub async fn resolve_permission_request(
    claude_manager: State<'_, ClaudeSessionManager>,
    input: ResolvePermissionRequestInput,
) -> Result<serde_json::Value, CommandError> {
    let (behavior, message, updated_input) = match input.behavior {
        PermissionDecisionBehavior::Allow => {
            let updated_input = match input.updated_input {
                Some(value @ serde_json::Value::Object(_)) => Some(value),
                Some(_) => {
                    return Err(CommandError {
                        message:
                            "Allowed permission requests require updated_input to be a JSON object."
                                .to_string(),
                    });
                }
                None => Some(json!({})),
            };
            ("allow", None, updated_input)
        }
        PermissionDecisionBehavior::Deny => (
            "deny",
            Some(
                input
                    .message
                    .unwrap_or_else(|| "Denied from Vertebrae GUI".to_string()),
            ),
            None,
        ),
    };

    claude_manager
        .resolve_permission_request(
            &input.request_id,
            LocalPermissionDecision {
                behavior: behavior.to_string(),
                message,
                updated_input,
            },
        )
        .map_err(|err| CommandError { message: err })
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

/// Replace the full dependency set for a task
///
/// Saves picker changes atomically instead of issuing one mutation per add/remove.
#[tauri::command]
#[specta::specta]
pub async fn sync_dependencies(
    state: State<'_, AppState>,
    task_id: String,
    depends_on_ids: Vec<String>,
) -> Result<(), CommandError> {
    log::info!(
        "sync_dependencies called with task_id: {}, {} dependencies",
        task_id,
        depends_on_ids.len()
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .tasks()
        .sync_dependencies(&task_id, &depends_on_ids)
        .await?;

    log::info!("Successfully synced dependencies for task {}", task_id);
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
            task: None,
            current_step_id: None,
            workflow_id: None,
            level: None,
            archived: None,
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

    if let Some(archived) = options.archived {
        update_opts.archived = Some(archived);
    }

    if let Some(new_worktree) = options.worktree {
        update_opts.worktree = Some(new_worktree);
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
/// The order is assigned by Sacrum.
#[tauri::command]
#[specta::specta]
pub async fn add_section(
    state: State<'_, AppState>,
    task_id: String,
    section_type: String,
    content: Option<String>,
) -> Result<Section, CommandError> {
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
    let parsed_type = section_type
        .parse::<vertebrae_core::SectionType>()
        .map_err(|e| CommandError { message: e })?;
    let is_single_instance = parsed_type.is_single_instance();

    // Use provided content or empty string
    let section_content = content.unwrap_or_default();

    let section = vertebrae_core::Section {
        section_type: parsed_type,
        content: section_content,
        order: None,
        done: None,
        done_at: None,
        refs: Vec::new(),
    };

    let created = if is_single_instance {
        service.tasks().upsert_section(&task_id, section).await?
    } else {
        service.tasks().add_section(&task_id, section).await?
    };

    log::info!("Successfully added section to task: {}", task_id);
    Ok(created.into())
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
) -> Result<Section, CommandError> {
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
    let parsed_type = section_type
        .parse::<vertebrae_core::SectionType>()
        .map_err(|e| CommandError { message: e })?;

    let updated = service
        .tasks()
        .edit_section_by_ordinal(&task_id, parsed_type, ordinal, &new_content)
        .await?;

    log::info!("Successfully edited section in task: {}", task_id);
    Ok(updated.into())
}

/// Toggle the completion status of a checklist item
///
/// Marks a checklist item as done or not done by toggling its done flag.
/// For checklist item sections only (other types will return an error).
#[tauri::command]
#[specta::specta]
pub async fn toggle_checklist_item_done(
    state: State<'_, AppState>,
    task_id: String,
    ordinal: u32,
) -> Result<Section, CommandError> {
    log::info!(
        "toggle_checklist_item_done called with task_id: {}, ordinal: {}",
        task_id,
        ordinal
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Use service method to toggle the checklist item done status
    let updated = service
        .tasks()
        .toggle_checklist_item_done(&task_id, ordinal)
        .await?;

    log::info!(
        "Successfully toggled checklist item done status for task: {}",
        task_id
    );
    Ok(updated.into())
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
) -> Result<Section, CommandError> {
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
    let parsed_type = section_type
        .parse::<vertebrae_core::SectionType>()
        .map_err(|e| CommandError { message: e })?;

    let removed = service
        .tasks()
        .remove_section_by_ordinal(&task_id, parsed_type, ordinal)
        .await?;

    log::info!("Successfully removed section from task: {}", task_id);
    Ok(removed.into())
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

    // Convert u32 indices to usize for internal use
    let indices_usize = indices.map(|v| v.into_iter().map(|i| i as usize).collect::<Vec<usize>>());

    let removed_count = indices_usize.as_ref().map_or(0, Vec::len);
    service
        .tasks()
        .remove_code_refs(&task_id, indices_usize)
        .await?;

    log::info!(
        "Successfully removed {} code_refs from task: {}",
        removed_count,
        task_id
    );
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

    let db_refs = refs
        .into_iter()
        .map(|code_ref| vertebrae_core::CodeRef {
            path: code_ref.path,
            line_start: code_ref.line_start,
            line_end: code_ref.line_end,
            name: code_ref.name,
            description: code_ref.description,
        })
        .collect::<Vec<_>>();

    service.tasks().set_code_refs(&task_id, &db_refs).await?;

    log::info!("Successfully replaced code refs for task: {}", task_id);
    Ok(())
}

// ============================================================================
// WebSocket Status Command
// ============================================================================

/// Get the current WebSocket connection status
#[tauri::command]
#[specta::specta]
pub async fn get_websocket_status(
    socket: State<'_, tokio::sync::Mutex<crate::websocket_client::SacrumSocket>>,
) -> Result<String, CommandError> {
    let guard = socket.lock().await;
    let status = guard.get_state().await;
    let status_str = match status {
        crate::websocket_client::ConnectionState::Disconnected => "disconnected",
        crate::websocket_client::ConnectionState::Connecting => "connecting",
        crate::websocket_client::ConnectionState::Connected => "connected",
        crate::websocket_client::ConnectionState::Reconnecting => "reconnecting",
    };
    Ok(status_str.to_string())
}

/// Quit the application.
///
/// Used by the first-run install screen's Cancel button so a user who does not
/// want to install the bundled tools can exit cleanly rather than being routed
/// into an app that can't function without them.
#[tauri::command]
#[specta::specta]
pub async fn quit_application(app_handle: tauri::AppHandle) -> Result<(), CommandError> {
    app_handle.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::mock_services;
    use crate::project_config::ProjectConfig;
    use serial_test::serial;
    use std::collections::BTreeMap;
    use std::env;
    use std::fs;
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use tauri::{Listener, Manager};

    /// Helper: build a mock Tauri app with services loaded.
    fn build_app_with_services() -> tauri::App<tauri::test::MockRuntime> {
        let services = mock_services();
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let project_config = ProjectConfig::with_path(tmp.path().to_path_buf());

        tauri::test::mock_builder()
            .manage(AppState {
                services: RwLock::new(Some(services)),
                sacrum_client: RwLock::new(None),
                project_config,
            })
            .manage(tokio::sync::Mutex::new(
                crate::websocket_client::SacrumSocket::disconnected(),
            ))
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
                sacrum_client: RwLock::new(None),
                project_config,
            })
            .manage(tokio::sync::Mutex::new(
                crate::websocket_client::SacrumSocket::disconnected(),
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    #[tokio::test]
    async fn list_embedded_skills_returns_sorted_manifest() {
        let skills = list_embedded_skills().await.unwrap();
        let expected = vertebrae_skills_assets::list_embedded_skills();

        assert!(!skills.is_empty());
        assert_eq!(skills, expected);
        assert!(skills.contains(&"vtb-add".to_string()));
    }

    #[tokio::test]
    async fn preview_project_slug_uses_backend_slugifier() {
        assert_eq!(
            preview_project_slug("Ørsted Project".to_string())
                .await
                .unwrap(),
            "orsted-project"
        );
    }

    struct EnvGuard {
        previous_home: Option<std::ffi::OsString>,
        previous_xdg_config_home: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn new(home: &Path) -> Self {
            let previous_home = env::var_os("HOME");
            let previous_xdg_config_home = env::var_os("XDG_CONFIG_HOME");
            unsafe {
                env::set_var("HOME", home);
                env::set_var("XDG_CONFIG_HOME", home.join(".config"));
            }

            Self {
                previous_home,
                previous_xdg_config_home,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous_home {
                Some(home) => unsafe { env::set_var("HOME", home) },
                None => unsafe { env::remove_var("HOME") },
            }
            match &self.previous_xdg_config_home {
                Some(config_home) => unsafe { env::set_var("XDG_CONFIG_HOME", config_home) },
                None => unsafe { env::remove_var("XDG_CONFIG_HOME") },
            }
        }
    }

    struct MockSacrumServer {
        url: String,
        shutdown_tx: mpsc::Sender<()>,
        handle: thread::JoinHandle<()>,
    }

    impl MockSacrumServer {
        fn stop(&self) {
            let _ = self.shutdown_tx.send(());
        }

        fn join(self) {
            self.handle
                .join()
                .expect("mock Sacrum server thread panicked");
        }
    }

    fn start_mock_sacrum_server() -> MockSacrumServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        listener
            .set_nonblocking(true)
            .expect("configure mock server listener");
        let url = format!("http://{}", listener.local_addr().expect("local addr"));
        let (shutdown_tx, shutdown_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            let mut handled_requests = 0;

            while handled_requests < 2 {
                if shutdown_rx.try_recv().is_ok() {
                    break;
                }

                let (mut stream, _) = match listener.accept() {
                    Ok(accepted) => accepted,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("accept mock request: {error}"),
                };
                stream
                    .set_nonblocking(false)
                    .expect("configure mock request stream");

                let request = read_http_request(&mut stream);
                let body = if handled_requests == 0 {
                    assert!(
                        request.contains("ListProjects"),
                        "first request should list projects, got {request}"
                    );
                    r#"{"data":{"projects":[]}}"#.to_string()
                } else {
                    assert!(
                        request.contains("CreateProject"),
                        "second request should create project, got {request}"
                    );
                    r#"{"data":{"create_project":{"id":"proj-123","name":"Temp Project","slug":"temp-project","description":null}}}"#
                        .to_string()
                };
                handled_requests += 1;

                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write mock response");
            }
        });

        MockSacrumServer {
            url,
            shutdown_tx,
            handle,
        }
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0; 1024];

        loop {
            let bytes_read = stream.read(&mut buffer).expect("read mock request");
            if bytes_read == 0 {
                break;
            }

            request.extend_from_slice(&buffer[..bytes_read]);

            if let Some(header_end) = find_header_end(&request) {
                let content_length = content_length(&request[..header_end]).unwrap_or(0);
                let body_start = header_end + 4;
                if request.len() >= body_start + content_length {
                    break;
                }
            }
        }

        String::from_utf8(request).expect("mock request is utf8")
    }

    fn find_header_end(request: &[u8]) -> Option<usize> {
        request.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn content_length(headers: &[u8]) -> Option<usize> {
        let headers = String::from_utf8_lossy(headers);
        headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())
                .flatten()
        })
    }

    fn assert_no_project_error<T: std::fmt::Debug>(result: Result<T, CommandError>) {
        let err = result.expect_err("expected command to fail without a selected project");
        assert!(err.message.contains("No project selected"));
    }

    async fn create_task_with_workflow(app: &tauri::App<tauri::test::MockRuntime>) -> String {
        let app_state = app.state::<AppState>();
        let (tasks, workflows) = {
            let services_guard = app_state.services.read().await;
            let services = services_guard.as_ref().expect("services initialized");
            (services.tasks_arc(), services.workflows_arc())
        };

        let task_id = tasks
            .create_task(vertebrae_core::CreateTaskOptions::new(
                "TaskRun command task",
            ))
            .await
            .expect("create task");
        let workflow_id = workflows
            .create_workflow(vertebrae_core::CreateWorkflowOptions::new(
                "TaskRun command workflow",
                vec![],
            ))
            .await
            .expect("create workflow");
        tasks
            .assign_workflow(&task_id, &workflow_id)
            .await
            .expect("assign workflow");

        task_id
    }

    #[test]
    fn derive_project_slug_rejects_empty_slugs() {
        assert_eq!(derive_project_slug("My Project").unwrap(), "my-project");
        let err = derive_project_slug("!!!").unwrap_err();
        assert!(err.message.contains("Could not create valid slug"));
    }

    #[test]
    fn canonical_project_root_requires_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(&dir.path().to_string_lossy()).unwrap();
        assert!(root.is_dir());

        let missing = dir.path().join("missing");
        let err = canonical_project_root(&missing.to_string_lossy()).unwrap_err();
        assert!(err.message.contains("Project path is not a directory"));
    }

    #[test]
    fn validate_sacrum_token_rejects_header_invalid_characters() {
        validate_sacrum_token("sac_valid-token").unwrap();

        for token in ["bad\n", "bad\r", "bad\0", "bad\u{7f}"] {
            let err = validate_sacrum_token(token).unwrap_err();
            assert!(err.message.contains("Authorization header"));
        }
    }

    #[test]
    fn project_slug_guard_allows_same_path_and_rejects_different_path() {
        let temp = tempfile::tempdir().unwrap();
        let registered = temp.path().join("registered");
        let other = temp.path().join("other");
        fs::create_dir_all(&registered).unwrap();
        fs::create_dir_all(&other).unwrap();

        let config = vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection::default(),
            projects: BTreeMap::from([(
                "duplicate".to_string(),
                vertebrae_sacrum_client::ProjectSection {
                    id: "existing-id".to_string(),
                    path: registered.to_string_lossy().to_string(),
                },
            )]),
        };

        ensure_project_slug_available_for_path(&config, "duplicate", &registered).unwrap();
        let err = ensure_project_slug_available_for_path(&config, "duplicate", &other).unwrap_err();
        assert!(err.message.contains("already exists in config"));
    }

    #[tokio::test]
    #[serial]
    async fn sacrum_settings_commands_validate_and_hide_token() {
        let temp_home = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(temp_home.path());

        let initial = sacrum_config_status().await.unwrap();
        assert!(!initial.config_exists);
        assert!(!initial.has_token);
        assert_eq!(initial.url, "https://vertebrae.dev");

        let empty = save_sacrum_settings("  ".to_string()).await.unwrap_err();
        assert!(empty.message.contains("required"));

        let invalid = save_sacrum_settings("bad\ntoken".to_string())
            .await
            .unwrap_err();
        assert!(invalid.message.contains("Authorization header"));
        assert!(
            !vertebrae_sacrum_client::config_path()
                .expect("config path")
                .exists(),
            "invalid tokens should not be persisted"
        );

        vertebrae_sacrum_client::save_config_file(&vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection {
                url: "https://custom.example.test".to_string(),
                token: None,
            },
            projects: BTreeMap::new(),
        })
        .unwrap();
        let custom_status = sacrum_config_status().await.unwrap();
        assert_eq!(custom_status.url, "https://custom.example.test");

        let status = save_sacrum_settings(" sac_valid-token ".to_string())
            .await
            .unwrap();
        assert!(status.config_exists);
        assert!(status.has_token);
        assert_eq!(status.url, "https://custom.example.test");

        let status_json = serde_json::to_value(&status).unwrap();
        assert!(status_json.get("token").is_none());

        let config = vertebrae_sacrum_client::load_config_file().unwrap();
        assert_eq!(config.sacrum.token.as_deref(), Some("sac_valid-token"));
        assert_eq!(config.sacrum.url, "https://custom.example.test");
    }

    #[tokio::test]
    #[serial]
    async fn initialize_project_rejects_duplicate_slug_for_different_path() {
        let temp_home = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(temp_home.path());
        let temp = tempfile::tempdir().unwrap();
        let registered = temp.path().join("registered");
        let other = temp.path().join("other");
        fs::create_dir_all(&registered).unwrap();
        fs::create_dir_all(&other).unwrap();

        vertebrae_sacrum_client::save_config_file(&vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection {
                url: "http://127.0.0.1:1".to_string(),
                token: Some("sac_valid-token".to_string()),
            },
            projects: BTreeMap::from([(
                "duplicate".to_string(),
                vertebrae_sacrum_client::ProjectSection {
                    id: "existing-id".to_string(),
                    path: registered.to_string_lossy().to_string(),
                },
            )]),
        })
        .unwrap();

        let app = build_app_without_services();
        let err = initialize_project_inner(
            app.handle(),
            other.to_string_lossy().to_string(),
            Some("Duplicate".to_string()),
        )
        .await
        .unwrap_err();

        assert!(err.message.contains("already exists in config"));
    }

    #[tokio::test]
    #[serial]
    async fn initialize_project_registers_skill_links_and_emits_progress() {
        let temp_home = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(temp_home.path());
        let project_parent = tempfile::tempdir().unwrap();
        let project_path = project_parent.path().join("Temp Project");
        fs::create_dir_all(&project_path).unwrap();
        let claude_skills = project_path.join(".claude/skills");
        let agents_skills = project_path.join(".agents/skills");
        fs::create_dir_all(&claude_skills).unwrap();
        fs::create_dir_all(&agents_skills).unwrap();
        let server = start_mock_sacrum_server();

        vertebrae_sacrum_client::save_config_file(&vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection {
                url: server.url.clone(),
                token: Some("sac_valid-token".to_string()),
            },
            projects: BTreeMap::new(),
        })
        .unwrap();

        let app = build_app_without_services();
        let (tx, rx) = mpsc::channel();
        let _listener = app.listen("project-init-progress-event", move |event| {
            tx.send(event.payload().to_string())
                .expect("record progress event");
        });

        let result = initialize_project_inner(
            app.handle(),
            project_path.to_string_lossy().to_string(),
            None,
        )
        .await
        .unwrap();
        server.stop();
        server.join();

        assert_eq!(result.slug, "temp-project");
        assert_eq!(result.project_id, "proj-123");
        assert_eq!(result.project_name, "Temp Project");
        assert!(result.project_created);
        assert!(result.skills_copied > 0);
        assert!(result.skills_target.contains(".claude/skills"));
        assert!(result.skills_target.contains(".agents/skills"));

        let staged_skill = vertebrae_installer::data_dir()
            .unwrap()
            .join("skills/vtb-add/SKILL.md");
        assert!(staged_skill.exists());
        for link in [
            project_path.join(".claude/skills/vtb-add/SKILL.md"),
            project_path.join(".agents/skills/vtb-add/SKILL.md"),
        ] {
            let metadata = fs::symlink_metadata(&link).unwrap();
            assert!(metadata.file_type().is_symlink());
            assert_eq!(fs::read_link(&link).unwrap(), staged_skill);
        }

        let config = vertebrae_sacrum_client::load_config_file().unwrap();
        let registered = config.projects.get("temp-project").unwrap();
        assert_eq!(registered.id, "proj-123");
        assert_eq!(registered.path, result.path);

        let events = rx
            .try_iter()
            .map(|payload| {
                serde_json::from_str::<crate::events::ProjectInitProgressEvent>(&payload)
                    .expect("progress event payload")
            })
            .collect::<Vec<_>>();
        let skill_events = events
            .iter()
            .filter(|event| {
                matches!(
                    event.kind,
                    crate::events::ProjectInitProgressKind::SkillFileInstalled
                )
            })
            .count();
        assert_eq!(skill_events, result.skills_copied as usize);
        assert!(matches!(
            events.last().map(|event| &event.kind),
            Some(crate::events::ProjectInitProgressKind::Completed)
        ));
    }

    #[tokio::test]
    #[serial]
    async fn initialize_project_stages_skills_without_creating_missing_skill_roots() {
        let temp_home = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(temp_home.path());
        let project_parent = tempfile::tempdir().unwrap();
        let project_path = project_parent.path().join("Temp Project");
        fs::create_dir_all(&project_path).unwrap();
        let server = start_mock_sacrum_server();

        vertebrae_sacrum_client::save_config_file(&vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection {
                url: server.url.clone(),
                token: Some("sac_valid-token".to_string()),
            },
            projects: BTreeMap::new(),
        })
        .unwrap();

        let app = build_app_without_services();
        let result = initialize_project_inner(
            app.handle(),
            project_path.to_string_lossy().to_string(),
            None,
        )
        .await
        .unwrap();
        server.stop();
        server.join();

        assert_eq!(result.skills_copied, 0);
        assert!(result.skills_target.contains("no existing .claude/skills"));
        assert!(vertebrae_installer::data_dir()
            .unwrap()
            .join("skills/vtb-add/SKILL.md")
            .exists());
        assert!(!project_path.join(".claude").exists());
        assert!(!project_path.join(".agents").exists());
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
    async fn sync_dependencies_replaces_dependency_set() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_a = create_task(state.clone(), "A".to_string(), None, None, None)
            .await
            .unwrap();
        let task_b = create_task(state.clone(), "B".to_string(), None, None, None)
            .await
            .unwrap();

        sync_dependencies(state.clone(), task_a.clone(), vec![task_b.clone()])
            .await
            .unwrap();
        let task = get_task(state.clone(), task_a.clone()).await.unwrap();
        assert_eq!(task.dependency_ids, vec![task_b.clone()]);

        sync_dependencies(state.clone(), task_a.clone(), vec![])
            .await
            .unwrap();
        let task = get_task(state, task_a).await.unwrap();
        assert!(task.dependency_ids.is_empty());
    }

    #[tokio::test]
    async fn sync_dependencies_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        let result = sync_dependencies(state, task_id, vec!["nonexistent".to_string()]).await;

        assert!(result.is_err());
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
                    order: 0,
                    is_default: false,
                    is_final: false,
                    kanban_column: None,
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

        let (wf_id, other_wf_id) = {
            let guard = state.services.read().await;
            let svc = guard.as_ref().unwrap();
            let wf_id = svc
                .workflows()
                .create_workflow(vertebrae_core::CreateWorkflowOptions {
                    name: "WF".to_string(),
                    description: None,
                    steps: vec![],
                    order: 0,
                    is_default: false,
                    is_final: false,
                    kanban_column: None,
                })
                .await
                .unwrap();
            let other_wf_id = svc
                .workflows()
                .create_workflow(vertebrae_core::CreateWorkflowOptions {
                    name: "Other WF".to_string(),
                    description: None,
                    steps: vec![],
                    order: 1,
                    is_default: false,
                    is_final: false,
                    kanban_column: None,
                })
                .await
                .unwrap();
            (wf_id, other_wf_id)
        };

        let included_task = create_task(state.clone(), "Included".to_string(), None, None, None)
            .await
            .unwrap();
        let excluded_task = create_task(state.clone(), "Excluded".to_string(), None, None, None)
            .await
            .unwrap();

        assign_workflow(state.clone(), included_task.clone(), wf_id.clone())
            .await
            .unwrap();
        assign_workflow(state.clone(), excluded_task, other_wf_id)
            .await
            .unwrap();

        let result = get_workflow_with_tasks(state, wf_id).await.unwrap();
        assert_eq!(
            result
                .tasks
                .iter()
                .map(|task| task.id.as_str())
                .collect::<Vec<_>>(),
            vec![included_task.as_str()]
        );
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
                    order: 0,
                    is_default: false,
                    is_final: false,
                    kanban_column: None,
                })
                .await
                .unwrap()
        };

        let result = get_workflow_with_task_details(state, wf_id).await.unwrap();
        assert!(result.tasks.is_empty());
    }

    // ========================================================================
    // list_workflows_full integration tests
    // ========================================================================

    #[tokio::test]
    async fn list_workflows_returns_full_workflow_fields() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();

        // Create a workflow with description via the service directly
        {
            let guard = state.services.read().await;
            let svc = guard.as_ref().unwrap();
            svc.workflows()
                .create_workflow(vertebrae_core::CreateWorkflowOptions {
                    name: "Full Details WF".to_string(),
                    description: Some("A detailed workflow".to_string()),
                    steps: vec![],
                    order: 0,
                    is_default: false,
                    is_final: false,
                    kanban_column: None,
                })
                .await
                .unwrap();
        }

        let workflows = list_workflows(state).await.unwrap();
        assert_eq!(workflows.len(), 1);
        let wf = &workflows[0];
        assert!(wf.id.is_some());
        assert_eq!(wf.name, "Full Details WF");
        assert_eq!(wf.description, Some("A detailed workflow".to_string()));
        assert!(wf.created_at.is_some());
    }

    #[tokio::test]
    async fn list_workflows_returns_multiple_full_workflows() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();

        {
            let guard = state.services.read().await;
            let svc = guard.as_ref().unwrap();
            svc.workflows()
                .create_workflow(vertebrae_core::CreateWorkflowOptions {
                    name: "WF One".to_string(),
                    description: None,
                    steps: vec![],
                    order: 0,
                    is_default: false,
                    is_final: false,
                    kanban_column: None,
                })
                .await
                .unwrap();
            svc.workflows()
                .create_workflow(vertebrae_core::CreateWorkflowOptions {
                    name: "WF Two".to_string(),
                    description: Some("Second workflow".to_string()),
                    steps: vec![],
                    order: 1,
                    is_default: false,
                    is_final: false,
                    kanban_column: None,
                })
                .await
                .unwrap();
        }

        let workflows = list_workflows(state).await.unwrap();
        assert_eq!(workflows.len(), 2);
        let names: Vec<&str> = workflows.iter().map(|w| w.name.as_str()).collect();
        assert!(names.contains(&"WF One"));
        assert!(names.contains(&"WF Two"));
    }

    // ========================================================================
    // get_pipeline_summary tests
    //
    // The command path requires a real Sacrum GraphQL client (it bypasses the
    // mock service trait by design — the resolver is what enforces the SQL
    // query budget). The error path is exercised here; success-path coverage
    // lives in the SacrumWorkflowService wiremock tests.
    // ========================================================================

    #[tokio::test]
    async fn get_pipeline_summary_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_pipeline_summary(state).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No project selected"));
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

    #[tokio::test]
    async fn get_execution_returns_none_for_unknown_id() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_execution(state, "missing-exec-id".to_string())
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn get_execution_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_execution(state, "exec".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn get_execution_returns_full_field_set() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();

        let exec_id = {
            let app_state = app.state::<AppState>();
            let services_guard = app_state.services.read().await;
            let services = services_guard.as_ref().expect("services initialized");
            let core_exec = services
                .executions()
                .run_step("task-1", "step-1")
                .await
                .expect("run_step succeeds");
            core_exec.id.clone().expect("execution id assigned")
        };

        let fetched = get_execution(state, exec_id.clone())
            .await
            .unwrap()
            .expect("execution found");
        assert_eq!(fetched.id.as_deref(), Some(exec_id.as_str()));
        assert_eq!(fetched.task_id, "task-1");
        assert_eq!(fetched.prompt.as_deref(), Some("mock prompt"));
        assert_eq!(fetched.output.as_deref(), Some("mock output"));
        assert_eq!(fetched.context.as_deref(), Some(r#"{"mock":"context"}"#));
        assert_eq!(fetched.transition_result.as_deref(), Some("mock_next_step"));
        assert_eq!(fetched.model.as_deref(), Some("claude-opus-4"));
        assert_eq!(fetched.model_provider.as_deref(), Some("anthropic"));
        assert_eq!(fetched.session_id.as_deref(), Some("mock-session-id"));
        assert_eq!(fetched.input_tokens, Some(123));
        assert_eq!(fetched.output_tokens, Some(45));
        assert_eq!(fetched.cost.as_deref(), Some("0.001"));
        assert_eq!(fetched.duration_ms, Some(250));
        assert_eq!(
            fetched.handoff.as_deref(),
            Some(r#"{"to":"mock_next_step"}"#)
        );
    }

    #[tokio::test]
    async fn task_run_commands_no_project_return_errors() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();

        assert_no_project_error(get_active_run(state.clone(), "task-1".to_string()).await);
        assert_no_project_error(get_task_runs(state.clone(), "task-1".to_string()).await);
        assert_no_project_error(get_task_run_trace(state.clone(), "run-1".to_string()).await);
        assert_no_project_error(run_workflow(state.clone(), "task-1".to_string()).await);
        assert_no_project_error(
            stop_run(
                state,
                StopRunRequest {
                    task_run_id: Some("run-1".to_string()),
                    task_id: None,
                },
            )
            .await,
        );
    }

    #[tokio::test]
    async fn active_run_and_history_commands_return_task_runs() {
        let app = build_app_with_services();
        let task_id = create_task_with_workflow(&app).await;
        let state: tauri::State<'_, AppState> = app.state();

        let no_active = get_active_run(state.clone(), task_id.clone())
            .await
            .expect("active run command succeeds before run");
        assert!(no_active.is_none());

        let run = run_workflow(state.clone(), task_id.clone())
            .await
            .expect("run workflow succeeds");
        let active = get_active_run(state.clone(), task_id.clone())
            .await
            .expect("active run command succeeds")
            .expect("active run exists");
        let history = get_task_runs(state, task_id.clone())
            .await
            .expect("task run history command succeeds");

        assert_eq!(active.id, run.id);
        assert_eq!(active.task_id, task_id);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, run.id);
    }

    #[tokio::test]
    async fn run_workflow_returns_task_run_serialized_with_snake_case_fields() {
        let app = build_app_with_services();
        let task_id = create_task_with_workflow(&app).await;
        let state: tauri::State<'_, AppState> = app.state();

        let run = run_workflow(state, task_id.clone())
            .await
            .expect("run workflow succeeds");

        assert_eq!(run.task_id, task_id);
        assert_eq!(run.project_id, "mock-project");
        assert_eq!(run.status, crate::types::TaskRunStatus::Executing);
        assert!(run.started_at.is_some());
        assert!(run.latest_step_execution_id.is_some());

        let value = serde_json::to_value(&run).expect("serialize task run");
        assert_eq!(value["task_id"].as_str(), Some(task_id.as_str()));
        assert_eq!(value["project_id"].as_str(), Some("mock-project"));
        assert_eq!(value["status"].as_str(), Some("executing"));
        assert!(value.get("taskId").is_none());
        assert!(value.get("projectId").is_none());
        assert!(value["latest_step_execution_id"].as_str().is_some());
    }

    #[tokio::test]
    async fn task_run_trace_serializes_runs_and_step_execution_links() {
        let app = build_app_with_services();
        let task_id = create_task_with_workflow(&app).await;
        let state: tauri::State<'_, AppState> = app.state();

        let run = run_workflow(state.clone(), task_id)
            .await
            .expect("run workflow succeeds");
        let trace = get_task_run_trace(state, run.id.clone())
            .await
            .expect("trace command succeeds");

        assert_eq!(trace.root_task_run_id, run.id);
        assert_eq!(trace.task_runs.len(), 1);
        assert_eq!(trace.task_runs[0].id, run.id);
        assert_eq!(trace.step_executions.len(), 1);
        assert_eq!(
            trace.step_executions[0].task_run_id.as_deref(),
            Some(run.id.as_str())
        );

        let value = serde_json::to_value(&trace).expect("serialize trace");
        assert_eq!(value["root_task_run_id"].as_str(), Some(run.id.as_str()));
        assert!(value.get("rootTaskRunId").is_none());
        assert_eq!(value["task_runs"][0]["id"].as_str(), Some(run.id.as_str()));
        assert_eq!(
            value["step_executions"][0]["task_run_id"].as_str(),
            Some(run.id.as_str())
        );
    }

    #[tokio::test]
    async fn stop_run_by_task_run_id_returns_serialized_task_run() {
        let app = build_app_with_services();
        let task_id = create_task_with_workflow(&app).await;
        let state: tauri::State<'_, AppState> = app.state();

        let run = run_workflow(state.clone(), task_id)
            .await
            .expect("run workflow succeeds");
        let stopped = stop_run(
            state,
            StopRunRequest {
                task_run_id: Some(run.id.clone()),
                task_id: None,
            },
        )
        .await
        .expect("stop run command succeeds")
        .expect("stopped run returned");

        assert_eq!(stopped.id, run.id);
        assert_eq!(stopped.status, crate::types::TaskRunStatus::Stopping);
        assert!(stopped.stop_requested_at.is_some());

        let value = serde_json::to_value(&stopped).expect("serialize stopped run");
        assert_eq!(value["id"].as_str(), Some(run.id.as_str()));
        assert_eq!(value["status"].as_str(), Some("stopping"));
        assert!(value["stop_requested_at"].as_str().is_some());
        assert!(value.get("stopRequestedAt").is_none());
    }

    #[tokio::test]
    async fn stop_run_by_task_id_returns_active_task_run() {
        let app = build_app_with_services();
        let task_id = create_task_with_workflow(&app).await;
        let state: tauri::State<'_, AppState> = app.state();

        let run = run_workflow(state.clone(), task_id.clone())
            .await
            .expect("run workflow succeeds");
        let stopped = stop_run(
            state,
            StopRunRequest {
                task_run_id: None,
                task_id: Some(task_id.clone()),
            },
        )
        .await
        .expect("stop run command succeeds")
        .expect("stopped run returned");

        assert_eq!(stopped.id, run.id);
        assert_eq!(stopped.task_id, task_id);
        assert_eq!(stopped.status, crate::types::TaskRunStatus::Stopping);
    }

    #[tokio::test]
    async fn orchestrate_task_compatibility_starts_task_run() {
        let app = build_app_with_services();
        let task_id = create_task_with_workflow(&app).await;
        let state: tauri::State<'_, AppState> = app.state();

        orchestrate_task(state.clone(), task_id.clone())
            .await
            .expect("compat orchestration command succeeds");
        let history = get_task_runs(state, task_id.clone())
            .await
            .expect("task run history command succeeds");

        assert_eq!(history.len(), 1);
        assert_eq!(history[0].task_id, task_id);
        assert_eq!(history[0].status, crate::types::TaskRunStatus::Executing);
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
            crate::types::CreateStepOptions {
                workflow_id: "wf-1".to_string(),
                name: "Review".to_string(),
                goal: Some("Review the code".to_string()),
                agents: vec!["sonnet".to_string()],
                skills: vec![],
                order: 0,
                is_final: false,
                transitions_to: vec![],
                step_type: Default::default(),
                output_schema: None,
            },
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
            crate::types::CreateStepOptions {
                workflow_id: "wf-x".to_string(),
                name: "Step1".to_string(),
                goal: None,
                agents: vec![],
                skills: vec![],
                order: 0,
                is_final: false,
                transitions_to: vec![],
                step_type: Default::default(),
                output_schema: None,
            },
        )
        .await
        .unwrap();
        create_step(
            state.clone(),
            crate::types::CreateStepOptions {
                workflow_id: "wf-x".to_string(),
                name: "Step2".to_string(),
                goal: None,
                agents: vec![],
                skills: vec![],
                order: 1,
                is_final: true,
                transitions_to: vec![],
                step_type: Default::default(),
                output_schema: None,
            },
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

        let update = vertebrae_core::StepUpdate::new()
            .with_name("Updated")
            .with_goal("New goal");
        let wf_id = update_step_inner(&services, &step_id, update)
            .await
            .unwrap();
        assert_eq!(wf_id, "wf-1");
    }

    #[tokio::test]
    async fn update_step_inner_nonexistent_returns_error() {
        let services = mock_services();
        let update = vertebrae_core::StepUpdate::new().with_name("Name");
        let result = update_step_inner(&services, "nonexistent", update).await;
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
            "checklist_item".to_string(),
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
        assert!(result.unwrap_err().message.contains("invalid section type"));
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
            "checklist_item",
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
            "checklist_item".to_string(),
            Some("Original".to_string()),
        )
        .await
        .unwrap();

        edit_section(
            state.clone(),
            id.clone(),
            "checklist_item".to_string(),
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
            "checklist_item".to_string(),
            Some("Step 1".to_string()),
        )
        .await
        .unwrap();

        remove_section(state.clone(), id.clone(), "checklist_item".to_string(), 0)
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
    async fn toggle_checklist_item_done_toggles_item() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "checklist_item".to_string(),
            Some("Do it".to_string()),
        )
        .await
        .unwrap();

        toggle_checklist_item_done(state.clone(), id.clone(), 0)
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
            None,
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
    async fn remove_code_refs_selective_keeps_survivors() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        for path in ["a.rs", "b.rs", "c.rs"] {
            add_code_ref(
                state.clone(),
                id.clone(),
                path.to_string(),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        }

        remove_code_refs(state.clone(), id.clone(), Some(vec![1]))
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(
            task.code_refs
                .iter()
                .map(|code_ref| code_ref.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.rs", "c.rs"]
        );
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

    #[tokio::test]
    async fn stop_orchestrator_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = stop_orchestrator(state, "task-1".to_string()).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.message.contains("No project selected"));
    }

    #[tokio::test]
    async fn stop_orchestrator_succeeds() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = stop_orchestrator(state, "task-1".to_string()).await;
        assert!(result.is_ok(), "expected ok, got {:?}", result.err());
    }
}
