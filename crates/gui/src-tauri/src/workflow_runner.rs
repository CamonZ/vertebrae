//! Workflow execution engine
//!
//! Executes workflows using a two-phase orchestration model:
//! - Phase 1 (Orchestrator): Haiku agent reads task/step config, generates structured JSON prompt
//! - Phase 2 (Execution): Main agent executes with step's agents/skills and the generated prompt
//!
//! Emits events for frontend updates and persists execution records to the database.

use std::path::PathBuf;

use crate::events::{WorkflowExecutionEvent, WorkflowExecutionEventType};
use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use vertebrae_core::{orchestrator_agent_config, OrchestratorOutput};
use vertebrae_db::{Database, ExecutionStatus, PermissionMode, SessionLog, StepExecution, Thing};

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

/// Parse orchestrator output from stdout, handling markdown-wrapped JSON
fn parse_orchestrator_from_stdout(output: &str) -> Result<OrchestratorOutput, String> {
    log::warn!("[WorkflowRunner] Parsing orchestrator output from stdout");

    // Try to extract JSON from the output - handles markdown code blocks
    let json_start = output.find('{');
    let json_end = output.rfind('}');

    match (json_start, json_end) {
        (Some(start), Some(end)) if end > start => {
            let json_str = &output[start..=end];
            log::info!(
                "[WorkflowRunner] Extracted JSON ({} chars) from stdout",
                json_str.len()
            );
            OrchestratorOutput::from_json(json_str)
                .map_err(|e| format!("Failed to parse JSON from stdout: {}", e))
        }
        _ => Err("Orchestrator did not produce valid JSON output".to_string()),
    }
}

/// Execute a workflow for a task
///
/// Fetches the task and its assigned workflow, then executes each step sequentially.
/// Each step goes through two phases: orchestrator (prompt generation) and execution.
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

    let workflow = db
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
        "[WorkflowRunner] Workflow started for task: {}, steps: {}, auto_advance: {}",
        task_id,
        steps.len(),
        workflow.auto_advance
    );

    // 3. Execute each step sequentially with two-phase model
    for (step_index, step) in steps.iter().enumerate() {
        log::info!(
            "[WorkflowRunner] Executing step {} of {}: {}",
            step_index + 1,
            steps.len(),
            step.name
        );

        match execute_step_two_phase(
            step.clone(),
            &task_id,
            &workflow_id_str,
            &db,
            &app_handle,
            workflow.auto_advance,
        )
        .await
        {
            Ok(should_continue) => {
                log::info!(
                    "[WorkflowRunner] Step {} completed, should_continue: {}",
                    step_index + 1,
                    should_continue
                );
                if !should_continue {
                    // Execution decided to hold or retreat
                    log::info!("[WorkflowRunner] Stopping workflow due to execution decision");
                    break;
                }
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

    // 4. All steps completed
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

/// Execute a single workflow step using two-phase orchestration
///
/// Phase 1 (Orchestrator): Spawns Haiku agent to analyze task context and generate JSON prompt
/// Phase 2 (Execution): Spawns main agent with step's agents/skills to execute the prompt
///
/// Returns Ok(true) if execution succeeded and should continue to next step
/// Returns Ok(false) if execution succeeded but should stop (hold/retreat)
async fn execute_step_two_phase(
    step: vertebrae_db::Step,
    task_id: &str,
    workflow_id: &str,
    db: &Database,
    app_handle: &AppHandle,
    auto_advance: bool,
) -> Result<bool, String> {
    log::info!(
        "[WorkflowRunner] Starting two-phase execution for step: {} task: {}",
        step.name,
        task_id
    );

    // Phase 1: Run orchestrator to generate prompt
    let (exec_id, orchestrator_output) =
        run_orchestrator(&step, task_id, workflow_id, db, app_handle).await?;

    // Phase 2: Run execution agent with the generated prompt
    let transition_result = run_execution(
        &step,
        &exec_id,
        task_id,
        workflow_id,
        &orchestrator_output,
        db,
        app_handle,
    )
    .await?;

    // Determine if we should continue based on transition result and auto_advance
    let should_continue = match transition_result.as_str() {
        "advance" => {
            if auto_advance {
                log::info!("[WorkflowRunner] Auto-advancing to next step");
                true
            } else {
                log::info!(
                    "[WorkflowRunner] Transition hint is advance but auto_advance=false, stopping"
                );
                false
            }
        }
        "hold" => {
            log::info!("[WorkflowRunner] Execution requested hold, stopping");
            false
        }
        "retreat" => {
            log::info!("[WorkflowRunner] Execution requested retreat, stopping");
            false
        }
        _ => {
            // Default behavior: continue if auto_advance is enabled
            auto_advance
        }
    };

    Ok(should_continue)
}

/// Phase 1: Run orchestrator agent to generate execution prompt
///
/// Spawns Haiku agent with read-only vtb commands to analyze task context
/// and create a StepExecution record with a structured JSON prompt.
async fn run_orchestrator(
    step: &vertebrae_db::Step,
    task_id: &str,
    workflow_id: &str,
    db: &Database,
    app_handle: &AppHandle,
) -> Result<(String, OrchestratorOutput), String> {
    log::info!(
        "[WorkflowRunner] Phase 1: Running orchestrator for step: {}",
        step.name
    );

    // 1. Create initial execution record for orchestrator phase
    let execution = StepExecution {
        id: None,
        task_id: Thing::from(("task".to_string(), task_id.to_string())),
        workflow_id: Thing::from(("workflow".to_string(), workflow_id.to_string())),
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

    let exec_id = db
        .executions()
        .create_execution(&execution)
        .await
        .map_err(|e| format!("Failed to create execution: {}", e))?;

    log::info!(
        "[WorkflowRunner] Created orchestrator execution record: {}",
        exec_id
    );

    // 2. Emit orchestrator started event
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.to_string(),
            workflow_id: workflow_id.to_string(),
            event_type: WorkflowExecutionEventType::OrchestratorStarted {
                execution_id: exec_id.clone(),
                step_name: step.name.clone(),
            },
        },
    );

    // 3. Find Claude binary
    let claude_path = find_claude_binary()?;
    log::info!("[WorkflowRunner] Found Claude binary at: {:?}", claude_path);

    // 4. Build orchestrator command with Haiku config
    let orchestrator_config = orchestrator_agent_config();
    let mut cmd = Command::new(&claude_path);

    // Collect args for logging
    let mut all_args: Vec<String> = Vec::new();

    // Add orchestrator agent config args
    for arg in orchestrator_config.to_cli_args() {
        all_args.push(arg.clone());
        cmd.arg(arg);
    }

    // Build the orchestrator prompt with task and step context
    let step_id = step.id.as_ref().map(|t| t.id.to_raw()).unwrap_or_default();

    let step_goal = step.goal.clone().unwrap_or_else(|| step.name.clone());

    let orchestrator_prompt = format!(
        "Analyze task {} at workflow step {} (step_id: {}).\n\
        Step goal: {}\n\
        Generate a JSON execution prompt with goal, steps, constraints, and success_criteria.",
        task_id, step.name, step_id, step_goal
    );

    // Log the orchestrator prompt for debugging
    log::info!(
        "[WorkflowRunner] Phase 1 orchestrator prompt:\n{}",
        orchestrator_prompt
    );

    all_args.push("--print".to_string());
    all_args.push(orchestrator_prompt.clone());

    cmd.arg("--print");
    cmd.arg(&orchestrator_prompt);

    // Log the full CLI command
    log::info!(
        "[WorkflowRunner] Claude CLI command: {:?} {}",
        claude_path,
        all_args
            .iter()
            .map(|a| format!("{:?}", a))
            .collect::<Vec<_>>()
            .join(" ")
    );

    // Set up pipes
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // 5. Spawn and capture output
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn orchestrator: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to get stdout".to_string())?;

    let mut reader = BufReader::new(stdout);
    let mut output = String::new();
    let mut line = String::new();

    log::info!("[WorkflowRunner] Reading orchestrator output");

    while reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("Failed to read line: {}", e))?
        > 0
    {
        output.push_str(&line);
        line.clear();
    }

    // Log raw output from orchestrator
    log::info!(
        "[WorkflowRunner] Orchestrator raw stdout ({} bytes):\n{}",
        output.len(),
        output
    );

    // 6. Wait for completion
    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait: {}", e))?;

    if !status.success() {
        // Mark as failed
        db.executions()
            .update_status(&exec_id, ExecutionStatus::Failed, Some(Utc::now()))
            .await
            .map_err(|e| format!("Failed to update status: {}", e))?;

        let error = format!(
            "Orchestrator exited with code: {}",
            status.code().unwrap_or(-1)
        );
        log::error!("[WorkflowRunner] {}", error);

        let _ = app_handle.emit(
            "workflow-execution-event",
            &WorkflowExecutionEvent {
                task_id: task_id.to_string(),
                workflow_id: workflow_id.to_string(),
                event_type: WorkflowExecutionEventType::OrchestratorFailed {
                    execution_id: exec_id,
                    error: error.clone(),
                },
            },
        );

        return Err(error);
    }

    log::info!("[WorkflowRunner] Orchestrator completed successfully");

    // 7. Parse the orchestrator output JSON from stdout
    let orchestrator_output = parse_orchestrator_from_stdout(&output)?;

    // 8. Update execution record with raw orchestrator output and the generated prompt
    let execution_prompt = orchestrator_output.to_execution_prompt(task_id);
    db.executions()
        .update_execution(
            &exec_id,
            Some(output.clone()),
            Some(execution_prompt.clone()),
        )
        .await
        .map_err(|e| format!("Failed to update execution: {}", e))?;

    // 9. Emit orchestrator completed event
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.to_string(),
            workflow_id: workflow_id.to_string(),
            event_type: WorkflowExecutionEventType::OrchestratorCompleted {
                execution_id: exec_id.clone(),
            },
        },
    );

    log::info!(
        "[WorkflowRunner] Phase 1 complete, orchestrator output goal: {}",
        orchestrator_output.goal
    );

    // Log full orchestrator output for debugging
    log::info!(
        "[WorkflowRunner] Orchestrator output:\n\
         ├── Goal: {}\n\
         ├── Steps: {:?}\n\
         ├── Constraints: {:?}\n\
         └── Success Criteria: {:?}",
        orchestrator_output.goal,
        orchestrator_output.steps,
        orchestrator_output.constraints,
        orchestrator_output.success_criteria
    );

    Ok((exec_id, orchestrator_output))
}

/// Phase 2: Run execution agent with the generated prompt
///
/// Spawns Claude with step's configured agents/skills and --dangerously-skip-permissions
/// to execute the prompt generated by the orchestrator.
async fn run_execution(
    step: &vertebrae_db::Step,
    exec_id: &str,
    task_id: &str,
    workflow_id: &str,
    orchestrator_output: &OrchestratorOutput,
    db: &Database,
    app_handle: &AppHandle,
) -> Result<String, String> {
    log::info!(
        "[WorkflowRunner] Phase 2: Running execution for step: {}",
        step.name
    );

    // 1. Emit step started event
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.to_string(),
            workflow_id: workflow_id.to_string(),
            event_type: WorkflowExecutionEventType::StepStarted {
                execution_id: exec_id.to_string(),
                step_name: step.name.clone(),
            },
        },
    );

    // 2. Find Claude binary
    let claude_path = find_claude_binary()?;

    // 3. Build execution command with step's agents/skills
    let mut cmd = Command::new(&claude_path);

    // Use step's agent_config if non-empty, otherwise use step's agents/skills
    let agent_config = if !step.agent_config.is_empty() {
        step.agent_config.clone()
    } else {
        // Build config from step's agents and skills
        let mut config = vertebrae_db::AgentConfig::new();

        // For now, use the step's goal as an append system prompt if available
        if let Some(ref goal) = step.goal {
            config = config.with_append_system_prompt(format!(
                "Step goal: {}\n\nYou are working on step '{}' of the workflow.",
                goal, step.name
            ));
        }

        config
    };

    // Add agent config args
    for arg in agent_config.to_cli_args() {
        cmd.arg(arg);
    }

    // Add step's agent files as --agent arguments
    for agent_path in &step.agents {
        cmd.arg("--agent");
        cmd.arg(agent_path);
    }

    // Add --dangerously-skip-permissions for vtb commands to work
    // This is required for the execution agent to run vtb transition commands
    cmd.arg("--permission-mode");
    cmd.arg(PermissionMode::BypassPermissions.as_str());

    // Build the execution prompt from orchestrator output
    // Note: success_criteria is NOT included in the prompt (used for evaluation later)
    let execution_prompt = orchestrator_output.to_execution_prompt(task_id);

    // Log the execution prompt for debugging
    log::info!(
        "[WorkflowRunner] Phase 2 execution prompt:\n{}",
        execution_prompt
    );

    // Add execution prompt
    cmd.arg("--print");
    cmd.arg(&execution_prompt);

    // Set up pipes
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // 4. Spawn and stream output
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn execution agent: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to get stdout".to_string())?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut output_batch = Vec::new();
    let mut full_output = String::new();
    let mut detected_transition: Option<String> = None;

    log::info!("[WorkflowRunner] Started reading execution output");

    while reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("Failed to read line: {}", e))?
        > 0
    {
        // Check for vtb workflow commands to detect transition
        if line.contains("vtb workflow advance") {
            detected_transition = Some("advance".to_string());
        } else if line.contains("vtb workflow retreat") {
            detected_transition = Some("retreat".to_string());
        }

        full_output.push_str(&line);
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
                        execution_id: exec_id.to_string(),
                        output_lines: output_batch.clone(),
                    },
                },
            );

            // Save to database
            for output_line in &output_batch {
                let log_entry = SessionLog {
                    id: None,
                    step_execution_id: Thing::from((
                        "step_execution".to_string(),
                        exec_id.to_string(),
                    )),
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
                    execution_id: exec_id.to_string(),
                    output_lines: output_batch.clone(),
                },
            },
        );

        for output_line in output_batch {
            let log_entry = SessionLog {
                id: None,
                step_execution_id: Thing::from(("step_execution".to_string(), exec_id.to_string())),
                content: output_line,
                created_at: Utc::now(),
            };
            let _ = db.executions().add_log(&log_entry).await;
        }
    }

    // 5. Wait for completion
    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait: {}", e))?;

    // Determine transition result - default to "advance" if not detected from executor output
    let transition_result = detected_transition.unwrap_or_else(|| "advance".to_string());

    if status.success() {
        log::info!("[WorkflowRunner] Execution completed successfully");

        // Update execution status and output
        db.executions()
            .update_status(exec_id, ExecutionStatus::Completed, Some(Utc::now()))
            .await
            .map_err(|e| format!("Failed to update status: {}", e))?;

        db.executions()
            .update_execution(exec_id, Some(full_output), Some(transition_result.clone()))
            .await
            .map_err(|e| format!("Failed to update execution: {}", e))?;

        // Emit completed
        let _ = app_handle.emit(
            "workflow-execution-event",
            &WorkflowExecutionEvent {
                task_id: task_id.to_string(),
                workflow_id: workflow_id.to_string(),
                event_type: WorkflowExecutionEventType::StepCompleted {
                    execution_id: exec_id.to_string(),
                },
            },
        );

        Ok(transition_result)
    } else {
        // Mark as failed
        db.executions()
            .update_status(exec_id, ExecutionStatus::Failed, Some(Utc::now()))
            .await
            .map_err(|e| format!("Failed to update status: {}", e))?;

        let error = format!(
            "Execution exited with code: {}",
            status.code().unwrap_or(-1)
        );
        log::error!("[WorkflowRunner] {}", error);

        let _ = app_handle.emit(
            "workflow-execution-event",
            &WorkflowExecutionEvent {
                task_id: task_id.to_string(),
                workflow_id: workflow_id.to_string(),
                event_type: WorkflowExecutionEventType::StepFailed {
                    execution_id: exec_id.to_string(),
                    error: error.clone(),
                },
            },
        );

        Err(error)
    }
}
