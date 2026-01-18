//! Workflow tests for workflow management commands
//!
//! Tests for workflow CRUD, assignment, and step progression.

use super::common::*;

// =============================================================================
// Workflow CRUD Tests
// =============================================================================

#[tokio::test]
async fn test_workflow_add() {
    let ctx = TestContext::new().await;

    let cmd = workflow_add_cmd("review-workflow", "Review", "gpt-4");
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
    let workflow_id = extract_workflow_id(&result.unwrap());
    assert!(workflow_exists(ctx.db(), &workflow_id).await);
}

#[tokio::test]
async fn test_workflow_add_with_multiple_steps() {
    let ctx = TestContext::new().await;

    use vertebrae_cli::commands::workflow::{ParsedStep, WorkflowAddCommand};
    use vertebrae_db::AgentConfig;

    let cmd = WorkflowAddCommand {
        name: "multi-step".to_string(),
        description: Some("Multi-step workflow".to_string()),
        steps: vec![
            ParsedStep {
                name: "Step 1".to_string(),
                agent_config: AgentConfig::new().with_model("gpt-4"),
            },
            ParsedStep {
                name: "Step 2".to_string(),
                agent_config: AgentConfig::new().with_model("claude-3"),
            },
        ],
        on_done: None,
        on_reject: None,
    };
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_workflow_list() {
    let ctx = TestContext::new().await;

    // Create some workflows
    workflow_add_cmd("workflow1", "Step", "model")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    workflow_add_cmd("workflow2", "Step", "model")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();

    let cmd = workflow_list_cmd();
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
    let output = result.unwrap();
    // List returns formatted string containing workflow names
    assert!(output.contains("workflow1"));
    assert!(output.contains("workflow2"));
}

#[tokio::test]
async fn test_workflow_show() {
    let ctx = TestContext::new().await;

    let add_result = workflow_add_cmd("test-workflow", "Review Step", "gpt-4")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    let cmd = workflow_show_cmd(&workflow_id);
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
    let output = result.unwrap();
    // Show returns formatted string containing workflow details
    assert!(output.contains("test-workflow"));
}

#[tokio::test]
async fn test_workflow_update_name() {
    let ctx = TestContext::new().await;

    let add_result = workflow_add_cmd("old-name", "Step", "model")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    let cmd = workflow_update_cmd(&workflow_id, Some("new-name"), None);
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());

    let show_result = workflow_show_cmd(&workflow_id)
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    // Show returns formatted string containing workflow details
    assert!(show_result.contains("new-name"));
}

#[tokio::test]
async fn test_workflow_update_description() {
    let ctx = TestContext::new().await;

    let add_result = workflow_add_cmd("workflow", "Step", "model")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    let cmd = workflow_update_cmd(&workflow_id, None, Some("New description"));
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());

    let show_result = workflow_show_cmd(&workflow_id)
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    // Show returns formatted string containing workflow details
    assert!(show_result.contains("New description"));
}

#[tokio::test]
async fn test_workflow_delete() {
    let ctx = TestContext::new().await;

    let add_result = workflow_add_cmd("to-delete", "Step", "model")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    assert!(workflow_exists(ctx.db(), &workflow_id).await);

    let cmd = workflow_delete_cmd(&workflow_id);
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
    assert!(!workflow_exists(ctx.db(), &workflow_id).await);
}

// =============================================================================
// Workflow Assignment Tests
// =============================================================================

#[tokio::test]
async fn test_workflow_assign() {
    let ctx = TestContext::new().await;

    // Create task and workflow
    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;
    let add_result = workflow_add_cmd("review", "Review Step", "gpt-4")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    let cmd = workflow_assign_cmd("task1", &workflow_id);
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_workflow_unassign() {
    let ctx = TestContext::new().await;

    // Create and assign workflow
    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;
    let add_result = workflow_add_cmd("review", "Review Step", "gpt-4")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    workflow_assign_cmd("task1", &workflow_id)
        .execute(&ctx.workflow_service)
        .await
        .unwrap();

    let cmd = workflow_unassign_cmd("task1");
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
}

// =============================================================================
// Workflow Step Progression Tests
// =============================================================================

#[tokio::test]
async fn test_workflow_advance() {
    let ctx = TestContext::new().await;

    // Create multi-step workflow
    use vertebrae_cli::commands::workflow::{ParsedStep, WorkflowAddCommand};
    use vertebrae_db::AgentConfig;

    let cmd = WorkflowAddCommand {
        name: "multi-step".to_string(),
        description: None,
        steps: vec![
            ParsedStep {
                name: "Step 1".to_string(),
                agent_config: AgentConfig::new().with_model("gpt-4"),
            },
            ParsedStep {
                name: "Step 2".to_string(),
                agent_config: AgentConfig::new().with_model("gpt-4"),
            },
        ],
        on_done: None,
        on_reject: None,
    };
    let add_result = cmd.execute(&ctx.workflow_service).await.unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    // Create task and assign workflow
    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;
    workflow_assign_cmd("task1", &workflow_id)
        .execute(&ctx.workflow_service)
        .await
        .unwrap();

    // Advance to next step
    let advance_cmd = workflow_advance_cmd("task1");
    let result = advance_cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_workflow_retreat() {
    let ctx = TestContext::new().await;

    // Create multi-step workflow
    use vertebrae_cli::commands::workflow::{ParsedStep, WorkflowAddCommand};
    use vertebrae_db::AgentConfig;

    let cmd = WorkflowAddCommand {
        name: "multi-step".to_string(),
        description: None,
        steps: vec![
            ParsedStep {
                name: "Step 1".to_string(),
                agent_config: AgentConfig::new().with_model("gpt-4"),
            },
            ParsedStep {
                name: "Step 2".to_string(),
                agent_config: AgentConfig::new().with_model("gpt-4"),
            },
        ],
        on_done: None,
        on_reject: None,
    };
    let add_result = cmd.execute(&ctx.workflow_service).await.unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    // Create task and assign workflow
    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;
    workflow_assign_cmd("task1", &workflow_id)
        .execute(&ctx.workflow_service)
        .await
        .unwrap();

    // Advance first
    workflow_advance_cmd("task1")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();

    // Then retreat
    let retreat_cmd = workflow_retreat_cmd("task1");
    let result = retreat_cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_workflow_reject() {
    let ctx = TestContext::new().await;

    // Create workflow and task
    let add_result = workflow_add_cmd("review", "Review Step", "gpt-4")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;
    workflow_assign_cmd("task1", &workflow_id)
        .execute(&ctx.workflow_service)
        .await
        .unwrap();

    let reject_cmd = workflow_reject_cmd("task1");
    let result = reject_cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_ok());
}

// =============================================================================
// Error Cases
// =============================================================================

#[tokio::test]
async fn test_workflow_assign_nonexistent_workflow() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

    let cmd = workflow_assign_cmd("task1", "nonexistent-workflow");
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_workflow_assign_nonexistent_task() {
    let ctx = TestContext::new().await;

    let add_result = workflow_add_cmd("review", "Step", "model")
        .execute(&ctx.workflow_service)
        .await
        .unwrap();
    let workflow_id = extract_workflow_id(&add_result);

    let cmd = workflow_assign_cmd("nonexistent-task", &workflow_id);
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_workflow_advance_no_workflow_assigned() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

    let cmd = workflow_advance_cmd("task1");
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_workflow_show_nonexistent() {
    let ctx = TestContext::new().await;

    let cmd = workflow_show_cmd("nonexistent");
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_workflow_delete_nonexistent() {
    let ctx = TestContext::new().await;

    let cmd = workflow_delete_cmd("nonexistent");
    let result = cmd.execute(&ctx.workflow_service).await;

    assert!(result.is_err());
}
