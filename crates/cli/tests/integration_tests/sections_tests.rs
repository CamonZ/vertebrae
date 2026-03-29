//! Integration tests for the `sections` command
//!
//! Tests listing sections for tasks, including:
//! - Listing all sections with multiple section types
//! - Listing sections when task has no sections
//! - Filtering by section type
//! - Handling nonexistent tasks
//! - Verifying actual section content, types, and ordinals

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
        track: None,
        workflow: None,
    };
    cmd.execute(services).await.unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_sections_with_multiple_types() {
        let services = mock_services();
        let id = create_task(&services, "Task with sections").await;

        // Add goal (single-instance, positive space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Implement login feature".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add context (single-instance, positive space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Context,
            content: "User needs secure authentication".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add steps (multi-instance, positive space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "Create login endpoint".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "Implement JWT validation".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "Add rate limiting".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add testing criterion (multi-instance, positive space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::TestingCriterion,
            content: "Valid credentials return JWT token".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::TestingCriterion,
            content: "Invalid credentials return 401".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add constraint (multi-instance, negative space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Constraint,
            content: "Must use bcrypt for password hashing".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add anti-pattern (multi-instance, negative space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::AntiPattern,
            content: "Do not store plaintext passwords".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Execute sections command
        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: None,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify all sections are present
        assert_eq!(result.sections.len(), 9);
        assert_eq!(result.id, id);
        assert_eq!(result.filter_type, None);

        // Verify each section type is present
        assert!(
            result
                .sections
                .iter()
                .any(|s| s.section_type == SectionType::Goal)
        );
        assert!(
            result
                .sections
                .iter()
                .any(|s| s.section_type == SectionType::Context)
        );
        assert_eq!(
            result
                .sections
                .iter()
                .filter(|s| s.section_type == SectionType::ChecklistItem)
                .count(),
            3
        );
        assert_eq!(
            result
                .sections
                .iter()
                .filter(|s| s.section_type == SectionType::TestingCriterion)
                .count(),
            2
        );
        assert!(
            result
                .sections
                .iter()
                .any(|s| s.section_type == SectionType::Constraint)
        );
        assert!(
            result
                .sections
                .iter()
                .any(|s| s.section_type == SectionType::AntiPattern)
        );

        // Verify content
        let goal = result
            .sections
            .iter()
            .find(|s| s.section_type == SectionType::Goal)
            .unwrap();
        assert_eq!(goal.content, "Implement login feature");

        let context = result
            .sections
            .iter()
            .find(|s| s.section_type == SectionType::Context)
            .unwrap();
        assert_eq!(context.content, "User needs secure authentication");

        // Verify steps are in order
        let steps: Vec<_> = result
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::ChecklistItem)
            .collect();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].order, Some(0));
        assert_eq!(steps[1].order, Some(1));
        assert_eq!(steps[2].order, Some(2));
        assert_eq!(steps[0].content, "Create login endpoint");
        assert_eq!(steps[1].content, "Implement JWT validation");
        assert_eq!(steps[2].content, "Add rate limiting");

        // Verify testing criteria
        let criteria: Vec<_> = result
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::TestingCriterion)
            .collect();
        assert_eq!(criteria.len(), 2);
        assert_eq!(criteria[0].content, "Valid credentials return JWT token");
        assert_eq!(criteria[1].content, "Invalid credentials return 401");
    }

    #[tokio::test]
    async fn test_sections_when_task_has_no_sections() {
        let services = mock_services();
        let id = create_task(&services, "Task with no sections").await;

        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: None,
        };
        let result = cmd.execute(&services).await.unwrap();

        assert_eq!(result.sections.len(), 0);
        assert_eq!(result.id, id);
        assert_eq!(result.filter_type, None);
    }

    #[tokio::test]
    async fn test_sections_filter_by_type_step() {
        let services = mock_services();
        let id = create_task(&services, "Task with steps and goals").await;

        // Add goal
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Complete the feature".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add steps
        for step in ["Step one", "Step two", "Step three"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::ChecklistItem,
                content: step.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Add constraint
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Constraint,
            content: "No external dependencies".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Filter by step type
        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: Some(SectionType::ChecklistItem),
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify only steps are returned
        assert_eq!(result.sections.len(), 3);
        assert_eq!(result.filter_type, Some(SectionType::ChecklistItem));
        assert!(
            result
                .sections
                .iter()
                .all(|s| s.section_type == SectionType::ChecklistItem)
        );

        // Verify content and order
        assert_eq!(result.sections[0].content, "Step one");
        assert_eq!(result.sections[1].content, "Step two");
        assert_eq!(result.sections[2].content, "Step three");
        assert_eq!(result.sections[0].order, Some(0));
        assert_eq!(result.sections[1].order, Some(1));
        assert_eq!(result.sections[2].order, Some(2));
    }

    #[tokio::test]
    async fn test_sections_filter_by_type_constraint() {
        let services = mock_services();
        let id = create_task(&services, "Task with constraints").await;

        // Add multiple constraints
        for constraint in [
            "Must use Rust",
            "Must be async",
            "Must have 95% test coverage",
        ] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::Constraint,
                content: constraint.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Add a step to verify filtering works
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "Implement feature".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Filter by constraint type
        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: Some(SectionType::Constraint),
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify only constraints are returned
        assert_eq!(result.sections.len(), 3);
        assert_eq!(result.filter_type, Some(SectionType::Constraint));
        assert!(
            result
                .sections
                .iter()
                .all(|s| s.section_type == SectionType::Constraint)
        );

        // Verify content
        assert_eq!(result.sections[0].content, "Must use Rust");
        assert_eq!(result.sections[1].content, "Must be async");
        assert_eq!(result.sections[2].content, "Must have 95% test coverage");
    }

    #[tokio::test]
    async fn test_sections_filter_by_single_instance_type() {
        let services = mock_services();
        let id = create_task(&services, "Task with goal").await;

        // Add goal
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Achieve world peace".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add steps
        for step in ["Step 1", "Step 2"] {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: SectionType::ChecklistItem,
                content: step.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Filter by goal type (single-instance)
        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: Some(SectionType::Goal),
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify only goal is returned
        assert_eq!(result.sections.len(), 1);
        assert_eq!(result.filter_type, Some(SectionType::Goal));
        assert_eq!(result.sections[0].section_type, SectionType::Goal);
        assert_eq!(result.sections[0].content, "Achieve world peace");
        assert_eq!(result.sections[0].order, None);
    }

    #[tokio::test]
    async fn test_sections_filter_returns_empty_when_no_match() {
        let services = mock_services();
        let id = create_task(&services, "Task with no testing criteria").await;

        // Add only a goal
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Do something".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Filter by testing criterion (which doesn't exist)
        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: Some(SectionType::TestingCriterion),
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify no sections are returned
        assert_eq!(result.sections.len(), 0);
        assert_eq!(result.filter_type, Some(SectionType::TestingCriterion));
    }

    #[tokio::test]
    async fn test_sections_with_nonexistent_task() {
        let services = mock_services();

        let cmd = SectionsCommand {
            id: "nonexistent_task".to_string(),
            section_type: None,
        };
        let result = cmd.execute(&services).await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().to_lowercase().contains("not found"));
    }

    #[tokio::test]
    async fn test_sections_case_insensitive_task_id() {
        let services = mock_services();
        let id = create_task(&services, "Task for case test").await;

        // Add a section
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Test case sensitivity".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Query with different case
        let upper_id = id.to_uppercase();
        let cmd = SectionsCommand {
            id: upper_id.clone(),
            section_type: None,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Should still find the sections (case-insensitive lookup)
        assert_eq!(result.sections.len(), 1);
        assert_eq!(result.sections[0].content, "Test case sensitivity");
    }

    #[tokio::test]
    async fn test_sections_sorting_positive_space_first() {
        let services = mock_services();
        let id = create_task(&services, "Task for sorting test").await;

        // Add sections in mixed order
        // First add a constraint (negative space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Constraint,
            content: "Constraint first".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add goal (positive space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Goal second".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add anti-pattern (negative space)
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::AntiPattern,
            content: "Anti-pattern third".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Execute sections command
        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: None,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify positive space comes before negative space
        // And within negative space, types are sorted by their sort order
        // (AntiPattern=6 comes before Constraint=8)
        assert_eq!(result.sections.len(), 3);
        assert_eq!(result.sections[0].section_type, SectionType::Goal);
        assert_eq!(result.sections[1].section_type, SectionType::AntiPattern);
        assert_eq!(result.sections[2].section_type, SectionType::Constraint);
    }

    #[tokio::test]
    async fn test_sections_with_mixed_positive_and_negative_space() {
        let services = mock_services();
        let id = create_task(&services, "Task with mixed sections").await;

        // Add various positive space sections
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Implement feature".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "Step 1".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Add negative space sections
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Constraint,
            content: "Constraint 1".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::FailureTest,
            content: "Failure test 1".to_string(),
        };
        cmd.execute(&services).await.unwrap();

        // Execute sections command
        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: None,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify correct grouping: positive space first, then negative
        assert_eq!(result.sections.len(), 4);

        // Positive space sections come first
        let positive_indices: Vec<_> = result
            .sections
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                matches!(
                    s.section_type,
                    SectionType::Goal
                        | SectionType::Context
                        | SectionType::CurrentBehavior
                        | SectionType::DesiredBehavior
                        | SectionType::ChecklistItem
                        | SectionType::TestingCriterion
                )
            })
            .map(|(i, _)| i)
            .collect();

        let negative_indices: Vec<_> = result
            .sections
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                matches!(
                    s.section_type,
                    SectionType::AntiPattern | SectionType::FailureTest | SectionType::Constraint
                )
            })
            .map(|(i, _)| i)
            .collect();

        // All positive indices should be less than all negative indices
        for &pos in &positive_indices {
            for &neg in &negative_indices {
                assert!(
                    pos < neg,
                    "Positive space should come before negative space"
                );
            }
        }
    }

    #[tokio::test]
    async fn test_sections_with_all_nine_types() {
        let services = mock_services();
        let id = create_task(&services, "Task with all section types").await;

        let all_types = vec![
            (SectionType::Goal, "Goal content"),
            (SectionType::Context, "Context content"),
            (SectionType::CurrentBehavior, "Current behavior content"),
            (SectionType::DesiredBehavior, "Desired behavior content"),
            (SectionType::ChecklistItem, "Step content"),
            (SectionType::TestingCriterion, "Testing criterion content"),
            (SectionType::AntiPattern, "Anti-pattern content"),
            (SectionType::FailureTest, "Failure test content"),
            (SectionType::Constraint, "Constraint content"),
        ];

        // Add all types
        for (section_type, content) in &all_types {
            let cmd = SectionCommand {
                id: id.clone(),
                section_type: section_type.clone(),
                content: content.to_string(),
            };
            cmd.execute(&services).await.unwrap();
        }

        // Get all sections
        let cmd = SectionsCommand {
            id: id.clone(),
            section_type: None,
        };
        let result = cmd.execute(&services).await.unwrap();

        // Verify we have all 9 sections
        assert_eq!(result.sections.len(), 9);

        // Verify each type is present with correct content
        for (section_type, content) in &all_types {
            let found = result
                .sections
                .iter()
                .find(|s| &s.section_type == section_type);
            assert!(found.is_some(), "Section type {:?} not found", section_type);
            assert_eq!(found.unwrap().content, *content);
        }
    }
}
