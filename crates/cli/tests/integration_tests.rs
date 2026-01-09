//! End-to-end integration tests for the Vertebrae CLI
//!
//! This test suite executes commands through the CLI command interface
//! using isolated database instances for each test to ensure no shared state.
//!
//! Tests are organized into modules matching the implementation steps:
//! - `test_infrastructure` - Shared test helpers and database setup
//! - `lifecycle` - Task lifecycle tests (add, triage, start, submit, done, reject)
//! - `sections` - Section tests for all 9 types with single/multi behavior
//! - `relationships` - Parent-child and dependency relationship tests
//! - `code_refs` - Code reference tests
//! - `queries` - Query and filter tests
//! - `error_cases` - Error handling tests

mod common;

use common::*;
use vertebrae_db::{DbError, Level, SectionType, Status};

// =============================================================================
// LIFECYCLE TESTS
// =============================================================================

mod lifecycle {
    use super::*;

    #[tokio::test]
    async fn test_add_creates_task_with_backlog_status() {
        let ctx = TestContext::new().await;

        let cmd = add_cmd("New feature");
        let id = cmd.execute(&ctx.db).await.unwrap();

        // Verify task was created with exact expected values
        let task = ctx.db.tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.title, "New feature");
        assert_eq!(task.level, Level::Task);
        assert_eq!(task.status, Status::Backlog);
    }

    #[tokio::test]
    async fn test_add_creates_epic_level() {
        let ctx = TestContext::new().await;

        let cmd = add_cmd_full(
            "Big initiative",
            Some(Level::Epic),
            Some("Epic description"),
            None,
        );
        let id = cmd.execute(&ctx.db).await.unwrap();

        let task = ctx.db.tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.level, Level::Epic);
        assert_eq!(task.description, Some("Epic description".to_string()));
    }

    #[tokio::test]
    async fn test_add_with_parent_creates_child_relationship() {
        let ctx = TestContext::new().await;

        // Create parent first
        create_task(&ctx.db, "parent1", "Parent Task", "epic", "todo").await;

        let cmd = add_cmd_with_parent("Child task", "parent1");
        let child_id = cmd.execute(&ctx.db).await.unwrap();

        assert!(
            child_of_exists(&ctx.db, &child_id, "parent1").await,
            "Child relationship should be created"
        );
    }

    #[tokio::test]
    async fn test_add_with_nonexistent_parent_fails() {
        let ctx = TestContext::new().await;

        let cmd = add_cmd_with_parent("Orphan task", "nonexistent");
        let result = cmd.execute(&ctx.db).await;
        assert!(result.is_err(), "Should fail with nonexistent parent");
    }

    #[tokio::test]
    async fn test_triage_moves_backlog_to_todo() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Backlog Task", "task", "backlog").await;

        triage_cmd("task1").execute(&ctx.db).await.unwrap();

        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("todo".to_string())
        );
    }

    #[tokio::test]
    async fn test_triage_from_non_backlog_fails() {
        let ctx = TestContext::new().await;
        // Use in_progress status - triage is idempotent for todo but fails for in_progress
        create_task(&ctx.db, "task1", "In Progress Task", "task", "in_progress").await;

        let result = triage_cmd("task1").execute(&ctx.db).await;
        assert!(result.is_err(), "Triage from in_progress should fail");

        // Status should remain unchanged
        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("in_progress".to_string())
        );
    }

    #[tokio::test]
    async fn test_triage_already_todo_is_idempotent() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Todo Task", "task", "todo").await;

        let result = triage_cmd("task1").execute(&ctx.db).await.unwrap();
        assert!(result.already_todo, "Triage should report already_todo");

        // Status should remain unchanged
        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("todo".to_string())
        );
    }

    #[tokio::test]
    async fn test_start_moves_todo_to_in_progress() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Todo Task", "task", "todo").await;

        start_cmd("task1").execute(&ctx.db).await.unwrap();

        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("in_progress".to_string())
        );

        // Verify started_at was set
        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert!(task.started_at.is_some(), "started_at should be set");
    }

    #[tokio::test]
    async fn test_start_from_backlog_fails() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Backlog Task", "task", "backlog").await;

        let result = start_cmd("task1").execute(&ctx.db).await;
        assert!(result.is_err(), "Start from backlog should fail");

        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("backlog".to_string())
        );
    }

    #[tokio::test]
    async fn test_start_already_in_progress_is_idempotent() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Active Task", "task", "in_progress").await;

        let result = start_cmd("task1").execute(&ctx.db).await;
        assert!(result.is_ok(), "Start on in_progress should be idempotent");

        let start_result = result.unwrap();
        assert!(
            start_result.already_in_progress,
            "Should indicate already started"
        );
    }

    #[tokio::test]
    async fn test_submit_moves_in_progress_to_pending_review() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Active Task", "task", "in_progress").await;

        submit_cmd("task1").execute(&ctx.db).await.unwrap();

        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("pending_review".to_string())
        );
    }

    #[tokio::test]
    async fn test_done_moves_pending_review_to_done() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Review Task", "task", "pending_review").await;

        done_cmd("task1").execute(&ctx.db).await.unwrap();

        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("done".to_string())
        );

        // Verify completed_at was set
        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert!(task.completed_at.is_some(), "completed_at should be set");
    }

    #[tokio::test]
    async fn test_done_with_incomplete_children_fails() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "parent", "Parent", "ticket", "pending_review").await;
        create_task(&ctx.db, "child", "Child", "task", "todo").await;
        create_child_of(&ctx.db, "child", "parent").await;

        let result = done_cmd("parent").execute(&ctx.db).await;
        match result {
            Err(DbError::IncompleteChildren { task_id, children }) => {
                assert_eq!(task_id, "parent");
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected IncompleteChildren error"),
        }
    }

    #[tokio::test]
    async fn test_done_with_all_children_complete_succeeds() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "parent", "Parent", "ticket", "pending_review").await;
        create_task(&ctx.db, "child1", "Child 1", "task", "done").await;
        create_task(&ctx.db, "child2", "Child 2", "task", "done").await;
        create_child_of(&ctx.db, "child1", "parent").await;
        create_child_of(&ctx.db, "child2", "parent").await;

        done_cmd("parent").execute(&ctx.db).await.unwrap();

        assert_eq!(
            get_task_status(&ctx.db, "parent").await,
            Some("done".to_string())
        );
    }

    #[tokio::test]
    async fn test_reject_moves_todo_to_rejected() {
        let ctx = TestContext::new().await;
        // Reject transitions from todo to rejected (not from pending_review)
        create_task(&ctx.db, "task1", "Todo Task", "task", "todo").await;

        reject_cmd("task1").execute(&ctx.db).await.unwrap();

        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("rejected".to_string())
        );
    }

    #[tokio::test]
    async fn test_reject_from_pending_review_fails() {
        let ctx = TestContext::new().await;
        // pending_review -> rejected is not a valid transition
        create_task(&ctx.db, "task1", "Review Task", "task", "pending_review").await;

        let result = reject_cmd("task1").execute(&ctx.db).await;
        assert!(result.is_err(), "Reject from pending_review should fail");

        // Status should remain unchanged
        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("pending_review".to_string())
        );
    }

    #[tokio::test]
    async fn test_complete_happy_path_lifecycle() {
        let ctx = TestContext::new().await;

        // 1. Add task (creates in backlog)
        let task_id = add_cmd("Lifecycle test task")
            .execute(&ctx.db)
            .await
            .unwrap();
        assert_eq!(
            get_task_status(&ctx.db, &task_id).await,
            Some("backlog".to_string())
        );

        // 2. Triage (backlog -> todo)
        triage_cmd(&task_id).execute(&ctx.db).await.unwrap();
        assert_eq!(
            get_task_status(&ctx.db, &task_id).await,
            Some("todo".to_string())
        );

        // 3. Start (todo -> in_progress)
        start_cmd(&task_id).execute(&ctx.db).await.unwrap();
        assert_eq!(
            get_task_status(&ctx.db, &task_id).await,
            Some("in_progress".to_string())
        );

        // 4. Submit (in_progress -> pending_review)
        submit_cmd(&task_id).execute(&ctx.db).await.unwrap();
        assert_eq!(
            get_task_status(&ctx.db, &task_id).await,
            Some("pending_review".to_string())
        );

        // 5. Done (pending_review -> done)
        done_cmd(&task_id).execute(&ctx.db).await.unwrap();
        assert_eq!(
            get_task_status(&ctx.db, &task_id).await,
            Some("done".to_string())
        );

        // Verify timestamps
        let task = ctx.db.tasks().get(&task_id).await.unwrap().unwrap();
        assert!(task.started_at.is_some());
        assert!(task.completed_at.is_some());
    }
}

// =============================================================================
// SECTION TESTS
// =============================================================================

mod sections {
    use super::*;

    #[tokio::test]
    async fn test_add_goal_section() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        section_cmd("task1", SectionType::Goal, "Implement authentication")
            .execute(&ctx.db)
            .await
            .unwrap();

        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].section_type, SectionType::Goal);
        assert_eq!(task.sections[0].content, "Implement authentication");
    }

    #[tokio::test]
    async fn test_single_instance_section_replaces_existing() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        // Add first goal
        section_cmd("task1", SectionType::Goal, "Original goal")
            .execute(&ctx.db)
            .await
            .unwrap();

        // Add second goal - should replace
        let result = section_cmd("task1", SectionType::Goal, "Updated goal")
            .execute(&ctx.db)
            .await
            .unwrap();
        assert!(result.replaced, "Second goal should indicate replacement");

        // Verify only one goal exists with new content
        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].content, "Updated goal");
    }

    #[tokio::test]
    async fn test_add_multiple_steps_incrementing_ordinals() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        // Add 5 steps
        for i in 0..5 {
            let result = section_cmd("task1", SectionType::Step, &format!("Step {}", i + 1))
                .execute(&ctx.db)
                .await
                .unwrap();
            assert_eq!(
                result.ordinal,
                Some(i as u32),
                "Step {} should have ordinal {}",
                i + 1,
                i
            );
        }

        // Verify all 5 steps exist
        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections.len(), 5);
    }

    #[tokio::test]
    async fn test_add_all_nine_section_types() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        for (section_type, content) in [
            (SectionType::Goal, "The goal"),
            (SectionType::Context, "The context"),
            (SectionType::CurrentBehavior, "Current behavior"),
            (SectionType::DesiredBehavior, "Desired behavior"),
            (SectionType::Step, "A step"),
            (SectionType::TestingCriterion, "A test criterion"),
            (SectionType::AntiPattern, "An anti-pattern"),
            (SectionType::FailureTest, "A failure test"),
            (SectionType::Constraint, "A constraint"),
        ] {
            section_cmd("task1", section_type, content)
                .execute(&ctx.db)
                .await
                .unwrap();
        }

        // Verify all 9 sections exist
        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections.len(), 9);
    }

    #[tokio::test]
    async fn test_section_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        let result = section_cmd("nonexistent", SectionType::Goal, "The goal")
            .execute(&ctx.db)
            .await;
        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_section_empty_content_fails() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        let result = section_cmd("task1", SectionType::Goal, "")
            .execute(&ctx.db)
            .await;
        assert!(result.is_err(), "Empty content should fail");
    }

    #[tokio::test]
    async fn test_section_content_with_unicode() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        let unicode_content = "Unicode: \u{1F600} emoji, \u{4E2D}\u{6587} Chinese";
        section_cmd("task1", SectionType::Goal, unicode_content)
            .execute(&ctx.db)
            .await
            .unwrap();

        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections[0].content, unicode_content);
    }
}

// =============================================================================
// RELATIONSHIP TESTS
// =============================================================================

mod relationships {
    use super::*;

    #[tokio::test]
    async fn test_create_dependency() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "blocker", "Blocker", "task", "todo").await;
        create_task(&ctx.db, "dependent", "Dependent", "task", "todo").await;

        let result = depend_cmd("dependent", "blocker")
            .execute(&ctx.db)
            .await
            .unwrap();

        assert_eq!(result.task_id, "dependent");
        assert_eq!(result.blocker_id, "blocker");
        assert!(!result.already_existed);

        assert!(dependency_exists(&ctx.db, "dependent", "blocker").await);
    }

    #[tokio::test]
    async fn test_dependency_is_idempotent() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "blocker", "Blocker", "task", "todo").await;
        create_task(&ctx.db, "dependent", "Dependent", "task", "todo").await;

        let result1 = depend_cmd("dependent", "blocker")
            .execute(&ctx.db)
            .await
            .unwrap();
        assert!(!result1.already_existed);

        let result2 = depend_cmd("dependent", "blocker")
            .execute(&ctx.db)
            .await
            .unwrap();
        assert!(result2.already_existed);
    }

    #[tokio::test]
    async fn test_self_dependency_fails() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Task 1", "task", "todo").await;

        let result = depend_cmd("task1", "task1").execute(&ctx.db).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_direct_cycle_detected() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "a", "Task A", "task", "todo").await;
        create_task(&ctx.db, "b", "Task B", "task", "todo").await;

        // A depends on B
        depend_cmd("a", "b").execute(&ctx.db).await.unwrap();

        // B depends on A - should fail (creates A -> B -> A cycle)
        let result = depend_cmd("b", "a").execute(&ctx.db).await;
        assert!(result.is_err());

        // Verify the cycle-creating edge was NOT added
        assert!(!dependency_exists(&ctx.db, "b", "a").await);
    }

    #[tokio::test]
    async fn test_transitive_cycle_detected() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "a", "Task A", "task", "todo").await;
        create_task(&ctx.db, "b", "Task B", "task", "todo").await;
        create_task(&ctx.db, "c", "Task C", "task", "todo").await;

        // A -> B -> C chain
        depend_cmd("a", "b").execute(&ctx.db).await.unwrap();
        depend_cmd("b", "c").execute(&ctx.db).await.unwrap();

        // C -> A would create cycle
        let result = depend_cmd("c", "a").execute(&ctx.db).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_diamond_dependency_allowed() {
        let ctx = TestContext::new().await;

        // Diamond: D depends on B and C, both B and C depend on A
        create_task(&ctx.db, "a", "Task A", "task", "done").await;
        create_task(&ctx.db, "b", "Task B", "task", "todo").await;
        create_task(&ctx.db, "c", "Task C", "task", "todo").await;
        create_task(&ctx.db, "d", "Task D", "task", "todo").await;

        depend_cmd("b", "a").execute(&ctx.db).await.unwrap();
        depend_cmd("c", "a").execute(&ctx.db).await.unwrap();
        depend_cmd("d", "b").execute(&ctx.db).await.unwrap();
        depend_cmd("d", "c").execute(&ctx.db).await.unwrap(); // Should succeed

        // Verify all 4 edges exist
        assert!(dependency_exists(&ctx.db, "b", "a").await);
        assert!(dependency_exists(&ctx.db, "c", "a").await);
        assert!(dependency_exists(&ctx.db, "d", "b").await);
        assert!(dependency_exists(&ctx.db, "d", "c").await);
    }
}

// =============================================================================
// CODE REF TESTS
// =============================================================================

mod code_refs {
    use super::*;

    #[tokio::test]
    async fn test_add_simple_file_reference() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        let result = ref_cmd("task1", "src/main.rs")
            .execute(&ctx.db)
            .await
            .unwrap();

        assert_eq!(result.id, "task1");
        assert_eq!(result.path, "src/main.rs");
        assert!(result.line_start.is_none());

        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");
    }

    #[tokio::test]
    async fn test_add_reference_with_line_range() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        let result = ref_cmd("task1", "src/auth.rs:L45-67")
            .execute(&ctx.db)
            .await
            .unwrap();

        assert_eq!(result.line_start, Some(45));
        assert_eq!(result.line_end, Some(67));

        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.code_refs[0].line_start, Some(45));
        assert_eq!(task.code_refs[0].line_end, Some(67));
    }

    #[tokio::test]
    async fn test_add_reference_with_name() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        ref_cmd_full("task1", "src/auth.rs:L45-67", Some("hash_password"), None)
            .execute(&ctx.db)
            .await
            .unwrap();

        let task = ctx.db.tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.code_refs[0].name, Some("hash_password".to_string()));
    }

    #[tokio::test]
    async fn test_ref_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        let result = ref_cmd("nonexistent", "src/main.rs").execute(&ctx.db).await;
        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_ref_invalid_line_range_start_gt_end() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Test Task", "task", "todo").await;

        let result = ref_cmd("task1", "src/auth.rs:L67-45") // start > end
            .execute(&ctx.db)
            .await;
        assert!(result.is_err());
    }
}

// =============================================================================
// QUERY TESTS
// =============================================================================

mod queries {
    use super::*;

    #[tokio::test]
    async fn test_list_empty_database_returns_empty() {
        let ctx = TestContext::new().await;

        let result = list_cmd().execute(&ctx.db).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_list_excludes_done_by_default() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "task1", "Todo Task", "task", "todo").await;
        create_task(&ctx.db, "task2", "Done Task", "task", "done").await;
        create_task(&ctx.db, "task3", "InProgress Task", "task", "in_progress").await;

        let result = list_cmd().execute(&ctx.db).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|t| t.status != "done"));
    }

    #[tokio::test]
    async fn test_list_includes_done_with_all_flag() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "task1", "Todo Task", "task", "todo").await;
        create_task(&ctx.db, "task2", "Done Task", "task", "done").await;

        let mut cmd = list_cmd();
        cmd.all = true;
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(result.len(), 2);
    }

    #[tokio::test]
    async fn test_list_filter_by_level() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "epic1", "Epic", "epic", "todo").await;
        create_task(&ctx.db, "ticket1", "Ticket", "ticket", "todo").await;
        create_task(&ctx.db, "task1", "Task", "task", "todo").await;

        let mut cmd = list_cmd();
        cmd.levels = vec![Level::Epic];
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].level, "epic");
    }

    #[tokio::test]
    async fn test_list_filter_by_status() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "task1", "Backlog", "task", "backlog").await;
        create_task(&ctx.db, "task2", "Todo", "task", "todo").await;
        create_task(&ctx.db, "task3", "InProgress", "task", "in_progress").await;

        let mut cmd = list_cmd();
        cmd.statuses = vec![Status::Backlog];
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, "backlog");
    }

    #[tokio::test]
    async fn test_list_root_only() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "root1", "Root Epic", "epic", "todo").await;
        create_task(&ctx.db, "root2", "Root Ticket", "ticket", "todo").await;
        create_task(&ctx.db, "child1", "Child Task", "task", "todo").await;
        create_child_of(&ctx.db, "child1", "root1").await;

        let mut cmd = list_cmd();
        cmd.root = true;
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(result.len(), 2);
        let ids: Vec<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"root1"));
        assert!(ids.contains(&"root2"));
        assert!(!ids.contains(&"child1"));
    }

    #[tokio::test]
    async fn test_list_children_of_parent() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "parent", "Parent Epic", "epic", "todo").await;
        create_task(&ctx.db, "child1", "Child 1", "ticket", "todo").await;
        create_task(&ctx.db, "child2", "Child 2", "ticket", "todo").await;
        create_task(&ctx.db, "other", "Other Task", "task", "todo").await;
        create_child_of(&ctx.db, "child1", "parent").await;
        create_child_of(&ctx.db, "child2", "parent").await;

        let mut cmd = list_cmd();
        cmd.children = Some("parent".to_string());
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(result.len(), 2);
        let ids: Vec<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"child1"));
        assert!(ids.contains(&"child2"));
    }
}

// =============================================================================
// SEARCH TESTS
// =============================================================================

mod search {
    use super::*;

    #[tokio::test]
    async fn test_search_finds_task_by_title_substring() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "task1", "Authentication feature", "task", "todo").await;
        create_task(&ctx.db, "task2", "Database migration", "task", "todo").await;
        create_task(&ctx.db, "task3", "API endpoint", "task", "todo").await;

        let cmd = list_cmd_with_search("auth");
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(
            result.len(),
            1,
            "Should find exactly one task containing 'auth'"
        );
        assert_eq!(result[0].id, "task1");
        assert_eq!(result[0].title, "Authentication feature");
    }

    #[tokio::test]
    async fn test_search_finds_task_by_description_substring() {
        let ctx = TestContext::new().await;

        create_task_with_description(
            &ctx.db,
            "task1",
            "Feature A",
            "task",
            "todo",
            "Implement user authentication system",
        )
        .await;
        create_task_with_description(
            &ctx.db,
            "task2",
            "Feature B",
            "task",
            "todo",
            "Add database caching",
        )
        .await;

        let cmd = list_cmd_with_search("authentication");
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(
            result.len(),
            1,
            "Should find exactly one task with 'authentication' in description"
        );
        assert_eq!(result[0].id, "task1");
    }

    #[tokio::test]
    async fn test_search_is_case_insensitive() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "task1", "AUTHENTICATION Feature", "task", "todo").await;
        create_task(&ctx.db, "task2", "Other task", "task", "todo").await;

        // Search with lowercase should find uppercase title
        let cmd = list_cmd_with_search("authentication");
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(result.len(), 1, "Search should be case-insensitive");
        assert_eq!(result[0].id, "task1");

        // Search with uppercase should also find
        let cmd2 = list_cmd_with_search("AUTHENTICATION");
        let result2 = cmd2.execute(&ctx.db).await.unwrap();

        assert_eq!(
            result2.len(),
            1,
            "Uppercase search should also find lowercase matches"
        );
        assert_eq!(result2[0].id, "task1");
    }

    #[tokio::test]
    async fn test_search_combined_with_status_returns_intersection() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "task1", "Auth task", "task", "todo").await;
        create_task(&ctx.db, "task2", "Auth in progress", "task", "in_progress").await;
        create_task(&ctx.db, "task3", "Other task", "task", "todo").await;

        // Search for "auth" AND status=in_progress
        let mut cmd = list_cmd_with_search("auth");
        cmd.statuses = vec![Status::InProgress];
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(
            result.len(),
            1,
            "Should return intersection of search and status filter"
        );
        assert_eq!(result[0].id, "task2");
    }

    #[tokio::test]
    async fn test_search_with_no_matches_returns_empty() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "task1", "Task A", "task", "todo").await;
        create_task(&ctx.db, "task2", "Task B", "task", "todo").await;

        let cmd = list_cmd_with_search("nonexistent");
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert!(
            result.is_empty(),
            "Search with no matches should return empty list"
        );
    }

    #[tokio::test]
    async fn test_tag_behavior_unchanged_or_semantics() {
        let ctx = TestContext::new().await;

        create_task_with_tags(&ctx.db, "task1", "Task 1", "task", "todo", &["backend"]).await;
        create_task_with_tags(&ctx.db, "task2", "Task 2", "task", "todo", &["frontend"]).await;
        create_task_with_tags(
            &ctx.db,
            "task3",
            "Task 3",
            "task",
            "todo",
            &["backend", "api"],
        )
        .await;
        create_task_with_tags(&ctx.db, "task4", "Task 4", "task", "todo", &["other"]).await;

        // Filter by multiple tags (OR semantics)
        let mut cmd = list_cmd();
        cmd.tags = vec!["backend".to_string(), "frontend".to_string()];
        let result = cmd.execute(&ctx.db).await.unwrap();

        assert_eq!(result.len(), 3, "Tag filter should use OR semantics");

        let ids: std::collections::HashSet<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(
            ids.contains("task1"),
            "Should contain task with 'backend' tag"
        );
        assert!(
            ids.contains("task2"),
            "Should contain task with 'frontend' tag"
        );
        assert!(
            ids.contains("task3"),
            "Should contain task with 'backend' tag (also has 'api')"
        );
        assert!(
            !ids.contains("task4"),
            "Should NOT contain task with only 'other' tag"
        );
    }

    #[tokio::test]
    async fn test_search_empty_returns_error() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "task1", "Task 1", "task", "todo").await;

        let cmd = list_cmd_with_search("");
        let result = cmd.execute(&ctx.db).await;

        assert!(result.is_err(), "Empty search should return error");
        match result {
            Err(DbError::ValidationError { message }) => {
                assert_eq!(message, "Search query cannot be empty");
            }
            _ => panic!("Expected ValidationError"),
        }
    }
}

// =============================================================================
// ERROR CASE TESTS
// =============================================================================

mod error_cases {
    use super::*;

    #[tokio::test]
    async fn test_triage_nonexistent_task() {
        let ctx = TestContext::new().await;

        let result = triage_cmd("nonexistent").execute(&ctx.db).await;
        assert!(matches!(result, Err(DbError::NotFound { task_id }) if task_id == "nonexistent"));
    }

    #[tokio::test]
    async fn test_start_nonexistent_task() {
        let ctx = TestContext::new().await;

        let result = start_cmd("nonexistent").execute(&ctx.db).await;
        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_done_nonexistent_task() {
        let ctx = TestContext::new().await;

        let result = done_cmd("nonexistent").execute(&ctx.db).await;
        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_invalid_status_transition_todo_to_done() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Task", "task", "todo").await;

        let result = done_cmd("task1").execute(&ctx.db).await;
        assert!(matches!(
            result,
            Err(DbError::InvalidStatusTransition { .. })
        ));
    }

    #[tokio::test]
    async fn test_invalid_status_transition_backlog_to_in_progress() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Task", "task", "backlog").await;

        let result = start_cmd("task1").execute(&ctx.db).await;
        assert!(matches!(
            result,
            Err(DbError::InvalidStatusTransition { .. })
        ));
    }

    #[tokio::test]
    async fn test_failed_transition_preserves_status() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Task", "task", "todo").await;

        let _ = done_cmd("task1").execute(&ctx.db).await;

        // Status should be unchanged
        assert_eq!(
            get_task_status(&ctx.db, "task1").await,
            Some("todo".to_string())
        );
    }
}

// =============================================================================
// DATA OPERATION TESTS
// =============================================================================

mod data_operations {
    use super::*;

    #[tokio::test]
    async fn test_delete_single_task() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "task1", "Task to delete", "task", "todo").await;

        delete_cmd("task1", false).execute(&ctx.db).await.unwrap();

        assert!(!task_exists(&ctx.db, "task1").await);
    }

    #[tokio::test]
    async fn test_delete_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        let result = delete_cmd("nonexistent", false).execute(&ctx.db).await;
        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_delete_cascade_children() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "parent", "Parent", "epic", "todo").await;
        create_task(&ctx.db, "child1", "Child 1", "ticket", "todo").await;
        create_task(&ctx.db, "child2", "Child 2", "ticket", "todo").await;
        create_child_of(&ctx.db, "child1", "parent").await;
        create_child_of(&ctx.db, "child2", "parent").await;

        delete_cmd("parent", true).execute(&ctx.db).await.unwrap();

        // All should be deleted
        assert!(!task_exists(&ctx.db, "parent").await);
        assert!(!task_exists(&ctx.db, "child1").await);
        assert!(!task_exists(&ctx.db, "child2").await);
    }

    #[tokio::test]
    async fn test_delete_orphans_children() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "parent", "Parent", "epic", "todo").await;
        create_task(&ctx.db, "child1", "Child 1", "ticket", "todo").await;
        create_child_of(&ctx.db, "child1", "parent").await;

        delete_cmd("parent", false).execute(&ctx.db).await.unwrap(); // No cascade

        // Parent deleted
        assert!(!task_exists(&ctx.db, "parent").await);
        // Child still exists but orphaned
        assert!(task_exists(&ctx.db, "child1").await);
    }

    #[tokio::test]
    async fn test_export_empty_database() {
        let ctx = TestContext::new().await;

        let result = export_cmd(None).execute(&ctx.db).await.unwrap();

        assert_eq!(result.tasks, 0);
        assert_eq!(result.child_of_relations, 0);
        assert_eq!(result.depends_on_relations, 0);
    }

    #[tokio::test]
    async fn test_export_with_relationships() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "epic", "Epic", "epic", "todo").await;
        create_task(&ctx.db, "ticket", "Ticket", "ticket", "todo").await;
        create_task(&ctx.db, "blocker", "Blocker", "task", "done").await;
        create_child_of(&ctx.db, "ticket", "epic").await;
        create_depends_on(&ctx.db, "ticket", "blocker").await;

        let result = export_cmd(None).execute(&ctx.db).await.unwrap();

        assert_eq!(result.tasks, 3);
        assert_eq!(result.child_of_relations, 1);
        assert_eq!(result.depends_on_relations, 1);
    }
}

// =============================================================================
// BOUNDARY AND EDGE CASE TESTS
// =============================================================================

mod boundary_edge_cases {
    use super::*;

    #[tokio::test]
    async fn test_very_long_title() {
        let ctx = TestContext::new().await;

        let long_title = "A".repeat(10000); // 10k characters
        let id = add_cmd(&long_title).execute(&ctx.db).await.unwrap();

        let task = ctx.db.tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.title, long_title);
    }

    #[tokio::test]
    async fn test_title_with_quotes() {
        let ctx = TestContext::new().await;

        let title = r#"Task with "quotes" and 'apostrophes'"#;
        let id = add_cmd(title).execute(&ctx.db).await.unwrap();

        let task = ctx.db.tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.title, title);
    }

    #[tokio::test]
    async fn test_title_with_unicode() {
        let ctx = TestContext::new().await;

        let title = "\u{1F600} Happy Task \u{4E2D}\u{6587}";
        let id = add_cmd(title).execute(&ctx.db).await.unwrap();

        let task = ctx.db.tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.title, title);
    }

    #[tokio::test]
    async fn test_case_insensitive_task_id() {
        let ctx = TestContext::new().await;
        create_task(&ctx.db, "abc123", "Task", "task", "backlog").await;

        // Uppercase should work
        triage_cmd("ABC123").execute(&ctx.db).await.unwrap();

        assert_eq!(
            get_task_status(&ctx.db, "abc123").await,
            Some("todo".to_string())
        );
    }

    #[tokio::test]
    async fn test_many_tasks() {
        let ctx = TestContext::new().await;

        // Create 100 tasks
        for i in 0..100 {
            create_task(
                &ctx.db,
                &format!("task{}", i),
                &format!("Task {}", i),
                "task",
                "todo",
            )
            .await;
        }

        let result = list_cmd().execute(&ctx.db).await.unwrap();
        assert_eq!(result.len(), 100);
    }

    #[tokio::test]
    async fn test_deep_hierarchy() {
        let ctx = TestContext::new().await;

        // Create a chain of 10 levels deep
        let mut parent_id: Option<String> = None;

        for i in 0..10 {
            let id = format!("task{}", i);
            let level = match i % 3 {
                0 => "epic",
                1 => "ticket",
                _ => "task",
            };

            create_task(&ctx.db, &id, &format!("Level {}", i), level, "todo").await;

            if let Some(ref parent) = parent_id {
                create_child_of(&ctx.db, &id, parent).await;
            }

            parent_id = Some(id);
        }

        // Verify count
        assert_eq!(count_tasks(&ctx.db).await, 10);
    }
}
