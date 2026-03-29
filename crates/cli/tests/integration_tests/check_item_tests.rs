//! Integration tests for the CheckItem command
//!
//! Tests the `vtb check-item` command which marks individual checklist items within a task as complete.

use super::mock::mock_services;
use vertebrae_cli::commands::*;
use vertebrae_core::SectionType;

async fn create_task_with_checklist_items(
    services: &vertebrae_core::VertebraeServices,
    title: &str,
    num_items: usize,
) -> String {
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
    let task_id = task.execute(services).await.unwrap();

    // Add checklist items
    for i in 1..=num_items {
        let section = SectionCommand {
            id: task_id.clone(),
            section_type: SectionType::ChecklistItem,
            content: format!("Item {}", i),
        };
        section.execute(services).await.unwrap();
    }

    task_id
}

#[tokio::test]
async fn test_check_item_marks_item_as_complete() {
    let services = mock_services();

    let task_id = create_task_with_checklist_items(&services, "Task with items", 3).await;

    // Mark item 1 as done
    let cmd = CheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
    assert_eq!(result.item_index, 1);
    assert_eq!(result.item_content, "Item 1");

    // Verify the item is marked as done
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(items.len(), 3);
    // Item 1 should be marked done
    assert_eq!(items[0].done, Some(true));
    assert!(items[0].done_at.is_some());
    // Items 2 and 3 should not be done
    assert_eq!(items[1].done, None);
    assert_eq!(items[2].done, None);
}

#[tokio::test]
async fn test_check_item_with_multiple_items() {
    let services = mock_services();

    let task_id = create_task_with_checklist_items(&services, "Multi-item task", 5).await;

    // Mark item 2 as done
    let cmd2 = CheckItemCommand {
        id: task_id.clone(),
        index: 2,
    };
    let result2 = cmd2.execute(&services).await.unwrap();
    assert_eq!(result2.item_index, 2);
    assert_eq!(result2.item_content, "Item 2");

    // Mark item 4 as done
    let cmd4 = CheckItemCommand {
        id: task_id.clone(),
        index: 4,
    };
    let result4 = cmd4.execute(&services).await.unwrap();
    assert_eq!(result4.item_index, 4);
    assert_eq!(result4.item_content, "Item 4");

    // Verify the correct items are marked done
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(items.len(), 5);
    assert_eq!(items[0].done, None); // Item 1 not done
    assert_eq!(items[1].done, Some(true)); // Item 2 done
    assert_eq!(items[2].done, None); // Item 3 not done
    assert_eq!(items[3].done, Some(true)); // Item 4 done
    assert_eq!(items[4].done, None); // Item 5 not done
}

#[tokio::test]
async fn test_check_item_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = CheckItemCommand {
        id: "nonexistent_task".to_string(),
        index: 1,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_check_item_invalid_index_zero_fails() {
    let services = mock_services();

    let task_id = create_task_with_checklist_items(&services, "Task", 3).await;

    let cmd = CheckItemCommand {
        id: task_id,
        index: 0,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
    // Verify it's specifically the validation error about checklist item index
    match result {
        Err(vertebrae_core::ServiceError::ValidationFailed { .. }) => {}
        _ => panic!("Expected ValidationFailed error"),
    }
}

#[tokio::test]
async fn test_check_item_index_out_of_bounds_fails() {
    let services = mock_services();

    let task_id = create_task_with_checklist_items(&services, "Task", 3).await;

    let cmd = CheckItemCommand {
        id: task_id,
        index: 5,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
    // Verify it's the out of bounds error
    match result {
        Err(vertebrae_core::ServiceError::ValidationFailed { message }) => {
            assert!(message.contains("Checklist item 5 not found"));
        }
        _ => panic!("Expected ValidationFailed error with specific message"),
    }
}

#[tokio::test]
async fn test_check_item_case_insensitive_task_id() {
    let services = mock_services();

    let task_id = create_task_with_checklist_items(&services, "Case task", 2).await;

    // Use uppercase version of the ID
    let uppercase_id = task_id.to_uppercase();

    let cmd = CheckItemCommand {
        id: uppercase_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    // Should succeed with uppercase ID
    assert_eq!(result.task_id, task_id); // Result normalizes to lowercase
    assert_eq!(result.item_index, 1);
}

#[tokio::test]
async fn test_check_item_result_contains_correct_content() {
    let services = mock_services();

    let task_id = create_task_with_checklist_items(&services, "Content task", 3).await;

    let cmd = CheckItemCommand {
        id: task_id.clone(),
        index: 2,
    };
    let result = cmd.execute(&services).await.unwrap();

    // Verify result has correct values
    assert_eq!(result.task_id, task_id);
    assert_eq!(result.item_index, 2);
    assert_eq!(result.item_content, "Item 2");

    // Verify display format
    let display = format!("{}", result);
    assert!(display.contains("Marked checklist item 2 as done"));
    assert!(display.contains(&task_id));
    assert!(display.contains("Item 2"));
}

#[tokio::test]
async fn test_check_item_with_single_item() {
    let services = mock_services();

    let task_id = create_task_with_checklist_items(&services, "Single item task", 1).await;

    let cmd = CheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.item_index, 1);
    assert_eq!(result.item_content, "Item 1");

    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].done, Some(true));
}

#[tokio::test]
async fn test_check_item_on_task_without_items_fails() {
    let services = mock_services();

    // Create a task without adding any checklist items
    let task = AddCommand {
        title: "Task without items".to_string(),
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

    let cmd = CheckItemCommand {
        id: task_id,
        index: 1,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_check_item_all_items_sequentially() {
    let services = mock_services();

    let task_id = create_task_with_checklist_items(&services, "Sequential task", 4).await;

    // Mark all items as done in order
    for i in 1..=4 {
        let cmd = CheckItemCommand {
            id: task_id.clone(),
            index: i,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.item_index, i);
    }

    // Verify all items are done
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(items.len(), 4);
    for item in items {
        assert_eq!(item.done, Some(true));
        assert!(item.done_at.is_some());
    }
}

#[tokio::test]
async fn test_check_item_with_constraint_sections() {
    let services = mock_services();

    // Create task with mixed section types
    let task = AddCommand {
        title: "Mixed sections task".to_string(),
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

    // Add checklist item
    let item1 = SectionCommand {
        id: task_id.clone(),
        section_type: SectionType::ChecklistItem,
        content: "Item 1".to_string(),
    };
    item1.execute(&services).await.unwrap();

    // Add constraint (non-checklist-item section)
    let constraint = SectionCommand {
        id: task_id.clone(),
        section_type: SectionType::Constraint,
        content: "Must be backwards compatible".to_string(),
    };
    constraint.execute(&services).await.unwrap();

    // Add another checklist item
    let item2 = SectionCommand {
        id: task_id.clone(),
        section_type: SectionType::ChecklistItem,
        content: "Item 2".to_string(),
    };
    item2.execute(&services).await.unwrap();

    // Mark item 1 as done (should be index 1, not affected by constraint)
    let cmd = CheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.item_content, "Item 1");

    // Mark item 2 as done (should be index 2)
    let cmd2 = CheckItemCommand {
        id: task_id.clone(),
        index: 2,
    };
    let result2 = cmd2.execute(&services).await.unwrap();

    assert_eq!(result2.item_content, "Item 2");

    // Verify both items are marked as done
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(items.len(), 2);
    assert_eq!(items[0].done, Some(true));
    assert_eq!(items[1].done, Some(true));
}

#[tokio::test]
async fn test_check_item_with_parent_child_hierarchy() {
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

    // Create child task with checklist items
    let child_id = create_task_with_checklist_items(&services, "Child task", 3).await;

    // Set parent relationship
    let depend_cmd = DependCommand {
        id: child_id.clone(),
        blocker_id: parent_id.clone(),
    };
    depend_cmd.execute(&services).await.unwrap();

    // Mark an item in the child task
    let cmd = CheckItemCommand {
        id: child_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, child_id);
    assert_eq!(result.item_index, 1);

    // Verify parent is unaffected
    let parent_task = services.tasks().get_task(&parent_id).await.unwrap();
    let parent_items: Vec<_> = parent_task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(parent_items.len(), 0);
}
