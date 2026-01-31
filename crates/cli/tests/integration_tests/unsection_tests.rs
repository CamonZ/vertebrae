//! Integration tests for the `unsection` command
//!
//! Tests removing sections from tasks, including:
//! - Removing a section by type and ordinal
//! - Removing with invalid ordinal
//! - Removing with invalid section type
//! - Removing with nonexistent task
//! - Removing single-instance sections
//! - Removing all sections of a type
//! - Removing all sections from a task
//! - Verifying sections are actually removed and remaining sections are correct

use super::mock::mock_services;
use vertebrae_cli::commands::*;
use vertebrae_core::SectionType;

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
        workflow: None,
    };
    cmd.execute(services).await.unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_remove_single_section_by_ordinal() {
        let services = mock_services();
        let id = create_task(&services, "Task with steps").await;

        // Add three steps
        for step in ["Step one", "Step two", "Step three"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Step,
                content: step.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Verify 3 steps exist
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(
            task.sections
                .iter()
                .filter(|s| s.section_type == SectionType::Step)
                .count(),
            3
        );

        // Remove step at index 1
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(1),
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify result
        assert_eq!(result.id, id);
        assert_eq!(result.removed_count, 1);
        assert_eq!(result.section_type, Some(SectionType::Step));
        assert!(!result.removed_all);

        // Verify the step is removed
        let task = services.tasks().get_task(&id).await.unwrap();
        let steps: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::Step)
            .collect();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].content, "Step one");
        assert_eq!(steps[1].content, "Step three");
    }

    #[tokio::test]
    async fn test_remove_section_by_ordinal_first() {
        let services = mock_services();
        let id = create_task(&services, "Task with constraints").await;

        // Add three constraints
        for constraint in ["First constraint", "Second constraint", "Third constraint"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Constraint,
                content: constraint.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Remove constraint at index 0
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Constraint),
            index: Some(0),
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 1);

        // Verify correct constraint was removed
        let task = services.tasks().get_task(&id).await.unwrap();
        let constraints: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::Constraint)
            .collect();
        assert_eq!(constraints.len(), 2);
        assert_eq!(constraints[0].content, "Second constraint");
        assert_eq!(constraints[1].content, "Third constraint");
    }

    #[tokio::test]
    async fn test_remove_section_by_ordinal_last() {
        let services = mock_services();
        let id = create_task(&services, "Task with testing criteria").await;

        // Add three testing criteria
        for criterion in ["First test", "Second test", "Third test"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::TestingCriterion,
                content: criterion.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Remove testing criterion at index 2 (last)
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::TestingCriterion),
            index: Some(2),
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 1);

        // Verify correct criterion was removed
        let task = services.tasks().get_task(&id).await.unwrap();
        let criteria: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::TestingCriterion)
            .collect();
        assert_eq!(criteria.len(), 2);
        assert_eq!(criteria[0].content, "First test");
        assert_eq!(criteria[1].content, "Second test");
    }

    #[tokio::test]
    async fn test_remove_single_instance_section() {
        let services = mock_services();
        let id = create_task(&services, "Task with goal").await;

        // Add goal (single-instance type)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Achieve something".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Verify goal exists
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(
            task.sections
                .iter()
                .filter(|s| s.section_type == SectionType::Goal)
                .count(),
            1
        );

        // Remove goal without specifying index
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 1);
        assert_eq!(result.section_type, Some(SectionType::Goal));

        // Verify goal is removed
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(
            task.sections
                .iter()
                .filter(|s| s.section_type == SectionType::Goal)
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn test_remove_single_instance_section_context() {
        let services = mock_services();
        let id = create_task(&services, "Task with context").await;

        // Add context (single-instance type)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Context,
            content: "Important background".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Remove context
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Context),
            index: None,
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 1);
        assert_eq!(result.section_type, Some(SectionType::Context));

        // Verify context is removed
        let task = services.tasks().get_task(&id).await.unwrap();
        assert!(
            !task
                .sections
                .iter()
                .any(|s| s.section_type == SectionType::Context)
        );
    }

    #[tokio::test]
    async fn test_remove_all_sections_of_type() {
        let services = mock_services();
        let id = create_task(&services, "Task with steps").await;

        // Add multiple steps
        for step in ["Step 1", "Step 2", "Step 3", "Step 4"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Step,
                content: step.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Add a goal to verify it's not removed
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Complete all steps".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Verify 4 steps and 1 goal exist
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(
            task.sections
                .iter()
                .filter(|s| s.section_type == SectionType::Step)
                .count(),
            4
        );

        // Remove all steps
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: None,
            all: true,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 4);
        assert_eq!(result.section_type, Some(SectionType::Step));
        assert!(result.removed_all);

        // Verify all steps are removed but goal remains
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(
            task.sections
                .iter()
                .filter(|s| s.section_type == SectionType::Step)
                .count(),
            0
        );
        assert_eq!(
            task.sections
                .iter()
                .filter(|s| s.section_type == SectionType::Goal)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn test_remove_all_sections_from_task() {
        let services = mock_services();
        let id = create_task(&services, "Task with many sections").await;

        // Add various sections
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Goal".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Step,
            content: "Step 1".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Constraint,
            content: "Constraint".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Verify sections exist
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 3);

        // Remove all sections
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: None,
            index: None,
            all: true,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 3);
        assert_eq!(result.section_type, None);
        assert!(result.removed_all);

        // Verify all sections are removed
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 0);
    }

    #[tokio::test]
    async fn test_remove_with_invalid_ordinal() {
        let services = mock_services();
        let id = create_task(&services, "Task with steps").await;

        // Add one step
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Step,
            content: "Step 1".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Try to remove non-existent step at index 5
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(5),
            all: false,
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("not found")
                || err.to_string().to_lowercase().contains("index")
        );
    }

    #[tokio::test]
    async fn test_remove_section_with_nonexistent_task() {
        let services = mock_services();

        let cmd = UnsectionCommand {
            id: "nonexistent_task".to_string(),
            section_type: Some(SectionType::Step),
            index: Some(0),
            all: false,
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().to_lowercase().contains("not found"));
    }

    #[tokio::test]
    async fn test_remove_nonexistent_section_type() {
        let services = mock_services();
        let id = create_task(&services, "Task with goal").await;

        // Add only a goal
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Some goal".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Try to remove a step (which doesn't exist)
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(0),
            all: false,
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_remove_nonexistent_section_type_with_all_flag() {
        let services = mock_services();
        let id = create_task(&services, "Task with goal").await;

        // Add only a goal
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Some goal".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Try to remove all steps (which don't exist)
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: None,
            all: true,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Should succeed with 0 removed
        assert_eq!(result.removed_count, 0);
        assert_eq!(result.section_type, Some(SectionType::Step));
        assert!(result.removed_all);
    }

    #[tokio::test]
    async fn test_remove_multi_instance_without_index_or_all_fails() {
        let services = mock_services();
        let id = create_task(&services, "Task with steps").await;

        // Add a step
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Step,
            content: "Step 1".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Try to remove without index or --all (should fail for multi-instance)
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: None,
            all: false,
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("index")
                || err.to_string().to_lowercase().contains("--index")
        );
    }

    #[tokio::test]
    async fn test_remove_from_task_with_no_sections() {
        let services = mock_services();
        let id = create_task(&services, "Empty task").await;

        // Try to remove from empty task with --all
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: None,
            index: None,
            all: true,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 0);
        assert_eq!(result.section_type, None);
        assert!(result.removed_all);
    }

    #[tokio::test]
    async fn test_remove_section_case_insensitive_task_id() {
        let services = mock_services();
        let id = create_task(&services, "Task for case test").await;

        // Add a step
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Step,
            content: "Test step".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Verify step exists
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 1);

        // Remove using uppercase ID
        let upper_id = id.to_uppercase();
        let cmd = UnsectionCommand {
            id: upper_id,
            section_type: Some(SectionType::Step),
            index: Some(0),
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 1);

        // Verify section is actually removed
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 0);
    }

    #[tokio::test]
    async fn test_remove_and_verify_other_sections_intact() {
        let services = mock_services();
        let id = create_task(&services, "Task with multiple types").await;

        // Add goal
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Achieve goal".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add steps
        for step in ["Step 1", "Step 2"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Step,
                content: step.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Add constraints
        for constraint in ["Constraint 1", "Constraint 2"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Constraint,
                content: constraint.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Verify initial state
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 5);

        // Remove step at index 0
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(0),
            all: false,
        };
        cmd.execute(&services).await.unwrap();

        // Verify only step was removed, others intact
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 4);

        // Verify goal is still there
        assert!(
            task.sections
                .iter()
                .any(|s| s.section_type == SectionType::Goal && s.content == "Achieve goal")
        );

        // Verify remaining step is correct
        let steps: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::Step)
            .collect();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].content, "Step 2");

        // Verify constraints are intact
        let constraints: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::Constraint)
            .collect();
        assert_eq!(constraints.len(), 2);
        assert_eq!(constraints[0].content, "Constraint 1");
        assert_eq!(constraints[1].content, "Constraint 2");
    }

    #[tokio::test]
    async fn test_remove_sections_sequentially() {
        let services = mock_services();
        let id = create_task(&services, "Task for sequential removal").await;

        // Add four steps
        for step in ["A", "B", "C", "D"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Step,
                content: step.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Remove step at index 1 (B)
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(1),
            all: false,
        };
        cmd.execute(&services).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        let steps: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::Step)
            .collect();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].content, "A");
        assert_eq!(steps[1].content, "C");
        assert_eq!(steps[2].content, "D");

        // Remove step at index 0 (A)
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(0),
            all: false,
        };
        cmd.execute(&services).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        let steps: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::Step)
            .collect();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].content, "C");
        assert_eq!(steps[1].content, "D");
    }

    #[tokio::test]
    async fn test_remove_all_of_one_type_with_multiple_types_present() {
        let services = mock_services();
        let id = create_task(&services, "Task with mixed sections").await;

        // Add steps
        for step in ["Step 1", "Step 2", "Step 3"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Step,
                content: step.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Add constraints
        for constraint in ["Constraint 1", "Constraint 2"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Constraint,
                content: constraint.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Add goal
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Goal".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Verify initial state
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 6);

        // Remove all steps
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: None,
            all: true,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.removed_count, 3);

        // Verify steps are removed but others remain
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 3);
        assert!(
            !task
                .sections
                .iter()
                .any(|s| s.section_type == SectionType::Step)
        );
        assert_eq!(
            task.sections
                .iter()
                .filter(|s| s.section_type == SectionType::Constraint)
                .count(),
            2
        );
        assert_eq!(
            task.sections
                .iter()
                .filter(|s| s.section_type == SectionType::Goal)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn test_remove_returns_correct_message_single_removal() {
        let services = mock_services();
        let id = create_task(&services, "Task for message test").await;

        // Add step
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Step,
            content: "Test".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Remove it
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(0),
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify message format
        let message = format!("{}", result);
        assert!(message.contains("Removed") || message.contains("removed"));
        assert!(message.contains(&id));
    }

    #[tokio::test]
    async fn test_remove_returns_correct_message_multiple_removals() {
        let services = mock_services();
        let id = create_task(&services, "Task for message test").await;

        // Add multiple constraints
        for constraint in ["C1", "C2", "C3"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Constraint,
                content: constraint.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Remove all
        let cmd = UnsectionCommand {
            id: id.clone(),
            section_type: Some(SectionType::Constraint),
            index: None,
            all: true,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify message mentions multiple
        let message = format!("{}", result);
        assert!(message.contains("Removed") || message.contains("removed"));
        assert!(message.contains("3"));
    }
}
