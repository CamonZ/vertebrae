//! Integration tests for the UncheckItem command
//!
//! Tests the `vtb uncheck-item` command which unchecks a previously checked checklist item
//! by toggling it back to done=false, done_at=null.

use super::mock::mock_services;
use vertebrae_cli::commands::*;
use vertebrae_core::SectionType;

async fn create_task_with_checked_items(
    services: &vertebrae_core::VertebraeServices,
    title: &str,
    num_items: usize,
    checked_indices: &[usize],
) -> String {
    let task = AddCommand {
        title: title.to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
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

    // Check the specified items
    for &idx in checked_indices {
        let cmd = CheckItemCommand {
            id: task_id.clone(),
            index: idx,
        };
        cmd.execute(services).await.unwrap();
    }

    task_id
}

#[tokio::test]
async fn test_uncheck_item_unchecks_checked_item() {
    let services = mock_services();

    let task_id = create_task_with_checked_items(&services, "Task with items", 3, &[1]).await;

    // Verify item 1 is checked
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(items[0].done, Some(true));
    assert!(items[0].done_at.is_some());

    // Uncheck item 1
    let cmd = UncheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
    assert_eq!(result.item_index, 1);
    assert_eq!(result.item_content, "Item 1");

    // Verify item 1 is now unchecked
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(items[0].done, Some(false));
    assert!(items[0].done_at.is_none());
}

#[tokio::test]
async fn test_uncheck_item_with_multiple_checked_items() {
    let services = mock_services();

    let task_id = create_task_with_checked_items(&services, "Multi-item task", 5, &[1, 3, 5]).await;

    // Verify items 1, 3, 5 are checked
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(items[0].done, Some(true));
    assert_eq!(items[2].done, Some(true));
    assert_eq!(items[4].done, Some(true));

    // Uncheck item 3
    let cmd = UncheckItemCommand {
        id: task_id.clone(),
        index: 3,
    };
    let result = cmd.execute(&services).await.unwrap();
    assert_eq!(result.item_index, 3);
    assert_eq!(result.item_content, "Item 3");

    // Verify item 3 is unchecked, others remain unchanged
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(items[0].done, Some(true)); // Item 1 still checked
    assert_eq!(items[1].done, None); // Item 2 still unchecked
    assert_eq!(items[2].done, Some(false)); // Item 3 now unchecked
    assert_eq!(items[3].done, None); // Item 4 still unchecked
    assert_eq!(items[4].done, Some(true)); // Item 5 still checked
}

#[tokio::test]
async fn test_uncheck_item_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = UncheckItemCommand {
        id: "nonexistent_task".to_string(),
        index: 1,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_uncheck_item_invalid_index_zero_fails() {
    let services = mock_services();

    let task_id = create_task_with_checked_items(&services, "Task", 3, &[1]).await;

    let cmd = UncheckItemCommand {
        id: task_id,
        index: 0,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
    match result {
        Err(vertebrae_core::ServiceError::ValidationFailed { .. }) => {}
        _ => panic!("Expected ValidationFailed error"),
    }
}

#[tokio::test]
async fn test_uncheck_item_index_out_of_bounds_fails() {
    let services = mock_services();

    let task_id = create_task_with_checked_items(&services, "Task", 3, &[1]).await;

    let cmd = UncheckItemCommand {
        id: task_id,
        index: 5,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
    match result {
        Err(vertebrae_core::ServiceError::ValidationFailed { message }) => {
            assert!(message.contains("Checklist item 5 not found"));
        }
        _ => panic!("Expected ValidationFailed error with specific message"),
    }
}

#[tokio::test]
async fn test_uncheck_item_case_insensitive_task_id() {
    let services = mock_services();

    let task_id = create_task_with_checked_items(&services, "Case task", 2, &[1]).await;

    // Use uppercase version of the ID
    let uppercase_id = task_id.to_uppercase();

    let cmd = UncheckItemCommand {
        id: uppercase_id,
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
    assert_eq!(result.item_index, 1);
}

#[tokio::test]
async fn test_uncheck_item_result_display_format() {
    let services = mock_services();

    let task_id = create_task_with_checked_items(&services, "Display task", 3, &[2]).await;

    let cmd = UncheckItemCommand {
        id: task_id.clone(),
        index: 2,
    };
    let result = cmd.execute(&services).await.unwrap();

    let display = format!("{}", result);
    assert!(display.contains("Unchecked checklist item 2"));
    assert!(display.contains(&task_id));
    assert!(display.contains("Item 2"));
}

#[tokio::test]
async fn test_uncheck_item_on_task_without_items_fails() {
    let services = mock_services();

    let task = AddCommand {
        title: "Task without items".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    let cmd = UncheckItemCommand {
        id: task_id,
        index: 1,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_uncheck_all_checked_items_sequentially() {
    let services = mock_services();

    let task_id =
        create_task_with_checked_items(&services, "Sequential task", 4, &[1, 2, 3, 4]).await;

    // Verify all items are checked
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    for item in &items {
        assert_eq!(item.done, Some(true));
        assert!(item.done_at.is_some());
    }

    // Uncheck all items in order
    for i in 1..=4 {
        let cmd = UncheckItemCommand {
            id: task_id.clone(),
            index: i,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.item_index, i);
    }

    // Verify all items are unchecked
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(items.len(), 4);
    for item in &items {
        assert_eq!(item.done, Some(false));
        assert!(item.done_at.is_none());
    }
}

#[tokio::test]
async fn test_uncheck_item_with_mixed_section_types() {
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
        workflow: None,
        worktree: None,
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

    // Check both items
    let check1 = CheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    check1.execute(&services).await.unwrap();

    let check2 = CheckItemCommand {
        id: task_id.clone(),
        index: 2,
    };
    check2.execute(&services).await.unwrap();

    // Uncheck item 1 (should not be affected by constraint section)
    let cmd = UncheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();
    assert_eq!(result.item_content, "Item 1");

    // Verify item 1 is unchecked and item 2 is still checked
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(items.len(), 2);
    assert_eq!(items[0].done, Some(false)); // Item 1 unchecked
    assert_eq!(items[1].done, Some(true)); // Item 2 still checked
}

#[tokio::test]
async fn test_uncheck_item_check_then_uncheck_then_recheck() {
    let services = mock_services();

    let task_id = create_task_with_checked_items(&services, "Toggle task", 2, &[1]).await;

    // Item 1 is checked; uncheck it
    let uncheck = UncheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    uncheck.execute(&services).await.unwrap();

    // Verify it's unchecked
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(items[0].done, Some(false));

    // Trying to uncheck again should fail since item is already unchecked
    let uncheck_again = UncheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = uncheck_again.execute(&services).await;
    assert!(result.is_err());
    match result {
        Err(vertebrae_core::ServiceError::ValidationFailed { message }) => {
            assert_eq!(message, "Checklist item 1 is not checked");
        }
        _ => panic!("Expected ValidationFailed error"),
    }

    // Re-check it using check-item
    let recheck = CheckItemCommand {
        id: task_id.clone(),
        index: 1,
    };
    recheck.execute(&services).await.unwrap();

    // Verify it's checked again
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(items[0].done, Some(true));
    assert!(items[0].done_at.is_some());
}

#[tokio::test]
async fn test_uncheck_item_already_unchecked_fails() {
    let services = mock_services();

    // Create task with items but none checked
    let task = AddCommand {
        title: "Task with unchecked items".to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        workflow: None,
        worktree: None,
    };
    let task_id = task.execute(&services).await.unwrap();

    let section = SectionCommand {
        id: task_id.clone(),
        section_type: SectionType::ChecklistItem,
        content: "Unchecked item".to_string(),
    };
    section.execute(&services).await.unwrap();

    // Trying to uncheck an item that was never checked should fail
    let cmd = UncheckItemCommand {
        id: task_id,
        index: 1,
    };
    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    match result {
        Err(vertebrae_core::ServiceError::ValidationFailed { message }) => {
            assert_eq!(message, "Checklist item 1 is not checked");
        }
        _ => panic!("Expected ValidationFailed error"),
    }
}
