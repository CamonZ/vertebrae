//! Integration tests for the `run` CLI command.
//!
//! The `run` command triggers workflow step execution via the ExecutionService.
//! It calls `run_step` on the execution service, which in production goes through
//! Sacrum's GraphQL API. The mock execution service handles it in-memory.

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
        name: "Run Workflow".to_string(),
        description: Some("Workflow for testing run command".to_string()),
        steps: vec![],
        auto_advance: false,
        order: 0,
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
mod run_command_tests {
    use super::*;

    #[tokio::test]
    async fn test_run_task_not_found() {
        let services = mock_services();
        let cmd = RunCommand {
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
    async fn test_run_task_without_workflow_fails() {
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

        let cmd = RunCommand {
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
    async fn test_run_task_without_step_fails() {
        let services = mock_services();

        // Create task and use TaskService.assign_workflow which sets
        // workflow_id but not current_step_id
        let task_cmd = AddCommand {
            title: "Task without step".to_string(),
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

        // TaskService.assign_workflow sets workflow_id but NOT current_step_id
        services
            .tasks()
            .assign_workflow(&task_id, "some-workflow-id")
            .await
            .unwrap();

        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert!(task.workflow_id.is_some());
        assert!(task.current_step_id.is_none());

        let cmd = RunCommand {
            task_id: task_id.clone(),
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());

        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(
                message.contains("no current step"),
                "Expected 'no current step', got: {}",
                message
            );
        } else {
            panic!("Expected ValidationFailed error, got: {:?}", result);
        }
    }

    #[tokio::test]
    async fn test_run_task_with_workflow_succeeds() {
        let services = mock_services();
        let (task_id, wf_id) = create_task_with_workflow(&services, "Runnable task").await;

        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert_eq!(task.workflow_id, Some(wf_id));
        assert!(task.current_step_id.is_some());

        let cmd = RunCommand { task_id };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
    }

    #[tokio::test]
    async fn test_run_multiple_different_tasks() {
        let services = mock_services();

        let (task1_id, wf1_id) = create_task_with_workflow(&services, "First task").await;
        let (task2_id, wf2_id) = create_task_with_workflow(&services, "Second task").await;

        let t1 = services.tasks().get_task(&task1_id).await.unwrap();
        assert_eq!(t1.workflow_id, Some(wf1_id));

        let t2 = services.tasks().get_task(&task2_id).await.unwrap();
        assert_eq!(t2.workflow_id, Some(wf2_id));

        let cmd1 = RunCommand { task_id: task1_id };
        let cmd2 = RunCommand { task_id: task2_id };

        let result1 = cmd1.execute(&services).await;
        let result2 = cmd2.execute(&services).await;

        assert!(result1.is_ok(), "First task run failed: {:?}", result1);
        assert!(result2.is_ok(), "Second task run failed: {:?}", result2);
    }

    #[tokio::test]
    async fn test_run_task_workflow_none_explicitly() {
        let services = mock_services();

        let task_cmd = AddCommand {
            title: "Task for workflow null check".to_string(),
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

        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert!(task.workflow_id.is_none());

        let cmd = RunCommand {
            task_id: task_id.clone(),
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(message.contains("no assigned workflow"));
            assert!(message.contains(&task_id));
        } else {
            panic!("Expected ValidationFailed error, got: {:?}", result);
        }
    }

    #[tokio::test]
    async fn test_run_task_epic_level_with_workflow() {
        let services = mock_services();

        let epic_cmd = AddCommand {
            title: "Runnable Epic".to_string(),
            level: Some(vertebrae_core::Level::Epic),
            description: Some("An epic that can run".to_string()),
            priority: Some(vertebrae_core::Priority::High),
            tags: vec!["epic".to_string()],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let epic_id = epic_cmd.execute(&services).await.unwrap();

        let wf_options = vertebrae_core::CreateWorkflowOptions {
            name: "Epic Workflow".to_string(),
            description: None,
            steps: vec![],
            auto_advance: false,
            order: 0,
        };
        let wf_id = services
            .workflows()
            .create_workflow(wf_options)
            .await
            .unwrap();

        services
            .workflows()
            .assign_workflow(&epic_id, &wf_id)
            .await
            .unwrap();

        let cmd = RunCommand { task_id: epic_id };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
    }

    #[tokio::test]
    async fn test_run_workflow_assignment_removal() {
        let services = mock_services();
        let (task_id, wf_id) = create_task_with_workflow(&services, "Task for unassign test").await;

        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert_eq!(task.workflow_id, Some(wf_id));

        services
            .workflows()
            .unassign_workflow(&task_id)
            .await
            .unwrap();

        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert!(task.workflow_id.is_none());

        let cmd = RunCommand {
            task_id: task_id.clone(),
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(message.contains("no assigned workflow"));
            assert!(message.contains(&task_id));
        }
    }

    #[tokio::test]
    async fn test_run_task_with_dependencies() {
        let services = mock_services();

        let blocker_cmd = AddCommand {
            title: "Blocker".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let blocker_id = blocker_cmd.execute(&services).await.unwrap();

        let task_cmd = AddCommand {
            title: "Dependent runnable task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![blocker_id],
            needs_review: false,
            workflow: None,
        };
        let task_id = task_cmd.execute(&services).await.unwrap();

        let wf_options = vertebrae_core::CreateWorkflowOptions {
            name: "Dependent Workflow".to_string(),
            description: None,
            steps: vec![],
            auto_advance: false,
            order: 0,
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

        let cmd = RunCommand { task_id };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
    }

    #[tokio::test]
    async fn test_run_parent_child_workflow_behavior() {
        let services = mock_services();

        let parent_cmd = AddCommand {
            title: "Parent task".to_string(),
            level: Some(vertebrae_core::Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let parent_id = parent_cmd.execute(&services).await.unwrap();

        let child_cmd = AddCommand {
            title: "Child task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let child_id = child_cmd.execute(&services).await.unwrap();

        let wf_options = vertebrae_core::CreateWorkflowOptions {
            name: "Parent Workflow".to_string(),
            description: None,
            steps: vec![],
            auto_advance: false,
            order: 0,
        };
        let wf_id = services
            .workflows()
            .create_workflow(wf_options)
            .await
            .unwrap();

        services
            .workflows()
            .assign_workflow(&parent_id, &wf_id)
            .await
            .unwrap();

        // Parent should be runnable
        let parent_run = RunCommand { task_id: parent_id };
        let parent_result = parent_run.execute(&services).await;
        assert!(
            parent_result.is_ok(),
            "Expected Ok, got: {:?}",
            parent_result
        );

        // Child has no workflow, should fail
        let child_run = RunCommand {
            task_id: child_id.clone(),
        };
        let child_result = child_run.execute(&services).await;
        assert!(child_result.is_err());
        if let Err(ServiceError::ValidationFailed { message }) = child_result {
            assert!(message.contains("no assigned workflow"));
            assert!(message.contains(&child_id));
        }
    }

    #[tokio::test]
    async fn test_run_empty_task_id() {
        let services = mock_services();
        let cmd = RunCommand {
            task_id: "".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_run_whitespace_task_id() {
        let services = mock_services();
        let cmd = RunCommand {
            task_id: "   ".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_run_creates_execution_record() {
        let services = mock_services();
        let (task_id, _wf_id) = create_task_with_workflow(&services, "Task for execution").await;

        // Before run, no executions
        let executions = services
            .executions()
            .list_executions_for_task(&task_id)
            .await
            .unwrap();
        assert_eq!(executions.len(), 0);

        let cmd = RunCommand {
            task_id: task_id.clone(),
        };
        cmd.execute(&services).await.unwrap();

        // After run, should have one execution
        let executions = services
            .executions()
            .list_executions_for_task(&task_id)
            .await
            .unwrap();
        assert_eq!(executions.len(), 1);
        assert_eq!(executions[0].task_id, task_id);
        assert!(executions[0].id.is_some());
    }
}
