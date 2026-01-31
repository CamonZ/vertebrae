//! Integration tests for the Review command
//!
//! Tests the `vtb review` command which toggles or sets the needs_human_review flag on tasks.

use super::mock::mock_services;
use vertebrae_cli::commands::*;

#[tokio::test]
async fn test_review_toggle_from_false_to_true() {
    let services = mock_services();

    // Create a task without review flag
    let task = AddCommand {
        title: "Review task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    // Verify initial state
    let initial_task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(initial_task.needs_human_review, None);

    // Toggle review flag
    let cmd = ReviewCommand {
        id: task_id.clone(),
        set: None,
    };
    let result = cmd.execute(&services).await.unwrap();

    // Verify the message indicates it's marked as needing review
    assert!(result.contains("marked as needing review"));
    assert!(result.contains(&task_id));

    // Verify the actual flag value changed
    let updated_task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(updated_task.needs_human_review, Some(true));
}

#[tokio::test]
async fn test_review_toggle_from_true_to_false() {
    let services = mock_services();

    // Create a task with review flag already set to true
    let task = AddCommand {
        title: "Review task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: true,
        workflow: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    // Verify initial state
    let initial_task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(initial_task.needs_human_review, Some(true));

    // Toggle review flag
    let cmd = ReviewCommand {
        id: task_id.clone(),
        set: None,
    };
    let result = cmd.execute(&services).await.unwrap();

    // Verify the message indicates it's marked as not needing review
    assert!(result.contains("marked as not needing review"));
    assert!(result.contains(&task_id));

    // Verify the actual flag value changed
    let updated_task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(updated_task.needs_human_review, Some(false));
}

#[tokio::test]
async fn test_review_set_to_true() {
    let services = mock_services();

    // Create a task
    let task = AddCommand {
        title: "Set review task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    // Set review flag to true explicitly
    let cmd = ReviewCommand {
        id: task_id.clone(),
        set: Some(true),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert!(result.contains("marked as needing review"));

    let updated_task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(updated_task.needs_human_review, Some(true));
}

#[tokio::test]
async fn test_review_set_to_false() {
    let services = mock_services();

    // Create a task with review already set
    let task = AddCommand {
        title: "Unset review task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: true,
        workflow: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    // Set review flag to false explicitly
    let cmd = ReviewCommand {
        id: task_id.clone(),
        set: Some(false),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert!(result.contains("marked as not needing review"));

    let updated_task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(updated_task.needs_human_review, Some(false));
}

#[tokio::test]
async fn test_review_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = ReviewCommand {
        id: "nonexistent_task".to_string(),
        set: None,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_review_case_insensitive_task_id() {
    let services = mock_services();

    // Create a task
    let task = AddCommand {
        title: "Case sensitive task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    // Use uppercase version of the ID
    let uppercase_id = task_id.to_uppercase();

    let cmd = ReviewCommand {
        id: uppercase_id.clone(),
        set: Some(true),
    };
    let result = cmd.execute(&services).await.unwrap();

    // Should succeed even with different case
    assert!(result.contains("marked as needing review"));

    // Verify the actual task was updated
    let updated_task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(updated_task.needs_human_review, Some(true));
}

#[tokio::test]
async fn test_review_multiple_toggles() {
    let services = mock_services();

    let task = AddCommand {
        title: "Toggle task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    // Toggle 1: false -> true
    let cmd1 = ReviewCommand {
        id: task_id.clone(),
        set: None,
    };
    cmd1.execute(&services).await.unwrap();
    let task1 = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task1.needs_human_review, Some(true));

    // Toggle 2: true -> false
    let cmd2 = ReviewCommand {
        id: task_id.clone(),
        set: None,
    };
    cmd2.execute(&services).await.unwrap();
    let task2 = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task2.needs_human_review, Some(false));

    // Toggle 3: false -> true again
    let cmd3 = ReviewCommand {
        id: task_id.clone(),
        set: None,
    };
    cmd3.execute(&services).await.unwrap();
    let task3 = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task3.needs_human_review, Some(true));
}

#[tokio::test]
async fn test_review_set_overrides_current_state() {
    let services = mock_services();

    // Create task with review = true
    let task = AddCommand {
        title: "Override task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: true,
        workflow: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    // Set to false explicitly
    let cmd1 = ReviewCommand {
        id: task_id.clone(),
        set: Some(false),
    };
    cmd1.execute(&services).await.unwrap();
    let task1 = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task1.needs_human_review, Some(false));

    // Set to true explicitly
    let cmd2 = ReviewCommand {
        id: task_id.clone(),
        set: Some(true),
    };
    cmd2.execute(&services).await.unwrap();
    let task2 = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task2.needs_human_review, Some(true));

    // Set to false again
    let cmd3 = ReviewCommand {
        id: task_id.clone(),
        set: Some(false),
    };
    cmd3.execute(&services).await.unwrap();
    let task3 = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task3.needs_human_review, Some(false));
}

#[tokio::test]
async fn test_review_with_parent_and_children() {
    let services = mock_services();

    // Create parent task
    let parent = AddCommand {
        title: "Parent task".to_string(),
        level: Some(vertebrae_core::Level::Epic),
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    };
    let parent_id = parent.execute(&services).await.unwrap();

    // Create child task
    let child = AddCommand {
        title: "Child task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: Some(parent_id.clone()),
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    };
    let child_id = child.execute(&services).await.unwrap();

    // Toggle review on parent
    let parent_cmd = ReviewCommand {
        id: parent_id.clone(),
        set: Some(true),
    };
    parent_cmd.execute(&services).await.unwrap();

    // Toggle review on child
    let child_cmd = ReviewCommand {
        id: child_id.clone(),
        set: Some(true),
    };
    child_cmd.execute(&services).await.unwrap();

    // Verify both are updated independently
    let updated_parent = services.tasks().get_task(&parent_id).await.unwrap();
    let updated_child = services.tasks().get_task(&child_id).await.unwrap();

    assert_eq!(updated_parent.needs_human_review, Some(true));
    assert_eq!(updated_child.needs_human_review, Some(true));
}
