//! Integration tests for the `run` CLI command.
//!
//! The `run` command starts workflow execution for a task. Since it attempts to contact
//! an external GUI server via HTTP, we test the validation logic and error paths here.
//! The HTTP POST request itself cannot be tested with mocks (it requires a live server),
//! but we validate the pre-conditions and error messages.

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
    // Create task
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

    // Create workflow
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

    // Assign workflow to task
    services
        .workflows()
        .assign_workflow(&task_id, &wf_id)
        .await
        .unwrap();

    (task_id, wf_id)
}

// ============================================================================
// Tests: validation and error paths
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

        // Verify error is a TaskNotFound error
        if let Err(ServiceError::TaskNotFound { task_id }) = result {
            assert_eq!(task_id, "nonexistent-task-id");
        } else {
            panic!("Expected TaskNotFound error, got: {:?}", result);
        }
    }

    #[tokio::test]
    async fn test_run_task_without_workflow_fails() {
        let services = mock_services();

        // Create task without workflow
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

        // Attempt to run - should fail
        let cmd = RunCommand {
            task_id: task_id.clone(),
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());

        // Verify error message mentions no workflow
        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(message.contains("no assigned workflow"));
            assert!(message.contains(&task_id));
        } else {
            panic!("Expected ValidationFailed error with 'no assigned workflow' message");
        }
    }

    #[tokio::test]
    async fn test_run_task_with_workflow_validates_preconditions() {
        let services = mock_services();
        let (task_id, wf_id) = create_task_with_workflow(&services, "Runnable task").await;

        // Verify task has workflow
        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert_eq!(task.workflow_id, Some(wf_id));

        // Create command - at this point it should pass validation
        let cmd = RunCommand { task_id };
        // Note: The actual execute will fail trying to HTTP POST to GUI,
        // but that means validation passed. We're testing validation only.
        let result = cmd.execute(&services).await;

        // Since GUI is not running, we expect an HTTP error
        assert!(result.is_err());

        // Error should be about GUI connection, not validation
        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(
                message.contains("Failed to connect to GUI")
                    || message.contains("GUI running")
                    || message.contains("GUI returned error")
                    || message.contains("HTTP client error"),
                "Expected GUI connection error, got: {}",
                message
            );
        } else {
            panic!(
                "Expected ValidationFailed with GUI connection error, got: {:?}",
                result
            );
        }
    }

    #[tokio::test]
    async fn test_run_command_structure() {
        let services = mock_services();
        let (task_id, _) = create_task_with_workflow(&services, "Task for structure test").await;

        // Verify we can construct the command
        let _cmd = RunCommand {
            task_id: task_id.clone(),
        };

        // Command was created successfully, just verify the type exists
        assert!(std::mem::size_of::<RunCommand>() > 0);
    }

    #[tokio::test]
    async fn test_run_multiple_different_tasks() {
        let services = mock_services();

        // Create first task with workflow
        let (task1_id, wf1_id) = create_task_with_workflow(&services, "First task").await;

        // Create second task with workflow
        let (task2_id, wf2_id) = create_task_with_workflow(&services, "Second task").await;

        // Verify both are valid
        let t1 = services.tasks().get_task(&task1_id).await.unwrap();
        assert_eq!(t1.workflow_id, Some(wf1_id));

        let t2 = services.tasks().get_task(&task2_id).await.unwrap();
        assert_eq!(t2.workflow_id, Some(wf2_id));

        // Both commands should pass validation and fail on HTTP
        let cmd1 = RunCommand { task_id: task1_id };
        let cmd2 = RunCommand { task_id: task2_id };

        let result1 = cmd1.execute(&services).await;
        let result2 = cmd2.execute(&services).await;

        // Both should fail on GUI connection, not validation
        assert!(result1.is_err());
        assert!(result2.is_err());

        for result in &[result1, result2] {
            if let Err(ServiceError::ValidationFailed { message }) = result {
                assert!(
                    message.contains("Failed to connect to GUI")
                        || message.contains("GUI running")
                        || message.contains("GUI returned error")
                        || message.contains("HTTP client error")
                );
            }
        }
    }

    #[tokio::test]
    async fn test_run_task_workflow_none_explicitly() {
        let services = mock_services();

        // Create task
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

        // Verify workflow_id is None
        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert!(task.workflow_id.is_none());

        // Run command should reject it
        let cmd = RunCommand {
            task_id: task_id.clone(),
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(message.contains("no assigned workflow"));
            assert!(message.contains(&task_id));
        } else {
            panic!(
                "Expected ValidationFailed error with workflow check, got: {:?}",
                result
            );
        }
    }

    #[tokio::test]
    async fn test_run_task_epic_level_with_workflow() {
        let services = mock_services();

        // Create an epic
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

        // Assign workflow
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

        // Run should validate successfully (fail on HTTP)
        let cmd = RunCommand { task_id: epic_id };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(
                message.contains("Failed to connect to GUI")
                    || message.contains("GUI running")
                    || message.contains("GUI returned error")
                    || message.contains("HTTP client error")
            );
        }
    }

    #[tokio::test]
    async fn test_run_workflow_assignment_removal() {
        let services = mock_services();
        let (task_id, wf_id) = create_task_with_workflow(&services, "Task for unassign test").await;

        // Verify it has workflow
        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert_eq!(task.workflow_id, Some(wf_id.clone()));

        // Unassign workflow
        services
            .workflows()
            .unassign_workflow(&task_id)
            .await
            .unwrap();

        // Verify it's gone
        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert!(task.workflow_id.is_none());

        // Now run should fail with validation error
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

        // Create blocker task
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

        // Create task that depends on blocker, with workflow
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

        // Assign workflow
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

        // Run should still pass validation (dependencies don't block run)
        let cmd = RunCommand { task_id };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        if let Err(ServiceError::ValidationFailed { message }) = result {
            assert!(
                message.contains("Failed to connect to GUI")
                    || message.contains("GUI running")
                    || message.contains("GUI returned error")
                    || message.contains("HTTP client error")
            );
        }
    }

    #[tokio::test]
    async fn test_run_parent_task_with_workflow() {
        let services = mock_services();

        // Create parent
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

        // Create child
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

        // Assign workflow to parent
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
        let parent_cmd = RunCommand { task_id: parent_id };
        let parent_result = parent_cmd.execute(&services).await;
        assert!(parent_result.is_err());
        if let Err(ServiceError::ValidationFailed { message }) = parent_result {
            assert!(
                message.contains("Failed to connect to GUI")
                    || message.contains("GUI running")
                    || message.contains("GUI returned error")
                    || message.contains("HTTP client error")
            );
        }

        // Child has no workflow, should fail
        let child_cmd = RunCommand {
            task_id: child_id.clone(),
        };
        let child_result = child_cmd.execute(&services).await;
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
}
