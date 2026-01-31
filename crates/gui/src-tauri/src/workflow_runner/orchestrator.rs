//! Orchestrator agent for generating execution prompts
//!
//! Phase 1 of the two-phase workflow execution model.
//! Spawns Haiku agent with read-only vtb commands to analyze task context
//! and generate a structured JSON prompt.

use std::sync::Arc;
use vertebrae_core::{ExecutionService, OrchestratorOutput};

use super::args::build_orchestrator_args;
use super::command_runner::CommandRunner;
use super::logging::trace;
use super::parsing::parse_orchestrator_output;

/// Orchestrator logic that accepts a `CommandRunner`.
///
/// Builds CLI args, runs the process, parses JSON output, and updates the
/// execution record. Event emission is handled by the caller (step.rs).
pub(crate) async fn run_orchestrator_with(
    runner: &dyn CommandRunner,
    step: &vertebrae_core::Step,
    exec_id: &str,
    task_id: &str,
    _workflow_id: &str,
    executions: &Arc<dyn ExecutionService>,
) -> Result<OrchestratorOutput, String> {
    trace(
        task_id,
        &format!("[exec_id={}] >>> run_orchestrator_with ENTERED", exec_id),
    );

    log::info!(
        "[WorkflowRunner] Phase 1: Running orchestrator for step: {}",
        step.name
    );

    // Build args
    let (claude_path, args) = build_orchestrator_args(step, task_id)?;

    log::info!(
        "[WorkflowRunner] Claude CLI command: {:?} {}",
        claude_path,
        args.iter()
            .map(|a| format!("{:?}", a))
            .collect::<Vec<_>>()
            .join(" ")
    );

    // Run the process
    let process_output = runner.run(&claude_path, &args).await?;

    trace(
        task_id,
        &format!(
            "[exec_id={}] Orchestrator output complete ({} bytes)",
            exec_id,
            process_output.stdout.len()
        ),
    );

    log::info!(
        "[WorkflowRunner] Orchestrator raw stdout ({} bytes)",
        process_output.stdout.len()
    );

    if !process_output.success {
        let error = format!(
            "Orchestrator exited with code: {}",
            process_output.exit_code.unwrap_or(-1)
        );
        trace(task_id, &format!("[exec_id={}] ERROR: {}", exec_id, error));
        log::error!("[WorkflowRunner] {}", error);
        return Err(error);
    }

    log::info!("[WorkflowRunner] Orchestrator completed successfully");

    // Parse the orchestrator output JSON
    let orchestrator_output = parse_orchestrator_output(&process_output.stdout)?;

    // Update execution record with raw output and the generated prompt
    let execution_prompt = orchestrator_output.to_execution_prompt();
    executions
        .update_execution(exec_id, Some(process_output.stdout), Some(execution_prompt))
        .await
        .map_err(|e| format!("Failed to update execution: {}", e))?;

    log::info!(
        "[WorkflowRunner] Phase 1 complete, orchestrator result: {} chars",
        orchestrator_output.result.len()
    );

    trace(
        task_id,
        &format!(
            "[exec_id={}] <<< run_orchestrator_with RETURNING Ok",
            exec_id
        ),
    );
    Ok(orchestrator_output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::mock_services;
    use crate::workflow_runner::command_runner::{MockCommandRunner, ProcessOutput};
    use vertebrae_core::{ExecutionStatus, OrchestratorOutput, Step, StepExecution};

    async fn setup_execution(executions: &Arc<dyn ExecutionService>) -> String {
        let exec = StepExecution {
            id: None,
            task_id: "task1".to_string(),
            workflow_id: "wf1".to_string(),
            step_name: "test-step".to_string(),
            started_at: chrono::Utc::now(),
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
        executions.create_execution(exec).await.unwrap()
    }

    #[tokio::test]
    async fn success_valid_jsonl_produces_correct_output() {
        let services = mock_services();
        let executions = services.executions_arc();
        let exec_id = setup_execution(&executions).await;

        let orchestrator_json = OrchestratorOutput::new("Execute the plan")
            .with_goal("Complete task")
            .to_json()
            .unwrap();
        let stdout = format!(
            "{{\"type\":\"init\",\"session_id\":\"abc\"}}\n{{\"type\":\"result\",\"structured_output\":{}}}\n",
            orchestrator_json
        );

        let runner = MockCommandRunner::new(vec![Ok(ProcessOutput {
            stdout,
            success: true,
            exit_code: Some(0),
        })]);

        let step = Step::new("test-step", "wf1");
        let result =
            run_orchestrator_with(&runner, &step, &exec_id, "task1", "wf1", &executions).await;

        assert!(result.is_ok());
        let output = result.unwrap();
        assert_eq!(output.result, "Execute the plan");
        assert_eq!(output.goal, Some("Complete task".to_string()));

        // Verify execution record was updated
        let exec = executions.get_execution(&exec_id).await.unwrap().unwrap();
        assert!(exec.output.is_some());
        assert!(exec.transition_result.is_some()); // stores the execution prompt
    }

    #[tokio::test]
    async fn failure_non_zero_exit_propagates_error() {
        let services = mock_services();
        let executions = services.executions_arc();
        let exec_id = setup_execution(&executions).await;

        let runner = MockCommandRunner::new(vec![Ok(ProcessOutput {
            stdout: "some output".to_string(),
            success: false,
            exit_code: Some(1),
        })]);

        let step = Step::new("test-step", "wf1");
        let result =
            run_orchestrator_with(&runner, &step, &exec_id, "task1", "wf1", &executions).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exited with code: 1"));
    }

    #[tokio::test]
    async fn failure_invalid_json_produces_parse_error() {
        let services = mock_services();
        let executions = services.executions_arc();
        let exec_id = setup_execution(&executions).await;

        let runner = MockCommandRunner::new(vec![Ok(ProcessOutput {
            stdout: "not valid json at all\n".to_string(),
            success: true,
            exit_code: Some(0),
        })]);

        let step = Step::new("test-step", "wf1");
        let result =
            run_orchestrator_with(&runner, &step, &exec_id, "task1", "wf1", &executions).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn execution_record_updated_with_raw_output_and_prompt() {
        let services = mock_services();
        let executions = services.executions_arc();
        let exec_id = setup_execution(&executions).await;

        let orchestrator_json = OrchestratorOutput::new("the prompt").to_json().unwrap();
        let stdout = format!(
            "{{\"type\":\"result\",\"structured_output\":{}}}\n",
            orchestrator_json
        );

        let runner = MockCommandRunner::new(vec![Ok(ProcessOutput {
            stdout: stdout.clone(),
            success: true,
            exit_code: Some(0),
        })]);

        let step = Step::new("test-step", "wf1");
        run_orchestrator_with(&runner, &step, &exec_id, "task1", "wf1", &executions)
            .await
            .unwrap();

        let exec = executions.get_execution(&exec_id).await.unwrap().unwrap();
        assert_eq!(exec.output, Some(stdout));
        assert_eq!(exec.transition_result, Some("the prompt".to_string()));
    }
}
