//! Integration tests for workflow commands
//!
//! These tests verify the full command execution flow with an in-memory database.

use super::*;
use vertebrae_core::{
    Database, DefaultWorkflowService, ServiceError, VertebraeServices, WorkflowService,
};
use vertebrae_db::{AgentConfig, Level, Task};

// ========================================
// Test helpers
// ========================================

/// Helper to create an in-memory test database
async fn setup_test_db() -> Database {
    let db = Database::connect_mem().await.unwrap();
    db.init().await.unwrap();
    db
}

/// Helper to create a workflow service from a database
fn create_service(db: &Database) -> DefaultWorkflowService {
    DefaultWorkflowService::new(db.clone())
}

/// Helper to create VertebraeServices from a database
fn create_services(db: Database) -> VertebraeServices {
    VertebraeServices::new(db)
}

/// Extract the workflow ID from "Created workflow: {id}" message
fn extract_workflow_id(msg: &str) -> String {
    msg.strip_prefix("Created workflow: ")
        .unwrap_or(msg)
        .to_string()
}

/// Helper to create a test task
async fn create_test_task(db: &Database, id: &str, title: &str) {
    let task = Task::new(title, Level::Task);
    db.tasks().create(id, &task).await.unwrap();
}

/// Helper to create a workflow and return its ID
async fn create_test_workflow(
    service: &dyn WorkflowService,
    name: &str,
    steps: Vec<(&str, &str)>,
) -> String {
    let parsed_steps: Vec<ParsedStep> = steps
        .into_iter()
        .map(|(name, model)| ParsedStep {
            name: name.to_string(),
            agent_config: AgentConfig::new().with_model(model),
        })
        .collect();

    let cmd = WorkflowAddCommand {
        name: name.to_string(),
        description: None,
        steps: parsed_steps,
        auto_advance: false,
        order: 0,
    };

    let result = cmd.execute(service).await.unwrap();
    extract_workflow_id(&result)
}

// ========================================
// WorkflowAddCommand tests
// ========================================

#[tokio::test]
async fn test_add_workflow_simple() {
    let db = setup_test_db().await;

    let cmd = WorkflowAddCommand {
        name: "My Workflow".to_string(),
        description: None,
        steps: vec![ParsedStep {
            name: "step1".to_string(),
            agent_config: AgentConfig::new().with_model("agent1"),
        }],
        auto_advance: false,
        order: 0,
    };

    let result = cmd
        .execute(&create_service(&db))
        .await
        .expect("Add should succeed");
    assert!(
        result.starts_with("Created workflow: "),
        "Result should start with 'Created workflow: '"
    );
    let id = extract_workflow_id(&result);
    assert_eq!(id.len(), 7); // 'x' prefix + 6 hex chars

    // Verify workflow was persisted
    let workflow = db.workflows().get(&id).await.unwrap();
    assert!(workflow.is_some());
    let workflow = workflow.unwrap();
    assert_eq!(workflow.name, "My Workflow");
    assert!(workflow.description.is_none());

    // Verify first-class Steps were created
    let workflow_thing = workflow.id.as_ref().unwrap();
    let steps = db.steps().list_by_workflow(workflow_thing).await.unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].name, "step1");
    assert_eq!(steps[0].agent_config.model, Some("agent1".to_string()));
    assert_eq!(steps[0].order, 0);
}

#[tokio::test]
async fn test_add_workflow_with_description() {
    let db = setup_test_db().await;

    let cmd = WorkflowAddCommand {
        name: "Described Workflow".to_string(),
        description: Some("A workflow with a description".to_string()),
        steps: vec![ParsedStep {
            name: "step1".to_string(),
            agent_config: AgentConfig::new().with_model("agent1"),
        }],
        auto_advance: false,
        order: 0,
    };

    let result = cmd
        .execute(&create_service(&db))
        .await
        .expect("Add should succeed");
    let id = extract_workflow_id(&result);

    let workflow = db.workflows().get(&id).await.unwrap().unwrap();
    assert_eq!(workflow.name, "Described Workflow");
    assert_eq!(
        workflow.description,
        Some("A workflow with a description".to_string())
    );
}

#[tokio::test]
async fn test_add_workflow_with_multiple_steps() {
    let db = setup_test_db().await;

    let cmd = WorkflowAddCommand {
        name: "Multi-step Workflow".to_string(),
        description: None,
        steps: vec![
            ParsedStep {
                name: "review".to_string(),
                agent_config: AgentConfig::new().with_model("code-reviewer"),
            },
            ParsedStep {
                name: "test".to_string(),
                agent_config: AgentConfig::new().with_model("tester"),
            },
            ParsedStep {
                name: "deploy".to_string(),
                agent_config: AgentConfig::new().with_model("deployer"),
            },
        ],
        auto_advance: false,
        order: 0,
    };

    let result = cmd
        .execute(&create_service(&db))
        .await
        .expect("Add should succeed");
    let id = extract_workflow_id(&result);

    let workflow = db.workflows().get(&id).await.unwrap().unwrap();
    let workflow_thing = workflow.id.as_ref().unwrap();
    let steps = db.steps().list_by_workflow(workflow_thing).await.unwrap();
    assert_eq!(steps.len(), 3);

    // Verify steps are ordered correctly
    assert_eq!(steps[0].name, "review");
    assert_eq!(steps[0].order, 0);
    assert_eq!(steps[1].name, "test");
    assert_eq!(steps[1].order, 1);
    assert_eq!(steps[2].name, "deploy");
    assert_eq!(steps[2].order, 2);
}

#[tokio::test]
async fn test_add_workflow_empty_name_fails() {
    let db = setup_test_db().await;

    let cmd = WorkflowAddCommand {
        name: "".to_string(),
        description: None,
        steps: vec![ParsedStep {
            name: "step1".to_string(),
            agent_config: AgentConfig::new().with_model("agent1"),
        }],
        auto_advance: false,
        order: 0,
    };

    let result = cmd.execute(&create_service(&db)).await;
    match result {
        Err(ServiceError::ValidationFailed { message }) => {
            assert!(
                message.contains("name cannot be empty"),
                "Expected 'name cannot be empty' in error, got: {}",
                message
            );
        }
        other => panic!("Expected ValidationFailed error, got {:?}", other),
    }
}

#[tokio::test]
async fn test_add_workflow_no_steps_fails() {
    let db = setup_test_db().await;

    let cmd = WorkflowAddCommand {
        name: "No Steps Workflow".to_string(),
        description: None,
        steps: vec![],
        auto_advance: false,
        order: 0,
    };

    let result = cmd.execute(&create_service(&db)).await;
    match result {
        Err(ServiceError::ValidationFailed { message }) => {
            assert!(
                message.contains("at least one step"),
                "Expected 'at least one step' in error, got: {}",
                message
            );
        }
        other => panic!("Expected ValidationFailed error, got {:?}", other),
    }
}

// Step parsing tests
#[test]
fn test_parse_step_valid() {
    let result = parse_step("review:sonnet");
    assert!(result.is_ok());
    let step = result.unwrap();
    assert_eq!(step.name, "review");
    assert_eq!(step.agent_config.model, Some("sonnet".to_string()));
}

#[test]
fn test_parse_step_with_spaces() {
    let result = parse_step(" review : sonnet ");
    assert!(result.is_ok());
    let step = result.unwrap();
    assert_eq!(step.name, "review");
    assert_eq!(step.agent_config.model, Some("sonnet".to_string()));
}

#[test]
fn test_parse_step_missing_colon() {
    let result = parse_step("review-sonnet");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.contains("invalid step format"));
    assert!(err.contains("name:model"));
}

#[test]
fn test_parse_step_empty_name() {
    let result = parse_step(":sonnet");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.contains("name cannot be empty"));
}

#[test]
fn test_parse_step_empty_model() {
    let result = parse_step("review:");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.contains("model cannot be empty"));
}

// ========================================
// WorkflowListCommand tests
// ========================================

#[tokio::test]
async fn test_list_workflows_shows_default_workflow() {
    let db = setup_test_db().await;

    let cmd = WorkflowListCommand {};
    let result = cmd.execute(&create_service(&db)).await.unwrap();

    // Default workflow is created on db.init()
    assert!(
        result.contains("default - Default Workflow"),
        "Expected default workflow in output: {}",
        result
    );
}

#[tokio::test]
async fn test_list_workflows_shows_all_with_step_counts() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    // Create workflow with 1 step
    let id1 = create_test_workflow(&services, "Workflow A", vec![("step1", "agent1")]).await;

    // Create workflow with 3 steps
    let id2 = create_test_workflow(
        &services,
        "Workflow B",
        vec![
            ("review", "reviewer"),
            ("test", "tester"),
            ("deploy", "deployer"),
        ],
    )
    .await;

    let cmd = WorkflowListCommand {};
    let result = cmd.execute(&services).await.unwrap();

    assert!(result.contains(&id1), "Should contain first workflow ID");
    assert!(result.contains("Workflow A"), "Should contain Workflow A");
    assert!(result.contains("(1 steps)"), "Should show 1 step count");

    assert!(result.contains(&id2), "Should contain second workflow ID");
    assert!(result.contains("Workflow B"), "Should contain Workflow B");
    assert!(result.contains("(3 steps)"), "Should show 3 step count");
}

// ========================================
// WorkflowShowCommand tests
// ========================================

#[tokio::test]
async fn test_show_workflow_displays_details() {
    let db = setup_test_db().await;
    let workflow_service = create_service(&db);
    let services = create_services(db.clone());

    let id = create_test_workflow(
        &workflow_service,
        "Multi-step Workflow",
        vec![
            ("review", "code-reviewer"),
            ("test", "tester"),
            ("deploy", "deployer"),
        ],
    )
    .await;

    let show_cmd = WorkflowShowCommand { id: id.clone() };
    let result = show_cmd.execute(&services).await.unwrap();

    // Verify header
    assert!(
        result.contains(&format!("Workflow: {} - Multi-step Workflow", id)),
        "Should show header with ID and name"
    );

    // Verify steps are shown in order
    assert!(result.contains("Steps (3 total)"), "Should show step count");
    assert!(
        result.contains("1. review (model: code-reviewer)"),
        "Should show step 1"
    );
    assert!(
        result.contains("2. test (model: tester)"),
        "Should show step 2"
    );
    assert!(
        result.contains("3. deploy (model: deployer)"),
        "Should show step 3"
    );
}

#[tokio::test]
async fn test_show_workflow_not_found() {
    let db = setup_test_db().await;
    let services = create_services(db);

    let cmd = WorkflowShowCommand {
        id: "nonexistent".to_string(),
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err(), "Should return error for nonexistent ID");

    match result {
        Err(ServiceError::WorkflowNotFound { workflow_id }) => {
            assert_eq!(workflow_id, "nonexistent");
        }
        other => panic!("Expected WorkflowNotFound error, got {:?}", other),
    }
}

#[tokio::test]
async fn test_show_workflow_case_insensitive() {
    let db = setup_test_db().await;
    let workflow_service = create_service(&db);
    let services = create_services(db.clone());

    let id = create_test_workflow(
        &workflow_service,
        "Case Test Workflow",
        vec![("step1", "agent1")],
    )
    .await;

    // Try with uppercase ID
    let show_cmd = WorkflowShowCommand {
        id: id.to_uppercase(),
    };
    let result = show_cmd.execute(&services).await;

    assert!(
        result.is_ok(),
        "Should find workflow with case-insensitive ID"
    );
    assert!(
        result.unwrap().contains("Case Test Workflow"),
        "Should show workflow name"
    );
}

// ========================================
// WorkflowUpdateCommand tests
// ========================================

#[tokio::test]
async fn test_update_workflow_name() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let id = create_test_workflow(&services, "Original Name", vec![("step1", "agent1")]).await;

    let update_cmd = WorkflowUpdateCommand {
        id: id.clone(),
        name: Some("New Name".to_string()),
        description: None,
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };
    let result = update_cmd.execute(&services).await.unwrap();
    assert_eq!(result, format!("Updated workflow: {}", id));

    // Verify the update
    let workflow = db.workflows().get(&id).await.unwrap().unwrap();
    assert_eq!(workflow.name, "New Name");
}

#[tokio::test]
async fn test_update_workflow_description() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let id = create_test_workflow(&services, "Test Workflow", vec![("step1", "agent1")]).await;

    let update_cmd = WorkflowUpdateCommand {
        id: id.clone(),
        name: None,
        description: Some("New description".to_string()),
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };
    let result = update_cmd.execute(&services).await.unwrap();
    assert_eq!(result, format!("Updated workflow: {}", id));

    let workflow = db.workflows().get(&id).await.unwrap().unwrap();
    assert_eq!(workflow.description, Some("New description".to_string()));
}

#[tokio::test]
async fn test_update_workflow_not_found() {
    let db = setup_test_db().await;

    let update_cmd = WorkflowUpdateCommand {
        id: "nonexistent".to_string(),
        name: Some("New Name".to_string()),
        description: None,
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };

    let result = update_cmd.execute(&create_service(&db)).await;
    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::WorkflowNotFound { workflow_id } => {
            assert_eq!(workflow_id, "nonexistent");
        }
        e => panic!("Expected WorkflowNotFound error, got {:?}", e),
    }
}

#[tokio::test]
async fn test_update_workflow_no_updates_fails() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let id = create_test_workflow(&services, "Test Workflow", vec![("step1", "agent1")]).await;

    let update_cmd = WorkflowUpdateCommand {
        id: id.clone(),
        name: None,
        description: None,
        clear_description: false,
        auto_advance: false,
        no_auto_advance: false,
    };

    let result = update_cmd.execute(&services).await;
    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::ValidationFailed { message } => {
            assert!(
                message.contains("no updates specified"),
                "Expected 'no updates specified' in error, got: {}",
                message
            );
        }
        e => panic!("Expected ValidationFailed error, got {:?}", e),
    }
}

// ========================================
// WorkflowDeleteCommand tests
// ========================================

#[tokio::test]
async fn test_delete_workflow_success() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let id = create_test_workflow(&services, "To Be Deleted", vec![("step1", "agent1")]).await;

    // Verify it exists
    assert!(db.workflows().exists(&id).await.unwrap());

    // Delete it
    let delete_cmd = WorkflowDeleteCommand { id: id.clone() };
    let result = delete_cmd.execute(&services).await.unwrap();
    assert_eq!(result, format!("Deleted workflow: {}", id));

    // Verify it's gone
    assert!(!db.workflows().exists(&id).await.unwrap());
}

#[tokio::test]
async fn test_delete_workflow_not_found() {
    let db = setup_test_db().await;

    let delete_cmd = WorkflowDeleteCommand {
        id: "nonexistent".to_string(),
    };

    let result = delete_cmd.execute(&create_service(&db)).await;
    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::WorkflowNotFound { workflow_id } => {
            assert_eq!(workflow_id, "nonexistent");
        }
        e => panic!("Expected WorkflowNotFound error, got {:?}", e),
    }
}

// ========================================
// WorkflowAssignCommand tests
// ========================================

#[tokio::test]
async fn test_assign_workflow_success() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let workflow_id = create_test_workflow(
        &services,
        "Test Workflow",
        vec![("review", "reviewer"), ("test", "tester")],
    )
    .await;

    // Create a task
    create_test_task(&db, "abc123", "Test Task").await;

    // Assign the task to the workflow
    let assign_cmd = WorkflowAssignCommand {
        task_id: "abc123".to_string(),
        workflow_id: workflow_id.clone(),
    };
    let result = assign_cmd.execute(&services).await.unwrap();

    assert!(
        result.contains("Assigned task abc123 to workflow"),
        "Should show assignment message: {}",
        result
    );
    assert!(
        result.contains("review"),
        "Should show first step name: {}",
        result
    );

    // Verify the task was updated
    let task = db.tasks().get("abc123").await.unwrap().unwrap();
    assert!(task.workflow_id.is_some(), "Task should have workflow_id");
    assert!(
        task.current_step_id.is_some(),
        "Task should have current_step_id"
    );
}

#[tokio::test]
async fn test_assign_workflow_task_not_found() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let workflow_id =
        create_test_workflow(&services, "Test Workflow", vec![("step1", "agent1")]).await;

    let assign_cmd = WorkflowAssignCommand {
        task_id: "nonexistent".to_string(),
        workflow_id: workflow_id.clone(),
    };
    let result = assign_cmd.execute(&services).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::TaskNotFound { task_id } => {
            assert_eq!(task_id, "nonexistent");
        }
        e => panic!("Expected TaskNotFound error, got {:?}", e),
    }
}

#[tokio::test]
async fn test_assign_workflow_workflow_not_found() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    create_test_task(&db, "abc123", "Test Task").await;

    let assign_cmd = WorkflowAssignCommand {
        task_id: "abc123".to_string(),
        workflow_id: "nonexistent".to_string(),
    };
    let result = assign_cmd.execute(&services).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::WorkflowNotFound { workflow_id } => {
            assert_eq!(workflow_id, "nonexistent");
        }
        e => panic!("Expected WorkflowNotFound error, got {:?}", e),
    }
}

// ========================================
// WorkflowUnassignCommand tests
// ========================================

#[tokio::test]
async fn test_unassign_workflow_success() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let workflow_id =
        create_test_workflow(&services, "Test Workflow", vec![("step1", "agent1")]).await;

    create_test_task(&db, "abc123", "Test Task").await;

    // First assign
    let assign_cmd = WorkflowAssignCommand {
        task_id: "abc123".to_string(),
        workflow_id: workflow_id.clone(),
    };
    assign_cmd.execute(&services).await.unwrap();

    // Verify assigned
    let task = db.tasks().get("abc123").await.unwrap().unwrap();
    assert!(task.workflow_id.is_some());

    // Now unassign
    let unassign_cmd = WorkflowUnassignCommand {
        task_id: "abc123".to_string(),
    };
    let result = unassign_cmd.execute(&services).await.unwrap();
    assert_eq!(result, "Unassigned workflow from task abc123");

    // Verify unassigned
    let task = db.tasks().get("abc123").await.unwrap().unwrap();
    assert!(task.workflow_id.is_none());
    assert!(task.current_step_id.is_none());
}

#[tokio::test]
async fn test_unassign_workflow_task_not_found() {
    let db = setup_test_db().await;

    let unassign_cmd = WorkflowUnassignCommand {
        task_id: "nonexistent".to_string(),
    };
    let result = unassign_cmd.execute(&create_service(&db)).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::TaskNotFound { task_id } => {
            assert_eq!(task_id, "nonexistent");
        }
        e => panic!("Expected TaskNotFound error, got {:?}", e),
    }
}

// ========================================
// WorkflowAdvanceCommand tests
// ========================================

#[tokio::test]
async fn test_advance_workflow_success() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let workflow_id = create_test_workflow(
        &services,
        "Test Workflow",
        vec![
            ("review", "reviewer"),
            ("test", "tester"),
            ("deploy", "deployer"),
        ],
    )
    .await;

    create_test_task(&db, "abc123", "Test Task").await;

    // Assign to workflow (starts at step 0)
    let assign_cmd = WorkflowAssignCommand {
        task_id: "abc123".to_string(),
        workflow_id: workflow_id.clone(),
    };
    assign_cmd.execute(&services).await.unwrap();

    // Advance to step 1
    let advance_cmd = WorkflowAdvanceCommand {
        task_id: "abc123".to_string(),
    };
    let result = advance_cmd.execute(&services).await.unwrap();

    assert!(
        result.contains("Advanced task abc123 to step 2/3"),
        "Should show advancement: {}",
        result
    );
    assert!(
        result.contains("test"),
        "Should show new step name: {}",
        result
    );
}

#[tokio::test]
async fn test_advance_workflow_task_not_found() {
    let db = setup_test_db().await;

    let advance_cmd = WorkflowAdvanceCommand {
        task_id: "nonexistent".to_string(),
    };
    let result = advance_cmd.execute(&create_service(&db)).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::TaskNotFound { task_id } => {
            assert_eq!(task_id, "nonexistent");
        }
        e => panic!("Expected TaskNotFound error, got {:?}", e),
    }
}

#[tokio::test]
async fn test_advance_workflow_not_assigned() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    create_test_task(&db, "abc123", "Test Task").await;

    let advance_cmd = WorkflowAdvanceCommand {
        task_id: "abc123".to_string(),
    };
    let result = advance_cmd.execute(&services).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::ValidationFailed { message } => {
            assert!(
                message.contains("not assigned") || message.contains("workflow"),
                "Expected workflow validation error, got: {}",
                message
            );
        }
        e => panic!("Expected ValidationFailed error, got {:?}", e),
    }
}

// ========================================
// WorkflowRetreatCommand tests
// ========================================

#[tokio::test]
async fn test_retreat_workflow_success() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let workflow_id = create_test_workflow(
        &services,
        "Test Workflow",
        vec![
            ("review", "reviewer"),
            ("test", "tester"),
            ("deploy", "deployer"),
        ],
    )
    .await;

    create_test_task(&db, "abc123", "Test Task").await;

    // Assign and advance
    let assign_cmd = WorkflowAssignCommand {
        task_id: "abc123".to_string(),
        workflow_id: workflow_id.clone(),
    };
    assign_cmd.execute(&services).await.unwrap();

    let advance_cmd = WorkflowAdvanceCommand {
        task_id: "abc123".to_string(),
    };
    advance_cmd.execute(&services).await.unwrap();

    // Now retreat
    let retreat_cmd = WorkflowRetreatCommand {
        task_id: "abc123".to_string(),
    };
    let result = retreat_cmd.execute(&services).await.unwrap();

    assert!(
        result.contains("Retreated task abc123 to step 1/3"),
        "Should show retreat: {}",
        result
    );
    assert!(
        result.contains("review"),
        "Should show previous step name: {}",
        result
    );
}

#[tokio::test]
async fn test_retreat_workflow_at_first_step_fails() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let workflow_id =
        create_test_workflow(&services, "Test Workflow", vec![("step1", "agent1")]).await;

    create_test_task(&db, "abc123", "Test Task").await;

    // Assign (at first step)
    let assign_cmd = WorkflowAssignCommand {
        task_id: "abc123".to_string(),
        workflow_id: workflow_id.clone(),
    };
    assign_cmd.execute(&services).await.unwrap();

    // Try to retreat
    let retreat_cmd = WorkflowRetreatCommand {
        task_id: "abc123".to_string(),
    };
    let result = retreat_cmd.execute(&services).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::ValidationFailed { message } => {
            assert!(
                message.contains("first step") || message.contains("cannot retreat"),
                "Expected first step error, got: {}",
                message
            );
        }
        e => panic!("Expected ValidationFailed error, got {:?}", e),
    }
}

// ========================================
// WorkflowRejectCommand tests
// ========================================

#[tokio::test]
async fn test_reject_workflow_success() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let workflow_id =
        create_test_workflow(&services, "Test Workflow", vec![("step1", "agent1")]).await;

    create_test_task(&db, "abc123", "Test Task").await;

    // Assign
    let assign_cmd = WorkflowAssignCommand {
        task_id: "abc123".to_string(),
        workflow_id: workflow_id.clone(),
    };
    assign_cmd.execute(&services).await.unwrap();

    // Reject
    let reject_cmd = WorkflowRejectCommand {
        task_id: "abc123".to_string(),
    };
    let result = reject_cmd.execute(&services).await.unwrap();

    assert!(
        result.contains("Rejected task abc123 from workflow"),
        "Should show rejection: {}",
        result
    );

    // Verify workflow was unassigned
    let task = db.tasks().get("abc123").await.unwrap().unwrap();
    assert!(task.workflow_id.is_none());
}

#[tokio::test]
async fn test_reject_workflow_not_assigned() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    create_test_task(&db, "abc123", "Test Task").await;

    let reject_cmd = WorkflowRejectCommand {
        task_id: "abc123".to_string(),
    };
    let result = reject_cmd.execute(&services).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::ValidationFailed { message } => {
            assert!(
                message.contains("not assigned") || message.contains("workflow"),
                "Expected workflow validation error, got: {}",
                message
            );
        }
        e => panic!("Expected ValidationFailed error, got {:?}", e),
    }
}

// ========================================
// Display type tests
// ========================================

#[test]
fn test_workflow_summary_display() {
    let summary = WorkflowSummary {
        id: "abc123".to_string(),
        name: "Test Workflow".to_string(),
        description: Some("A test workflow".to_string()),
        step_count: 3,
    };

    let output = format!("{}", summary);
    assert_eq!(output, "abc123 - Test Workflow (3 steps) - A test workflow");
}

#[test]
fn test_workflow_summary_display_no_description() {
    let summary = WorkflowSummary {
        id: "def456".to_string(),
        name: "Simple Workflow".to_string(),
        description: None,
        step_count: 1,
    };

    let output = format!("{}", summary);
    assert_eq!(output, "def456 - Simple Workflow (1 steps)");
}

#[test]
fn test_workflow_detail_display() {
    let detail = WorkflowDetail {
        id: "abc123".to_string(),
        name: "Full Workflow".to_string(),
        description: Some("A complete workflow".to_string()),
        auto_advance: false,
        steps: vec![
            StepDisplayInfo {
                name: "step1".to_string(),
                model: Some("agent1".to_string()),
                order: 0,
            },
            StepDisplayInfo {
                name: "step2".to_string(),
                model: Some("agent2".to_string()),
                order: 1,
            },
        ],
        metadata: std::collections::HashMap::new(),
        created_at: None,
        updated_at: None,
    };

    let output = format!("{}", detail);

    assert!(output.contains("Workflow: abc123 - Full Workflow"));
    assert!(output.contains("Description"));
    assert!(output.contains("A complete workflow"));
    assert!(output.contains("Auto Advance: No"));
    assert!(output.contains("Steps (2 total)"));
    assert!(output.contains("1. step1 (model: agent1)"));
    assert!(output.contains("2. step2 (model: agent2)"));
}

#[test]
fn test_format_timestamp() {
    // RFC3339 format
    assert_eq!(
        format_timestamp(Some(&"2024-01-15T10:30:00+00:00".to_string())),
        "2024-01-15 10:30"
    );

    // None
    assert_eq!(format_timestamp(None), "");
}

// ========================================
// TransitionAddCommand tests
// ========================================

#[tokio::test]
async fn test_transition_add_success() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    // Create two workflows
    let from_id = create_test_workflow(&services, "From Workflow", vec![("step1", "agent1")]).await;
    let to_id = create_test_workflow(&services, "To Workflow", vec![("step1", "agent1")]).await;

    // Create transition
    let cmd = transition::TransitionAddCommand {
        from_workflow_id: from_id.clone(),
        to_workflow_id: to_id.clone(),
        label: "approve".to_string(),
        target_step: None,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert!(
        result.contains("Created transition 'approve'"),
        "Should show created transition: {}",
        result
    );
    assert!(
        result.contains(&from_id),
        "Should show from workflow: {}",
        result
    );
    assert!(
        result.contains(&to_id),
        "Should show to workflow: {}",
        result
    );
}

#[tokio::test]
async fn test_transition_add_workflow_not_found() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let from_id = create_test_workflow(&services, "From Workflow", vec![("step1", "agent1")]).await;

    let cmd = transition::TransitionAddCommand {
        from_workflow_id: from_id.clone(),
        to_workflow_id: "nonexistent".to_string(),
        label: "approve".to_string(),
        target_step: None,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::WorkflowNotFound { workflow_id } => {
            assert_eq!(workflow_id, "nonexistent");
        }
        e => panic!("Expected WorkflowNotFound error, got {:?}", e),
    }
}

#[tokio::test]
async fn test_transition_add_already_exists() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let from_id = create_test_workflow(&services, "From Workflow", vec![("step1", "agent1")]).await;
    let to_id = create_test_workflow(&services, "To Workflow", vec![("step1", "agent1")]).await;

    // Create first transition
    let cmd = transition::TransitionAddCommand {
        from_workflow_id: from_id.clone(),
        to_workflow_id: to_id.clone(),
        label: "approve".to_string(),
        target_step: None,
    };
    cmd.execute(&services).await.unwrap();

    // Try to create duplicate
    let cmd2 = transition::TransitionAddCommand {
        from_workflow_id: from_id.clone(),
        to_workflow_id: to_id.clone(),
        label: "approve again".to_string(),
        target_step: None,
    };
    let result = cmd2.execute(&services).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::ValidationFailed { message } => {
            assert!(
                message.contains("transition") || message.contains("already exists"),
                "Expected already exists error, got: {}",
                message
            );
        }
        e => panic!("Expected ValidationFailed error, got {:?}", e),
    }
}

// ========================================
// TransitionListCommand tests
// ========================================

#[tokio::test]
async fn test_transition_list_with_default() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    // db.init() creates a default transition for the default workflow
    let cmd = transition::TransitionListCommand { workflow_id: None };
    let result = cmd.execute(&services).await.unwrap();

    // Should have at least the default transition
    assert!(
        result.contains("default"),
        "Should show default transition: {}",
        result
    );
}

#[tokio::test]
async fn test_transition_list_shows_all() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let wf1 = create_test_workflow(&services, "Workflow 1", vec![("step1", "agent1")]).await;
    let wf2 = create_test_workflow(&services, "Workflow 2", vec![("step1", "agent1")]).await;
    let wf3 = create_test_workflow(&services, "Workflow 3", vec![("step1", "agent1")]).await;

    // Create transitions
    let cmd1 = transition::TransitionAddCommand {
        from_workflow_id: wf1.clone(),
        to_workflow_id: wf2.clone(),
        label: "approve".to_string(),
        target_step: None,
    };
    cmd1.execute(&services).await.unwrap();

    let cmd2 = transition::TransitionAddCommand {
        from_workflow_id: wf2.clone(),
        to_workflow_id: wf3.clone(),
        label: "escalate".to_string(),
        target_step: None,
    };
    cmd2.execute(&services).await.unwrap();

    // List all
    let list_cmd = transition::TransitionListCommand { workflow_id: None };
    let result = list_cmd.execute(&services).await.unwrap();

    assert!(result.contains(&wf1), "Should contain wf1: {}", result);
    assert!(result.contains(&wf2), "Should contain wf2: {}", result);
    assert!(result.contains(&wf3), "Should contain wf3: {}", result);
    assert!(
        result.contains("[approve]"),
        "Should contain approve label: {}",
        result
    );
    assert!(
        result.contains("[escalate]"),
        "Should contain escalate label: {}",
        result
    );
}

#[tokio::test]
async fn test_transition_list_filtered_by_workflow() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let wf1 = create_test_workflow(&services, "Workflow 1", vec![("step1", "agent1")]).await;
    let wf2 = create_test_workflow(&services, "Workflow 2", vec![("step1", "agent1")]).await;
    let wf3 = create_test_workflow(&services, "Workflow 3", vec![("step1", "agent1")]).await;

    // Create transition from wf1 to wf2
    let cmd1 = transition::TransitionAddCommand {
        from_workflow_id: wf1.clone(),
        to_workflow_id: wf2.clone(),
        label: "approve".to_string(),
        target_step: None,
    };
    cmd1.execute(&services).await.unwrap();

    // Create transition from wf2 to wf3
    let cmd2 = transition::TransitionAddCommand {
        from_workflow_id: wf2.clone(),
        to_workflow_id: wf3.clone(),
        label: "escalate".to_string(),
        target_step: None,
    };
    cmd2.execute(&services).await.unwrap();

    // List only transitions from wf1
    let list_cmd = transition::TransitionListCommand {
        workflow_id: Some(wf1.clone()),
    };
    let result = list_cmd.execute(&services).await.unwrap();

    assert!(
        result.contains("[approve]"),
        "Should contain approve: {}",
        result
    );
    assert!(
        !result.contains("[escalate]"),
        "Should not contain escalate: {}",
        result
    );
}

// ========================================
// TransitionDeleteCommand tests
// ========================================

#[tokio::test]
async fn test_transition_delete_success() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let wf1 = create_test_workflow(&services, "Workflow 1", vec![("step1", "agent1")]).await;
    let wf2 = create_test_workflow(&services, "Workflow 2", vec![("step1", "agent1")]).await;

    // Create transition
    let add_cmd = transition::TransitionAddCommand {
        from_workflow_id: wf1.clone(),
        to_workflow_id: wf2.clone(),
        label: "approve".to_string(),
        target_step: None,
    };
    add_cmd.execute(&services).await.unwrap();

    // Verify it exists
    let list_cmd = transition::TransitionListCommand { workflow_id: None };
    let before = list_cmd.execute(&services).await.unwrap();
    assert!(
        before.contains("[approve]"),
        "Should have transition before delete"
    );

    // Delete it
    let delete_cmd = transition::TransitionDeleteCommand {
        from_workflow_id: wf1.clone(),
        to_workflow_id: wf2.clone(),
    };
    let result = delete_cmd.execute(&services).await.unwrap();

    assert!(
        result.contains("Deleted transition"),
        "Should show deleted: {}",
        result
    );

    // Verify it's gone (default transition may still exist)
    let after = list_cmd.execute(&services).await.unwrap();
    assert!(
        !after.contains("[approve]"),
        "Should not have the deleted transition: {}",
        after
    );
}

#[tokio::test]
async fn test_transition_delete_not_found() {
    let db = setup_test_db().await;
    let services = create_service(&db);

    let wf1 = create_test_workflow(&services, "Workflow 1", vec![("step1", "agent1")]).await;
    let wf2 = create_test_workflow(&services, "Workflow 2", vec![("step1", "agent1")]).await;

    // Try to delete non-existent transition
    let delete_cmd = transition::TransitionDeleteCommand {
        from_workflow_id: wf1.clone(),
        to_workflow_id: wf2.clone(),
    };
    let result = delete_cmd.execute(&services).await;

    assert!(result.is_err());
    match result.unwrap_err() {
        ServiceError::InvalidInput(message) => {
            assert!(
                message.contains("transition") || message.contains("not found"),
                "Expected transition not found error, got: {}",
                message
            );
        }
        e => panic!("Expected InvalidInput error, got {:?}", e),
    }
}
