//! Workflow execution engine
//!
//! Executes workflows sequentially using Claude Code CLI.
//! Emits events for frontend updates and persists execution records to the database.

use std::path::PathBuf;

use crate::events::{WorkflowExecutionEvent, WorkflowExecutionEventType};
use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use vertebrae_db::{Database, ExecutionStatus, SessionLog, StepExecution, Thing};

/// Public message type for workflow supervisor
#[derive(Debug, Clone)]
pub enum WorkflowSupervisorMessage {
    StartWorkflow { task_id: String },
}

/// Find the Claude Code CLI binary
pub fn find_claude_binary() -> Result<PathBuf, String> {
    // Check CLAUDE_CODE_PATH environment variable
    if let Ok(path) = std::env::var("CLAUDE_CODE_PATH") {
        return Ok(PathBuf::from(path));
    }

    // Try to find 'claude' in PATH
    if let Ok(output) = std::process::Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            return Ok(PathBuf::from(path_str.trim()));
        }
    }

    Err(
        "Claude Code CLI not found. Set CLAUDE_CODE_PATH environment variable or ensure 'claude' is in PATH"
            .to_string(),
    )
}

/// Execute a workflow for a task
///
/// Fetches the task and its assigned workflow, then executes each step sequentially.
/// Emits events for each stage and persists execution records to the database.
pub async fn execute_workflow(
    task_id: String,
    db: Database,
    app_handle: AppHandle,
) -> Result<(), String> {
    log::info!(
        "[WorkflowRunner] Starting workflow execution for task: {}",
        task_id
    );

    // 1. Fetch task and workflow
    let task = db
        .tasks()
        .get(&task_id)
        .await
        .map_err(|e| format!("Failed to get task: {}", e))?
        .ok_or_else(|| format!("Task {} not found", task_id))?;

    let workflow_id = task
        .workflow_id
        .ok_or_else(|| "Task has no workflow".to_string())?;

    let _workflow = db
        .workflows()
        .get(&workflow_id.id.to_raw())
        .await
        .map_err(|e| format!("Failed to get workflow: {}", e))?
        .ok_or_else(|| "Workflow not found".to_string())?;

    let workflow_id_str = workflow_id.id.to_raw();

    // Fetch first-class Step entities for this workflow
    let steps = db
        .steps()
        .list_by_workflow(&workflow_id)
        .await
        .map_err(|e| format!("Failed to get steps: {}", e))?;

    // 2. Emit started event
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
        steps.len()
    );

    // 3. Get task goal for prompt
    let task_goal = task
        .sections
        .iter()
        .find(|s| matches!(s.section_type, vertebrae_db::SectionType::Goal))
        .map(|s| s.content.clone())
        .unwrap_or_else(|| task.title.clone());

    // 4. Execute each step sequentially
    for (step_index, step) in steps.iter().enumerate() {
        log::info!(
            "[WorkflowRunner] Executing step {} of {}: {}",
            step_index + 1,
            steps.len(),
            step.name
        );

        match execute_step(
            step.clone(),
            &task_goal,
            &task_id,
            &workflow_id_str,
            &db,
            &app_handle,
        )
        .await
        {
            Ok(_) => {
                log::info!(
                    "[WorkflowRunner] Step {} completed successfully",
                    step_index + 1
                );
            }
            Err(e) => {
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
                return Err("Workflow failed".to_string());
            }
        }
    }

    // 5. All steps completed
    log::info!("[WorkflowRunner] All steps completed for task: {}", task_id);
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.clone(),
            workflow_id: workflow_id_str,
            event_type: WorkflowExecutionEventType::Completed,
        },
    );

    Ok(())
}

/// Execute a single workflow step
///
/// Creates an execution record, spawns Claude CLI, streams output to SessionLog,
/// and emits events for progress updates.
async fn execute_step(
    step: vertebrae_db::Step,
    task_goal: &str,
    task_id: &str,
    workflow_id: &str,
    db: &Database,
    app_handle: &AppHandle,
) -> Result<(), String> {
    log::info!(
        "[WorkflowRunner] Executing step: {} for task: {}",
        step.name,
        task_id
    );

    // 1. Create execution record
    let execution = StepExecution {
        id: None,
        task_id: Thing::from(("task".to_string(), task_id.to_string())),
        workflow_id: Thing::from(("workflow".to_string(), workflow_id.to_string())),
        step_name: step.name.clone(),
        started_at: Utc::now(),
        completed_at: None,
        status: ExecutionStatus::InProgress,
    };

    let exec_id = db
        .executions()
        .create_execution(&execution)
        .await
        .map_err(|e| format!("Failed to create execution: {}", e))?;

    log::info!("[WorkflowRunner] Created execution record: {}", exec_id);

    // 2. Emit step started
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.to_string(),
            workflow_id: workflow_id.to_string(),
            event_type: WorkflowExecutionEventType::StepStarted {
                execution_id: exec_id.clone(),
                step_name: step.name.clone(),
            },
        },
    );

    // 3. Find Claude binary
    let claude_path = find_claude_binary()?;
    log::info!("[WorkflowRunner] Found Claude binary at: {:?}", claude_path);

    // 4. Build command
    let mut cmd = Command::new(&claude_path);

    // Add agent config args
    for arg in step.agent_config.to_cli_args() {
        cmd.arg(arg);
    }

    // Add task goal as prompt
    cmd.arg(task_goal);

    // Set up pipes
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // 5. Spawn and stream output
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to get stdout".to_string())?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut output_batch = Vec::new();

    log::info!("[WorkflowRunner] Started reading Claude output");

    while reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("Failed to read line: {}", e))?
        > 0
    {
        output_batch.push(line.trim().to_string());

        // Emit and save batches of 100 lines
        if output_batch.len() >= 100 {
            log::debug!(
                "[WorkflowRunner] Emitting and saving batch of {} lines",
                output_batch.len()
            );

            // Emit progress event
            let _ = app_handle.emit(
                "workflow-execution-event",
                &WorkflowExecutionEvent {
                    task_id: task_id.to_string(),
                    workflow_id: workflow_id.to_string(),
                    event_type: WorkflowExecutionEventType::StepProgress {
                        execution_id: exec_id.clone(),
                        output_lines: output_batch.clone(),
                    },
                },
            );

            // Save to database
            for output_line in &output_batch {
                let log_entry = SessionLog {
                    id: None,
                    step_execution_id: Thing::from(("step_execution".to_string(), exec_id.clone())),
                    content: output_line.clone(),
                    created_at: Utc::now(),
                };
                let _ = db.executions().add_log(&log_entry).await;
            }

            output_batch.clear();
        }

        line.clear();
    }

    // Emit remaining output
    if !output_batch.is_empty() {
        log::debug!(
            "[WorkflowRunner] Emitting and saving final batch of {} lines",
            output_batch.len()
        );

        let _ = app_handle.emit(
            "workflow-execution-event",
            &WorkflowExecutionEvent {
                task_id: task_id.to_string(),
                workflow_id: workflow_id.to_string(),
                event_type: WorkflowExecutionEventType::StepProgress {
                    execution_id: exec_id.clone(),
                    output_lines: output_batch.clone(),
                },
            },
        );

        for output_line in output_batch {
            let log_entry = SessionLog {
                id: None,
                step_execution_id: Thing::from(("step_execution".to_string(), exec_id.clone())),
                content: output_line,
                created_at: Utc::now(),
            };
            let _ = db.executions().add_log(&log_entry).await;
        }
    }

    // 6. Wait for completion
    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait: {}", e))?;

    if status.success() {
        log::info!("[WorkflowRunner] Claude exited successfully");

        // Update execution status
        db.executions()
            .update_status(&exec_id, ExecutionStatus::Completed, Some(Utc::now()))
            .await
            .map_err(|e| format!("Failed to update status: {}", e))?;

        // Emit completed
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

        Ok(())
    } else {
        // Mark as failed
        db.executions()
            .update_status(&exec_id, ExecutionStatus::Failed, Some(Utc::now()))
            .await
            .map_err(|e| format!("Failed to update status: {}", e))?;

        let error = format!("Claude exited with code: {}", status.code().unwrap_or(-1));
        log::error!("[WorkflowRunner] {}", error);

        let _ = app_handle.emit(
            "workflow-execution-event",
            &WorkflowExecutionEvent {
                task_id: task_id.to_string(),
                workflow_id: workflow_id.to_string(),
                event_type: WorkflowExecutionEventType::StepFailed {
                    execution_id: exec_id,
                    error: error.clone(),
                },
            },
        );

        Err(error)
    }
}
