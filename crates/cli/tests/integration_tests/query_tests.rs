//! Query tests for list, show, blockers, ready, and path commands
//!
//! Tests for querying and filtering tasks through various CLI commands.

use super::common::*;
use vertebrae_db::Level;

// =============================================================================
// List Command Tests
// =============================================================================

#[tokio::test]
async fn test_list_empty_database() {
    let ctx = TestContext::new().await;

    let cmd = list_cmd();
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    assert!(tasks.is_empty());
}

#[tokio::test]
async fn test_list_all_tasks() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;
    create_task(ctx.db(), "task3", "Task 3", "task", "todo").await;

    let cmd = list_cmd();
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    assert_eq!(tasks.len(), 3);
}

#[tokio::test]
async fn test_list_with_status_filter() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "in_progress").await;
    create_task(ctx.db(), "task3", "Task 3", "task", "done").await;

    let cmd = list_cmd_with_status(vec!["todo"]);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "task1");
}

#[tokio::test]
async fn test_list_with_multiple_statuses() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "in_progress").await;
    create_task(ctx.db(), "task3", "Task 3", "task", "done").await;

    let cmd = list_cmd_with_status(vec!["todo", "in_progress"]);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    assert_eq!(tasks.len(), 2);
}

#[tokio::test]
async fn test_list_with_level_filter() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "epic1", "Epic 1", "epic", "todo").await;
    create_task(ctx.db(), "ticket1", "Ticket 1", "ticket", "todo").await;
    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = list_cmd_with_level(vec![Level::Epic]);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, "epic1");
}

#[tokio::test]
async fn test_list_with_tag_filter() {
    let ctx = TestContext::new().await;

    create_task_with_tags(ctx.db(), "task1", "Task 1", "task", "todo", &["frontend"]).await;
    create_task_with_tags(ctx.db(), "task2", "Task 2", "task", "todo", &["backend"]).await;
    create_task_with_tags(
        ctx.db(),
        "task3",
        "Task 3",
        "task",
        "todo",
        &["frontend", "urgent"],
    )
    .await;

    let cmd = list_cmd_with_tags(vec!["frontend"]);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    assert_eq!(tasks.len(), 2);
}

#[tokio::test]
async fn test_list_root_only() {
    let ctx = TestContext::new().await;

    // Create hierarchy: epic -> ticket -> task
    create_task(ctx.db(), "epic", "Epic", "epic", "todo").await;
    create_task(ctx.db(), "ticket", "Ticket", "ticket", "todo").await;
    create_task(ctx.db(), "task1", "Task", "task", "todo").await;
    create_child_of(ctx.db(), "ticket", "epic").await;
    create_child_of(ctx.db(), "task1", "ticket").await;

    // Also a standalone task
    create_task(ctx.db(), "task2", "Standalone Task", "task", "todo").await;

    let cmd = list_cmd_root();
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    // Should only get epic and standalone task (they have no parent)
    assert_eq!(tasks.len(), 2);
}

#[tokio::test]
async fn test_list_with_parent_filter() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
    create_task(ctx.db(), "child1", "Child 1", "ticket", "todo").await;
    create_task(ctx.db(), "child2", "Child 2", "ticket", "todo").await;
    create_task(ctx.db(), "other", "Other", "task", "todo").await;
    create_child_of(ctx.db(), "child1", "parent").await;
    create_child_of(ctx.db(), "child2", "parent").await;

    let cmd = list_cmd_with_parent("parent");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    assert_eq!(tasks.len(), 2);
}

#[tokio::test]
async fn test_list_with_search() {
    let ctx = TestContext::new().await;

    create_task(
        ctx.db(),
        "auth1",
        "Implement authentication",
        "task",
        "todo",
    )
    .await;
    create_task(ctx.db(), "auth2", "Fix auth bug", "task", "todo").await;
    create_task(ctx.db(), "other", "Database migration", "task", "todo").await;

    let cmd = list_cmd_with_search("auth");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let tasks = result.unwrap();
    assert_eq!(tasks.len(), 2);
}

#[tokio::test]
async fn test_list_flat_output() {
    let ctx = TestContext::new().await;

    // Create hierarchy
    create_task(ctx.db(), "epic", "Epic", "epic", "todo").await;
    create_task(ctx.db(), "ticket", "Ticket", "ticket", "todo").await;
    create_child_of(ctx.db(), "ticket", "epic").await;

    let cmd = list_cmd_flat();
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    // Flat should still return all tasks, just displayed differently
    let tasks = result.unwrap();
    assert_eq!(tasks.len(), 2);
}

#[tokio::test]
async fn test_list_all_flag_includes_done() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "done").await;
    create_task(ctx.db(), "task3", "Task 3", "task", "rejected").await;

    // Default list excludes only "done" status (rejected is included)
    let cmd = list_cmd();
    let result = cmd.execute(&ctx.service).await.unwrap();
    assert_eq!(result.len(), 2); // todo + rejected

    // With --all flag, done is also included
    let cmd = list_cmd_all();
    let result = cmd.execute(&ctx.service).await.unwrap();
    assert_eq!(result.len(), 3);
}

// =============================================================================
// Show Command Tests
// =============================================================================

#[tokio::test]
async fn test_show_task_details() {
    let ctx = TestContext::new().await;

    create_task_with_description(
        ctx.db(),
        "task1",
        "Test Task",
        "task",
        "todo",
        "This is a description",
    )
    .await;

    let cmd = show_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let detail = result.unwrap();
    assert_eq!(detail.id, "task1");
    assert_eq!(detail.title, "Test Task");
    assert_eq!(
        detail.description,
        Some("This is a description".to_string())
    );
}

#[tokio::test]
async fn test_show_task_with_sections() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;
    section_cmd("task1", vertebrae_db::SectionType::Goal, "The goal")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", vertebrae_db::SectionType::Step, "Step 1")
        .execute(&ctx.service)
        .await
        .unwrap();

    let cmd = show_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let detail = result.unwrap();
    assert_eq!(detail.sections.len(), 2);
}

#[tokio::test]
async fn test_show_task_with_relationships() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
    create_task(ctx.db(), "child", "Child", "ticket", "todo").await;
    create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;
    create_child_of(ctx.db(), "child", "parent").await;
    create_depends_on(ctx.db(), "child", "blocker").await;

    let cmd = show_cmd("child");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let detail = result.unwrap();
    assert!(detail.parent.is_some());
    assert_eq!(detail.parent.unwrap().id, "parent");
    assert!(!detail.blocked_by.is_empty());
}

#[tokio::test]
async fn test_show_case_insensitive() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

    let cmd = show_cmd("TASK1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert_eq!(result.unwrap().id, "task1");
}

// =============================================================================
// Blockers Command Tests
// =============================================================================

#[tokio::test]
async fn test_blockers_no_dependencies() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = blockers_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let blockers_result = result.unwrap();
    assert!(blockers_result.blockers.is_empty());
}

#[tokio::test]
async fn test_blockers_direct_blockers() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker1", "Blocker 1", "task", "todo").await;
    create_task(ctx.db(), "blocker2", "Blocker 2", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "blocker1").await;
    create_depends_on(ctx.db(), "task1", "blocker2").await;

    let cmd = blockers_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let blockers_result = result.unwrap();
    assert_eq!(blockers_result.blockers.len(), 2);
}

#[tokio::test]
async fn test_blockers_transitive() {
    let ctx = TestContext::new().await;

    // Chain: task1 -> blocker1 -> blocker2
    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker1", "Blocker 1", "task", "todo").await;
    create_task(ctx.db(), "blocker2", "Blocker 2", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "blocker1").await;
    create_depends_on(ctx.db(), "blocker1", "blocker2").await;

    let cmd = blockers_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let blockers_result = result.unwrap();
    // Should show transitive dependencies
    assert_eq!(blockers_result.total_count, 2);
}

#[tokio::test]
async fn test_blockers_excludes_done_by_default() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker1", "Blocker 1", "task", "done").await;
    create_task(ctx.db(), "blocker2", "Blocker 2", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "blocker1").await;
    create_depends_on(ctx.db(), "task1", "blocker2").await;

    let cmd = blockers_cmd("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let blockers_result = result.unwrap();
    // Only incomplete blocker
    assert_eq!(blockers_result.blockers.len(), 1);
}

#[tokio::test]
async fn test_blockers_with_all_flag() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker1", "Blocker 1", "task", "done").await;
    create_task(ctx.db(), "blocker2", "Blocker 2", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "blocker1").await;
    create_depends_on(ctx.db(), "task1", "blocker2").await;

    let cmd = blockers_cmd_full("task1", None, true);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let blockers_result = result.unwrap();
    // Both blockers with --all flag
    assert_eq!(blockers_result.blockers.len(), 2);
}

#[tokio::test]
async fn test_blockers_with_depth_limit() {
    let ctx = TestContext::new().await;

    // Chain: task1 -> b1 -> b2 -> b3
    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "b1", "Blocker 1", "task", "todo").await;
    create_task(ctx.db(), "b2", "Blocker 2", "task", "todo").await;
    create_task(ctx.db(), "b3", "Blocker 3", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "b1").await;
    create_depends_on(ctx.db(), "b1", "b2").await;
    create_depends_on(ctx.db(), "b2", "b3").await;

    let cmd = blockers_cmd_full("task1", Some(1), false);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let blockers_result = result.unwrap();
    // Only depth 1 (direct blocker)
    assert_eq!(blockers_result.blockers.len(), 1);
}

// =============================================================================
// Ready Command Tests
// =============================================================================

#[tokio::test]
async fn test_ready_shows_todo_tasks() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "backlog").await;

    let cmd = ready_cmd();
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let ready_result = result.unwrap();
    assert_eq!(ready_result.todo_ready.len(), 1);
    assert_eq!(ready_result.backlog_ready.len(), 1);
}

#[tokio::test]
async fn test_ready_excludes_blocked_tasks() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "blocker").await;

    let cmd = ready_cmd();
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let ready_result = result.unwrap();
    // task1 is blocked, blocker is ready
    assert_eq!(ready_result.todo_ready.len(), 1);
    assert_eq!(ready_result.todo_ready[0].id, "blocker");
}

#[tokio::test]
async fn test_ready_excludes_tasks_with_in_progress_children() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
    create_task(ctx.db(), "child", "Child", "task", "in_progress").await;
    create_child_of(ctx.db(), "child", "parent").await;

    let cmd = ready_cmd();
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let ready_result = result.unwrap();
    // Parent has work started (child is in_progress)
    assert!(ready_result.todo_ready.is_empty());
}

// =============================================================================
// Path Command Tests
// =============================================================================

#[tokio::test]
async fn test_path_direct_dependency() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "task2").await;

    let cmd = path_cmd("task1", "task2");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let path_result = result.unwrap();
    assert!(path_result.path.is_some());
    let path = path_result.path.unwrap();
    assert_eq!(path.len(), 2);
}

#[tokio::test]
async fn test_path_transitive() {
    let ctx = TestContext::new().await;

    // Chain: task1 -> task2 -> task3
    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;
    create_task(ctx.db(), "task3", "Task 3", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "task2").await;
    create_depends_on(ctx.db(), "task2", "task3").await;

    let cmd = path_cmd("task1", "task3");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let path_result = result.unwrap();
    assert!(path_result.path.is_some());
    let path = path_result.path.unwrap();
    assert_eq!(path.len(), 3);
}

#[tokio::test]
async fn test_path_no_connection() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;
    // No dependency between them

    let cmd = path_cmd("task1", "task2");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let path_result = result.unwrap();
    assert!(path_result.path.is_none());
}

#[tokio::test]
async fn test_path_same_task() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

    let cmd = path_cmd("task1", "task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let path_result = result.unwrap();
    // Path to itself should be just the task
    assert!(path_result.path.is_some());
    assert_eq!(path_result.path.unwrap().len(), 1);
}

#[tokio::test]
async fn test_path_case_insensitive() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
    create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;
    create_depends_on(ctx.db(), "task1", "task2").await;

    let cmd = path_cmd("TASK1", "TASK2");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    assert!(result.unwrap().path.is_some());
}
