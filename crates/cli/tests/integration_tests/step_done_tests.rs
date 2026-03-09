//! Integration tests for the StepDone command
//!
//! Tests the `vtb step-done` command which marks individual steps within a task as complete.

use super::mock::mock_services;
use vertebrae_cli::commands::*;
use vertebrae_core::SectionType;

async fn create_task_with_steps(
    services: &vertebrae_core::VertebraeServices,
    title: &str,
    num_steps: usize,
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

    // Add steps
    for i in 1..=num_steps {
        let section = SectionCommand {
            id: task_id.clone(),
            section_type: SectionType::ChecklistItem,
            content: format!("Step {}", i),
        };
        section.execute(services).await.unwrap();
    }

    task_id
}

#[tokio::test]
async fn test_step_done_marks_step_as_complete() {
    let services = mock_services();

    let task_id = create_task_with_steps(&services, "Task with steps", 3).await;

    // Mark step 1 as done
    let cmd = StepDoneCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, task_id);
    assert_eq!(result.step_index, 1);
    assert_eq!(result.step_content, "Step 1");

    // Verify the step is marked as done
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(steps.len(), 3);
    // Step 1 should be marked done
    assert_eq!(steps[0].done, Some(true));
    assert!(steps[0].done_at.is_some());
    // Steps 2 and 3 should not be done
    assert_eq!(steps[1].done, None);
    assert_eq!(steps[2].done, None);
}

#[tokio::test]
async fn test_step_done_with_multiple_steps() {
    let services = mock_services();

    let task_id = create_task_with_steps(&services, "Multi-step task", 5).await;

    // Mark step 2 as done
    let cmd2 = StepDoneCommand {
        id: task_id.clone(),
        index: 2,
    };
    let result2 = cmd2.execute(&services).await.unwrap();
    assert_eq!(result2.step_index, 2);
    assert_eq!(result2.step_content, "Step 2");

    // Mark step 4 as done
    let cmd4 = StepDoneCommand {
        id: task_id.clone(),
        index: 4,
    };
    let result4 = cmd4.execute(&services).await.unwrap();
    assert_eq!(result4.step_index, 4);
    assert_eq!(result4.step_content, "Step 4");

    // Verify the correct steps are marked done
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(steps.len(), 5);
    assert_eq!(steps[0].done, None); // Step 1 not done
    assert_eq!(steps[1].done, Some(true)); // Step 2 done
    assert_eq!(steps[2].done, None); // Step 3 not done
    assert_eq!(steps[3].done, Some(true)); // Step 4 done
    assert_eq!(steps[4].done, None); // Step 5 not done
}

#[tokio::test]
async fn test_step_done_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = StepDoneCommand {
        id: "nonexistent_task".to_string(),
        index: 1,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_step_done_invalid_index_zero_fails() {
    let services = mock_services();

    let task_id = create_task_with_steps(&services, "Task", 3).await;

    let cmd = StepDoneCommand {
        id: task_id,
        index: 0,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
    // Verify it's specifically the validation error about step index
    match result {
        Err(vertebrae_core::ServiceError::ValidationFailed { .. }) => {}
        _ => panic!("Expected ValidationFailed error"),
    }
}

#[tokio::test]
async fn test_step_done_index_out_of_bounds_fails() {
    let services = mock_services();

    let task_id = create_task_with_steps(&services, "Task", 3).await;

    let cmd = StepDoneCommand {
        id: task_id,
        index: 5,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
    // Verify it's the out of bounds error
    match result {
        Err(vertebrae_core::ServiceError::ValidationFailed { message }) => {
            assert!(message.contains("Step 5 not found"));
        }
        _ => panic!("Expected ValidationFailed error with specific message"),
    }
}

#[tokio::test]
async fn test_step_done_case_insensitive_task_id() {
    let services = mock_services();

    let task_id = create_task_with_steps(&services, "Case task", 2).await;

    // Use uppercase version of the ID
    let uppercase_id = task_id.to_uppercase();

    let cmd = StepDoneCommand {
        id: uppercase_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    // Should succeed with uppercase ID
    assert_eq!(result.task_id, task_id); // Result normalizes to lowercase
    assert_eq!(result.step_index, 1);
}

#[tokio::test]
async fn test_step_done_result_contains_correct_content() {
    let services = mock_services();

    let task_id = create_task_with_steps(&services, "Content task", 3).await;

    let cmd = StepDoneCommand {
        id: task_id.clone(),
        index: 2,
    };
    let result = cmd.execute(&services).await.unwrap();

    // Verify result has correct values
    assert_eq!(result.task_id, task_id);
    assert_eq!(result.step_index, 2);
    assert_eq!(result.step_content, "Step 2");

    // Verify display format
    let display = format!("{}", result);
    assert!(display.contains("Marked step 2 as done"));
    assert!(display.contains(&task_id));
    assert!(display.contains("Step 2"));
}

#[tokio::test]
async fn test_step_done_with_single_step() {
    let services = mock_services();

    let task_id = create_task_with_steps(&services, "Single step task", 1).await;

    let cmd = StepDoneCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.step_index, 1);
    assert_eq!(result.step_content, "Step 1");

    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].done, Some(true));
}

#[tokio::test]
async fn test_step_done_on_task_without_steps_fails() {
    let services = mock_services();

    // Create a task without adding any steps
    let task = AddCommand {
        title: "Task without steps".to_string(),
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

    let cmd = StepDoneCommand {
        id: task_id,
        index: 1,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_step_done_all_steps_sequentially() {
    let services = mock_services();

    let task_id = create_task_with_steps(&services, "Sequential task", 4).await;

    // Mark all steps as done in order
    for i in 1..=4 {
        let cmd = StepDoneCommand {
            id: task_id.clone(),
            index: i,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.step_index, i);
    }

    // Verify all steps are done
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(steps.len(), 4);
    for step in steps {
        assert_eq!(step.done, Some(true));
        assert!(step.done_at.is_some());
    }
}

#[tokio::test]
async fn test_step_done_with_constraint_sections() {
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

    // Add step
    let step1 = SectionCommand {
        id: task_id.clone(),
        section_type: SectionType::ChecklistItem,
        content: "Step 1".to_string(),
    };
    step1.execute(&services).await.unwrap();

    // Add constraint (non-step section)
    let constraint = SectionCommand {
        id: task_id.clone(),
        section_type: SectionType::Constraint,
        content: "Must be backwards compatible".to_string(),
    };
    constraint.execute(&services).await.unwrap();

    // Add another step
    let step2 = SectionCommand {
        id: task_id.clone(),
        section_type: SectionType::ChecklistItem,
        content: "Step 2".to_string(),
    };
    step2.execute(&services).await.unwrap();

    // Mark step 1 as done (should be index 1, not affected by constraint)
    let cmd = StepDoneCommand {
        id: task_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.step_content, "Step 1");

    // Mark step 2 as done (should be index 2)
    let cmd2 = StepDoneCommand {
        id: task_id.clone(),
        index: 2,
    };
    let result2 = cmd2.execute(&services).await.unwrap();

    assert_eq!(result2.step_content, "Step 2");

    // Verify both steps are marked as done
    let task = services.tasks().get_task(&task_id).await.unwrap();
    let steps: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();

    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].done, Some(true));
    assert_eq!(steps[1].done, Some(true));
}

#[tokio::test]
async fn test_step_done_with_parent_child_hierarchy() {
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

    // Create child task with steps
    let child_id = create_task_with_steps(&services, "Child task", 3).await;

    // Set parent relationship
    let depend_cmd = DependCommand {
        id: child_id.clone(),
        blocker_id: parent_id.clone(),
    };
    depend_cmd.execute(&services).await.unwrap();

    // Mark a step in the child task
    let cmd = StepDoneCommand {
        id: child_id.clone(),
        index: 1,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.task_id, child_id);
    assert_eq!(result.step_index, 1);

    // Verify parent is unaffected
    let parent_task = services.tasks().get_task(&parent_id).await.unwrap();
    let parent_steps: Vec<_> = parent_task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    assert_eq!(parent_steps.len(), 0);
}
