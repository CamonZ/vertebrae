//! Integration tests for the `start-taskrun` CLI command.
//!
//! The `start-taskrun` command starts a durable TaskRun for a task workflow.

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
        workflow: None,
    };
    let task_id = task_cmd.execute(services).await.unwrap();

    let wf_options = vertebrae_core::CreateWorkflowOptions {
        name: "Orchestration Workflow".to_string(),
        description: Some("Workflow for testing start-taskrun command".to_string()),
        steps: vec![],
        order: 0,
        is_default: false,
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
            msg.contains("Run: executing"),
            "Expected success message, got: {}",
            msg
        );
        assert!(
            msg.contains("taskRun=mock"),
            "Expected message to contain TaskRun ID, got: {}",
            msg
        );
        assert!(
            msg.contains("latestStep=mock"),
            "Expected message to contain latest step execution ID, got: {}",
            msg
        );
    }

    #[tokio::test]
    async fn test_task_run_lifecycle_surfaces_in_list_show_and_stop() {
        let services = mock_services();
        let (task_id, _) = create_task_with_workflow(&services, "TaskRun surfaced task").await;

        let run_msg = RunWorkflowCommand {
            task_id: task_id.clone(),
        }
        .execute(&services)
        .await
        .unwrap();
        assert!(run_msg.contains("Run: executing"));

        let list = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            root: false,
            parent: None,
            include_archived: false,
            search: None,
            flat: false,
        }
        .execute(&services)
        .await
        .unwrap();
        let listed = list
            .iter()
            .find(|summary| summary.id == task_id)
            .expect("task should be listed");
        assert_eq!(listed.run_state.as_deref(), Some("executing"));
        assert!(
            listed
                .active_task_run_id
                .as_deref()
                .is_some_and(|id| id.starts_with("mock")),
            "list summary should expose active TaskRun ID: {:?}",
            listed
        );
        assert!(
            listed
                .latest_step_execution_id
                .as_deref()
                .is_some_and(|id| id.starts_with("mock")),
            "list summary should expose latest step execution ID: {:?}",
            listed
        );

        let detail = ShowCommand {
            id: task_id.clone(),
        }
        .execute(&services)
        .await
        .unwrap();
        let active_run = detail
            .run_controls
            .as_ref()
            .and_then(|controls| controls.active_run.as_ref())
            .expect("active run summary");
        assert_eq!(active_run.status.to_string(), "executing");
        assert_eq!(detail.run_history.len(), 1);
        assert!(
            detail
                .run_controls
                .as_ref()
                .is_some_and(|controls| !controls.runnable && controls.stoppable),
            "show should expose server-derived run controls"
        );
        let display = detail.to_string();
        assert!(
            display.contains(&format!(
                "Run: executing taskRun={} latestStep={}",
                active_run.id,
                active_run.latest_step_execution_id.as_deref().unwrap()
            )),
            "show output should include active TaskRun state, got:\n{}",
            display
        );
        assert!(
            display.contains("Controls: runnable=false stoppable=true"),
            "show output should include run controls, got:\n{}",
            display
        );
        assert!(
            display.contains("History:"),
            "show output should include concise run history, got:\n{}",
            display
        );

        let stop_msg = StopCommand {
            task_id: task_id.clone(),
        }
        .execute(&services)
        .await
        .unwrap();
        assert!(
            stop_msg.contains(&format!("Stopped run: stopping taskRun={}", active_run.id)),
            "stop should prefer active TaskRun ID, got: {}",
            stop_msg
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
            "First task start-taskrun failed: {:?}",
            result1
        );
        assert!(
            result2.is_ok(),
            "Second task start-taskrun failed: {:?}",
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
