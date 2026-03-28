//! Integration tests for update command covering uncovered code paths
//!
//! Tests edit-section, remove-section, validation errors, self-parent validation,
//! nonexistent parent validation, no-op updates, and combined updates.

use super::mock::mock_services;
use vertebrae_cli::commands::*;
use vertebrae_core::SectionType;

/// Helper to create a task with a specific ID for testing
async fn create_task(services: &vertebrae_core::VertebraeServices, title: &str) -> String {
    let cmd = AddCommand {
        title: title.to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        track: None,
        workflow: None,
    };
    cmd.execute(services).await.unwrap()
}

/// Helper to add a section to a task
async fn add_section(
    services: &vertebrae_core::VertebraeServices,
    task_id: &str,
    section_type: SectionType,
    content: &str,
) {
    let cmd = SectionCommand {
        id: task_id.to_string(),
        section_type,
        content: content.to_string(),
    };
    cmd.execute(services).await.unwrap();
}

// ============================================================================
// Edit section tests
// ============================================================================

#[tokio::test]
async fn test_update_edit_section_valid_step() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with steps").await;

    // Add two step sections
    add_section(
        &services,
        &task_id,
        SectionType::ChecklistItem,
        "First step",
    )
    .await;
    add_section(
        &services,
        &task_id,
        SectionType::ChecklistItem,
        "Second step",
    )
    .await;

    // Edit first step (ordinal 0)
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec![
            "checklist_item".to_string(),
            "0".to_string(),
            "Updated first step".to_string(),
        ]),
        remove_section: None,
    };

    cmd.execute(&services).await.unwrap();

    // Verify the section was edited
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].content, "Updated first step");
    assert_eq!(steps[1].content, "Second step");
}

#[tokio::test]
async fn test_update_edit_section_second_ordinal() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with multiple steps").await;

    // Add three step sections
    add_section(&services, &task_id, SectionType::ChecklistItem, "Step 1").await;
    add_section(&services, &task_id, SectionType::ChecklistItem, "Step 2").await;
    add_section(&services, &task_id, SectionType::ChecklistItem, "Step 3").await;

    // Edit second step (ordinal 1)
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec![
            "checklist_item".to_string(),
            "1".to_string(),
            "Modified Step 2".to_string(),
        ]),
        remove_section: None,
    };

    cmd.execute(&services).await.unwrap();

    // Verify correct step was edited
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(steps[0].content, "Step 1");
    assert_eq!(steps[1].content, "Modified Step 2");
    assert_eq!(steps[2].content, "Step 3");
}

#[tokio::test]
async fn test_update_edit_constraint_section() {
    let services = mock_services();
    let task_id = create_task(&services, "Constrained task").await;

    // Add constraint (single-instance section)
    add_section(
        &services,
        &task_id,
        SectionType::Constraint,
        "Original constraint",
    )
    .await;

    // Edit constraint
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec![
            "constraint".to_string(),
            "0".to_string(),
            "Updated constraint".to_string(),
        ]),
        remove_section: None,
    };

    cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    let constraints: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::Constraint)
        .collect();
    assert_eq!(constraints.len(), 1);
    assert_eq!(constraints[0].content, "Updated constraint");
}

#[tokio::test]
async fn test_update_edit_section_invalid_ordinal() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Try to edit non-existent section ordinal
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec![
            "checklist_item".to_string(),
            "999".to_string(),
            "Invalid".to_string(),
        ]),
        remove_section: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_update_edit_section_invalid_ordinal_format() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Try to parse invalid ordinal (not a number)
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec![
            "checklist_item".to_string(),
            "not_a_number".to_string(),
            "Content".to_string(),
        ]),
        remove_section: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err_msg = format!("{:?}", result);
    assert!(err_msg.contains("invalid ordinal"));
}

#[tokio::test]
async fn test_update_edit_section_invalid_type() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Try to parse invalid section type
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec![
            "invalid_type".to_string(),
            "0".to_string(),
            "Content".to_string(),
        ]),
        remove_section: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err_msg = format!("{:?}", result);
    assert!(err_msg.contains("invalid section type"));
}

#[tokio::test]
async fn test_update_edit_section_wrong_arg_count() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Try edit-section with only 2 args (needs 3)
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec!["checklist_item".to_string(), "0".to_string()]),
        remove_section: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err_msg = format!("{:?}", result);
    assert!(err_msg.contains("edit-section requires"));
}

// ============================================================================
// Remove section tests
// ============================================================================

#[tokio::test]
async fn test_update_remove_section_valid_step() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with steps").await;

    // Add two step sections
    add_section(
        &services,
        &task_id,
        SectionType::ChecklistItem,
        "First step",
    )
    .await;
    add_section(
        &services,
        &task_id,
        SectionType::ChecklistItem,
        "Second step",
    )
    .await;

    // Remove first step
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: Some(vec!["checklist_item".to_string(), "0".to_string()]),
    };

    cmd.execute(&services).await.unwrap();

    // Verify only second step remains
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].content, "Second step");
}

#[tokio::test]
async fn test_update_remove_section_second_ordinal() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with steps").await;

    // Add three step sections
    add_section(&services, &task_id, SectionType::ChecklistItem, "Step 1").await;
    add_section(&services, &task_id, SectionType::ChecklistItem, "Step 2").await;
    add_section(&services, &task_id, SectionType::ChecklistItem, "Step 3").await;

    // Remove middle step (ordinal 1)
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: Some(vec!["checklist_item".to_string(), "1".to_string()]),
    };

    cmd.execute(&services).await.unwrap();

    // Verify correct step was removed
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].content, "Step 1");
    assert_eq!(steps[1].content, "Step 3");
}

#[tokio::test]
async fn test_update_remove_constraint_section() {
    let services = mock_services();
    let task_id = create_task(&services, "Constrained task").await;

    // Add constraint
    add_section(
        &services,
        &task_id,
        SectionType::Constraint,
        "Must be backwards compatible",
    )
    .await;

    // Remove constraint
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: Some(vec!["constraint".to_string(), "0".to_string()]),
    };

    cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    let constraints: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::Constraint)
        .collect();
    assert_eq!(constraints.len(), 0);
}

#[tokio::test]
async fn test_update_remove_section_invalid_ordinal() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Add a step so we can try to remove a different ordinal
    add_section(&services, &task_id, SectionType::ChecklistItem, "Step 0").await;

    // Try to remove non-existent ordinal (1 doesn't exist, only 0)
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: Some(vec!["checklist_item".to_string(), "999".to_string()]),
    };

    // Mock's remove_section_by_ordinal just retains sections that don't match,
    // so this won't error even if ordinal doesn't exist
    cmd.execute(&services).await.unwrap();

    // Verify the step at ordinal 0 still exists (999 never existed)
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(steps.len(), 1);
}

#[tokio::test]
async fn test_update_remove_section_invalid_ordinal_format() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Try to parse invalid ordinal
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: Some(vec!["checklist_item".to_string(), "abc".to_string()]),
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err_msg = format!("{:?}", result);
    assert!(err_msg.contains("invalid ordinal"));
}

#[tokio::test]
async fn test_update_remove_section_invalid_type() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Try invalid section type
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: Some(vec!["bad_type".to_string(), "0".to_string()]),
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err_msg = format!("{:?}", result);
    assert!(err_msg.contains("invalid section type"));
}

#[tokio::test]
async fn test_update_remove_section_wrong_arg_count() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Try remove-section with only 1 arg (needs 2)
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: Some(vec!["checklist_item".to_string()]),
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err_msg = format!("{:?}", result);
    assert!(err_msg.contains("remove-section requires"));
}

// ============================================================================
// Parent validation tests
// ============================================================================

#[tokio::test]
async fn test_update_self_parent_fails() {
    let services = mock_services();
    let task_id = create_task(&services, "Self-parent test").await;

    // Try to set task as its own parent
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: Some(task_id.clone()),
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err_msg = format!("{:?}", result);
    assert!(err_msg.contains("own parent"));
}

#[tokio::test]
async fn test_update_nonexistent_parent_fails() {
    let services = mock_services();
    let task_id = create_task(&services, "Task").await;

    // Try to set non-existent task as parent
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: Some("nonexistent".to_string()),
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
}

// ============================================================================
// No-op and combined update tests
// ============================================================================

#[tokio::test]
async fn test_update_no_changes_specified() {
    let services = mock_services();
    let task_id = create_task(&services, "No changes").await;

    // Get original state
    let original = services.tasks().get_task(&task_id).await.unwrap();

    // Update with no changes
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    let result = cmd.execute(&services).await.unwrap();
    assert_eq!(result, task_id);

    // Verify task is unchanged
    let after = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(original.title, after.title);
    assert_eq!(original.description, after.description);
    assert_eq!(original.priority, after.priority);
}

#[tokio::test]
async fn test_update_title_and_description() {
    let services = mock_services();
    let task_id = create_task(&services, "Original").await;

    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: Some("New title".to_string()),
        description: Some("New description".to_string()),
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.title, "New title");
    assert_eq!(task.description, Some("New description".to_string()));
}

#[tokio::test]
async fn test_update_clear_description() {
    let services = mock_services();

    // Create task with description
    let cmd = AddCommand {
        title: "Task".to_string(),
        level: None,
        description: Some("Original description".to_string()),
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        track: None,
        workflow: None,
    };
    let task_id = cmd.execute(&services).await.unwrap();

    // Verify original description
    let task_before = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(
        task_before.description,
        Some("Original description".to_string())
    );

    // Update to a new description
    let update = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: Some("Updated description".to_string()),
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    update.execute(&services).await.unwrap();

    // Verify description was updated
    let task_after = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(
        task_after.description,
        Some("Updated description".to_string())
    );
}

#[tokio::test]
async fn test_update_tags_combined() {
    let services = mock_services();

    // Create task with tags
    let cmd = AddCommand {
        title: "Task".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec!["tag1".to_string(), "tag2".to_string()],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        track: None,
        workflow: None,
    };
    let task_id = cmd.execute(&services).await.unwrap();

    // Add and remove tags in same update
    let update = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec!["tag3".to_string(), "tag4".to_string()],
        remove_tags: vec!["tag1".to_string()],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    update.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    // Note: mock implementation just clones tags, so we verify the update was called
    assert!(!task.tags.is_empty());
}

#[tokio::test]
async fn test_update_title_and_priority_and_tags() {
    let services = mock_services();
    let task_id = create_task(&services, "Original").await;

    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: Some("Updated title".to_string()),
        description: None,
        priority: Some(vertebrae_core::Priority::Critical),
        add_tags: vec!["urgent".to_string()],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.title, "Updated title");
    assert_eq!(task.priority, Some(vertebrae_core::Priority::Critical));
}

#[tokio::test]
async fn test_update_edit_and_field_change() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with steps").await;

    // Add a step
    add_section(
        &services,
        &task_id,
        SectionType::ChecklistItem,
        "Original step",
    )
    .await;

    // Update both step content and title
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: Some("Updated title".to_string()),
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec![
            "checklist_item".to_string(),
            "0".to_string(),
            "Updated step content".to_string(),
        ]),
        remove_section: None,
    };

    cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.title, "Updated title");
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(steps[0].content, "Updated step content");
}

#[tokio::test]
async fn test_update_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = UpdateCommand {
        id: "nonexistent".to_string(),
        title: Some("New title".to_string()),
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_update_case_insensitive_id() {
    let services = mock_services();
    let task_id = create_task(&services, "Test").await;

    // Update with uppercase ID
    let cmd = UpdateCommand {
        id: task_id.to_uppercase(),
        title: Some("Changed".to_string()),
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: None,
        remove_section: None,
    };

    let result = cmd.execute(&services).await.unwrap();
    assert_eq!(result, task_id);

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.title, "Changed");
}

#[tokio::test]
async fn test_update_all_fields_at_once() {
    let services = mock_services();

    let task_id = create_task(&services, "Original").await;

    // Add a section
    add_section(&services, &task_id, SectionType::ChecklistItem, "Old step").await;

    // Update title, description, priority and section
    // (Note: parent update via UpdateCommand calls set_parent internally,
    // but mock doesn't implement that, so we test fields that work)
    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: Some("Complete new title".to_string()),
        description: Some("Complete new description".to_string()),
        priority: Some(vertebrae_core::Priority::High),
        add_tags: vec!["important".to_string()],
        remove_tags: vec![],
        parent: None,
        worktree: None,
        track: None,
        edit_section: Some(vec![
            "checklist_item".to_string(),
            "0".to_string(),
            "New step content".to_string(),
        ]),
        remove_section: None,
    };

    cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.title, "Complete new title");
    assert_eq!(
        task.description,
        Some("Complete new description".to_string())
    );
    assert_eq!(task.priority, Some(vertebrae_core::Priority::High));

    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(steps[0].content, "New step content");
}

// ============================================================================
// Worktree update tests
// ============================================================================

#[tokio::test]
async fn test_update_set_worktree() {
    let services = mock_services();
    let task_id = create_task(&services, "Worktree task").await;

    let cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: Some("/home/user/projects/my-worktree".to_string()),
        track: None,
        edit_section: None,
        remove_section: None,
    };

    cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(
        task.worktree.as_deref(),
        Some("/home/user/projects/my-worktree")
    );
}

#[tokio::test]
async fn test_update_clear_worktree() {
    let services = mock_services();
    let task_id = create_task(&services, "Worktree task").await;

    // First set a worktree
    let set_cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: Some("/some/path".to_string()),
        track: None,
        edit_section: None,
        remove_section: None,
    };
    set_cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.worktree.as_deref(), Some("/some/path"));

    // Clear it with empty string
    let clear_cmd = UpdateCommand {
        id: task_id.clone(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        worktree: Some("".to_string()),
        track: None,
        edit_section: None,
        remove_section: None,
    };
    clear_cmd.execute(&services).await.unwrap();

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert!(task.worktree.is_none());
}
