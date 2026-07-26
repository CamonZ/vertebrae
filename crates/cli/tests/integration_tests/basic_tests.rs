//! Integration test suite for Vertebrae CLI
//!
//! Tests CLI command execution against in-memory mock services.
//! Each test creates a fresh `VertebraeServices` via `mock_services()`.

use super::mock::mock_services;
use vertebrae_cli::commands::*;

// ============================================================================
// Lifecycle tests: create, update, delete
// ============================================================================

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[tokio::test]
    async fn test_create_basic_task() {
        let services = mock_services();
        let cmd = AddCommand {
            title: "My first task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let id = cmd.execute(&services).await.unwrap();
        assert!(!id.is_empty());

        // Verify the task exists
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.title, "My first task");
    }

    #[tokio::test]
    async fn test_add_json_returns_structured_task_id_without_output_wrapper() {
        let services = mock_services();
        let command = Command::Add(AddCommand {
            title: "JSON task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        });

        let result = command.execute_json(&services).await.unwrap();
        let CommandResult::Json(json) = result else {
            panic!("add --json should return JSON output");
        };

        assert!(json.get("output").is_none());
        assert_eq!(json["command"], "add");
        assert_eq!(json["status"], "created");
        let task_id = json["task_id"]
            .as_str()
            .expect("task id should be a string");
        assert!(!task_id.is_empty());

        let task = services.tasks().get_task(task_id).await.unwrap();
        assert_eq!(task.title, "JSON task");
    }

    #[tokio::test]
    async fn test_add_human_output_is_unchanged() {
        let services = mock_services();
        let command = Command::Add(AddCommand {
            title: "Human task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        });

        let result = command.execute(&services).await.unwrap();
        let output = result.to_string();

        assert!(output.starts_with("Created task: "));
        assert!(!output.strip_prefix("Created task: ").unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_show_json_returns_domain_data_without_output_wrapper() {
        let services = mock_services();
        let add = AddCommand {
            title: "Readable task".to_string(),
            level: None,
            description: Some("Structured detail".to_string()),
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let task_id = add.execute(&services).await.unwrap();

        let command = Command::Show(ShowCommand {
            id: task_id.clone(),
        });
        let result = command.execute_json(&services).await.unwrap();
        let CommandResult::Json(json) = result else {
            panic!("show --json should return JSON output");
        };

        assert!(json.get("output").is_none());
        assert_eq!(json["id"], task_id);
        assert_eq!(json["title"], "Readable task");
        assert_eq!(json["description"], "Structured detail");
    }

    #[tokio::test]
    async fn test_workflow_list_json_returns_nested_structured_data_without_output_wrapper() {
        let services = mock_services();
        services
            .workflows()
            .create_workflow(vertebrae_core::CreateWorkflowOptions::new(
                "Structured workflow",
                vec![],
            ))
            .await
            .unwrap();

        let command = Command::Workflow(workflow::WorkflowCommand::List(
            workflow::WorkflowListCommand {},
        ));
        let result = command.execute_json(&services).await.unwrap();
        let CommandResult::Json(json) = result else {
            panic!("workflow list --json should return JSON output");
        };

        assert!(json.get("output").is_none());
        let workflows = json.as_array().expect("workflow list should be an array");
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0]["name"], "Structured workflow");
        assert_eq!(workflows[0]["step_count"], 0);
    }

    #[tokio::test]
    async fn test_create_task_with_metadata() {
        let services = mock_services();
        let cmd = AddCommand {
            title: "Epic task".to_string(),
            level: Some(vertebrae_core::Level::Epic),
            description: Some("Detailed description".to_string()),
            priority: Some(vertebrae_core::Priority::High),
            tags: vec!["backend".to_string(), "api".to_string()],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let id = cmd.execute(&services).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.level, vertebrae_core::Level::Epic);
        assert_eq!(task.description, Some("Detailed description".to_string()));
        assert_eq!(task.priority, Some(vertebrae_core::Priority::High));
        assert_eq!(task.tags, vec!["backend", "api"]);
    }

    #[tokio::test]
    async fn test_create_task_with_parent() {
        let services = mock_services();

        // Create parent
        let parent_cmd = AddCommand {
            title: "Parent".to_string(),
            level: Some(vertebrae_core::Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let parent_id = parent_cmd.execute(&services).await.unwrap();

        // Create child
        let child_cmd = AddCommand {
            title: "Child".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            workflow: None,
        };
        let child_id = child_cmd.execute(&services).await.unwrap();

        // Verify parent-child relationship
        let parent = services.tasks().get_parent(&child_id).await.unwrap();
        assert_eq!(parent, Some(parent_id.clone()));

        let children = services.tasks().get_children(&parent_id).await.unwrap();
        assert!(children.contains(&child_id));
    }

    #[tokio::test]
    async fn test_create_task_empty_title_fails() {
        let services = mock_services();
        let cmd = AddCommand {
            title: "   ".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_update_task() {
        let services = mock_services();

        // Create a task
        let add = AddCommand {
            title: "Original".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let id = add.execute(&services).await.unwrap();

        // Update title and priority
        let update = UpdateCommand {
            id: id.clone(),
            title: Some("Updated title".to_string()),
            description: Some("New description".to_string()),
            priority: Some(vertebrae_core::Priority::Critical),
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            worktree: None,
            edit_section: None,
            remove_section: None,
        };
        let updated_id = update.execute(&services).await.unwrap();
        assert_eq!(updated_id, id);

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.title, "Updated title");
        assert_eq!(task.description, Some("New description".to_string()));
        assert_eq!(task.priority, Some(vertebrae_core::Priority::Critical));
    }

    #[tokio::test]
    async fn test_update_nonexistent_task_fails() {
        let services = mock_services();
        let update = UpdateCommand {
            id: "nonexistent".to_string(),
            title: Some("New title".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            worktree: None,
            edit_section: None,
            remove_section: None,
        };
        let result = update.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_task() {
        let services = mock_services();

        let add = AddCommand {
            title: "To delete".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let id = add.execute(&services).await.unwrap();

        // Delete with force (skip confirmation)
        let delete = DeleteCommand {
            id: id.clone(),
            cascade: false,
            force: true,
        };
        delete.execute(&services).await.unwrap();

        // Task should no longer exist
        let result = services.tasks().get_task(&id).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_task_cascade() {
        let services = mock_services();

        // Create parent
        let parent = AddCommand {
            title: "Parent".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let parent_id = parent.execute(&services).await.unwrap();

        // Create child
        let child = AddCommand {
            title: "Child".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            workflow: None,
        };
        let child_id = child.execute(&services).await.unwrap();

        // Delete parent with cascade
        let delete = DeleteCommand {
            id: parent_id.clone(),
            cascade: true,
            force: true,
        };
        delete.execute(&services).await.unwrap();

        // Both should be gone
        assert!(services.tasks().get_task(&parent_id).await.is_err());
        assert!(services.tasks().get_task(&child_id).await.is_err());
    }

    #[tokio::test]
    async fn test_delete_nonexistent_task_fails() {
        let services = mock_services();
        let delete = DeleteCommand {
            id: "nonexistent".to_string(),
            cascade: false,
            force: true,
        };
        let result = delete.execute(&services).await;
        assert!(result.is_err());
    }
}

// ============================================================================
// Query tests: list, show, ready
// ============================================================================

#[cfg(test)]
mod query_tests {
    use super::*;

    #[tokio::test]
    async fn test_list_tasks() {
        let services = mock_services();

        // Create a few tasks
        for title in ["Task A", "Task B", "Task C"] {
            let cmd = AddCommand {
                title: title.to_string(),
                level: None,
                description: None,
                priority: None,
                tags: vec![],
                parent: None,
                depends_on: vec![],
                workflow: None,
            };
            cmd.execute(&services).await.unwrap();
        }

        let list = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            parent: None,
            root: false,
            include_archived: false,
            search: None,
            flat: true,
        };
        let tasks = list.execute(&services).await.unwrap();
        assert_eq!(tasks.len(), 3);
    }

    #[tokio::test]
    async fn test_list_tasks_filters_by_step_id() {
        let services = mock_services();

        // Create three tasks
        let mut ids = Vec::new();
        for title in ["Task A", "Task B", "Task C"] {
            let cmd = AddCommand {
                title: title.to_string(),
                level: None,
                description: None,
                priority: None,
                tags: vec![],
                parent: None,
                depends_on: vec![],
                workflow: None,
            };
            ids.push(cmd.execute(&services).await.unwrap());
        }

        // Place tasks at two different step IDs
        let target_step = "11111111-2222-3333-4444-555555555555";
        let other_step = "99999999-8888-7777-6666-555555555555";
        services
            .tasks()
            .set_current_step(&ids[0], target_step)
            .await
            .unwrap();
        services
            .tasks()
            .set_current_step(&ids[1], target_step)
            .await
            .unwrap();
        services
            .tasks()
            .set_current_step(&ids[2], other_step)
            .await
            .unwrap();

        // Filter by --step <target>
        let list = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: Some(target_step.to_string()),
            parent: None,
            root: false,
            include_archived: false,
            search: None,
            flat: true,
        };
        let tasks = list.execute(&services).await.unwrap();
        assert_eq!(
            tasks.len(),
            2,
            "expected 2 tasks at target step, got {}: {:?}",
            tasks.len(),
            tasks.iter().map(|t| &t.id).collect::<Vec<_>>()
        );
        let returned_ids: Vec<&String> = tasks.iter().map(|t| &t.id).collect();
        assert!(returned_ids.contains(&&ids[0]));
        assert!(returned_ids.contains(&&ids[1]));
        assert!(!returned_ids.contains(&&ids[2]));

        // No --step filter returns all 3
        let list_all = ListCommand {
            levels: vec![],
            statuses: vec![],
            priorities: vec![],
            tags: vec![],
            workflow: None,
            step: None,
            parent: None,
            root: false,
            include_archived: false,
            search: None,
            flat: true,
        };
        let all_tasks = list_all.execute(&services).await.unwrap();
        assert_eq!(all_tasks.len(), 3);
    }

    #[tokio::test]
    async fn test_show_task_details() {
        let services = mock_services();

        let add = AddCommand {
            title: "Detailed task".to_string(),
            level: Some(vertebrae_core::Level::Ticket),
            description: Some("A description".to_string()),
            priority: Some(vertebrae_core::Priority::High),
            tags: vec!["ui".to_string()],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let id = add.execute(&services).await.unwrap();

        let show = ShowCommand { id: id.clone() };
        let detail = show.execute(&services).await.unwrap();

        assert_eq!(detail.id, id);
        assert_eq!(detail.title, "Detailed task");
        assert_eq!(detail.level, "ticket");
        assert_eq!(detail.priority, Some("high".to_string()));
        assert_eq!(detail.tags, vec!["ui"]);
    }

    #[tokio::test]
    async fn test_show_nonexistent_task_fails() {
        let services = mock_services();
        let show = ShowCommand {
            id: "nonexistent".to_string(),
        };
        let result = show.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_show_task_with_relationships() {
        let services = mock_services();

        // Create parent
        let parent_add = AddCommand {
            title: "Parent".to_string(),
            level: Some(vertebrae_core::Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let parent_id = parent_add.execute(&services).await.unwrap();

        // Create child
        let child_add = AddCommand {
            title: "Child".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            workflow: None,
        };
        let child_id = child_add.execute(&services).await.unwrap();

        // Show child - should have parent
        let show = ShowCommand {
            id: child_id.clone(),
        };
        let detail = show.execute(&services).await.unwrap();
        assert!(detail.parent.is_some());
        assert_eq!(detail.parent.unwrap().id, parent_id);

        // Show parent - should have child
        let show_parent = ShowCommand {
            id: parent_id.clone(),
        };
        let parent_detail = show_parent.execute(&services).await.unwrap();
        assert_eq!(parent_detail.children.len(), 1);
        assert_eq!(parent_detail.children[0].id, child_id);
    }

    #[tokio::test]
    async fn test_ready_returns_unblocked_tasks() {
        let services = mock_services();

        // Create two tasks
        let a = AddCommand {
            title: "Task A".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
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
        };
        let _b_id = b.execute(&services).await.unwrap();

        // list_ready should return A (no blockers) but not B (blocked by A)
        let ready = services.tasks().list_ready().await.unwrap();

        let ready_ids: Vec<&str> = ready.iter().map(|t| t.id.as_str()).collect();
        assert!(ready_ids.contains(&a_id.as_str()));
    }
}

// ============================================================================
// Relationship tests: dependencies, blockers, paths
// ============================================================================

#[cfg(test)]
mod relationship_tests {
    use super::*;

    /// Helper to create a simple task and return its ID
    async fn create_task(services: &vertebrae_core::VertebraeServices, title: &str) -> String {
        let cmd = AddCommand {
            title: title.to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        cmd.execute(services).await.unwrap()
    }

    #[tokio::test]
    async fn test_add_dependency() {
        let services = mock_services();
        let a = create_task(&services, "Task A").await;
        let b = create_task(&services, "Task B").await;

        let cmd = DependCommand {
            id: b.clone(),
            blocker_id: a.clone(),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(!result.already_existed);
        assert_eq!(result.task_id, b);
        assert_eq!(result.blocker_id, a);
    }

    #[tokio::test]
    async fn test_dependency_idempotent() {
        let services = mock_services();
        let a = create_task(&services, "Task A").await;
        let b = create_task(&services, "Task B").await;

        let cmd = DependCommand {
            id: b.clone(),
            blocker_id: a.clone(),
        };
        cmd.execute(&services).await.unwrap();

        // Adding again should be idempotent
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.already_existed);
    }

    #[tokio::test]
    async fn test_self_dependency_fails() {
        let services = mock_services();
        let a = create_task(&services, "Task A").await;

        let cmd = DependCommand {
            id: a.clone(),
            blocker_id: a.clone(),
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_remove_dependency() {
        let services = mock_services();
        let a = create_task(&services, "Task A").await;
        let b = create_task(&services, "Task B").await;

        // Add dependency B -> A
        let depend = DependCommand {
            id: b.clone(),
            blocker_id: a.clone(),
        };
        depend.execute(&services).await.unwrap();

        // Remove dependency
        let undepend = UndependCommand {
            id: b.clone(),
            blocker_id: a.clone(),
        };
        undepend.execute(&services).await.unwrap();

        // Verify it's gone
        let deps = services.tasks().get_dependencies(&b).await.unwrap();
        assert!(!deps.contains(&a));
    }

    #[tokio::test]
    async fn test_get_blockers() {
        let services = mock_services();
        let a = create_task(&services, "Blocker A").await;
        let b = create_task(&services, "Blocker B").await;
        let c = create_task(&services, "Blocked C").await;

        // C depends on A and B
        DependCommand {
            id: c.clone(),
            blocker_id: a.clone(),
        }
        .execute(&services)
        .await
        .unwrap();
        DependCommand {
            id: c.clone(),
            blocker_id: b.clone(),
        }
        .execute(&services)
        .await
        .unwrap();

        let cmd = BlockersCommand {
            id: c.clone(),
            depth: None,
            all: false,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.blockers.len(), 2);
        assert_eq!(result.total_count, 2);
    }

    #[tokio::test]
    async fn test_find_dependency_path() {
        let services = mock_services();
        let a = create_task(&services, "Start").await;
        let b = create_task(&services, "Middle").await;
        let c = create_task(&services, "End").await;

        // C -> B -> A (C depends on B, B depends on A)
        DependCommand {
            id: c.clone(),
            blocker_id: b.clone(),
        }
        .execute(&services)
        .await
        .unwrap();
        DependCommand {
            id: b.clone(),
            blocker_id: a.clone(),
        }
        .execute(&services)
        .await
        .unwrap();

        let cmd = PathCommand {
            from_id: c.clone(),
            to_id: a.clone(),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.path.is_some());
        let path = result.path.unwrap();
        assert_eq!(path.len(), 3);
        assert_eq!(path[0].id, c);
        assert_eq!(path[1].id, b);
        assert_eq!(path[2].id, a);
    }

    #[tokio::test]
    async fn test_no_path_between_unrelated_tasks() {
        let services = mock_services();
        let a = create_task(&services, "Task A").await;
        let b = create_task(&services, "Task B").await;

        let cmd = PathCommand {
            from_id: a.clone(),
            to_id: b.clone(),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.path.is_none());
    }

    #[tokio::test]
    async fn test_path_to_self() {
        let services = mock_services();
        let a = create_task(&services, "Self").await;

        let cmd = PathCommand {
            from_id: a.clone(),
            to_id: a.clone(),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(result.path.is_some());
        let path = result.path.unwrap();
        assert_eq!(path.len(), 1);
        assert_eq!(path[0].id, a);
    }

    #[tokio::test]
    async fn test_dependency_on_nonexistent_task_fails() {
        let services = mock_services();
        let a = create_task(&services, "Real task").await;

        let cmd = DependCommand {
            id: a.clone(),
            blocker_id: "nonexistent".to_string(),
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }
}

// ============================================================================
// Section tests: add, edit, remove sections and code refs
// ============================================================================

#[cfg(test)]
mod section_tests {
    use super::*;
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
            workflow: None,
        };
        cmd.execute(services).await.unwrap()
    }

    #[tokio::test]
    async fn test_add_step_section() {
        let services = mock_services();
        let id = create_task(&services, "Task with steps").await;

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "First step".to_string(),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.ordinal, Some(0));
        assert!(!result.replaced);

        // Add second step
        let cmd2 = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "Second step".to_string(),
        };
        let result2 = cmd2.execute(&services).await.unwrap();
        assert_eq!(result2.ordinal, Some(1));

        // Verify sections exist on the task
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 2);
        assert_eq!(task.sections[0].content, "First step");
        assert_eq!(task.sections[1].content, "Second step");
    }

    #[tokio::test]
    async fn test_add_section_after_delete_reports_server_assigned_ordinal() {
        let services = mock_services();
        let id = create_task(&services, "Task with replaced step").await;

        let first = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "First step".to_string(),
        };
        let first_result = first.execute(&services).await.unwrap();
        assert_eq!(first_result.ordinal, Some(0));

        let remove = UnsectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            index: Some(0),
        };
        let remove_result = remove.execute(&services).await.unwrap();
        assert_eq!(remove_result.removed_count, 1);

        let second = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "Second step".to_string(),
        };
        let second_result = second.execute(&services).await.unwrap();

        assert_eq!(second_result.ordinal, Some(1));
        assert_eq!(
            second_result.to_string(),
            format!("Added checklist_item section (ordinal 1) to task: {}", id)
        );

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].content, "Second step");
        assert_eq!(task.sections[0].order, Some(1));
    }

    #[tokio::test]
    async fn test_add_single_instance_section_replaces() {
        let services = mock_services();
        let id = create_task(&services, "Task with goal").await;

        // Add goal
        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "Original goal".to_string(),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(!result.replaced);
        assert_eq!(result.ordinal, None);

        // Add goal again - should replace
        let cmd2 = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Goal,
            content: "New goal".to_string(),
        };
        let result2 = cmd2.execute(&services).await.unwrap();
        assert!(result2.replaced);
        assert_eq!(result2.ordinal, None);

        // Verify only one goal section
        let task = services.tasks().get_task(&id).await.unwrap();
        let goals: Vec<_> = task
            .sections
            .iter()
            .filter(|s| s.section_type == SectionType::Goal)
            .collect();
        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0].content, "New goal");
    }

    #[tokio::test]
    async fn test_add_constraint_section() {
        let services = mock_services();
        let id = create_task(&services, "Constrained task").await;

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::Constraint,
            content: "Must be backwards compatible".to_string(),
        };
        let result = cmd.execute(&services).await.unwrap();
        assert_eq!(result.section_type, SectionType::Constraint);
    }

    #[tokio::test]
    async fn test_empty_section_content_fails() {
        let services = mock_services();
        let id = create_task(&services, "Task").await;

        let cmd = SectionCommand {
            id: id.clone(),
            section_type: SectionType::ChecklistItem,
            content: "   ".to_string(),
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_add_code_reference() {
        let services = mock_services();
        let id = create_task(&services, "Task with refs").await;

        let cmd = RefCommand {
            id: id.clone(),
            file_spec: "src/main.rs:L42".to_string(),
            name: Some("entry_point".to_string()),
            description: None,
        };
        let result = cmd.execute(&services).await.unwrap();
        assert!(format!("{}", result).contains(&id));

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");
        assert_eq!(task.code_refs[0].line_start, Some(42));
    }

    #[tokio::test]
    async fn test_section_on_nonexistent_task_fails() {
        let services = mock_services();

        let cmd = SectionCommand {
            id: "nonexistent".to_string(),
            section_type: SectionType::ChecklistItem,
            content: "Something".to_string(),
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }
}

// ============================================================================
// Workflow tests: create, assign, advance, retreat
// ============================================================================

#[cfg(test)]
mod workflow_tests {
    use super::*;

    async fn create_task(services: &vertebrae_core::VertebraeServices, title: &str) -> String {
        let cmd = AddCommand {
            title: title.to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        cmd.execute(services).await.unwrap()
    }

    #[tokio::test]
    async fn test_create_workflow() {
        let services = mock_services();
        let options = vertebrae_core::CreateWorkflowOptions {
            name: "Test Workflow".to_string(),
            description: Some("A test workflow".to_string()),
            steps: vec![],
            order: 0,
            is_default: false,
            kanban_column: None,
        };
        let wf_id = services.workflows().create_workflow(options).await.unwrap();
        assert!(!wf_id.is_empty());

        let wf = services.workflows().get_workflow(&wf_id).await.unwrap();
        assert_eq!(wf.name, "Test Workflow");
    }

    #[tokio::test]
    async fn test_assign_workflow_to_task() {
        let services = mock_services();
        let task_id = create_task(&services, "Workflow task").await;

        let wf_options = vertebrae_core::CreateWorkflowOptions {
            name: "Dev Workflow".to_string(),
            description: None,
            steps: vec![],
            order: 0,
            is_default: false,
            kanban_column: None,
        };
        let wf_id = services
            .workflows()
            .create_workflow(wf_options)
            .await
            .unwrap();

        let result = services
            .workflows()
            .assign_workflow(&task_id, &wf_id)
            .await
            .unwrap();
        assert_eq!(result.task_id, task_id);
        assert_eq!(result.workflow_id, wf_id);

        // Verify task now has workflow assigned
        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert_eq!(task.workflow_id, Some(wf_id));
    }

    #[tokio::test]
    async fn test_unassign_workflow() {
        let services = mock_services();
        let task_id = create_task(&services, "Unassign test").await;
        // Assign workflow
        let wf_options = vertebrae_core::CreateWorkflowOptions {
            name: "Temporary Workflow".to_string(),
            description: None,
            steps: vec![],
            order: 0,
            is_default: false,
            kanban_column: None,
        };
        let wf_id = services
            .workflows()
            .create_workflow(wf_options)
            .await
            .unwrap();
        services
            .workflows()
            .assign_workflow(&task_id, &wf_id)
            .await
            .unwrap();

        // Unassign
        services
            .workflows()
            .unassign_workflow(&task_id)
            .await
            .unwrap();

        let task = services.tasks().get_task(&task_id).await.unwrap();
        assert!(task.workflow_id.is_none());
        assert!(task.current_step_id.is_none());
    }
}

// ============================================================================
// Command dispatch tests: verify Command::execute integration
// ============================================================================

#[cfg(test)]
mod command_dispatch_tests {
    use super::*;

    #[tokio::test]
    async fn test_command_add_via_dispatch() {
        let services = mock_services();
        let cmd = Command::Add(AddCommand {
            title: "Dispatched task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        });
        let result = cmd.execute(&services).await.unwrap();
        let output = format!("{}", result);
        assert!(output.starts_with("Created task:"));
    }

    #[tokio::test]
    async fn test_command_show_via_dispatch() {
        let services = mock_services();

        // First create a task
        let add = AddCommand {
            title: "Show me".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let id = add.execute(&services).await.unwrap();

        let cmd = Command::Show(ShowCommand { id: id.clone() });
        let result = cmd.execute(&services).await.unwrap();
        let output = format!("{}", result);
        assert!(output.contains("Show me"));
        assert!(output.contains(&id));
    }

    #[tokio::test]
    async fn test_command_delete_via_dispatch() {
        let services = mock_services();

        let add = AddCommand {
            title: "Delete me".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let id = add.execute(&services).await.unwrap();

        let cmd = Command::Delete(DeleteCommand {
            id: id.clone(),
            cascade: false,
            force: true,
        });
        let result = cmd.execute(&services).await.unwrap();
        let output = format!("{}", result);
        assert!(output.contains("Deleted"));
    }

    #[tokio::test]
    async fn test_command_update_via_dispatch() {
        let services = mock_services();

        let add = AddCommand {
            title: "Update me".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            workflow: None,
        };
        let id = add.execute(&services).await.unwrap();

        let cmd = Command::Update(UpdateCommand {
            id: id.clone(),
            title: Some("Updated".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            worktree: None,
            edit_section: None,
            remove_section: None,
        });
        let result = cmd.execute(&services).await.unwrap();
        let output = format!("{}", result);
        assert!(output.contains("Updated task:"));
    }
}

// Infrastructure test
#[tokio::test]
async fn test_mock_services_creation() {
    let services = mock_services();
    // Verify the services are functional
    let filter = vertebrae_core::TaskFilter::default();
    let tasks = services.tasks().list_tasks(&filter).await.unwrap();
    assert!(tasks.is_empty());
}
