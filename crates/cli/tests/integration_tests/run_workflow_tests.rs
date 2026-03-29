//! Integration tests for the `run-workflow` CLI command.
//!
//! The `run-workflow` command orchestrates a task through its entire workflow
//! via the ExecutionService's `orchestrate_task` method.

use super::mock::mock_services;
use vertebrae_cli::commands::*;
use vertebrae_core::ServiceError;

// ============================================================================
// Helper: Create a task with a workflow
// ============================================================================

async fn create_task_with_workflow(
    services: &vertebrae_core::VertebraeServices,
    title: &str,
) -> (String, String) {
    let task_cmd = AddCommand {
        title: title.to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    };
    let task_id = task_cmd.execute(services).await.unwrap();

    let wf_options = vertebrae_core::CreateWorkflowOptions {
        name: "Orchestration Workflow".to_string(),
        description: Some("Workflow for testing run-workflow command".to_string()),
        steps: vec![],
        auto_advance: false,
        order: 0,
        kanban_column: None,
    };
    let wf_id = services
        .workflows()
        .create_workflow(wf_options)
        .await
        .unwrap();

    services
        .workflows()
        .assign_workflow(&task_id, &wf_id)
        .await
        .unwrap();

    (task_id, wf_id)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod run_workflow_command_tests {
    use super::*;

    #[tokio::test]
    async fn test_run_workflow_task_not_found() {
        let services = mock_services();
        let cmd = RunWorkflowCommand {
            task_id: "nonexistent-task-id".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err());

        if let Err(ServiceError::TaskNotFound { task_id }) = result {
            assert_eq!(task_id, "nonexistent-task-id");
        } else {
            panic!("Expected TaskNotFound error, got: {:?}", result);
        }
    }

    #[tokio::test]
    async fn test_run_workflow_task_without_workflow_fails() {
        let services = mock_services();

        let task_cmd = AddCommand {
            title: "Task without workflow".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let task_id = task_cmd.execute(&services).await.unwrap();

        let cmd = RunWorkflowCommand {
            task_id: task_id.clone(),
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());

        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(
                message.contains("no assigned workflow"),
                "Expected 'no assigned workflow', got: {}",
                message
            );
            assert!(message.contains(&task_id));
        } else {
            panic!("Expected ValidationFailed error, got: {:?}", result);
        }
    }

    #[tokio::test]
    async fn test_run_workflow_task_with_workflow_succeeds() {
        let services = mock_services();
        let (task_id, wf_id) = create_task_with_workflow(&services, "Orchestratable task").await;

        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert_eq!(task.workflow_id, Some(wf_id));

        let cmd = RunWorkflowCommand {
            task_id: task_id.clone(),
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);

        let msg = result.unwrap();
        assert!(
            msg.contains("Workflow orchestration started"),
            "Expected success message, got: {}",
            msg
        );
        let short_id = &task_id[..8];
        assert!(
            msg.contains(short_id),
            "Expected message to contain short task ID '{}', got: {}",
            short_id,
            msg
        );
    }

    #[tokio::test]
    async fn test_run_workflow_empty_task_id() {
        let services = mock_services();
        let cmd = RunWorkflowCommand {
            task_id: "".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_run_workflow_multiple_tasks() {
        let services = mock_services();

        let (task1_id, _) = create_task_with_workflow(&services, "First orchestration task").await;
        let (task2_id, _) = create_task_with_workflow(&services, "Second orchestration task").await;

        let cmd1 = RunWorkflowCommand { task_id: task1_id };
        let cmd2 = RunWorkflowCommand { task_id: task2_id };

        let result1 = cmd1.execute(&services).await;
        let result2 = cmd2.execute(&services).await;

        assert!(
            result1.is_ok(),
            "First task run-workflow failed: {:?}",
            result1
        );
        assert!(
            result2.is_ok(),
            "Second task run-workflow failed: {:?}",
            result2
        );
    }

    #[tokio::test]
    async fn test_run_workflow_after_unassign_fails() {
        let services = mock_services();
        let (task_id, _) = create_task_with_workflow(&services, "Task for unassign test").await;

        services
            .workflows()
            .unassign_workflow(&task_id)
            .await
            .unwrap();

        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert!(task.workflow_id.is_none());

        let cmd = RunWorkflowCommand {
            task_id: task_id.clone(),
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(
                message.contains("no assigned workflow"),
                "Expected 'no assigned workflow', got: {}",
                message
            );
        } else {
            panic!("Expected ValidationFailed error, got: {:?}", result);
        }
    }
}
