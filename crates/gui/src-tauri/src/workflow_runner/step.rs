//! Two-phase step execution with retry logic
//!
//! Executes a workflow step using the orchestrator (Phase 1) and executor (Phase 2).
//! Handles retries, status updates, and event emission.

use chrono::Utc;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime};
use vertebrae_core::{ExecutionService, ExecutionStatus, StepExecution, TaskService};

use crate::events::{
    StepExecutionChangeType, StepExecutionChangedEvent, StepExecutionStatus,
    WorkflowExecutionEvent, WorkflowExecutionEventType,
};

use super::command_runner::{CommandRunner, TokioCommandRunner};
use super::executor::run_execution_with;
use super::helpers::{reconnect_or_fallback, update_execution_status};
use super::logging::trace;
use super::orchestrator::run_orchestrator_with;

const MAX_RETRIES: u32 = 3;

/// Execute a workflow step using two-phase orchestration
///
/// Phase 1: Run orchestrator to generate prompt
/// Phase 2: Run executor with the generated prompt
///
/// Retries up to MAX_RETRIES times on failure.
pub async fn execute_step_two_phase(
    step: vertebrae_core::Step,
    task_id: &str,
    workflow_id: &str,
    tasks: &Arc<dyn TaskService>,
    executions: &Arc<dyn ExecutionService>,
    app_handle: &AppHandle,
) -> Result<(), String> {
    let runner = TokioCommandRunner::with_log_context(task_id, "ORCHESTRATOR");

    execute_step_two_phase_with(
        &runner,
        step,
        task_id,
        workflow_id,
        tasks,
        executions,
        app_handle,
    )
    .await
}

/// Inner two-phase step execution that accepts a `CommandRunner`.
///
/// Event emission uses AppHandle but the core retry/orchestrate/execute logic
/// is testable via MockCommandRunner.
pub(crate) async fn execute_step_two_phase_with<R: Runtime>(
    runner: &dyn CommandRunner,
    step: vertebrae_core::Step,
    task_id: &str,
    workflow_id: &str,
    tasks: &Arc<dyn TaskService>,
    executions: &Arc<dyn ExecutionService>,
    app_handle: &AppHandle<R>,
) -> Result<(), String> {
    trace(
        task_id,
        &format!(">>> execute_step_two_phase ENTERED for step: {}", step.name),
    );

    log::info!(
        "[WorkflowRunner] Starting two-phase execution for step: {} task: {}",
        step.name,
        task_id
    );

    let mut last_error = String::new();

    for attempt in 1..=MAX_RETRIES {
        trace(
            task_id,
            &format!(
                "--- ATTEMPT {}/{} for step: {} ---",
                attempt, MAX_RETRIES, step.name
            ),
        );

        log::info!(
            "[WorkflowRunner] Saga attempt {}/{} for step: {}",
            attempt,
            MAX_RETRIES,
            step.name
        );

        // Create execution record at start of each attempt
        let exec_id = match create_execution_record(
            &step,
            task_id,
            workflow_id,
            tasks,
            executions,
            app_handle,
        )
        .await
        {
            Ok(id) => id,
            Err(e) => {
                last_error = e;
                if attempt < MAX_RETRIES {
                    trace(task_id, "Will retry in 2 seconds...");
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    continue;
                }
                trace(
                    task_id,
                    &format!(
                        "<<< execute_step_two_phase RETURNING Err after {} attempts",
                        MAX_RETRIES
                    ),
                );
                return Err(last_error);
            }
        };

        // Phase 1: Run orchestrator to generate prompt
        trace(
            task_id,
            &format!("[exec_id={}] Starting PHASE 1: run_orchestrator", exec_id),
        );
        let orchestrator_output = match run_orchestrator_with(
            runner,
            &step,
            &exec_id,
            task_id,
            workflow_id,
            executions,
        )
        .await
        {
            Ok(output) => {
                trace(
                    task_id,
                    &format!(
                        "[exec_id={}] PHASE 1 SUCCESS: orchestrator completed",
                        exec_id
                    ),
                );
                output
            }
            Err(e) => {
                last_error = e.clone();
                trace(
                    task_id,
                    &format!("[exec_id={}] PHASE 1 FAILED: {}", exec_id, e),
                );
                log::warn!(
                    "[WorkflowRunner] Orchestrator failed on attempt {}: {}",
                    attempt,
                    e
                );

                // Mark execution as failed
                let _ = update_execution_status(
                    executions,
                    app_handle,
                    &exec_id,
                    task_id,
                    workflow_id,
                    &step.name,
                    ExecutionStatus::Failed,
                )
                .await;

                let _ = app_handle.emit(
                    "workflow-execution-event",
                    &WorkflowExecutionEvent {
                        task_id: task_id.to_string(),
                        workflow_id: workflow_id.to_string(),
                        event_type: WorkflowExecutionEventType::OrchestratorFailed {
                            execution_id: exec_id.clone(),
                            error: e,
                        },
                    },
                );

                if attempt < MAX_RETRIES {
                    trace(task_id, "Will retry in 2 seconds...");
                    log::info!("[WorkflowRunner] Retrying in 2 seconds...");
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    continue;
                }
                trace(task_id, &format!("<<< execute_step_two_phase RETURNING Err (orchestrator failed after {} attempts)", MAX_RETRIES));
                return Err(format!(
                    "Orchestrator failed after {} attempts: {}",
                    MAX_RETRIES, last_error
                ));
            }
        };

        // Phase 2: Run execution agent with the generated prompt
        trace(
            task_id,
            &format!("[exec_id={}] Starting PHASE 2: run_execution", exec_id),
        );
        match run_execution_with(
            runner,
            &step,
            &exec_id,
            task_id,
            workflow_id,
            &orchestrator_output,
            executions,
        )
        .await
        {
            Ok(()) => {
                trace(
                    task_id,
                    &format!("[exec_id={}] PHASE 2 SUCCESS: execution completed", exec_id),
                );

                // Mark execution as completed
                if let Err(e) = update_execution_status(
                    executions,
                    app_handle,
                    &exec_id,
                    task_id,
                    workflow_id,
                    &step.name,
                    ExecutionStatus::Completed,
                )
                .await
                {
                    trace(
                        task_id,
                        "<<< execute_step_two_phase RETURNING Err (failed to update status)",
                    );
                    return Err(e);
                }

                let _ = app_handle.emit(
                    "workflow-execution-event",
                    &WorkflowExecutionEvent {
                        task_id: task_id.to_string(),
                        workflow_id: workflow_id.to_string(),
                        event_type: WorkflowExecutionEventType::StepCompleted {
                            execution_id: exec_id,
                        },
                    },
                );

                log::info!(
                    "[WorkflowRunner] Step {} completed successfully on attempt {}",
                    step.name,
                    attempt
                );
                trace(
                    task_id,
                    &format!(
                        "<<< execute_step_two_phase RETURNING Ok for step: {}",
                        step.name
                    ),
                );
                return Ok(());
            }
            Err(e) => {
                last_error = e.clone();
                trace(
                    task_id,
                    &format!("[exec_id={}] PHASE 2 FAILED: {}", exec_id, e),
                );
                log::warn!(
                    "[WorkflowRunner] Executor failed on attempt {}: {}",
                    attempt,
                    e
                );

                // Mark execution as failed
                let _ = update_execution_status(
                    executions,
                    app_handle,
                    &exec_id,
                    task_id,
                    workflow_id,
                    &step.name,
                    ExecutionStatus::Failed,
                )
                .await;

                let _ = app_handle.emit(
                    "workflow-execution-event",
                    &WorkflowExecutionEvent {
                        task_id: task_id.to_string(),
                        workflow_id: workflow_id.to_string(),
                        event_type: WorkflowExecutionEventType::StepFailed {
                            execution_id: exec_id,
                            error: e,
                        },
                    },
                );

                if attempt < MAX_RETRIES {
                    trace(task_id, "Will retry in 2 seconds...");
                    log::info!("[WorkflowRunner] Retrying in 2 seconds...");
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    continue;
                }
                trace(task_id, &format!("<<< execute_step_two_phase RETURNING Err (execution failed after {} attempts)", MAX_RETRIES));
                return Err(format!(
                    "Execution failed after {} attempts: {}",
                    MAX_RETRIES, last_error
                ));
            }
        }
    }

    // Should not reach here, but handle gracefully
    trace(
        task_id,
        "<<< execute_step_two_phase RETURNING Err (fell through loop - should not happen)",
    );
    Err(format!(
        "Step execution failed after {} attempts: {}",
        MAX_RETRIES, last_error
    ))
}

/// Create a new execution record and emit creation event
async fn create_execution_record<R: Runtime>(
    step: &vertebrae_core::Step,
    task_id: &str,
    workflow_id: &str,
    tasks: &Arc<dyn TaskService>,
    executions: &Arc<dyn ExecutionService>,
    app_handle: &AppHandle<R>,
) -> Result<String, String> {
    // Reconnect to database before creating execution (CLI may have modified it)
    let _fresh_db = reconnect_or_fallback(tasks, task_id, "new").await;

    trace(
        task_id,
        "Creating StepExecution record with status=InProgress...",
    );
    let execution = StepExecution {
        id: None,
        task_id: task_id.to_string(),
        workflow_id: workflow_id.to_string(),
        step_name: step.name.clone(),
        started_at: Utc::now(),
        completed_at: None,
        status: ExecutionStatus::InProgress,
        context: None,
        prompt: None,
        output: None,
        transition_result: None,
        model_used: Some("haiku".to_string()),
        session_id: None,
        token_usage: None,
        cost_usd: None,
        duration_ms: None,
    };

    match executions.create_execution(execution).await {
        Ok(id) => {
            trace(
                task_id,
                &format!("Execution record CREATED: exec_id={}", id),
            );
            // Emit event for new execution
            let _ = app_handle.emit(
                "step-execution-changed-event",
                StepExecutionChangedEvent {
                    execution_id: id.to_string(),
                    task_id: task_id.to_string(),
                    workflow_id: workflow_id.to_string(),
                    step_name: step.name.clone(),
                    status: StepExecutionStatus::Running,
                    change_type: StepExecutionChangeType::Created,
                },
            );
            Ok(id)
        }
        Err(e) => {
            let err = format!("Failed to create execution: {}", e);
            trace(task_id, &format!("ERROR creating execution: {}", err));
            log::error!("[WorkflowRunner] {}", err);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::mock_services;
    use crate::workflow_runner::command_runner::{MockCommandRunner, ProcessOutput};
    use crate::workflow_runner::helpers::tests::CLAUDE_ENV_MUTEX;
    use vertebrae_core::{OrchestratorOutput, Step};

    fn build_test_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    fn make_orchestrator_stdout() -> String {
        let orchestrator_json = OrchestratorOutput::new("Execute the plan")
            .with_goal("Complete task")
            .to_json()
            .unwrap();
        format!(
            "{{\"type\":\"result\",\"structured_output\":{}}}\n",
            orchestrator_json
        )
    }

    fn success_output(stdout: &str) -> Result<ProcessOutput, String> {
        Ok(ProcessOutput {
            stdout: stdout.to_string(),
            success: true,
            exit_code: Some(0),
        })
    }

    fn failure_output(stdout: &str) -> Result<ProcessOutput, String> {
        Ok(ProcessOutput {
            stdout: stdout.to_string(),
            success: false,
            exit_code: Some(1),
        })
    }

    #[tokio::test]
    async fn success_on_first_attempt() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();
        std::env::set_var("CLAUDE_CODE_PATH", "/bin/ls");

        tokio::time::pause();

        let services = mock_services();
        let tasks = services.tasks_arc();
        let executions = services.executions_arc();

        let app = build_test_app();
        let handle = app.handle();

        // Orchestrator succeeds, then executor succeeds
        let runner = MockCommandRunner::new(vec![
            success_output(&make_orchestrator_stdout()),
            success_output("executor output\n"),
        ]);

        let step = Step::new("test-step", "wf1");
        let result =
            execute_step_two_phase_with(&runner, step, "task1", "wf1", &tasks, &executions, handle)
                .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn retry_orchestrator_fails_twice_succeeds_third() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();
        std::env::set_var("CLAUDE_CODE_PATH", "/bin/ls");

        tokio::time::pause();

        let services = mock_services();
        let tasks = services.tasks_arc();
        let executions = services.executions_arc();

        let app = build_test_app();
        let handle = app.handle();

        // Orchestrator fails twice (non-zero exit), then succeeds, then executor succeeds
        let runner = MockCommandRunner::new(vec![
            failure_output("error1"),
            failure_output("error2"),
            success_output(&make_orchestrator_stdout()),
            success_output("executor output\n"),
        ]);

        let step = Step::new("test-step", "wf1");
        let result =
            execute_step_two_phase_with(&runner, step, "task1", "wf1", &tasks, &executions, handle)
                .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn retry_executor_fails_once_succeeds_second() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();
        std::env::set_var("CLAUDE_CODE_PATH", "/bin/ls");

        tokio::time::pause();

        let services = mock_services();
        let tasks = services.tasks_arc();
        let executions = services.executions_arc();

        let app = build_test_app();
        let handle = app.handle();

        // Attempt 1: orchestrator succeeds, executor fails
        // Attempt 2: orchestrator succeeds, executor succeeds
        let runner = MockCommandRunner::new(vec![
            success_output(&make_orchestrator_stdout()),
            failure_output("exec error"),
            success_output(&make_orchestrator_stdout()),
            success_output("executor output\n"),
        ]);

        let step = Step::new("test-step", "wf1");
        let result =
            execute_step_two_phase_with(&runner, step, "task1", "wf1", &tasks, &executions, handle)
                .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn all_retries_exhausted_returns_error() {
        let _lock = CLAUDE_ENV_MUTEX.lock().unwrap();
        std::env::set_var("CLAUDE_CODE_PATH", "/bin/ls");

        tokio::time::pause();

        let services = mock_services();
        let tasks = services.tasks_arc();
        let executions = services.executions_arc();

        let app = build_test_app();
        let handle = app.handle();

        // All 3 orchestrator attempts fail
        let runner = MockCommandRunner::new(vec![
            failure_output("error1"),
            failure_output("error2"),
            failure_output("error3"),
        ]);

        let step = Step::new("test-step", "wf1");
        let result =
            execute_step_two_phase_with(&runner, step, "task1", "wf1", &tasks, &executions, handle)
                .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("failed after 3 attempts"));
    }

    #[tokio::test]
    async fn execution_record_created_correctly() {
        let services = mock_services();
        let tasks = services.tasks_arc();
        let executions = services.executions_arc();

        let app = build_test_app();
        let handle = app.handle();

        let step = Step::new("test-step", "wf1");
        let result =
            create_execution_record(&step, "task1", "wf1", &tasks, &executions, handle).await;

        assert!(result.is_ok());
        let exec_id = result.unwrap();

        // Verify the execution was created
        let exec = executions.get_execution(&exec_id).await.unwrap().unwrap();
        assert_eq!(exec.task_id, "task1");
        assert_eq!(exec.workflow_id, "wf1");
        assert_eq!(exec.step_name, "test-step");
        assert_eq!(exec.status, ExecutionStatus::InProgress);
    }
}
