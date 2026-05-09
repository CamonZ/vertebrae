//! Integration tests for execution commands
//!
//! Tests the `ExecutionCommand` variants:
//! - Create: Create a new step execution for a task
//! - List: List all executions for a task
//! - Show: Show details of a specific execution
//! - Update: Update execution output and transition result
//! - Log: Add a log entry to an execution

use super::mock::{mock_services, mock_services_with_seeder};
use chrono::Utc;
use vertebrae_cli::commands::execution::{
    ExecutionCreateCommand, ExecutionListCommand, ExecutionLogCommand, ExecutionShowCommand,
    ExecutionUpdateCommand,
};
use vertebrae_core::{
    CreateTaskOptions, CreateWorkflowOptions, ExecutionStatus, SessionLog, Step, StepExecution,
    TaskRun, TaskRunStatus,
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
        is_default: false,
        is_final: false,
        kanban_column: None,
    };
    let workflow_id = services
        .workflows()
        .create_workflow(workflow)
        .await
        .unwrap();

    // Create a step
    let step = Step::new("Review", &workflow_id);
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
            is_default: false,
            is_final: false,
            kanban_column: None,
        })
        .await
        .unwrap();

    let step = Step::new("Execute", &workflow_id);
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
            is_default: false,
            is_final: false,
            kanban_column: None,
        })
        .await
        .unwrap();

    let step = Step::new("S", workflow_id);
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
        })
        .await
        .unwrap();

    let list_cmd = ExecutionListCommand {
        task_id: Some(task_id.clone()),
        task_run_id: None,
    };

    let result = list_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();
    assert!(output.contains("No TaskRun-backed executions found"));
    assert!(output.contains(&task_id));
}

#[tokio::test]
async fn test_execution_list_ignores_legacy_executions_without_task_run() {
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
        })
        .await
        .unwrap();

    // Create multiple executions for the task
    let now = Utc::now();
    let exec1 = StepExecution::new(&task_id, "workflow1", "legacy-step1");
    services.executions().create_execution(exec1).await.unwrap();

    let exec2 = StepExecution::new(&task_id, "workflow1", "step2")
        .with_started_at(now + chrono::Duration::seconds(10));
    services.executions().create_execution(exec2).await.unwrap();

    let list_cmd = ExecutionListCommand {
        task_id: Some(task_id.clone()),
        task_run_id: None,
    };

    let result = list_cmd.execute(&services).await;
    assert!(result.is_ok());
    let output = result.unwrap();
    assert!(output.contains("No TaskRun-backed executions found"));
    assert!(!output.contains("Legacy Step Executions"));
    assert!(!output.contains("legacy-step1"));
    assert!(!output.contains("step2"));
}

#[tokio::test]
async fn test_execution_list_nonexistent_task_fails() {
    let services = mock_services();

    let list_cmd = ExecutionListCommand {
        task_id: Some("00000000-0000-4000-8000-000000000000".to_string()),
        task_run_id: None,
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

fn seeded_task_run(
    id: &str,
    task_id: &str,
    status: TaskRunStatus,
    inserted_at: chrono::DateTime<chrono::Utc>,
) -> TaskRun {
    TaskRun {
        id: id.to_string(),
        task_id: task_id.to_string(),
        project_id: "mock-project".to_string(),
        user_id: None,
        status,
        started_at: Some(inserted_at),
        ended_at: None,
        stop_requested_at: None,
        latest_step_execution_id: None,
        outcome_kind: None,
        outcome_context: None,
        parent_task_run_id: None,
        root_task_run_id: None,
        triggered_by_step_execution_id: None,
        inserted_at: Some(inserted_at),
        updated_at: Some(inserted_at),
    }
}

#[tokio::test]
async fn test_execution_list_task_short_id_groups_task_run_backed_executions() {
    let (services, seeder) = mock_services_with_seeder();
    let task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "TaskRun execution list task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
        })
        .await
        .unwrap();

    let base_time = Utc::now();
    let first_run_id = "11111111-1111-4111-8111-111111111111";
    let second_run_id = "22222222-2222-4222-8222-222222222222";
    let first_exec_id = "33333333-3333-4333-8333-333333333333";
    let second_exec_id = "44444444-4444-4444-8444-444444444444";
    let third_exec_id = "55555555-5555-4555-8555-555555555555";
    let log_id = "66666666-6666-4666-8666-666666666666";

    seeder.insert_task_run(seeded_task_run(
        first_run_id,
        &task_id,
        TaskRunStatus::Completed,
        base_time,
    ));
    seeder.insert_task_run(seeded_task_run(
        second_run_id,
        &task_id,
        TaskRunStatus::Failed,
        base_time + chrono::Duration::seconds(10),
    ));

    let mut second_execution = StepExecution::new(&task_id, "workflow-1", "build")
        .with_task_run_id(first_run_id)
        .with_started_at(base_time + chrono::Duration::seconds(2));
    second_execution.id = Some(second_exec_id.to_string());
    seeder.insert_execution(second_execution);

    let mut first_execution = StepExecution::new(&task_id, "workflow-1", "plan")
        .with_task_run_id(first_run_id)
        .with_started_at(base_time + chrono::Duration::seconds(1));
    first_execution.id = Some(first_exec_id.to_string());
    seeder.insert_execution(first_execution);

    let mut third_execution = StepExecution::new(&task_id, "workflow-1", "review")
        .with_task_run_id(second_run_id)
        .with_started_at(base_time + chrono::Duration::seconds(11));
    third_execution.id = Some(third_exec_id.to_string());
    third_execution.complete_at(base_time + chrono::Duration::seconds(15));
    seeder.insert_execution(third_execution);

    let mut legacy_execution = StepExecution::new(&task_id, "workflow-1", "legacy-without-run-id");
    legacy_execution.id = Some("77777777-7777-4777-8777-777777777777".to_string());
    seeder.insert_execution(legacy_execution);

    let mut log = SessionLog::new(first_exec_id, "log content that belongs in execution show");
    log.id = Some(log_id.to_string());
    seeder.insert_log(log);

    let short_task_id = task_id[..8].to_string();
    let list_cmd = ExecutionListCommand {
        task_id: Some(short_task_id),
        task_run_id: None,
    };
    let output = list_cmd.execute(&services).await.unwrap();

    assert!(output.contains(&format!(
        "TaskRun Executions for task {} (3 total)",
        task_id
    )));
    assert!(output.contains(&format!("TaskRun: {}", first_run_id)));
    assert!(output.contains(&format!("TaskRun: {}", second_run_id)));
    assert!(output.contains(&format!(
        "- execution {} task={} taskRunId={} step=plan status=IN_PROGRESS",
        first_exec_id, task_id, first_run_id
    )));
    assert!(output.contains(&format!(
        "- execution {} task={} taskRunId={} step=build status=IN_PROGRESS",
        second_exec_id, task_id, first_run_id
    )));
    assert!(output.contains(&format!(
        "- execution {} task={} taskRunId={} step=review status=COMPLETED",
        third_exec_id, task_id, second_run_id
    )));
    assert!(output.find("step=plan").unwrap() < output.find("step=build").unwrap());
    assert!(!output.contains("TaskRun Trace"));
    assert!(!output.contains("Run Tree"));
    assert!(!output.contains("Session Logs"));
    assert!(!output.contains("rootTaskRunId"));
    assert!(!output.contains("legacy-without-run-id"));
    assert!(!output.contains("log content that belongs in execution show"));
}

#[tokio::test]
async fn test_execution_list_task_run_full_uuid_filters_exact_run() {
    let (services, seeder) = mock_services_with_seeder();
    let root_task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Root task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
        })
        .await
        .unwrap();
    let child_task_id = services
        .tasks()
        .create_task(CreateTaskOptions {
            id: None,
            title: "Child task".to_string(),
            description: None,
            level: None,
            priority: None,
            tags: vec![],
            parent_id: None,
            depends_on: vec![],
            needs_review: false,
        })
        .await
        .unwrap();
    let root_run_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let child_run_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let root_exec_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let child_exec_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let log_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let base_time = Utc::now();

    let mut root_run = seeded_task_run(
        root_run_id,
        &root_task_id,
        TaskRunStatus::Completed,
        base_time,
    );
    root_run.latest_step_execution_id = Some(root_exec_id.to_string());
    let mut child_run = seeded_task_run(
        child_run_id,
        &child_task_id,
        TaskRunStatus::Executing,
        base_time + chrono::Duration::seconds(5),
    );
    child_run.parent_task_run_id = Some(root_run_id.to_string());
    child_run.root_task_run_id = Some(root_run_id.to_string());
    child_run.triggered_by_step_execution_id = Some(root_exec_id.to_string());
    child_run.latest_step_execution_id = Some(child_exec_id.to_string());
    seeder.insert_task_run(root_run);
    seeder.insert_task_run(child_run);

    let mut root_execution = StepExecution::new(&root_task_id, "workflow-root", "wait_children")
        .with_task_run_id(root_run_id)
        .with_started_at(base_time);
    root_execution.id = Some(root_exec_id.to_string());
    root_execution.complete_at(base_time + chrono::Duration::seconds(2));
    seeder.insert_execution(root_execution);

    let mut child_execution = StepExecution::new(&child_task_id, "workflow-child", "implement")
        .with_task_run_id(child_run_id)
        .with_started_at(base_time + chrono::Duration::seconds(6));
    child_execution.id = Some(child_exec_id.to_string());
    seeder.insert_execution(child_execution);

    let mut log = SessionLog::new(child_exec_id, "child output streamed");
    log.id = Some(log_id.to_string());
    seeder.insert_log(log);

    let list_cmd = ExecutionListCommand {
        task_id: None,
        task_run_id: Some(child_run_id.to_string()),
    };
    let output = list_cmd.execute(&services).await.unwrap();

    assert!(output.contains(&format!(
        "TaskRun Executions for TaskRun {} (1 total)",
        child_run_id
    )));
    assert!(output.contains(&format!("TaskRun: {}", child_run_id)));
    assert!(output.contains(&format!(
        "- execution {} task={} taskRunId={} step=implement status=IN_PROGRESS",
        child_exec_id, child_task_id, child_run_id
    )));
    assert!(!output.contains(root_exec_id));
    assert!(!output.contains(&format!("task={}", root_task_id)));
    assert!(!output.contains("TaskRun Trace"));
    assert!(!output.contains("Run Tree"));
    assert!(!output.contains("Session Logs"));
    assert!(!output.contains("rootTaskRunId"));
    assert!(!output.contains("child output streamed"));
}

#[tokio::test]
async fn test_execution_list_task_run_short_id_fails() {
    let services = mock_services();
    let list_cmd = ExecutionListCommand {
        task_id: None,
        task_run_id: Some("bbbbbbbb".to_string()),
    };

    let result = list_cmd.execute(&services).await;

    assert!(result.is_err());
    let error = result.unwrap_err().to_string();
    assert!(
        error.contains("TaskRun short IDs are not supported"),
        "expected TaskRun short ID error, got: {}",
        error
    );
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
        })
        .await
        .unwrap();

    // Create executions
    let task_run_id = "88888888-8888-4888-8888-888888888888";
    let exec1 = StepExecution::new(&task_id, "wf", "step1")
        .with_task_run_id(task_run_id)
        .with_output("First result")
        .with_transition_result("approve");
    let exec1_id = services.executions().create_execution(exec1).await.unwrap();

    let exec2 = StepExecution::new(&task_id, "wf", "step2")
        .with_task_run_id(task_run_id)
        .with_output("Second result");
    let exec2_id = services.executions().create_execution(exec2).await.unwrap();

    // List executions
    let list_cmd = ExecutionListCommand {
        task_id: Some(task_id.clone()),
        task_run_id: None,
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
