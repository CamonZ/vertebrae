//! Orchestrator agent for generating execution prompts
//!
//! Phase 1 of the two-phase workflow execution model.
//! Spawns Haiku agent with read-only vtb commands to analyze task context
//! and generate a structured JSON prompt.

use crate::events::{WorkflowExecutionEvent, WorkflowExecutionEventType};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use vertebrae_core::{
    orchestrator_agent_config, orchestrator_prompt, ExecutionService, OrchestratorOutput,
};

use super::helpers::find_claude_binary;
use super::logging::{append_to_workflow_log, trace};
use super::parsing::parse_orchestrator_output;

/// Run orchestrator agent to generate execution prompt
///
/// Spawns Haiku agent with read-only vtb commands to analyze task context
/// and generate a structured JSON prompt. Does not manage execution status.
pub async fn run_orchestrator(
    step: &vertebrae_core::Step,
    exec_id: &str,
    task_id: &str,
    workflow_id: &str,
    executions: &Arc<dyn ExecutionService>,
    app_handle: &AppHandle,
) -> Result<OrchestratorOutput, String> {
    trace(
        task_id,
        &format!("[exec_id={}] >>> run_orchestrator ENTERED", exec_id),
    );

    log::info!(
        "[WorkflowRunner] Phase 1: Running orchestrator for step: {}",
        step.name
    );

    // 1. Emit orchestrator started event
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.to_string(),
            workflow_id: workflow_id.to_string(),
            event_type: WorkflowExecutionEventType::OrchestratorStarted {
                execution_id: exec_id.to_string(),
                step_name: step.name.clone(),
            },
        },
    );

    // 2. Find Claude binary
    trace(
        task_id,
        &format!("[exec_id={}] Finding Claude binary...", exec_id),
    );
    let claude_path = match find_claude_binary() {
        Ok(path) => {
            trace(
                task_id,
                &format!("[exec_id={}] Claude binary found: {:?}", exec_id, path),
            );
            path
        }
        Err(e) => {
            trace(
                task_id,
                &format!(
                    "[exec_id={}] ERROR: Failed to find Claude binary: {}",
                    exec_id, e
                ),
            );
            return Err(e);
        }
    };
    log::info!("[WorkflowRunner] Found Claude binary at: {:?}", claude_path);

    // 3. Build orchestrator command with Haiku config
    let orchestrator_config = orchestrator_agent_config();
    let mut cmd = Command::new(&claude_path);

    // Collect args for logging
    let mut all_args: Vec<String> = Vec::new();

    // Add --dangerously-skip-permissions for autonomous operation
    all_args.push("--dangerously-skip-permissions".to_string());
    cmd.arg("--dangerously-skip-permissions");

    // Add orchestrator agent config args (model, json-schema)
    for arg in orchestrator_config.to_cli_args() {
        all_args.push(arg.clone());
        cmd.arg(arg);
    }

    // Build the orchestrator prompt with task and step context
    let step_id = step.id.as_deref().unwrap_or_default();
    let prompt = orchestrator_prompt(task_id, step_id);

    // Log the orchestrator prompt for debugging
    log::info!("[WorkflowRunner] Phase 1 orchestrator prompt:\n{}", prompt);

    // Add prompt with -p flag
    all_args.push("-p".to_string());
    all_args.push(prompt.clone());
    cmd.arg("-p");
    cmd.arg(&prompt);

    // Add output format for streaming JSON
    all_args.push("--output-format".to_string());
    all_args.push("stream-json".to_string());
    cmd.arg("--output-format");
    cmd.arg("stream-json");

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

    // 4. Spawn and stream output in real-time
    trace(
        task_id,
        &format!("[exec_id={}] Spawning orchestrator process...", exec_id),
    );
    let mut child = match cmd.spawn() {
        Ok(c) => {
            trace(
                task_id,
                &format!(
                    "[exec_id={}] Orchestrator process spawned successfully",
                    exec_id
                ),
            );
            c
        }
        Err(e) => {
            let err = format!("Failed to spawn orchestrator: {}", e);
            trace(task_id, &format!("[exec_id={}] ERROR: {}", exec_id, err));
            return Err(err);
        }
    };

    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let err = "Failed to get stdout".to_string();
            trace(task_id, &format!("[exec_id={}] ERROR: {}", exec_id, err));
            return Err(err);
        }
    };

    let mut reader = BufReader::new(stdout);
    let mut output = String::new();
    let mut line = String::new();

    trace(
        task_id,
        &format!(
            "[exec_id={}] Reading orchestrator output (streaming)...",
            exec_id
        ),
    );
    log::info!("[WorkflowRunner] Reading orchestrator output (streaming)");

    loop {
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                output.push_str(&line);
                // Stream each line to the log file in real-time
                let _ = append_to_workflow_log(task_id, "ORCHESTRATOR", line.trim());
                line.clear();
            }
            Err(e) => {
                let err = format!("Failed to read line: {}", e);
                trace(task_id, &format!("[exec_id={}] ERROR: {}", exec_id, err));
                return Err(err);
            }
        }
    }

    trace(
        task_id,
        &format!(
            "[exec_id={}] Orchestrator output complete ({} bytes)",
            exec_id,
            output.len()
        ),
    );

    // Log raw output from orchestrator
    log::info!(
        "[WorkflowRunner] Orchestrator raw stdout ({} bytes):\n{}",
        output.len(),
        output
    );

    // 5. Wait for completion
    trace(
        task_id,
        &format!(
            "[exec_id={}] Waiting for orchestrator process to exit...",
            exec_id
        ),
    );
    let status = match child.wait().await {
        Ok(s) => {
            trace(
                task_id,
                &format!(
                    "[exec_id={}] Orchestrator process exited with status: {:?}",
                    exec_id, s
                ),
            );
            s
        }
        Err(e) => {
            let err = format!("Failed to wait: {}", e);
            trace(task_id, &format!("[exec_id={}] ERROR: {}", exec_id, err));
            return Err(err);
        }
    };

    if !status.success() {
        let error = format!(
            "Orchestrator exited with code: {}",
            status.code().unwrap_or(-1)
        );
        trace(task_id, &format!("[exec_id={}] ERROR: {}", exec_id, error));
        log::error!("[WorkflowRunner] {}", error);

        // Emit orchestrator failed event for visibility (status update handled by caller)
        let _ = app_handle.emit(
            "workflow-execution-event",
            &WorkflowExecutionEvent {
                task_id: task_id.to_string(),
                workflow_id: workflow_id.to_string(),
                event_type: WorkflowExecutionEventType::OrchestratorFailed {
                    execution_id: exec_id.to_string(),
                    error: error.clone(),
                },
            },
        );

        trace(
            task_id,
            &format!(
                "[exec_id={}] <<< run_orchestrator RETURNING Err (non-zero exit)",
                exec_id
            ),
        );
        return Err(error);
    }

    log::info!("[WorkflowRunner] Orchestrator completed successfully");

    // 7. Parse the orchestrator output JSON
    trace(
        task_id,
        &format!("[exec_id={}] Parsing orchestrator output JSON...", exec_id),
    );
    let orchestrator_output = match parse_orchestrator_output(&output) {
        Ok(output) => {
            trace(
                task_id,
                &format!("[exec_id={}] JSON parsing successful", exec_id),
            );
            output
        }
        Err(e) => {
            trace(
                task_id,
                &format!("[exec_id={}] ERROR: JSON parsing failed: {}", exec_id, e),
            );
            log::error!("[WorkflowRunner] JSON parsing failed: {}", e);
            return Err(e);
        }
    };

    // 8. Update execution record with raw orchestrator output and the generated prompt
    let execution_prompt = orchestrator_output.to_execution_prompt();
    trace(
        task_id,
        &format!(
            "[exec_id={}] Updating execution record with orchestrator output...",
            exec_id
        ),
    );
    match executions
        .update_execution(
            exec_id,
            Some(output.clone()),
            Some(execution_prompt.clone()),
        )
        .await
    {
        Ok(()) => {
            trace(
                task_id,
                &format!(
                    "[exec_id={}] Execution record updated successfully",
                    exec_id
                ),
            );
        }
        Err(e) => {
            let err = format!("Failed to update execution: {}", e);
            trace(task_id, &format!("[exec_id={}] ERROR: {}", exec_id, err));
            return Err(err);
        }
    }

    // 9. Emit orchestrator completed event
    let _ = app_handle.emit(
        "workflow-execution-event",
        &WorkflowExecutionEvent {
            task_id: task_id.to_string(),
            workflow_id: workflow_id.to_string(),
            event_type: WorkflowExecutionEventType::OrchestratorCompleted {
                execution_id: exec_id.to_string(),
            },
        },
    );

    log::info!(
        "[WorkflowRunner] Phase 1 complete, orchestrator result: {} chars",
        orchestrator_output.result.len()
    );

    // Log full orchestrator output for debugging
    log::info!(
        "[WorkflowRunner] Orchestrator output:\n\
         ├── Result: {} chars\n\
         ├── Goal: {:?}\n\
         ├── Steps: {:?}\n\
         ├── Constraints: {:?}\n\
         └── Success Criteria: {:?}",
        orchestrator_output.result.len(),
        orchestrator_output.goal,
        orchestrator_output.steps,
        orchestrator_output.constraints,
        orchestrator_output.success_criteria
    );

    trace(
        task_id,
        &format!("[exec_id={}] <<< run_orchestrator RETURNING Ok", exec_id),
    );
    Ok(orchestrator_output)
}
