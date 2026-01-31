//! Two-phase step execution with retry logic
//!
//! Executes a workflow step using the orchestrator (Phase 1) and executor (Phase 2).
//! Handles retries, status updates, and event emission.

use chrono::Utc;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use vertebrae_core::{ExecutionService, ExecutionStatus, StepExecution, TaskService};

use crate::events::{
    StepExecutionChangeType, StepExecutionChangedEvent, StepExecutionStatus,
    WorkflowExecutionEvent, WorkflowExecutionEventType,
};

use super::executor::run_execution;
use super::helpers::{reconnect_or_fallback, update_execution_status};
use super::logging::trace;
use super::orchestrator::run_orchestrator;

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
        let orchestrator_output = match run_orchestrator(
            &step,
            &exec_id,
            task_id,
            workflow_id,
            executions,
            app_handle,
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
        match run_execution(
            &step,
            &exec_id,
            task_id,
            workflow_id,
            &orchestrator_output,
            executions,
            app_handle,
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
async fn create_execution_record(
    step: &vertebrae_core::Step,
    task_id: &str,
    workflow_id: &str,
    tasks: &Arc<dyn TaskService>,
    executions: &Arc<dyn ExecutionService>,
    app_handle: &AppHandle,
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
