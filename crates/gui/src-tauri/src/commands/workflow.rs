use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::build_app_with_services;
    use crate::commands::test_support::build_app_without_services;
    use tauri::Manager;

    #[tokio::test]
    async fn list_workflows_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = list_workflows(state).await;
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
}
