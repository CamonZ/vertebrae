//! Relationship tests for parent-child and dependency relationships
//!
//! Tests the depend, undepend commands and parent-child relationships
//! including cycle detection and relationship management.

use super::common::*;
use vertebrae_db::Level;

// =============================================================================
// Dependency Tests
// =============================================================================

#[tokio::test]
async fn test_depend_creates_dependency() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;

    let cmd = depend_cmd("task1", "blocker");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(dependency_exists(ctx.db(), "task1", "blocker").await);
}

#[tokio::test]
async fn test_depend_multiple_blockers() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker1", "Blocker 1", "task", "todo").await;
    create_task(ctx.db(), "blocker2", "Blocker 2", "task", "todo").await;

    depend_cmd("task1", "blocker1")
        .execute(&ctx.service)
        .await
        .unwrap();
    depend_cmd("task1", "blocker2")
        .execute(&ctx.service)
        .await
        .unwrap();

    assert!(dependency_exists(ctx.db(), "task1", "blocker1").await);
    assert!(dependency_exists(ctx.db(), "task1", "blocker2").await);
    assert_eq!(count_dependencies(ctx.db(), "task1").await, 2);
}

#[tokio::test]
async fn test_undepend_removes_dependency() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "blocker").await;

    assert!(dependency_exists(ctx.db(), "task1", "blocker").await);

    let cmd = undepend_cmd("task1", "blocker");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(!dependency_exists(ctx.db(), "task1", "blocker").await);
}

#[tokio::test]
async fn test_undepend_nonexistent_dependency() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;

    // No dependency exists between them
    let cmd = undepend_cmd("task1", "task2");
    let result = cmd.execute(&ctx.service).await;

    // Should succeed but indicate no dependency existed
    assert!(result.is_ok());
    assert!(!result.unwrap().existed);
}

// =============================================================================
// Cycle Detection Tests
// =============================================================================

#[tokio::test]
async fn test_depend_rejects_self_dependency() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = depend_cmd("task1", "task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(err.to_string().contains("cannot depend on itself"));
}

#[tokio::test]
async fn test_depend_rejects_direct_cycle() {
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
async fn test_depend_rejects_transitive_cycle() {
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

    // Try to create task3 -> task1 (would create cycle)
    let cmd = depend_cmd("task3", "task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_depend_allows_diamond_dependency() {
    let ctx = TestContext::new().await;

    // Diamond pattern:
    //     task1
    //    /     \
    // task2   task3
    //    \     /
    //     task4
    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;
    create_task(ctx.db(), "task3", "Task 3", "task", "todo").await;
    create_task(ctx.db(), "task4", "Task 4", "task", "todo").await;

    depend_cmd("task1", "task2")
        .execute(&ctx.service)
        .await
        .unwrap();
    depend_cmd("task1", "task3")
        .execute(&ctx.service)
        .await
        .unwrap();
    depend_cmd("task2", "task4")
        .execute(&ctx.service)
        .await
        .unwrap();

    // This should be allowed - it's a diamond, not a cycle
    let result = depend_cmd("task3", "task4").execute(&ctx.service).await;

    assert!(result.is_ok());
}

// =============================================================================
// Parent-Child Tests
// =============================================================================

#[tokio::test]
async fn test_add_with_parent_creates_relationship() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "parent", "Parent Epic", "epic", "todo").await;

    let cmd = add_cmd_with_parent("Child Task", "parent");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();
    assert!(child_of_exists(ctx.db(), &task_id, "parent").await);
}

#[tokio::test]
async fn test_reparent_via_update() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "parent1", "Parent 1", "epic", "todo").await;
    create_task(ctx.db(), "parent2", "Parent 2", "epic", "todo").await;
    create_task(ctx.db(), "child", "Child", "ticket", "todo").await;
    create_child_of(ctx.db(), "child", "parent1").await;

    assert!(child_of_exists(ctx.db(), "child", "parent1").await);
    assert!(!child_of_exists(ctx.db(), "child", "parent2").await);

    let cmd = update_cmd_with_parent("child", Some("parent2"));
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(!child_of_exists(ctx.db(), "child", "parent1").await);
    assert!(child_of_exists(ctx.db(), "child", "parent2").await);
}

#[tokio::test]
async fn test_remove_parent_via_update() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
    create_task(ctx.db(), "child", "Child", "ticket", "todo").await;
    create_child_of(ctx.db(), "child", "parent").await;

    assert!(child_of_exists(ctx.db(), "child", "parent").await);

    // Pass empty string to remove parent
    let cmd = update_cmd_with_parent("child", Some(""));
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(!child_of_exists(ctx.db(), "child", "parent").await);
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
// Add with Depends-On Tests
// =============================================================================

#[tokio::test]
async fn test_add_with_multiple_depends_on() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "blocker1", "Blocker 1", "task", "todo").await;
    create_task(ctx.db(), "blocker2", "Blocker 2", "task", "todo").await;

    let mut cmd = add_cmd("Dependent Task");
    cmd.depends_on = vec!["blocker1".to_string(), "blocker2".to_string()];
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();

    assert!(dependency_exists(ctx.db(), &task_id, "blocker1").await);
    assert!(dependency_exists(ctx.db(), &task_id, "blocker2").await);
}

#[tokio::test]
async fn test_add_with_parent_and_depends_on() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "parent", "Parent Epic", "epic", "todo").await;
    create_task(ctx.db(), "blocker", "Blocker", "task", "done").await;

    let mut cmd = add_cmd_with_parent("Child with Dep", "parent");
    cmd.depends_on = vec!["blocker".to_string()];
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let task_id = result.unwrap();

    assert!(child_of_exists(ctx.db(), &task_id, "parent").await);
    assert!(dependency_exists(ctx.db(), &task_id, "blocker").await);
}

// =============================================================================
// Case Insensitivity Tests
// =============================================================================

#[tokio::test]
async fn test_depend_case_insensitive() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;

    // Use uppercase IDs
    let cmd = depend_cmd("TASK1", "BLOCKER");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    // Should still be stored in lowercase
    assert!(dependency_exists(ctx.db(), "task1", "blocker").await);
}

#[tokio::test]
async fn test_undepend_case_insensitive() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "blocker").await;

    let cmd = undepend_cmd("TASK1", "BLOCKER");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(!dependency_exists(ctx.db(), "task1", "blocker").await);
}

// =============================================================================
// Hierarchy Tests
// =============================================================================

#[tokio::test]
async fn test_full_hierarchy_creation() {
    let ctx = TestContext::new().await;

    // Create epic -> ticket -> task hierarchy
    let epic_cmd = add_cmd_full("Epic", Some(Level::Epic), None, None);
    let epic_id = epic_cmd.execute(&ctx.service).await.unwrap();

    let ticket_cmd = add_cmd_full("Ticket", Some(Level::Ticket), None, Some(&epic_id));
    let ticket_id = ticket_cmd.execute(&ctx.service).await.unwrap();

    let task_cmd = add_cmd_full("Task", Some(Level::Task), None, Some(&ticket_id));
    let task_id = task_cmd.execute(&ctx.service).await.unwrap();

    // Verify hierarchy
    assert!(child_of_exists(ctx.db(), &ticket_id, &epic_id).await);
    assert!(child_of_exists(ctx.db(), &task_id, &ticket_id).await);
    assert_eq!(count_children(ctx.db(), &epic_id).await, 1);
    assert_eq!(count_children(ctx.db(), &ticket_id).await, 1);
}
