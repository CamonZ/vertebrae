//! Workflow execution engine
//!
//! Executes workflows using a two-phase orchestration model:
//! - Phase 1 (Orchestrator): Haiku agent reads task/step config, generates structured JSON prompt
//! - Phase 2 (Execution): Main agent executes with step's agents/skills and the generated prompt
//!
//! Emits events for frontend updates and persists execution records to the database.
//!
//! ## Log Files
//!
//! Workflow execution logs are written to `~/.vertebrae/workflow-logs/{task_id}.log`.
//! Each entry is prefixed with `[ORCHESTRATOR]` or `[EXECUTOR]` to identify the phase.
//!
//! Tail the log to monitor workflow execution in real-time:
//! ```bash
//! tail -f ~/.vertebrae/workflow-logs/{task_id}.log
//! ```

mod args;
mod command_runner;
mod executor;
mod helpers;
mod logging;
mod orchestrator;
mod parsing;
mod step;

use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use vertebrae_core::{ExecutionService, StepService, TaskService, WorkflowService};

use crate::events::{TaskStepChangedEvent, WorkflowExecutionEvent, WorkflowExecutionEventType};

// Re-exports
pub use helpers::find_claude_binary;
pub use logging::get_workflow_log_path;

use logging::trace;
use step::execute_step_two_phase;

/// Public message type for workflow supervisor
#[derive(Debug, Clone)]
pub enum WorkflowSupervisorMessage {
    StartWorkflow { task_id: String },
}

/// Execute a workflow for a task
///
/// Fetches the task and its assigned workflow, then executes each step sequentially.
/// Each step goes through two phases: orchestrator (prompt generation) and execution.
/// Emits events for each stage and persists execution records to the database.
pub async fn execute_workflow(
    task_id: String,
    tasks: Arc<dyn TaskService>,
    workflows: Arc<dyn WorkflowService>,
    executions: Arc<dyn ExecutionService>,
    steps: Arc<dyn StepService>,
    app_handle: AppHandle,
) -> Result<(), String> {
    trace(&task_id, "=== WORKFLOW EXECUTION STARTED ===");
    trace(
        &task_id,
        &format!("execute_workflow called for task_id={}", task_id),
    );

    log::info!(
        "[WorkflowRunner] Starting workflow execution for task: {}",
        task_id
    );

    // 1. Fetch task and workflow
    trace(&task_id, "Fetching task from database...");
    let task = match tasks.get_task(&task_id).await {
        Ok(t) => {
            trace(&task_id, &format!("Task found: title={:?}", t.title));
            t
        }
        Err(e) => {
            trace(&task_id, &format!("ERROR: Failed to get task: {}", e));
            return Err(format!("Failed to get task: {}", e));
        }
    };

    let workflow_id = match task.workflow_id {
        Some(ref id) => {
            trace(&task_id, &format!("Task has workflow_id: {:?}", id));
            id.clone()
        }
        None => {
            trace(&task_id, "ERROR: Task has no workflow assigned");
            return Err("Task has no workflow".to_string());
        }
    };

    // Fetch workflow to validate it exists
    trace(&task_id, &format!("Fetching workflow: {}", workflow_id));
    let _workflow = match workflows.get_workflow(&workflow_id).await {
        Ok(w) => {
            trace(&task_id, &format!("Workflow found: name={}", w.name));
            w
        }
        Err(e) => {
            trace(&task_id, &format!("ERROR: Failed to get workflow: {}", e));
            return Err(format!("Failed to get workflow: {}", e));
        }
    };

    let workflow_id_str = workflow_id.clone();

    // Fetch first-class Step entities for this workflow
    trace(&task_id, "Fetching workflow steps...");
    let steps_list = match steps.list_steps_for_workflow(&workflow_id).await {
        Ok(s) => {
            trace(&task_id, &format!("Found {} steps", s.len()));
            for (i, step) in s.iter().enumerate() {
                trace(&task_id, &format!("  Step {}: {}", i, step.name));
            }
            s
        }
        Err(e) => {
            trace(&task_id, &format!("ERROR: Failed to get steps: {}", e));
            return Err(format!("Failed to get steps: {}", e));
        }
    };

    // 2. Emit started event
    trace(&task_id, "Emitting workflow-started event");
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.clone(),
            workflow_id: workflow_id_str.clone(),
            event_type: WorkflowExecutionEventType::Started,
        },
    );

    log::info!(
        "[WorkflowRunner] Workflow started for task: {}, steps: {}",
        task_id,
        steps_list.len()
    );

    // 3. Execute each step sequentially with two-phase model
    for (step_index, step) in steps_list.iter().enumerate() {
        trace(
            &task_id,
            &format!(
                "=== STARTING STEP {}/{}: {} ===",
                step_index + 1,
                steps_list.len(),
                step.name
            ),
        );

        log::info!(
            "[WorkflowRunner] Executing step {} of {}: {}",
            step_index + 1,
            steps_list.len(),
            step.name
        );

        // Update task's current_step_id BEFORE executing the step
        if let Some(ref step_id_str) = step.id {
            // Reconnect to database before writing (CLI may have modified it during previous step)
            trace(
                &task_id,
                &format!("Updating task current_step_id to: {:?}", step_id_str),
            );
            match tasks.set_current_step(&task_id, step_id_str).await {
                Ok(()) => {
                    trace(&task_id, "current_step_id updated successfully");
                    // Emit event so frontend can update directly without refetching
                    let _ = app_handle.emit(
                        "task-step-changed-event",
                        TaskStepChangedEvent {
                            task_id: task_id.clone(),
                            step_id: step_id_str.clone(),
                            step_name: step.name.clone(),
                        },
                    );
                }
                Err(e) => {
                    trace(
                        &task_id,
                        &format!("ERROR: Failed to update task step: {}", e),
                    );
                    return Err(format!("Failed to update task step: {}", e));
                }
            }
            log::info!(
                "[WorkflowRunner] Updated task {} to step: {}",
                task_id,
                step.name
            );
        }

        trace(&task_id, "Calling execute_step_two_phase...");
        match execute_step_two_phase(
            step.clone(),
            &task_id,
            &workflow_id_str,
            &tasks,
            &executions,
            &app_handle,
        )
        .await
        {
            Ok(()) => {
                trace(
                    &task_id,
                    &format!("Step {} completed successfully", step_index + 1),
                );
                log::info!(
                    "[WorkflowRunner] Step {} completed successfully",
                    step_index + 1
                );
            }
            Err(e) => {
                trace(
                    &task_id,
                    &format!("ERROR: Step {} failed: {}", step_index + 1, e),
                );
                log::error!("[WorkflowRunner] Step {} failed: {}", step_index + 1, e);
                // Step failed, stop workflow
                let _ = app_handle.emit(
                    "workflow-execution-event",
                    &WorkflowExecutionEvent {
                        task_id: task_id.clone(),
                        workflow_id: workflow_id_str.clone(),
                        event_type: WorkflowExecutionEventType::Failed { error: e },
                    },
                );
                trace(
                    &task_id,
                    "Returning Err(Workflow failed) from execute_workflow",
                );
                return Err("Workflow failed".to_string());
            }
        }
    }

    // 4. All steps completed
    trace(&task_id, "=== ALL STEPS COMPLETED ===");
    log::info!("[WorkflowRunner] All steps completed for task: {}", task_id);
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.clone(),
            workflow_id: workflow_id_str,
            event_type: WorkflowExecutionEventType::Completed,
        },
    );

    trace(&task_id, "Returning Ok(()) from execute_workflow");
    Ok(())
}
