//! Integration tests for step lifecycle commands (start-step, complete-step, reject-step)
//!
//! Tests the `vtb start-step`, `vtb complete-step`, and `vtb reject-step` commands
//! against mock service implementations.

use super::mock::mock_services;
use vertebrae_cli::commands::*;

/// Create a test task and return its ID
async fn create_task(services: &vertebrae_core::VertebraeServices, title: &str) -> String {
    let task = AddCommand {
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
    task.execute(services).await.unwrap()
}

// ============================================================================
// StartStepCommand tests
// ============================================================================

#[tokio::test]
async fn test_start_step_success() {
    let services = mock_services();
    let task_id = create_task(&services, "Task to start").await;

    let cmd = StartStepCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);

    let display = format!("{}", result);
    assert!(display.contains("Started step"));
    assert!(display.contains(&task_id));
}

#[tokio::test]
async fn test_start_step_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = StartStepCommand {
        id: "nonexistent".to_string(),
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_start_step_case_insensitive_id() {
    let services = mock_services();
    let task_id = create_task(&services, "Case test task").await;

    let cmd = StartStepCommand {
        id: task_id.to_uppercase(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
}

// ============================================================================
// CompleteStepCommand tests
// ============================================================================

#[tokio::test]
async fn test_complete_step_success() {
    let services = mock_services();
    let task_id = create_task(&services, "Task to complete").await;

    let cmd = CompleteStepCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);

    let display = format!("{}", result);
    assert!(display.contains("Completed step"));
    assert!(display.contains(&task_id));
}

#[tokio::test]
async fn test_complete_step_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = CompleteStepCommand {
        id: "nonexistent".to_string(),
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_complete_step_case_insensitive_id() {
    let services = mock_services();
    let task_id = create_task(&services, "Case test task").await;

    let cmd = CompleteStepCommand {
        id: task_id.to_uppercase(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
}

// ============================================================================
// RejectStepCommand tests
// ============================================================================

#[tokio::test]
async fn test_reject_step_with_feedback() {
    let services = mock_services();
    let task_id = create_task(&services, "Task to reject").await;

    let cmd = RejectStepCommand {
        id: task_id.clone(),
        target_step_id: "a1b2c3d4-0000-4000-8000-000000000099".to_string(),
        feedback: Some("Needs more tests".to_string()),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
    assert_eq!(
        result.target_step_id,
        "a1b2c3d4-0000-4000-8000-000000000099"
    );
    assert_eq!(result.feedback.as_deref(), Some("Needs more tests"));

    let display = format!("{}", result);
    assert!(display.contains("Rejected step"));
    assert!(display.contains(&task_id));
    assert!(display.contains("Feedback: Needs more tests"));
}

#[tokio::test]
async fn test_reject_step_without_feedback() {
    let services = mock_services();
    let task_id = create_task(&services, "Task to reject").await;

    let cmd = RejectStepCommand {
        id: task_id.clone(),
        target_step_id: "a1b2c3d4-0000-4000-8000-000000000099".to_string(),
        feedback: None,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
    assert!(result.feedback.is_none());

    let display = format!("{}", result);
    assert!(display.contains("Rejected step"));
    assert!(!display.contains("Feedback:"));
}

#[tokio::test]
async fn test_reject_step_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = RejectStepCommand {
        id: "nonexistent".to_string(),
        target_step_id: "a1b2c3d4-0000-4000-8000-000000000099".to_string(),
        feedback: None,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_reject_step_case_insensitive_id() {
    let services = mock_services();
    let task_id = create_task(&services, "Case test task").await;

    let cmd = RejectStepCommand {
        id: task_id.to_uppercase(),
        target_step_id: "A1B2C3D4-0000-4000-8000-000000000099".to_string(),
        feedback: Some("Fix issues".to_string()),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
    assert_eq!(
        result.target_step_id,
        "a1b2c3d4-0000-4000-8000-000000000099"
    );
}

// ============================================================================
// Cross-command tests
// ============================================================================

#[tokio::test]
async fn test_start_then_complete_step() {
    let services = mock_services();
    let task_id = create_task(&services, "Lifecycle task").await;

    // Start the step
    let start_cmd = StartStepCommand {
        id: task_id.clone(),
    };
    start_cmd.execute(&services).await.unwrap();

    // Complete the step
    let complete_cmd = CompleteStepCommand {
        id: task_id.clone(),
    };
    let result = complete_cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
}

#[tokio::test]
async fn test_start_then_reject_step() {
    let services = mock_services();
    let task_id = create_task(&services, "Rejected lifecycle task").await;

    // Start the step
    let start_cmd = StartStepCommand {
        id: task_id.clone(),
    };
    start_cmd.execute(&services).await.unwrap();

    // Reject the step
    let reject_cmd = RejectStepCommand {
        id: task_id.clone(),
        target_step_id: "a1b2c3d4-0000-4000-8000-000000000099".to_string(),
        feedback: Some("Not ready yet".to_string()),
    };
    let result = reject_cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
    assert_eq!(result.feedback.as_deref(), Some("Not ready yet"));
}
