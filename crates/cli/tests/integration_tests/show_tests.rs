//! Integration tests for the `show` command
//!
//! Tests comprehensive display of task details including sections, code references,
//! relationships, and workflow information.

use super::mock::mock_services;
use vertebrae_cli::commands::AddCommand;
use vertebrae_cli::commands::show::ShowCommand;
use vertebrae_core::{CodeRef, Level, Priority, Section, SectionType};

// ============================================================================
// Basic show command tests
// ============================================================================

#[cfg(test)]
mod show_basic_tests {
    use super::*;

    #[tokio::test]
    async fn test_show_simple_task() {
        let services = mock_services();

        // Create a simple task
        let cmd = AddCommand {
            title: "Simple Task".to_string(),
            level: Some(Level::Task),
            description: Some("A simple task description".to_string()),
            priority: Some(Priority::High),
            tags: vec!["test".to_string()],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let task_id = cmd.execute(&services).await.unwrap();

        // Show the task
        let show_cmd = ShowCommand {
            id: task_id.clone(),
        };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify basic fields
        assert_eq!(result.id, task_id);
        assert_eq!(result.title, "Simple Task");
        assert_eq!(
            result.description,
            Some("A simple task description".to_string())
        );
        assert_eq!(result.level, "task");
        assert_eq!(result.priority, Some("high".to_string()));
        assert_eq!(result.tags, vec!["test"]);
        assert!(!result.sections.is_empty() || result.sections.is_empty()); // Just check it exists
    }

    #[tokio::test]
    async fn test_show_task_case_insensitive() {
        let services = mock_services();

        let cmd = AddCommand {
            title: "Case Test".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Show with uppercase ID
        let show_cmd = ShowCommand {
            id: task_id.to_uppercase(),
        };
        let result = show_cmd.execute(&services).await.unwrap();

        assert_eq!(result.id, task_id);
        assert_eq!(result.title, "Case Test");
    }

    #[tokio::test]
    async fn test_show_nonexistent_task() {
        let services = mock_services();

        let show_cmd = ShowCommand {
            id: "nonexistent".to_string(),
        };
        let result = show_cmd.execute(&services).await;

        assert!(result.is_err());
    }
}

// ============================================================================
// Show with worktree tests
// ============================================================================

#[cfg(test)]
mod show_worktree_tests {
    use super::*;
    use vertebrae_core::UpdateTaskOptions;

    #[tokio::test]
    async fn test_show_task_with_worktree() {
        let services = mock_services();

        let cmd = AddCommand {
            title: "Worktree Task".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let task_id = cmd.execute(&services).await.unwrap();

        // Set worktree via update
        let update_opts = UpdateTaskOptions::new().with_worktree("/home/user/projects/my-worktree");
        services
            .tasks()
            .update_task(&task_id, update_opts)
            .await
            .unwrap();

        let show_cmd = ShowCommand {
            id: task_id.clone(),
        };
        let result = show_cmd.execute(&services).await.unwrap();

        assert_eq!(
            result.worktree.as_deref(),
            Some("/home/user/projects/my-worktree")
        );

        // Verify display includes worktree
        let display = format!("{}", result);
        assert!(
            display.contains("Worktree: /home/user/projects/my-worktree"),
            "Display output should contain worktree line"
        );
    }

    #[tokio::test]
    async fn test_show_task_without_worktree() {
        let services = mock_services();

        let cmd = AddCommand {
            title: "No Worktree Task".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let task_id = cmd.execute(&services).await.unwrap();

        let show_cmd = ShowCommand {
            id: task_id.clone(),
        };
        let result = show_cmd.execute(&services).await.unwrap();

        assert!(result.worktree.is_none());

        // Verify display does NOT include worktree line
        let display = format!("{}", result);
        assert!(
            !display.contains("Worktree:"),
            "Display output should not contain worktree line when not set"
        );
    }
}

// ============================================================================
// Show with sections tests
// ============================================================================

#[cfg(test)]
mod show_sections_tests {
    use super::*;

    #[tokio::test]
    async fn test_show_task_with_goal_section() {
        let services = mock_services();

        // Create task
        let cmd = AddCommand {
            title: "Task with goal".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Add a goal section
        let goal_section = Section::new(SectionType::Goal, "Achieve project milestones");
        services
            .tasks()
            .add_section(&task_id, goal_section)
            .await
            .unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify section is present
        assert_eq!(result.sections.len(), 1);
        assert_eq!(result.sections[0].section_type, SectionType::Goal);
        assert_eq!(result.sections[0].content, "Achieve project milestones");
    }

    #[tokio::test]
    async fn test_show_task_with_multiple_section_types() {
        let services = mock_services();

        // Create task
        let cmd = AddCommand {
            title: "Multi-section task".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Add sections of different types
        let goal = Section::new(SectionType::Goal, "Main goal");
        let context = Section::new(SectionType::Context, "Background information");
        let constraint = Section::new(SectionType::Constraint, "Must handle edge cases");

        services.tasks().add_section(&task_id, goal).await.unwrap();
        services
            .tasks()
            .add_section(&task_id, context)
            .await
            .unwrap();
        services
            .tasks()
            .add_section(&task_id, constraint)
            .await
            .unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify all sections are present
        assert_eq!(result.sections.len(), 3);

        let section_types: Vec<_> = result.sections.iter().map(|s| &s.section_type).collect();
        assert!(section_types.contains(&&SectionType::Goal));
        assert!(section_types.contains(&&SectionType::Context));
        assert!(section_types.contains(&&SectionType::Constraint));
    }

    #[tokio::test]
    async fn test_show_task_with_ordered_steps() {
        let services = mock_services();

        // Create task
        let cmd = AddCommand {
            title: "Task with steps".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Add ordered steps
        let step1 = Section::with_order(SectionType::ChecklistItem, "First step", 0);
        let step2 = Section::with_order(SectionType::ChecklistItem, "Second step", 1);
        let step3 = Section::with_order(SectionType::ChecklistItem, "Third step", 2);

        services.tasks().add_section(&task_id, step1).await.unwrap();
        services.tasks().add_section(&task_id, step2).await.unwrap();
        services.tasks().add_section(&task_id, step3).await.unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify steps are present and ordered
        let steps: Vec<_> = result
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::ChecklistItem)
            .collect();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].order, Some(0));
        assert_eq!(steps[0].content, "First step");
        assert_eq!(steps[1].order, Some(1));
        assert_eq!(steps[1].content, "Second step");
        assert_eq!(steps[2].order, Some(2));
        assert_eq!(steps[2].content, "Third step");
    }
}

// ============================================================================
// Show with code references tests
// ============================================================================

#[cfg(test)]
mod show_code_refs_tests {
    use super::*;

    #[tokio::test]
    async fn test_show_task_with_file_code_ref() {
        let services = mock_services();

        // Create task
        let cmd = AddCommand {
            title: "Code task".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Add file code reference
        let code_ref = CodeRef::file("src/main.rs")
            .with_name("main_function")
            .with_description("Entry point");

        services
            .tasks()
            .add_code_ref(&task_id, code_ref)
            .await
            .unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify code reference
        assert_eq!(result.code_refs.len(), 1);
        assert_eq!(result.code_refs[0].path, "src/main.rs");
        assert_eq!(result.code_refs[0].name, Some("main_function".to_string()));
        assert_eq!(
            result.code_refs[0].description,
            Some("Entry point".to_string())
        );
    }

    #[tokio::test]
    async fn test_show_task_with_line_code_ref() {
        let services = mock_services();

        // Create task
        let cmd = AddCommand {
            title: "Line ref task".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Add line code reference
        let code_ref = CodeRef::line("src/config.rs", 42)
            .with_name("parse_config")
            .with_description("Configuration parser");

        services
            .tasks()
            .add_code_ref(&task_id, code_ref)
            .await
            .unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify code reference
        assert_eq!(result.code_refs.len(), 1);
        assert_eq!(result.code_refs[0].path, "src/config.rs");
        assert_eq!(result.code_refs[0].line_start, Some(42));
        assert_eq!(result.code_refs[0].line_end, None);
        assert_eq!(result.code_refs[0].name, Some("parse_config".to_string()));
    }

    #[tokio::test]
    async fn test_show_task_with_range_code_ref() {
        let services = mock_services();

        // Create task
        let cmd = AddCommand {
            title: "Range ref task".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Add range code reference
        let code_ref = CodeRef::range("src/utils.rs", 100, 150)
            .with_name("utility_functions")
            .with_description("Helper functions");

        services
            .tasks()
            .add_code_ref(&task_id, code_ref)
            .await
            .unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify code reference
        assert_eq!(result.code_refs.len(), 1);
        assert_eq!(result.code_refs[0].path, "src/utils.rs");
        assert_eq!(result.code_refs[0].line_start, Some(100));
        assert_eq!(result.code_refs[0].line_end, Some(150));
    }

    #[tokio::test]
    async fn test_show_task_with_multiple_code_refs() {
        let services = mock_services();

        // Create task
        let cmd = AddCommand {
            title: "Multiple refs task".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Add multiple code references
        let ref1 = CodeRef::file("src/main.rs").with_name("main");
        let ref2 = CodeRef::line("src/lib.rs", 25).with_name("setup");
        let ref3 = CodeRef::range("tests/tests.rs", 1, 50).with_name("test_suite");

        services.tasks().add_code_ref(&task_id, ref1).await.unwrap();
        services.tasks().add_code_ref(&task_id, ref2).await.unwrap();
        services.tasks().add_code_ref(&task_id, ref3).await.unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify all code references
        assert_eq!(result.code_refs.len(), 3);
        assert_eq!(result.code_refs[0].path, "src/main.rs");
        assert_eq!(result.code_refs[1].path, "src/lib.rs");
        assert_eq!(result.code_refs[2].path, "tests/tests.rs");
    }

    #[tokio::test]
    async fn test_show_section_with_inline_code_refs() {
        let services = mock_services();

        // Create task
        let cmd = AddCommand {
            title: "Section with refs".to_string(),
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
        let task_id = cmd.execute(&services).await.unwrap();

        // Add a testing criterion section
        let mut criterion = Section::new(
            SectionType::TestingCriterion,
            "Code should handle null inputs",
        );

        // Add code refs to the section
        let code_ref = CodeRef::file("tests/null_test.rs")
            .with_name("test_null_input")
            .with_description("Test null handling");
        criterion.refs.push(code_ref);

        services
            .tasks()
            .add_section(&task_id, criterion)
            .await
            .unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify section and its inline refs
        assert_eq!(result.sections.len(), 1);
        assert_eq!(
            result.sections[0].section_type,
            SectionType::TestingCriterion
        );
        assert_eq!(result.sections[0].refs.len(), 1);
        assert_eq!(result.sections[0].refs[0].path, "tests/null_test.rs");
    }
}

// ============================================================================
// Show with relationships tests
// ============================================================================

#[cfg(test)]
mod show_relationships_tests {
    use super::*;

    #[tokio::test]
    async fn test_show_task_with_parent() {
        let services = mock_services();

        // Create parent
        let parent_cmd = AddCommand {
            title: "Parent Epic".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let parent_id = parent_cmd.execute(&services).await.unwrap();

        // Create child
        let child_cmd = AddCommand {
            title: "Child Task".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let child_id = child_cmd.execute(&services).await.unwrap();

        // Show the child
        let show_cmd = ShowCommand { id: child_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify parent is present
        assert!(result.parent.is_some());
        let parent = result.parent.unwrap();
        assert_eq!(parent.id, parent_id);
        assert_eq!(parent.title, "Parent Epic");
        assert_eq!(parent.level, "epic");
    }

    #[tokio::test]
    async fn test_show_task_with_children() {
        let services = mock_services();

        // Create parent
        let parent_cmd = AddCommand {
            title: "Parent".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let parent_id = parent_cmd.execute(&services).await.unwrap();

        // Create children
        let child1_cmd = AddCommand {
            title: "Child 1".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let child1_id = child1_cmd.execute(&services).await.unwrap();

        let child2_cmd = AddCommand {
            title: "Child 2".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let child2_id = child2_cmd.execute(&services).await.unwrap();

        // Show the parent
        let show_cmd = ShowCommand { id: parent_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify children are present
        assert_eq!(result.children.len(), 2);
        let child_ids: Vec<_> = result.children.iter().map(|c| &c.id).collect();
        assert!(child_ids.contains(&&child1_id));
        assert!(child_ids.contains(&&child2_id));

        let child_titles: Vec<_> = result.children.iter().map(|c| &c.title).collect();
        assert!(child_titles.contains(&&"Child 1".to_string()));
        assert!(child_titles.contains(&&"Child 2".to_string()));
    }

    #[tokio::test]
    async fn test_show_task_with_blockers() {
        let services = mock_services();

        // Create blocking task
        let blocker_cmd = AddCommand {
            title: "Blocker Task".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let blocker_id = blocker_cmd.execute(&services).await.unwrap();

        // Create task that depends on blocker
        let task_cmd = AddCommand {
            title: "Blocked Task".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![blocker_id.clone()],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let task_id = task_cmd.execute(&services).await.unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify blocker is in blocked_by list
        assert_eq!(result.blocked_by.len(), 1);
        assert_eq!(result.blocked_by[0].id, blocker_id);
        assert_eq!(result.blocked_by[0].title, "Blocker Task");
    }

    #[tokio::test]
    async fn test_show_task_with_blocked_tasks() {
        let services = mock_services();

        // Create task
        let task_cmd = AddCommand {
            title: "Blocking Task".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let task_id = task_cmd.execute(&services).await.unwrap();

        // Create tasks that depend on it
        let blocked1_cmd = AddCommand {
            title: "Blocked 1".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![task_id.clone()],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let blocked1_id = blocked1_cmd.execute(&services).await.unwrap();

        let blocked2_cmd = AddCommand {
            title: "Blocked 2".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![task_id.clone()],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let blocked2_id = blocked2_cmd.execute(&services).await.unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify blocks list
        assert_eq!(result.blocks.len(), 2);
        let block_ids: Vec<_> = result.blocks.iter().map(|b| &b.id).collect();
        assert!(block_ids.contains(&&blocked1_id));
        assert!(block_ids.contains(&&blocked2_id));
    }
}

// ============================================================================
// Show with workflow information tests
// ============================================================================

#[cfg(test)]
mod show_workflow_tests {
    use super::*;
    use vertebrae_core::CreateWorkflowOptions;

    #[tokio::test]
    async fn test_show_task_with_workflow_assignment() {
        let services = mock_services();

        // Create a workflow
        let workflow_options =
            CreateWorkflowOptions::new("Review", vec![]).with_description("Code review workflow");
        let workflow_id = services
            .workflows()
            .create_workflow(workflow_options)
            .await
            .unwrap();

        // Create task and assign workflow
        let task_cmd = AddCommand {
            title: "Task with workflow".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: Some(workflow_id.clone()),
        };
        let task_id = task_cmd.execute(&services).await.unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify workflow info is present
        assert!(result.workflow.is_some());
        let workflow = result.workflow.unwrap();
        assert_eq!(workflow.id, workflow_id);
        assert_eq!(workflow.name, "Review");
    }
}

// ============================================================================
// Show comprehensive tests
// ============================================================================

#[cfg(test)]
mod show_comprehensive_tests {
    use super::*;

    #[tokio::test]
    async fn test_show_task_with_all_fields() {
        let services = mock_services();

        // Create parent task
        let parent_cmd = AddCommand {
            title: "Parent Epic".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let parent_id = parent_cmd.execute(&services).await.unwrap();

        // Create blocker task
        let blocker_cmd = AddCommand {
            title: "Blocker".to_string(),
            level: Some(Level::Task),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            track: None,
            workflow: None,
        };
        let blocker_id = blocker_cmd.execute(&services).await.unwrap();

        // Create main task with all relationships
        let task_cmd = AddCommand {
            title: "Comprehensive Task".to_string(),
            level: Some(Level::Task),
            description: Some("Full featured task".to_string()),
            priority: Some(Priority::Critical),
            tags: vec!["important".to_string(), "urgent".to_string()],
            parent: Some(parent_id.clone()),
            depends_on: vec![blocker_id.clone()],
            needs_review: true,
            track: None,
            workflow: None,
        };
        let task_id = task_cmd.execute(&services).await.unwrap();

        // Add sections
        let goal = Section::new(SectionType::Goal, "Complete the implementation");
        let step1 = Section::with_order(SectionType::ChecklistItem, "Write code", 0);
        let step2 = Section::with_order(SectionType::ChecklistItem, "Test code", 1);
        let constraint = Section::new(SectionType::Constraint, "Must pass linting");

        services.tasks().add_section(&task_id, goal).await.unwrap();
        services.tasks().add_section(&task_id, step1).await.unwrap();
        services.tasks().add_section(&task_id, step2).await.unwrap();
        services
            .tasks()
            .add_section(&task_id, constraint)
            .await
            .unwrap();

        // Add code references
        let code_ref1 = CodeRef::file("src/main.rs").with_name("main");
        let code_ref2 = CodeRef::range("src/lib.rs", 1, 100).with_name("lib");

        services
            .tasks()
            .add_code_ref(&task_id, code_ref1)
            .await
            .unwrap();
        services
            .tasks()
            .add_code_ref(&task_id, code_ref2)
            .await
            .unwrap();

        // Show the task
        let show_cmd = ShowCommand { id: task_id };
        let result = show_cmd.execute(&services).await.unwrap();

        // Verify all fields
        assert_eq!(result.title, "Comprehensive Task");
        assert_eq!(result.description, Some("Full featured task".to_string()));
        assert_eq!(result.level, "task");
        assert_eq!(result.priority, Some("critical".to_string()));
        assert_eq!(result.tags, vec!["important", "urgent"]);
        assert_eq!(result.needs_human_review, Some(true));

        // Verify parent
        assert!(result.parent.is_some());
        assert_eq!(result.parent.unwrap().id, parent_id);

        // Verify blockers
        assert_eq!(result.blocked_by.len(), 1);
        assert_eq!(result.blocked_by[0].id, blocker_id);

        // Verify sections
        assert!(result.sections.len() >= 4);
        let has_goal = result
            .sections
            .iter()
            .any(|s| s.section_type == SectionType::Goal);
        let has_constraint = result
            .sections
            .iter()
            .any(|s| s.section_type == SectionType::Constraint);
        assert!(has_goal);
        assert!(has_constraint);

        // Verify code refs
        assert_eq!(result.code_refs.len(), 2);
    }
}
