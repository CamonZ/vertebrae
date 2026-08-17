//! Integration tests for the Ready command
//!
//! Tests the `vtb ready` command which shows highest-level actionable items
//! (tasks that are unblocked and in backlog status).

use super::mock::mock_services;
use vertebrae_cli::commands::*;

#[tokio::test]
async fn test_ready_returns_unblocked_tasks() {
    let services = mock_services();

    // Create two tasks: one unblocked, one blocked
    let unblocked = AddCommand {
        title: "Unblocked task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let unblocked_id = unblocked.execute(&services).await.unwrap();

    let blocker = AddCommand {
        title: "Blocker task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let blocker_id = blocker.execute(&services).await.unwrap();

    let blocked = AddCommand {
        title: "Blocked task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![blocker_id.clone()],
        workflow: None,
        worktree: None,
    };
    let blocked_id = blocked.execute(&services).await.unwrap();

    // Execute ready command
    let cmd = ReadyCommand {};
    let result = cmd.execute(&services).await.unwrap();

    // Should include both unblocked and blocker, but not blocked
    assert_eq!(result.backlog_ready.len(), 2);

    let ready_ids: Vec<&str> = result.backlog_ready.iter().map(|t| t.id.as_str()).collect();
    assert!(ready_ids.contains(&unblocked_id.as_str()));
    assert!(ready_ids.contains(&blocker_id.as_str()));
    assert!(!ready_ids.contains(&blocked_id.as_str()));
}

#[tokio::test]
async fn test_ready_with_no_tasks() {
    let services = mock_services();

    let cmd = ReadyCommand {};
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.backlog_ready.len(), 0);
    assert!(result.backlog_ready.is_empty());
}

#[tokio::test]
async fn test_ready_with_all_tasks_blocked() {
    let services = mock_services();

    // Create a blocker task
    let blocker = AddCommand {
        title: "Blocker".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let blocker_id = blocker.execute(&services).await.unwrap();

    // Create multiple tasks that all depend on the blocker
    for i in 1..=3 {
        let task = AddCommand {
            title: format!("Task {}", i),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![blocker_id.clone()],
            workflow: None,
            worktree: None,
        };
        task.execute(&services).await.unwrap();
    }

    // Only the blocker should be ready
    let cmd = ReadyCommand {};
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.backlog_ready.len(), 1);
    assert_eq!(result.backlog_ready[0].id, blocker_id);
}

#[tokio::test]
async fn test_ready_command_display_format() {
    let services = mock_services();

    let task1 = AddCommand {
        title: "First task".to_string(),
        level: Some(vertebrae_core::Level::Epic),
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let id1 = task1.execute(&services).await.unwrap();

    let task2 = AddCommand {
        title: "Second task".to_string(),
        level: Some(vertebrae_core::Level::Ticket),
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let id2 = task2.execute(&services).await.unwrap();

    let cmd = ReadyCommand {};
    let result = cmd.execute(&services).await.unwrap();

    // Check the display format includes expected content
    let display_output = format!("{}", result);
    assert!(display_output.contains("Ready to start (backlog):"));
    assert!(display_output.contains(&id1));
    assert!(display_output.contains(&id2));
    assert!(display_output.contains("First task"));
    assert!(display_output.contains("Second task"));
    assert!(display_output.contains("epic"));
    assert!(display_output.contains("ticket"));
}

#[tokio::test]
async fn test_ready_empty_display_message() {
    let services = mock_services();

    let cmd = ReadyCommand {};
    let result = cmd.execute(&services).await.unwrap();

    let display_output = format!("{}", result);
    assert_eq!(display_output, "No actionable items found.");
}

#[tokio::test]
async fn test_ready_with_multiple_dependency_levels() {
    let services = mock_services();

    // Create dependency chain: A -> B -> C -> D
    let a = AddCommand {
        title: "Task A".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let a_id = a.execute(&services).await.unwrap();

    let b = AddCommand {
        title: "Task B".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![a_id.clone()],
        workflow: None,
        worktree: None,
    };
    let b_id = b.execute(&services).await.unwrap();

    let c = AddCommand {
        title: "Task C".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![b_id.clone()],
        workflow: None,
        worktree: None,
    };
    let c_id = c.execute(&services).await.unwrap();

    let d = AddCommand {
        title: "Task D".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![c_id.clone()],
        workflow: None,
        worktree: None,
    };
    let _d_id = d.execute(&services).await.unwrap();

    // Only A should be ready (no blockers)
    let cmd = ReadyCommand {};
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.backlog_ready.len(), 1);
    assert_eq!(result.backlog_ready[0].id, a_id);
    assert_eq!(result.backlog_ready[0].title, "Task A");
}

#[tokio::test]
async fn test_ready_task_properties() {
    let services = mock_services();

    // Create a task with specific properties
    let task = AddCommand {
        title: "Test task".to_string(),
        level: Some(vertebrae_core::Level::Ticket),
        description: Some("Test description".to_string()),
        priority: Some(vertebrae_core::Priority::High),
        tags: vec!["frontend".to_string(), "urgent".to_string()],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    let cmd = ReadyCommand {};
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.backlog_ready.len(), 1);
    let ready_task = &result.backlog_ready[0];
    assert_eq!(ready_task.id, task_id);
    assert_eq!(ready_task.title, "Test task");
    assert_eq!(ready_task.level, vertebrae_core::Level::Ticket);
    assert_eq!(ready_task.priority, Some(vertebrae_core::Priority::High));
    assert_eq!(ready_task.tags, vec!["frontend", "urgent"]);
}
