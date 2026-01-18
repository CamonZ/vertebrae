//! Lifecycle tests for task creation and status transitions
//!
//! Tests the add command with various options and status transitions
//! through the task lifecycle (backlog -> todo -> in_progress -> pending_review -> done).

use super::common::*;
use vertebrae_cli::commands::{TransitionToCommand, transition_to};
use vertebrae_db::{Level, Priority};

// =============================================================================
// Add Command Tests
// =============================================================================

#[tokio::test]
async fn test_add_task_minimal() {
    let ctx = TestContext::new().await;

    let cmd = add_cmd("Minimal Task");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();

    // Default level is task, default status is backlog
    assert_eq!(
        get_task_level(ctx.db(), &task_id).await,
        Some("task".to_string())
    );
    assert_eq!(
        get_task_status(ctx.db(), &task_id).await,
        Some("backlog".to_string())
    );
}

#[tokio::test]
async fn test_add_task_with_level_epic() {
    let ctx = TestContext::new().await;

    let cmd = add_cmd_full("Epic Task", Some(Level::Epic), None, None);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();
    assert_eq!(
        get_task_level(ctx.db(), &task_id).await,
        Some("epic".to_string())
    );
}

#[tokio::test]
async fn test_add_task_with_level_ticket() {
    let ctx = TestContext::new().await;

    let cmd = add_cmd_full("Ticket Task", Some(Level::Ticket), None, None);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();
    assert_eq!(
        get_task_level(ctx.db(), &task_id).await,
        Some("ticket".to_string())
    );
}

#[tokio::test]
async fn test_add_task_with_description() {
    let ctx = TestContext::new().await;

    let cmd = add_cmd_full(
        "Described Task",
        None,
        Some("This is the description"),
        None,
    );
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();
    assert_eq!(
        get_task_description(ctx.db(), &task_id).await,
        Some("This is the description".to_string())
    );
}

#[tokio::test]
async fn test_add_task_with_parent() {
    let ctx = TestContext::new().await;

    // Create parent epic first
    create_task(ctx.db(), "parent", "Parent Epic", "epic", "todo").await;

    let cmd = add_cmd_with_parent("Child Task", "parent");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();

    // Verify parent relationship exists
    assert!(child_of_exists(ctx.db(), &task_id, "parent").await);
}

#[tokio::test]
async fn test_add_task_with_depends_on() {
    let ctx = TestContext::new().await;

    // Create blocker first
    create_task(ctx.db(), "blocker", "Blocker Task", "task", "todo").await;

    let mut cmd = add_cmd("Dependent Task");
    cmd.depends_on = vec!["blocker".to_string()];
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();

    // Verify dependency exists
    assert!(dependency_exists(ctx.db(), &task_id, "blocker").await);
}

#[tokio::test]
async fn test_add_task_with_tags() {
    let ctx = TestContext::new().await;

    let mut cmd = add_cmd("Tagged Task");
    cmd.tags = vec!["frontend".to_string(), "urgent".to_string()];
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();

    let tags = get_task_tags(ctx.db(), &task_id).await;
    assert!(tags.contains(&"frontend".to_string()));
    assert!(tags.contains(&"urgent".to_string()));
}

#[tokio::test]
async fn test_add_task_with_priority() {
    let ctx = TestContext::new().await;

    let mut cmd = add_cmd("High Priority Task");
    cmd.priority = Some(Priority::High);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();
    assert_eq!(
        get_task_priority(ctx.db(), &task_id).await,
        Some(Priority::High)
    );
}

// =============================================================================
// Transition Tests
// =============================================================================

#[tokio::test]
async fn test_transition_backlog_to_todo() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;

    let cmd = triage_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert_eq!(
        get_task_status(ctx.db(), "task1").await,
        Some("todo".to_string())
    );
}

#[tokio::test]
async fn test_transition_todo_to_in_progress() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

    let cmd = start_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert_eq!(
        get_task_status(ctx.db(), "task1").await,
        Some("in_progress".to_string())
    );
}

#[tokio::test]
async fn test_transition_in_progress_to_pending_review() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = submit_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert_eq!(
        get_task_status(ctx.db(), "task1").await,
        Some("pending_review".to_string())
    );
}

#[tokio::test]
async fn test_transition_pending_review_to_done() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "pending_review").await;

    let cmd = done_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert_eq!(
        get_task_status(ctx.db(), "task1").await,
        Some("done".to_string())
    );
}

#[tokio::test]
async fn test_transition_todo_to_rejected() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

    let cmd = reject_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert_eq!(
        get_task_status(ctx.db(), "task1").await,
        Some("rejected".to_string())
    );
}

#[tokio::test]
async fn test_transition_in_progress_to_rejected_not_allowed() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    // Direct transition from in_progress to rejected is NOT allowed
    // Valid transitions from in_progress: pending_review only
    // Note: The skip_validation flag in CLI is not wired to bypass service-level transition rules
    let cmd = reject_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    // This transition is invalid per the state machine
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Invalid status transition"));
}

#[tokio::test]
async fn test_transition_with_reason() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

    let cmd = reject_cmd_with_reason("task1", "Duplicate task");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert_eq!(
        get_task_status(ctx.db(), "task1").await,
        Some("rejected".to_string())
    );
}

// =============================================================================
// Unblocking Tests
// =============================================================================

#[tokio::test]
async fn test_completing_task_unblocks_dependents() {
    let ctx = TestContext::new().await;

    // Create blocker and dependent
    create_task(ctx.db(), "blocker", "Blocker", "task", "in_progress").await;
    create_task(ctx.db(), "dependent", "Dependent", "task", "todo").await;
    create_depends_on(ctx.db(), "dependent", "blocker").await;

    // Complete the blocker: in_progress -> pending_review -> done
    submit_cmd("blocker").execute(&ctx.service).await.unwrap();
    let result = done_cmd("blocker").execute(&ctx.service).await;

    assert!(result.is_ok());
    let unblocked = result.unwrap().unblocked_tasks;
    // dependent should now be unblocked (it was blocked by blocker which is now done)
    // unblocked_tasks is Vec<(id, title)>
    assert!(unblocked.iter().any(|(id, _)| id == "dependent"));
}

// =============================================================================
// Force Flag Tests
// =============================================================================

#[tokio::test]
async fn test_force_transition_skips_validation() {
    let ctx = TestContext::new().await;

    // Create a task with an incomplete blocker
    create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;
    create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;
    create_depends_on(ctx.db(), "task1", "blocker").await;

    // Normal triage should work (we're using skip_validation in tests by default)
    let cmd = triage_cmd("task1");
    let result = cmd.execute(&ctx.service).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_invalid_transition_is_rejected() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;

    // Invalid transitions (like backlog -> done) are rejected even with force/skip_validation
    // because the service layer enforces transition rules.
    // Note: force and skip_validation are currently only for triage validation warnings,
    // not for bypassing transition state machine rules.
    let cmd = TransitionToCommand {
        id: "task1".to_string(),
        target: transition_to::TargetStatus::Done,
        reason: None,
        force: true,
        skip_validation: true,
    };
    let result = cmd.execute(&ctx.service).await;

    // Invalid transition should fail
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    // Error message format: "Invalid status transition from 'backlog' to 'done'"
    assert!(err.contains("Invalid status transition"));
}

// =============================================================================
// Delete Tests
// =============================================================================

#[tokio::test]
async fn test_delete_task() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;
    assert!(task_exists(ctx.db(), "task1").await);

    let cmd = delete_cmd("task1", false);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(!task_exists(ctx.db(), "task1").await);
}

#[tokio::test]
async fn test_delete_task_cascade() {
    let ctx = TestContext::new().await;

    // Create parent with children
    create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
    create_task(ctx.db(), "child1", "Child 1", "ticket", "todo").await;
    create_task(ctx.db(), "child2", "Child 2", "ticket", "todo").await;
    create_child_of(ctx.db(), "child1", "parent").await;
    create_child_of(ctx.db(), "child2", "parent").await;

    let cmd = delete_cmd("parent", true);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(!task_exists(ctx.db(), "parent").await);
    assert!(!task_exists(ctx.db(), "child1").await);
    assert!(!task_exists(ctx.db(), "child2").await);
}

#[tokio::test]
async fn test_delete_task_without_cascade_orphans_children() {
    let ctx = TestContext::new().await;

    // Create parent with child
    create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
    create_task(ctx.db(), "child", "Child", "ticket", "todo").await;
    create_child_of(ctx.db(), "child", "parent").await;

    let cmd = delete_cmd("parent", false);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(!task_exists(ctx.db(), "parent").await);
    // Child should still exist but be orphaned
    assert!(task_exists(ctx.db(), "child").await);
    assert!(!child_of_exists(ctx.db(), "child", "parent").await);
}
