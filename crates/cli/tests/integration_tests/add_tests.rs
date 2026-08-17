//! Integration coverage for task creation options exposed by `vtb add`.

use super::mock::mock_services;
use vertebrae_cli::commands::AddCommand;

fn add_command(title: &str, worktree: Option<&str>) -> AddCommand {
    AddCommand {
        title: title.to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: worktree.map(str::to_string),
    }
}

#[tokio::test]
async fn add_forwards_worktree_to_created_task() {
    let services = mock_services();

    let task_id = add_command("Task with worktree", Some("/tmp/task-worktree"))
        .execute(&services)
        .await
        .unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.worktree.as_deref(), Some("/tmp/task-worktree"));
}

#[tokio::test]
async fn add_without_worktree_leaves_created_task_unset() {
    let services = mock_services();

    let task_id = add_command("Task without worktree", None)
        .execute(&services)
        .await
        .unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert!(task.worktree.is_none());
}
