use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{
        assert_no_project_error, build_app_with_services, build_app_without_services,
        create_task_with_workflow,
    };
    use tauri::Manager;

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
