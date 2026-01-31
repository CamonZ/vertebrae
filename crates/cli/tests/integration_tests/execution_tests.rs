//! Integration tests for execution commands
//!
//! Tests the `ExecutionCommand` variants:
//! - Create: Create a new step execution for a task
//! - List: List all executions for a task
//! - Show: Show details of a specific execution
//! - Update: Update execution output and transition result
//! - Log: Add a log entry to an execution

use super::mock::mock_services;
use chrono::Utc;
use vertebrae_cli::commands::execution::{
    ExecutionCreateCommand, ExecutionListCommand, ExecutionLogCommand, ExecutionShowCommand,
    ExecutionUpdateCommand,
};
use vertebrae_core::{
    CreateTaskOptions, CreateWorkflowOptions, ExecutionStatus, SessionLog, Step, StepExecution,
};

// ============================================================================
// Test: Create execution for a task
// ============================================================================

#[tokio::test]
async fn test_execution_create_success() {
    let services = mock_services();

    // Create a task with a workflow
    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Test task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    // Create and assign a workflow
    let workflow = CreateWorkflowOptions {
        name: "test-workflow".to_string(),
        description: None,
        auto_advance: false,
        steps: vec![],
        order: 0,
    };
    let workflow_id = services
        .workflows()
        .create_workflow(workflow)
        .await
        .unwrap();

    // Create a step
    let step = Step {
        id: Some("step1".to_string()),
        name: "Review".to_string(),
        workflow_id: workflow_id.clone(),
        goal: None,
        agents: vec![],
        skills: vec![],
        agent_config: Default::default(),
        is_final: false,
        order: 0,
        transitions_to: vec![],
        created_at: None,
        updated_at: None,
    };
    services
        .steps()
        .create_step_with_id("step1", &step)
        .await
        .unwrap();

    // Assign workflow to task
    services
        .workflows()
        .assign_workflow(&task_id, &workflow_id)
        .await
        .unwrap();
    services
        .tasks()
        .set_current_step(&task_id, "step1")
        .await
        .unwrap();

    // Create execution with task that has workflow
    let create_cmd = ExecutionCreateCommand {
        task_id: task_id.clone(),
        context: None,
        prompt: None,
    };

    let result = create_cmd.execute(&services).await;
    assert!(
        result.is_ok(),
        "Failed to create execution: {:?}",
        result.err()
    );
    let exec_id = result.unwrap();
    assert!(!exec_id.is_empty());

    // Verify the execution was created
    let execution = services.executions().get_execution(&exec_id).await.unwrap();
    assert!(execution.is_some());
    let exec = execution.unwrap();
    assert_eq!(exec.task_id, task_id);
    assert_eq!(exec.step_name, "Review");
    assert_eq!(exec.status, ExecutionStatus::InProgress);
    assert!(exec.context.is_none());
    assert!(exec.prompt.is_none());
}

#[tokio::test]
async fn test_execution_create_with_context_and_prompt() {
    let services = mock_services();

    // Create task and workflow setup
    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task with context".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let workflow_id = services
        .workflows()
        .create_workflow(CreateWorkflowOptions {
            name: "workflow".to_string(),
            description: None,
            auto_advance: false,
            steps: vec![],
            order: 0,
        })
        .await
        .unwrap();

    let step = Step {
        id: Some("step_id".to_string()),
        name: "Execute".to_string(),
        workflow_id: workflow_id.clone(),
        goal: None,
        agents: vec![],
        skills: vec![],
        agent_config: Default::default(),
        is_final: false,
        order: 0,
        transitions_to: vec![],
        created_at: None,
        updated_at: None,
    };
    services
        .steps()
        .create_step_with_id("step_id", &step)
        .await
        .unwrap();
    services
        .workflows()
        .assign_workflow(&task_id, &workflow_id)
        .await
        .unwrap();
    services
        .tasks()
        .set_current_step(&task_id, "step_id")
        .await
        .unwrap();

    let context = r#"{"file": "test.rs", "line": 42}"#;
    let prompt = r#"{"instruction": "review the code"}"#;

    let create_cmd = ExecutionCreateCommand {
        task_id: task_id.clone(),
        context: Some(context.to_string()),
        prompt: Some(prompt.to_string()),
    };

    let result = create_cmd.execute(&services).await;
    assert!(result.is_ok());
    let exec_id = result.unwrap();

    let execution = services
        .executions()
        .get_execution(&exec_id)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(execution.context.as_deref(), Some(context));
    assert_eq!(execution.prompt.as_deref(), Some(prompt));
}

#[tokio::test]
async fn test_execution_create_invalid_context_json_fails() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let workflow_id = services
        .workflows()
        .create_workflow(CreateWorkflowOptions {
            name: "wf".to_string(),
            description: None,
            auto_advance: false,
            steps: vec![],
            order: 0,
        })
        .await
        .unwrap();

    let step = Step {
        id: Some("s".to_string()),
        name: "S".to_string(),
        workflow_id,
        goal: None,
        agents: vec![],
        skills: vec![],
        agent_config: Default::default(),
        is_final: false,
        order: 0,
        transitions_to: vec![],
        created_at: None,
        updated_at: None,
    };
    services
        .steps()
        .create_step_with_id("s", &step)
        .await
        .unwrap();
    services
        .tasks()
        .set_current_step(&task_id, "s")
        .await
        .unwrap();

    let create_cmd = ExecutionCreateCommand {
        task_id,
        context: Some("{ invalid json }".to_string()),
        prompt: None,
    };

    let result = create_cmd.execute(&services).await;
    assert!(result.is_err(), "Should fail with invalid JSON");
}

#[tokio::test]
async fn test_execution_create_task_not_found() {
    let services = mock_services();

    let create_cmd = ExecutionCreateCommand {
        task_id: "nonexistent".to_string(),
        context: None,
        prompt: None,
    };

    let result = create_cmd.execute(&services).await;
    assert!(result.is_err());
}

// ============================================================================
// Test: List executions for a task
// ============================================================================

#[tokio::test]
async fn test_execution_list_empty() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let list_cmd = ExecutionListCommand {
        task_id: task_id.clone(),
    };

    let result = list_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();
    assert!(output.contains("No executions found"));
    assert!(output.contains(&task_id[..6]));
}

#[tokio::test]
async fn test_execution_list_with_executions() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    // Create multiple executions for the task
    let now = Utc::now();
    let exec1 = StepExecution::new(&task_id, "workflow1", "step1");
    let exec1_id = services.executions().create_execution(exec1).await.unwrap();

    let exec2 = StepExecution::new(&task_id, "workflow1", "step2")
        .with_started_at(now + chrono::Duration::seconds(10));
    let _exec2_id = services.executions().create_execution(exec2).await.unwrap();

    let list_cmd = ExecutionListCommand {
        task_id: task_id.clone(),
    };

    let result = list_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();
    assert!(output.contains("Executions for task"));
    assert!(output.contains("2 total"));
    assert!(output.contains("step1"));
    assert!(output.contains("step2"));
    assert!(output.contains(&exec1_id[..6]));
    assert!(output.contains("IN_PROGRESS"));
}

#[tokio::test]
async fn test_execution_list_nonexistent_task_fails() {
    let services = mock_services();

    let list_cmd = ExecutionListCommand {
        task_id: "nonexistent".to_string(),
    };

    let result = list_cmd.execute(&services).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_execution_list_chronological_order() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let base_time = Utc::now();

    // Create executions in reverse chronological order
    let exec2 = StepExecution::new(&task_id, "wf", "step2")
        .with_started_at(base_time + chrono::Duration::seconds(20));
    services.executions().create_execution(exec2).await.unwrap();

    let exec1 = StepExecution::new(&task_id, "wf", "step1")
        .with_started_at(base_time + chrono::Duration::seconds(10));
    services.executions().create_execution(exec1).await.unwrap();

    let exec0 = StepExecution::new(&task_id, "wf", "step0").with_started_at(base_time);
    services.executions().create_execution(exec0).await.unwrap();

    // Verify they're returned in chronological order
    let executions = services
        .executions()
        .list_executions_for_task(&task_id)
        .await
        .unwrap();
    assert_eq!(executions.len(), 3);
    assert_eq!(executions[0].step_name, "step0");
    assert_eq!(executions[1].step_name, "step1");
    assert_eq!(executions[2].step_name, "step2");
}

// ============================================================================
// Test: Show execution details
// ============================================================================

#[tokio::test]
async fn test_execution_show_basic() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution =
        StepExecution::new(task_id.clone(), "workflow-id", "Initialize").with_output("Success");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let show_cmd = ExecutionShowCommand {
        execution_id: exec_id.clone(),
    };

    let result = show_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();

    assert!(output.contains(&format!("Execution: {}", exec_id)));
    assert!(output.contains("Metadata"));
    assert!(output.contains(&task_id[..6.min(task_id.len())]));
    assert!(output.contains("Initialize"));
    assert!(output.contains("IN_PROGRESS"));
    assert!(output.contains("Output"));
    assert!(output.contains("Success"));
}

#[tokio::test]
async fn test_execution_show_with_context_prompt_output() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let context_text = "Context data";
    let prompt_text = "Prompt text";
    let output_text = "Output result";

    let execution = StepExecution::new(task_id, "wf", "step")
        .with_context(context_text)
        .with_prompt(prompt_text)
        .with_output(output_text);

    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let show_cmd = ExecutionShowCommand {
        execution_id: exec_id,
    };

    let result = show_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();

    assert!(output.contains("Context"));
    assert!(output.contains(context_text));
    assert!(output.contains("Prompt"));
    assert!(output.contains(prompt_text));
    assert!(output.contains("Output"));
    assert!(output.contains(output_text));
}

#[tokio::test]
async fn test_execution_show_with_logs() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    // Add logs
    let log1 = SessionLog::new(&exec_id, "First log entry");
    let _log1_id = services.executions().add_log(log1).await.unwrap();

    let log2 = SessionLog::new(&exec_id, "Second log entry");
    let _log2_id = services.executions().add_log(log2).await.unwrap();

    let show_cmd = ExecutionShowCommand {
        execution_id: exec_id,
    };

    let result = show_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();

    assert!(output.contains("Session Logs"));
    assert!(output.contains("First log entry"));
    assert!(output.contains("Second log entry"));
    assert!(output.contains("[1] Log"));
    assert!(output.contains("[2] Log"));
}

#[tokio::test]
async fn test_execution_show_with_transition_result() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step").with_transition_result("approve");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let show_cmd = ExecutionShowCommand {
        execution_id: exec_id,
    };

    let result = show_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();

    assert!(output.contains("Transition: approve"));
}

#[tokio::test]
async fn test_execution_show_nonexistent_fails() {
    let services = mock_services();

    let show_cmd = ExecutionShowCommand {
        execution_id: "nonexistent".to_string(),
    };

    let result = show_cmd.execute(&services).await;
    assert!(result.is_err());
}

// ============================================================================
// Test: Update execution
// ============================================================================

#[tokio::test]
async fn test_execution_update_output() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let update_cmd = ExecutionUpdateCommand {
        execution_id: exec_id.clone(),
        output: Some("New output".to_string()),
        transition_result: None,
    };

    let result = update_cmd.execute(&services).await;
    assert!(result.is_ok());

    // Verify the update
    let updated = services
        .executions()
        .get_execution(&exec_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.output.as_deref(), Some("New output"));
}

#[tokio::test]
async fn test_execution_update_transition_result() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let update_cmd = ExecutionUpdateCommand {
        execution_id: exec_id.clone(),
        output: None,
        transition_result: Some("approve".to_string()),
    };

    let result = update_cmd.execute(&services).await;
    assert!(result.is_ok());

    let updated = services
        .executions()
        .get_execution(&exec_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.transition_result.as_deref(), Some("approve"));
}

#[tokio::test]
async fn test_execution_update_both_fields() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let update_cmd = ExecutionUpdateCommand {
        execution_id: exec_id.clone(),
        output: Some("Result".to_string()),
        transition_result: Some("reject".to_string()),
    };

    let result = update_cmd.execute(&services).await;
    assert!(result.is_ok());

    let updated = services
        .executions()
        .get_execution(&exec_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.output.as_deref(), Some("Result"));
    assert_eq!(updated.transition_result.as_deref(), Some("reject"));
}

#[tokio::test]
async fn test_execution_update_nonexistent_fails() {
    let services = mock_services();

    let update_cmd = ExecutionUpdateCommand {
        execution_id: "nonexistent".to_string(),
        output: Some("test".to_string()),
        transition_result: None,
    };

    let result = update_cmd.execute(&services).await;
    assert!(result.is_err());
}

// ============================================================================
// Test: Add log to execution
// ============================================================================

#[tokio::test]
async fn test_execution_log_success() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let log_cmd = ExecutionLogCommand {
        execution_id: exec_id.clone(),
        content: "Log message".to_string(),
    };

    let result = log_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();
    assert!(output.contains("Added log"));
    assert!(output.contains(&exec_id[..6.min(exec_id.len())]));
    assert!(output.contains("Log message"));

    // Verify the log was added
    let logs = services
        .executions()
        .list_logs_for_execution(&exec_id)
        .await
        .unwrap();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].content, "Log message");
    assert_eq!(logs[0].step_execution_id, exec_id);
}

#[tokio::test]
async fn test_execution_log_multiline() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let log_content = "Line 1\nLine 2\nLine 3";
    let log_cmd = ExecutionLogCommand {
        execution_id: exec_id.clone(),
        content: log_content.to_string(),
    };

    let result = log_cmd.execute(&services).await;
    assert!(result.is_ok());

    let logs = services
        .executions()
        .list_logs_for_execution(&exec_id)
        .await
        .unwrap();
    assert_eq!(logs[0].content, log_content);
}

#[tokio::test]
async fn test_execution_log_long_content_truncated_in_output() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    let long_content = "a".repeat(100);
    let log_cmd = ExecutionLogCommand {
        execution_id: exec_id.clone(),
        content: long_content.clone(),
    };

    let result = log_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();
    // The output preview should be truncated to 50 chars + "..."
    assert!(output.contains("..."));
    assert!(output.len() < long_content.len());

    // But the full content should be stored
    let logs = services
        .executions()
        .list_logs_for_execution(&exec_id)
        .await
        .unwrap();
    assert_eq!(logs[0].content, long_content);
}

#[tokio::test]
async fn test_execution_log_nonexistent_execution_fails() {
    let services = mock_services();

    let log_cmd = ExecutionLogCommand {
        execution_id: "nonexistent".to_string(),
        content: "Log".to_string(),
    };

    let result = log_cmd.execute(&services).await;
    assert!(result.is_err());
}

// ============================================================================
// Test: Integration tests combining multiple operations
// ============================================================================

#[tokio::test]
async fn test_execution_workflow_create_list_show() {
    let services = mock_services();

    // Create a task
    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Integration test".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    // Create executions
    let exec1 = StepExecution::new(&task_id, "wf", "step1")
        .with_output("First result")
        .with_transition_result("approve");
    let exec1_id = services.executions().create_execution(exec1).await.unwrap();

    let exec2 = StepExecution::new(&task_id, "wf", "step2").with_output("Second result");
    let exec2_id = services.executions().create_execution(exec2).await.unwrap();

    // List executions
    let list_cmd = ExecutionListCommand {
        task_id: task_id.clone(),
    };
    let list_result = list_cmd.execute(&services).await.unwrap();
    assert!(list_result.contains("2 total"));
    assert!(list_result.contains("step1"));
    assert!(list_result.contains("step2"));

    // Show first execution
    let show_cmd = ExecutionShowCommand {
        execution_id: exec1_id.clone(),
    };
    let show_result = show_cmd.execute(&services).await.unwrap();
    assert!(show_result.contains("First result"));
    assert!(show_result.contains("approve"));

    // Show second execution
    let show_cmd2 = ExecutionShowCommand {
        execution_id: exec2_id.clone(),
    };
    let show_result2 = show_cmd2.execute(&services).await.unwrap();
    assert!(show_result2.contains("Second result"));

    // Update first execution and verify in show
    let update_cmd = ExecutionUpdateCommand {
        execution_id: exec1_id.clone(),
        output: Some("Updated result".to_string()),
        transition_result: Some("reject".to_string()),
    };
    update_cmd.execute(&services).await.unwrap();

    let show_updated = ExecutionShowCommand {
        execution_id: exec1_id,
    };
    let show_updated_result = show_updated.execute(&services).await.unwrap();
    assert!(show_updated_result.contains("Updated result"));
    assert!(show_updated_result.contains("reject"));
}

#[tokio::test]
async fn test_execution_with_logs_complete_flow() {
    let services = mock_services();

    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
            status: None,
        })
        .await
        .unwrap();

    let execution = StepExecution::new(task_id, "wf", "step");
    let exec_id = services
        .executions()
        .create_execution(execution)
        .await
        .unwrap();

    // Add multiple logs
    for i in 1..=3 {
        let log_cmd = ExecutionLogCommand {
            execution_id: exec_id.clone(),
            content: format!("Log entry {}", i),
        };
        log_cmd.execute(&services).await.unwrap();
    }

    // Show execution and verify all logs are present
    let show_cmd = ExecutionShowCommand {
        execution_id: exec_id.clone(),
    };
    let output = show_cmd.execute(&services).await.unwrap();

    assert!(output.contains("Session Logs"));
    assert!(output.contains("Log entry 1"));
    assert!(output.contains("Log entry 2"));
    assert!(output.contains("Log entry 3"));
    assert!(output.contains("[1] Log"));
    assert!(output.contains("[2] Log"));
    assert!(output.contains("[3] Log"));

    // Verify logs are in chronological order
    let logs = services
        .executions()
        .list_logs_for_execution(&exec_id)
        .await
        .unwrap();
    assert_eq!(logs.len(), 3);
    assert_eq!(logs[0].content, "Log entry 1");
    assert_eq!(logs[1].content, "Log entry 2");
    assert_eq!(logs[2].content, "Log entry 3");
}
