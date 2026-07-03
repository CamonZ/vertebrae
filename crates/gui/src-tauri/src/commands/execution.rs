use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{
        build_app_with_services, build_app_without_services, create_task_with_workflow,
    };
    use tauri::Manager;

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
}
