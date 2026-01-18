//! Error handling tests
//!
//! Tests for various error conditions and edge cases.

use super::common::*;
use vertebrae_db::SectionType;

// =============================================================================
// Task Not Found Errors
// =============================================================================

#[tokio::test]
async fn test_show_nonexistent_task() {
    let ctx = TestContext::new().await;

    let cmd = show_cmd("nonexistent");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().to_lowercase().contains("not found"));
}

#[tokio::test]
async fn test_transition_nonexistent_task() {
    let ctx = TestContext::new().await;

    let cmd = start_cmd("nonexistent");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_depend_on_nonexistent_blocker() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = depend_cmd("task1", "nonexistent");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_depend_nonexistent_task() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;

    let cmd = depend_cmd("nonexistent", "blocker");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_section_nonexistent_task() {
    let ctx = TestContext::new().await;

    let cmd = section_cmd("nonexistent", SectionType::Goal, "Goal");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_ref_nonexistent_task() {
    let ctx = TestContext::new().await;

    let cmd = ref_cmd("nonexistent", "src/file.rs");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

// =============================================================================
// Invalid Transition Errors
// =============================================================================

#[tokio::test]
async fn test_transition_backlog_to_done_without_force() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "backlog").await;

    // Can't go directly from backlog to done without force
    let cmd = done_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_transition_done_to_in_progress_without_force() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "done").await;

    // Can't go back from done to in_progress without force
    let cmd = start_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_transition_rejected_to_done_without_force() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "rejected").await;

    let cmd = done_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

// =============================================================================
// Self-Reference Errors
// =============================================================================

#[tokio::test]
async fn test_self_dependency_rejected() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = depend_cmd("task1", "task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("cannot depend on itself"));
}

#[tokio::test]
async fn test_self_parent_rejected() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = update_cmd_with_parent("task1", Some("task1"));
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    // Error message is "Cannot set task as its own parent"
    assert!(err.to_string().contains("own parent"));
}

// =============================================================================
// Cycle Detection Errors
// =============================================================================

#[tokio::test]
async fn test_dependency_cycle_rejected() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;

    // Create task1 -> task2
    depend_cmd("task1", "task2")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Try to create task2 -> task1 (would create cycle)
    let cmd = depend_cmd("task2", "task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().to_lowercase().contains("cycle"));
}

#[tokio::test]
async fn test_transitive_cycle_rejected() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;
    create_task(ctx.db(), "task3", "Task 3", "task", "todo").await;

    // Create chain: task1 -> task2 -> task3
    depend_cmd("task1", "task2")
        .execute(&ctx.service)
        .await
        .unwrap();
    depend_cmd("task2", "task3")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Try to create task3 -> task1 (transitive cycle)
    let cmd = depend_cmd("task3", "task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

// =============================================================================
// Update Command Errors
// =============================================================================

#[tokio::test]
async fn test_update_nonexistent_task() {
    let ctx = TestContext::new().await;

    let cmd = update_cmd_with_title("nonexistent", "New Title");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_update_parent_to_nonexistent() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = update_cmd_with_parent("task1", Some("nonexistent"));
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

// =============================================================================
// Delete Command Errors
// =============================================================================

#[tokio::test]
async fn test_delete_nonexistent_task() {
    let ctx = TestContext::new().await;

    let cmd = delete_cmd("nonexistent", false);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

// =============================================================================
// Blockers Command Errors
// =============================================================================

#[tokio::test]
async fn test_blockers_nonexistent_task() {
    let ctx = TestContext::new().await;

    let cmd = blockers_cmd("nonexistent");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

// =============================================================================
// Path Command Errors
// =============================================================================

#[tokio::test]
async fn test_path_from_nonexistent() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = path_cmd("nonexistent", "task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_path_to_nonexistent() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = path_cmd("task1", "nonexistent");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}
