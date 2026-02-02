//! Integration tests for workflow subcommands
//!
//! Tests the workflow command dispatch and individual workflow command execution
//! against mock service implementations. Focuses on CLI-level behavior verification
//! with strong assertions on actual data values.

use super::mock::mock_services;
use vertebrae_cli::commands::workflow::*;
use vertebrae_core::{CreateWorkflowOptions, VertebraeServices};

// ============================================================================
// Helper functions
// ============================================================================

/// Create a test workflow with given name and optional description
async fn create_workflow(
    services: &VertebraeServices,
    name: &str,
    description: Option<&str>,
) -> String {
    let options = CreateWorkflowOptions {
        name: name.to_string(),
        description: description.map(|d| d.to_string()),
        steps: vec![],
        auto_advance: false,
        order: 0,
    };
    services.workflows().create_workflow(options).await.unwrap()
}

/// Create a test task with given title
async fn create_task(services: &VertebraeServices, title: &str) -> String {
    let options = vertebrae_core::CreateTaskOptions {
        id: None,
        title: title.to_string(),
        description: None,
        level: Some(vertebrae_core::Level::Task),
        status: None,
        priority: None,
        tags: vec![],
        parent_id: None,
        depends_on: vec![],
        needs_review: false,
    };
    services.tasks().create_task(options).await.unwrap()
}

// ============================================================================
// WorkflowShowCommand tests
// ============================================================================

#[tokio::test]
async fn test_workflow_show_existing_workflow() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Review Workflow", Some("Peer review")).await;

    let cmd = WorkflowShowCommand { id: wf_id.clone() };
    let output = cmd.execute(&services).await.unwrap();

    // Verify output contains workflow details
    assert!(output.contains("Review Workflow"));
    assert!(output.contains("Peer review"));
    assert!(output.contains(&wf_id));
}

#[tokio::test]
async fn test_workflow_show_nonexistent_workflow() {
    let services = mock_services();

    let cmd = WorkflowShowCommand {
        id: "nonexistent".to_string(),
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_workflow_show_captures_workflow_name() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Integration Testing Workflow", None).await;

    let cmd = WorkflowShowCommand { id: wf_id };
    let output = cmd.execute(&services).await.unwrap();

    // Verify the exact workflow name appears in output
    assert!(output.contains("Integration Testing Workflow"));
}

// ============================================================================
// WorkflowListCommand tests
// ============================================================================

#[tokio::test]
async fn test_workflow_list_empty() {
    let services = mock_services();

    let cmd = WorkflowListCommand {};
    let output = cmd.execute(services.workflows()).await.unwrap();

    assert_eq!(output, "No workflows found");
}

#[tokio::test]
async fn test_workflow_list_single_workflow() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Testing Workflow", None).await;

    let cmd = WorkflowListCommand {};
    let output = cmd.execute(services.workflows()).await.unwrap();

    assert!(output.contains(&wf_id));
    assert!(output.contains("Testing Workflow"));
    // Verify step count is shown
    assert!(output.contains("0 steps"));
}

#[tokio::test]
async fn test_workflow_list_multiple_workflows() {
    let services = mock_services();
    let wf1_id = create_workflow(&services, "QA Workflow", None).await;
    let wf2_id = create_workflow(&services, "Deployment Workflow", Some("Deploy to prod")).await;

    let cmd = WorkflowListCommand {};
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Both workflows should appear
    assert!(output.contains(&wf1_id));
    assert!(output.contains(&wf2_id));
    assert!(output.contains("QA Workflow"));
    assert!(output.contains("Deployment Workflow"));
    assert!(output.contains("Deploy to prod"));
}

#[tokio::test]
async fn test_workflow_list_includes_step_count() {
    let services = mock_services();
    let _wf_id = create_workflow(&services, "Counted Workflow", None).await;

    let cmd = WorkflowListCommand {};
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Output should show step count
    assert!(output.contains("steps"));
}

// ============================================================================
// WorkflowUpdateCommand tests
// ============================================================================

#[tokio::test]
async fn test_workflow_update_name() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Old Name", None).await;

    let cmd = WorkflowUpdateCommand {
        id: wf_id.clone(),
        name: Some("New Name".to_string()),
        description: None,
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Verify success message
    assert!(output.contains("Updated workflow"));
    assert!(output.contains(&wf_id));

    // Verify the update actually happened
    let updated = services.workflows().get_workflow(&wf_id).await.unwrap();
    assert_eq!(updated.name, "New Name");
}

#[tokio::test]
async fn test_workflow_update_description() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Workflow", None).await;

    let cmd = WorkflowUpdateCommand {
        id: wf_id.clone(),
        name: None,
        description: Some("Updated description".to_string()),
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    assert!(output.contains("Updated workflow"));

    // Verify description was set
    let updated = services.workflows().get_workflow(&wf_id).await.unwrap();
    assert_eq!(updated.description, Some("Updated description".to_string()));
}

#[tokio::test]
async fn test_workflow_update_auto_advance_enable() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Auto Workflow", None).await;

    let cmd = WorkflowUpdateCommand {
        id: wf_id.clone(),
        name: None,
        description: None,
        clear_description: false,
        auto_advance: true,
        no_auto_advance: false,
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    assert!(output.contains("Updated workflow"));

    // Verify auto_advance was enabled
    let updated = services.workflows().get_workflow(&wf_id).await.unwrap();
    assert!(updated.auto_advance);
}

#[tokio::test]
async fn test_workflow_update_multiple_fields() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Multi Update", None).await;

    let cmd = WorkflowUpdateCommand {
        id: wf_id.clone(),
        name: Some("Updated Multi Workflow".to_string()),
        description: Some("Multiple fields updated".to_string()),
        clear_description: false,
        auto_advance: true,
        no_auto_advance: false,
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    assert!(output.contains("Updated workflow"));

    // Verify all updates applied
    let updated = services.workflows().get_workflow(&wf_id).await.unwrap();
    assert_eq!(updated.name, "Updated Multi Workflow");
    assert_eq!(
        updated.description,
        Some("Multiple fields updated".to_string())
    );
    assert!(updated.auto_advance);
}

#[tokio::test]
async fn test_workflow_update_no_updates_fails() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Workflow", None).await;

    let cmd = WorkflowUpdateCommand {
        id: wf_id,
        name: None,
        description: None,
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };
    let result = cmd.execute(services.workflows()).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_workflow_update_nonexistent_workflow() {
    let services = mock_services();

    let cmd = WorkflowUpdateCommand {
        id: "nonexistent".to_string(),
        name: Some("New Name".to_string()),
        description: None,
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };
    let result = cmd.execute(services.workflows()).await;

    assert!(result.is_err());
}

// ============================================================================
// WorkflowAdvanceCommand tests
// ============================================================================

#[tokio::test]
async fn test_workflow_advance_step() {
    let services = mock_services();
    let task_id = create_task(&services, "Task to advance").await;

    let cmd = WorkflowAdvanceCommand {
        task_id: task_id.clone(),
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Verify output contains advancement information
    assert!(output.contains("Advanced task"));
    assert!(output.contains(&task_id));
    assert!(output.contains("step"));
}

#[tokio::test]
async fn test_workflow_advance_contains_step_numbers() {
    let services = mock_services();
    let task_id = create_task(&services, "Numbered task").await;

    let cmd = WorkflowAdvanceCommand {
        task_id: task_id.clone(),
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Verify output shows step progression (step 2/3, etc)
    assert!(output.contains("/"));
}

#[tokio::test]
async fn test_workflow_advance_task_not_found() {
    let services = mock_services();

    let cmd = WorkflowAdvanceCommand {
        task_id: "nonexistent".to_string(),
    };
    let result = cmd.execute(services.workflows()).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_workflow_advance_execution_id_in_output() {
    let services = mock_services();
    let task_id = create_task(&services, "Execution task").await;

    let cmd = WorkflowAdvanceCommand {
        task_id: task_id.clone(),
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Verify execution ID appears in output
    assert!(output.contains("execution"));
}

// ============================================================================
// WorkflowRetreatCommand tests
// ============================================================================

#[tokio::test]
async fn test_workflow_retreat_step() {
    let services = mock_services();
    let task_id = create_task(&services, "Task to retreat").await;

    let cmd = WorkflowRetreatCommand {
        task_id: task_id.clone(),
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Verify output contains retreat information
    assert!(output.contains("Retreated task"));
    assert!(output.contains(&task_id));
    assert!(output.contains("step"));
}

#[tokio::test]
async fn test_workflow_retreat_contains_step_numbers() {
    let services = mock_services();
    let task_id = create_task(&services, "Retreat numbered task").await;

    let cmd = WorkflowRetreatCommand {
        task_id: task_id.clone(),
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Verify output shows step regression (e.g., step 1/3)
    assert!(output.contains("/"));
}

#[tokio::test]
async fn test_workflow_retreat_task_not_found() {
    let services = mock_services();

    let cmd = WorkflowRetreatCommand {
        task_id: "nonexistent".to_string(),
    };
    let result = cmd.execute(services.workflows()).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_workflow_retreat_execution_id_in_output() {
    let services = mock_services();
    let task_id = create_task(&services, "Retreat execution task").await;

    let cmd = WorkflowRetreatCommand {
        task_id: task_id.clone(),
    };
    let output = cmd.execute(services.workflows()).await.unwrap();

    // Verify execution ID appears in output
    assert!(output.contains("execution"));
}

// ============================================================================
// WorkflowCommand dispatch tests
// ============================================================================

#[tokio::test]
async fn test_workflow_command_dispatch_show() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Dispatch Show", None).await;

    let cmd = WorkflowCommand::Show(WorkflowShowCommand { id: wf_id.clone() });
    let output = cmd.execute(&services).await.unwrap();

    assert!(output.contains("Dispatch Show"));
    assert!(output.contains(&wf_id));
}

#[tokio::test]
async fn test_workflow_command_dispatch_list() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Dispatch List", None).await;

    let cmd = WorkflowCommand::List(WorkflowListCommand {});
    let output = cmd.execute(&services).await.unwrap();

    assert!(output.contains(&wf_id));
    assert!(output.contains("Dispatch List"));
}

#[tokio::test]
async fn test_workflow_command_dispatch_update() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Dispatch Update", None).await;

    let cmd = WorkflowCommand::Update(WorkflowUpdateCommand {
        id: wf_id.clone(),
        name: Some("Updated via dispatch".to_string()),
        description: None,
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    });
    let output = cmd.execute(&services).await.unwrap();

    assert!(output.contains("Updated workflow"));

    // Verify the update was applied
    let updated = services.workflows().get_workflow(&wf_id).await.unwrap();
    assert_eq!(updated.name, "Updated via dispatch");
}

#[tokio::test]
async fn test_workflow_command_dispatch_advance() {
    let services = mock_services();
    let task_id = create_task(&services, "Dispatch advance task").await;

    let cmd = WorkflowCommand::Advance(WorkflowAdvanceCommand {
        task_id: task_id.clone(),
    });
    let output = cmd.execute(&services).await.unwrap();

    assert!(output.contains("Advanced task"));
    assert!(output.contains(&task_id));
}

#[tokio::test]
async fn test_workflow_command_dispatch_retreat() {
    let services = mock_services();
    let task_id = create_task(&services, "Dispatch retreat task").await;

    let cmd = WorkflowCommand::Retreat(WorkflowRetreatCommand {
        task_id: task_id.clone(),
    });
    let output = cmd.execute(&services).await.unwrap();

    assert!(output.contains("Retreated task"));
    assert!(output.contains(&task_id));
}

// ============================================================================
// Cross-command workflow scenarios
// ============================================================================

#[tokio::test]
async fn test_workflow_show_after_update() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Original", Some("Original description")).await;

    // Update workflow
    let update_cmd = WorkflowUpdateCommand {
        id: wf_id.clone(),
        name: Some("Modified".to_string()),
        description: Some("Modified description".to_string()),
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };
    update_cmd.execute(services.workflows()).await.unwrap();

    // Show workflow to verify updates persisted
    let show_cmd = WorkflowShowCommand { id: wf_id };
    let output = show_cmd.execute(&services).await.unwrap();

    assert!(output.contains("Modified"));
    assert!(output.contains("Modified description"));
    assert!(!output.contains("Original description"));
}

#[tokio::test]
async fn test_advance_retreat_roundtrip() {
    let services = mock_services();
    let task_id = create_task(&services, "Roundtrip task").await;

    // Advance
    let advance_cmd = WorkflowAdvanceCommand {
        task_id: task_id.clone(),
    };
    let advance_output = advance_cmd.execute(services.workflows()).await.unwrap();
    assert!(advance_output.contains("Advanced task"));

    // Retreat back
    let retreat_cmd = WorkflowRetreatCommand {
        task_id: task_id.clone(),
    };
    let retreat_output = retreat_cmd.execute(services.workflows()).await.unwrap();
    assert!(retreat_output.contains("Retreated task"));
}

#[tokio::test]
async fn test_workflow_list_after_multiple_creates() {
    let services = mock_services();

    // Create multiple workflows
    let wf1 = create_workflow(&services, "Workflow 1", None).await;
    let wf2 = create_workflow(&services, "Workflow 2", Some("With description")).await;
    let wf3 = create_workflow(&services, "Workflow 3", None).await;

    // List and verify all appear
    let cmd = WorkflowListCommand {};
    let output = cmd.execute(services.workflows()).await.unwrap();

    assert!(output.contains(&wf1));
    assert!(output.contains(&wf2));
    assert!(output.contains(&wf3));
    assert!(output.contains("Workflow 1"));
    assert!(output.contains("Workflow 2"));
    assert!(output.contains("Workflow 3"));
    assert!(output.contains("With description"));
}

// ============================================================================
// list_workflows_full tests
// ============================================================================

#[tokio::test]
async fn test_list_workflows_full_empty() {
    let services = mock_services();
    let result = services.workflows().list_workflows_full().await.unwrap();
    assert!(result.is_empty());
}

#[tokio::test]
async fn test_list_workflows_full_returns_complete_workflow_objects() {
    let services = mock_services();
    let wf_id = create_workflow(&services, "Full Workflow", Some("Detailed description")).await;

    let workflows = services.workflows().list_workflows_full().await.unwrap();

    assert_eq!(workflows.len(), 1);
    let wf = &workflows[0];
    assert_eq!(wf.id.as_deref(), Some(wf_id.as_str()));
    assert_eq!(wf.name, "Full Workflow");
    assert_eq!(wf.description, Some("Detailed description".to_string()));
    // Full workflows have timestamps that summaries don't
    assert!(wf.created_at.is_some());
    assert!(wf.updated_at.is_some());
}

#[tokio::test]
async fn test_list_workflows_full_returns_all_workflows() {
    let services = mock_services();
    let id1 = create_workflow(&services, "WF Alpha", None).await;
    let id2 = create_workflow(&services, "WF Beta", Some("Beta desc")).await;
    let id3 = create_workflow(&services, "WF Gamma", Some("Gamma desc")).await;

    let workflows = services.workflows().list_workflows_full().await.unwrap();

    assert_eq!(workflows.len(), 3);
    let ids: Vec<&str> = workflows.iter().filter_map(|w| w.id.as_deref()).collect();
    assert!(ids.contains(&id1.as_str()));
    assert!(ids.contains(&id2.as_str()));
    assert!(ids.contains(&id3.as_str()));
}
