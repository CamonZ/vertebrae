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
        let id = cmd.execute(ctx.db()).await.unwrap();

        // Verify task was created with exact expected values
        let task = ctx.db().tasks().get(&id).await.unwrap().unwrap();
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
        let id = cmd.execute(ctx.db()).await.unwrap();

        let task = ctx.db().tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.level, Level::Epic);
        assert_eq!(task.description, Some("Epic description".to_string()));
    }

    #[tokio::test]
    async fn test_add_with_parent_creates_child_relationship() {
        let ctx = TestContext::new().await;

        // Create parent first
        create_task(ctx.db(), "parent1", "Parent Task", "epic", "todo").await;

        let cmd = add_cmd_with_parent("Child task", "parent1");
        let child_id = cmd.execute(ctx.db()).await.unwrap();

        assert!(
            child_of_exists(ctx.db(), &child_id, "parent1").await,
            "Child relationship should be created"
        );
    }

    #[tokio::test]
    async fn test_add_with_nonexistent_parent_fails() {
        let ctx = TestContext::new().await;

        let cmd = add_cmd_with_parent("Orphan task", "nonexistent");
        let result = cmd.execute(ctx.db()).await;
        assert!(result.is_err(), "Should fail with nonexistent parent");
    }

    #[tokio::test]
    async fn test_triage_moves_backlog_to_todo() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Backlog Task", "task", "backlog").await;

        triage_cmd("task1").execute(ctx.db()).await.unwrap();

        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("todo".to_string())
        );
    }

    #[tokio::test]
    async fn test_triage_from_non_backlog_fails() {
        let ctx = TestContext::new().await;
        // Use in_progress status - triage is idempotent for todo but fails for in_progress
        create_task(ctx.db(), "task1", "In Progress Task", "task", "in_progress").await;

        let result = triage_cmd("task1").execute(ctx.db()).await;
        assert!(result.is_err(), "Triage from in_progress should fail");

        // Status should remain unchanged
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("in_progress".to_string())
        );
    }

    #[tokio::test]
    async fn test_triage_already_todo_is_idempotent() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Todo Task", "task", "todo").await;

        let result = triage_cmd("task1").execute(ctx.db()).await.unwrap();
        assert!(
            result.already_in_target,
            "Triage should report already_in_target"
        );

        // Status should remain unchanged
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("todo".to_string())
        );
    }

    #[tokio::test]
    async fn test_start_moves_todo_to_in_progress() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Todo Task", "task", "todo").await;

        start_cmd("task1").execute(ctx.db()).await.unwrap();

        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("in_progress".to_string())
        );

        // Verify started_at was set
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.started_at.is_some(), "started_at should be set");
    }

    #[tokio::test]
    async fn test_start_from_backlog_fails() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Backlog Task", "task", "backlog").await;

        let result = start_cmd("task1").execute(ctx.db()).await;
        assert!(result.is_err(), "Start from backlog should fail");

        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("backlog".to_string())
        );
    }

    #[tokio::test]
    async fn test_start_already_in_progress_is_idempotent() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Active Task", "task", "in_progress").await;

        let result = start_cmd("task1").execute(ctx.db()).await;
        assert!(result.is_ok(), "Start on in_progress should be idempotent");

        let start_result = result.unwrap();
        assert!(
            start_result.already_in_target,
            "Should indicate already started"
        );
    }

    #[tokio::test]
    async fn test_submit_moves_in_progress_to_pending_review() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Active Task", "task", "in_progress").await;

        submit_cmd("task1").execute(ctx.db()).await.unwrap();

        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("pending_review".to_string())
        );
    }

    #[tokio::test]
    async fn test_done_moves_pending_review_to_done() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Review Task", "task", "pending_review").await;

        done_cmd("task1").execute(ctx.db()).await.unwrap();

        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("done".to_string())
        );

        // Verify completed_at was set
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.completed_at.is_some(), "completed_at should be set");
    }

    #[tokio::test]
    async fn test_done_with_incomplete_children_fails() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "parent", "Parent", "ticket", "pending_review").await;
        create_task(ctx.db(), "child", "Child", "task", "todo").await;
        create_child_of(ctx.db(), "child", "parent").await;

        let result = done_cmd("parent").execute(ctx.db()).await;
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

        create_task(ctx.db(), "parent", "Parent", "ticket", "pending_review").await;
        create_task(ctx.db(), "child1", "Child 1", "task", "done").await;
        create_task(ctx.db(), "child2", "Child 2", "task", "done").await;
        create_child_of(ctx.db(), "child1", "parent").await;
        create_child_of(ctx.db(), "child2", "parent").await;

        done_cmd("parent").execute(ctx.db()).await.unwrap();

        assert_eq!(
            get_task_status(ctx.db(), "parent").await,
            Some("done".to_string())
        );
    }

    #[tokio::test]
    async fn test_reject_moves_todo_to_rejected() {
        let ctx = TestContext::new().await;
        // Reject transitions from todo to rejected (not from pending_review)
        create_task(ctx.db(), "task1", "Todo Task", "task", "todo").await;

        reject_cmd("task1").execute(ctx.db()).await.unwrap();

        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("rejected".to_string())
        );
    }

    #[tokio::test]
    async fn test_reject_from_pending_review_fails() {
        let ctx = TestContext::new().await;
        // pending_review -> rejected is not a valid transition
        create_task(ctx.db(), "task1", "Review Task", "task", "pending_review").await;

        let result = reject_cmd("task1").execute(ctx.db()).await;
        assert!(result.is_err(), "Reject from pending_review should fail");

        // Status should remain unchanged
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("pending_review".to_string())
        );
    }

    #[tokio::test]
    async fn test_complete_happy_path_lifecycle() {
        let ctx = TestContext::new().await;

        // 1. Add task (creates in backlog)
        let task_id = add_cmd("Lifecycle test task")
            .execute(ctx.db())
            .await
            .unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("backlog".to_string())
        );

        // 2. Triage (backlog -> todo)
        triage_cmd(&task_id).execute(ctx.db()).await.unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("todo".to_string())
        );

        // 3. Start (todo -> in_progress)
        start_cmd(&task_id).execute(ctx.db()).await.unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("in_progress".to_string())
        );

        // 4. Submit (in_progress -> pending_review)
        submit_cmd(&task_id).execute(ctx.db()).await.unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("pending_review".to_string())
        );

        // 5. Done (pending_review -> done)
        done_cmd(&task_id).execute(ctx.db()).await.unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("done".to_string())
        );

        // Verify timestamps
        let task = ctx.db().tasks().get(&task_id).await.unwrap().unwrap();
        assert!(task.started_at.is_some());
        assert!(task.completed_at.is_some());
    }

    // =========================================================================
    // BACKWARDS COMPATIBILITY TESTS (standalone start/done/submit/triage)
    // =========================================================================

    #[tokio::test]
    async fn test_standalone_start_works_identically_to_transition_to() {
        // Test that `vtb start` produces the same behavior as `vtb transition-to <id> in_progress`
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Todo Task", "task", "todo").await;

        // Use the standalone start command
        standalone_start_cmd("task1")
            .execute(ctx.db())
            .await
            .unwrap();

        // Verify same outcome as transition-to
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("in_progress".to_string())
        );

        // Verify started_at was set
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.started_at.is_some(), "started_at should be set");
    }

    #[tokio::test]
    async fn test_standalone_done_works_identically_to_transition_to() {
        // Test that `vtb done` produces the same behavior as `vtb transition-to <id> done`
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Review Task", "task", "pending_review").await;

        // Use the standalone done command
        standalone_done_cmd("task1")
            .execute(ctx.db())
            .await
            .unwrap();

        // Verify same outcome as transition-to
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("done".to_string())
        );

        // Verify completed_at was set
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.completed_at.is_some(), "completed_at should be set");
    }

    #[tokio::test]
    async fn test_standalone_commands_complete_happy_path() {
        // Test complete lifecycle using standalone commands
        let ctx = TestContext::new().await;

        // 1. Add task (creates in backlog)
        let task_id = add_cmd("Backwards compat test")
            .execute(ctx.db())
            .await
            .unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("backlog".to_string())
        );

        // 2. Transition to todo using transition-to command
        triage_cmd(&task_id).execute(ctx.db()).await.unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("todo".to_string())
        );

        // 3. Start using standalone command
        standalone_start_cmd(&task_id)
            .execute(ctx.db())
            .await
            .unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("in_progress".to_string())
        );

        // 4. Submit using transition-to command
        submit_cmd(&task_id).execute(ctx.db()).await.unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("pending_review".to_string())
        );

        // 5. Done using standalone command
        standalone_done_cmd(&task_id)
            .execute(ctx.db())
            .await
            .unwrap();
        assert_eq!(
            get_task_status(ctx.db(), &task_id).await,
            Some("done".to_string())
        );

        // Verify timestamps
        let task = ctx.db().tasks().get(&task_id).await.unwrap().unwrap();
        assert!(task.started_at.is_some());
        assert!(task.completed_at.is_some());
    }

    #[tokio::test]
    async fn test_standalone_start_from_backlog_fails() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Backlog Task", "task", "backlog").await;

        let result = standalone_start_cmd("task1").execute(ctx.db()).await;
        assert!(result.is_err(), "Start from backlog should fail");

        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("backlog".to_string())
        );
    }

    #[tokio::test]
    async fn test_standalone_done_with_incomplete_children_fails() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "parent", "Parent", "ticket", "pending_review").await;
        create_task(ctx.db(), "child", "Child", "task", "todo").await;
        create_child_of(ctx.db(), "child", "parent").await;

        let result = standalone_done_cmd("parent").execute(ctx.db()).await;
        match result {
            Err(DbError::IncompleteChildren { task_id, children }) => {
                assert_eq!(task_id, "parent");
                assert_eq!(children.len(), 1);
            }
            _ => panic!("Expected IncompleteChildren error"),
        }
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
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        section_cmd("task1", SectionType::Goal, "Implement authentication")
            .execute(ctx.db())
            .await
            .unwrap();

        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].section_type, SectionType::Goal);
        assert_eq!(task.sections[0].content, "Implement authentication");
    }

    #[tokio::test]
    async fn test_single_instance_section_replaces_existing() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Add first goal
        section_cmd("task1", SectionType::Goal, "Original goal")
            .execute(ctx.db())
            .await
            .unwrap();

        // Add second goal - should replace
        let result = section_cmd("task1", SectionType::Goal, "Updated goal")
            .execute(ctx.db())
            .await
            .unwrap();
        assert!(result.replaced, "Second goal should indicate replacement");

        // Verify only one goal exists with new content
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].content, "Updated goal");
    }

    #[tokio::test]
    async fn test_add_multiple_steps_incrementing_ordinals() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Add 5 steps
        for i in 0..5 {
            let result = section_cmd("task1", SectionType::Step, &format!("Step {}", i + 1))
                .execute(ctx.db())
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
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections.len(), 5);
    }

    #[tokio::test]
    async fn test_add_all_nine_section_types() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

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
                .execute(ctx.db())
                .await
                .unwrap();
        }

        // Verify all 9 sections exist
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.sections.len(), 9);
    }

    #[tokio::test]
    async fn test_section_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        let result = section_cmd("nonexistent", SectionType::Goal, "The goal")
            .execute(ctx.db())
            .await;
        assert!(matches!(result, Err(DbError::TaskNotFound { .. })));
    }

    #[tokio::test]
    async fn test_section_empty_content_fails() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        let result = section_cmd("task1", SectionType::Goal, "")
            .execute(ctx.db())
            .await;
        assert!(result.is_err(), "Empty content should fail");
    }

    #[tokio::test]
    async fn test_section_content_with_unicode() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        let unicode_content = "Unicode: \u{1F600} emoji, \u{4E2D}\u{6587} Chinese";
        section_cmd("task1", SectionType::Goal, unicode_content)
            .execute(ctx.db())
            .await
            .unwrap();

        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
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

        create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;
        create_task(ctx.db(), "dependent", "Dependent", "task", "todo").await;

        let result = depend_cmd("dependent", "blocker")
            .execute(&ctx.service)
            .await
            .unwrap();

        assert_eq!(result.task_id, "dependent");
        assert_eq!(result.blocker_id, "blocker");
        assert!(!result.already_existed);

        assert!(dependency_exists(ctx.db(), "dependent", "blocker").await);
    }

    #[tokio::test]
    async fn test_dependency_is_idempotent() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "blocker", "Blocker", "task", "todo").await;
        create_task(ctx.db(), "dependent", "Dependent", "task", "todo").await;

        let result1 = depend_cmd("dependent", "blocker")
            .execute(&ctx.service)
            .await
            .unwrap();
        assert!(!result1.already_existed);

        let result2 = depend_cmd("dependent", "blocker")
            .execute(&ctx.service)
            .await
            .unwrap();
        assert!(result2.already_existed);
    }

    #[tokio::test]
    async fn test_self_dependency_fails() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

        let result = depend_cmd("task1", "task1").execute(&ctx.service).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_direct_cycle_detected() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "a", "Task A", "task", "todo").await;
        create_task(ctx.db(), "b", "Task B", "task", "todo").await;

        // A depends on B
        depend_cmd("a", "b").execute(&ctx.service).await.unwrap();

        // B depends on A - should fail (creates A -> B -> A cycle)
        let result = depend_cmd("b", "a").execute(&ctx.service).await;
        assert!(result.is_err());

        // Verify the cycle-creating edge was NOT added
        assert!(!dependency_exists(ctx.db(), "b", "a").await);
    }

    #[tokio::test]
    async fn test_transitive_cycle_detected() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "a", "Task A", "task", "todo").await;
        create_task(ctx.db(), "b", "Task B", "task", "todo").await;
        create_task(ctx.db(), "c", "Task C", "task", "todo").await;

        // A -> B -> C chain
        depend_cmd("a", "b").execute(&ctx.service).await.unwrap();
        depend_cmd("b", "c").execute(&ctx.service).await.unwrap();

        // C -> A would create cycle
        let result = depend_cmd("c", "a").execute(&ctx.service).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_diamond_dependency_allowed() {
        let ctx = TestContext::new().await;

        // Diamond: D depends on B and C, both B and C depend on A
        create_task(ctx.db(), "a", "Task A", "task", "done").await;
        create_task(ctx.db(), "b", "Task B", "task", "todo").await;
        create_task(ctx.db(), "c", "Task C", "task", "todo").await;
        create_task(ctx.db(), "d", "Task D", "task", "todo").await;

        depend_cmd("b", "a").execute(&ctx.service).await.unwrap();
        depend_cmd("c", "a").execute(&ctx.service).await.unwrap();
        depend_cmd("d", "b").execute(&ctx.service).await.unwrap();
        depend_cmd("d", "c").execute(&ctx.service).await.unwrap(); // Should succeed

        // Verify all 4 edges exist
        assert!(dependency_exists(ctx.db(), "b", "a").await);
        assert!(dependency_exists(ctx.db(), "c", "a").await);
        assert!(dependency_exists(ctx.db(), "d", "b").await);
        assert!(dependency_exists(ctx.db(), "d", "c").await);
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
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        let result = ref_cmd("task1", "src/main.rs")
            .execute(&ctx.service)
            .await
            .unwrap();

        assert_eq!(result.id, "task1");
        assert_eq!(result.path, "src/main.rs");
        assert!(result.line_start.is_none());

        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");
    }

    #[tokio::test]
    async fn test_add_reference_with_line_range() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        let result = ref_cmd("task1", "src/auth.rs:L45-67")
            .execute(&ctx.service)
            .await
            .unwrap();

        assert_eq!(result.line_start, Some(45));
        assert_eq!(result.line_end, Some(67));

        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.code_refs[0].line_start, Some(45));
        assert_eq!(task.code_refs[0].line_end, Some(67));
    }

    #[tokio::test]
    async fn test_add_reference_with_name() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        ref_cmd_full("task1", "src/auth.rs:L45-67", Some("hash_password"), None)
            .execute(&ctx.service)
            .await
            .unwrap();

        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.code_refs[0].name, Some("hash_password".to_string()));
    }

    #[tokio::test]
    async fn test_ref_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        let result = ref_cmd("nonexistent", "src/main.rs")
            .execute(&ctx.service)
            .await;
        assert!(result.is_err(), "Should fail for nonexistent task");
    }

    #[tokio::test]
    async fn test_ref_invalid_line_range_start_gt_end() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        let result = ref_cmd("task1", "src/auth.rs:L67-45") // start > end
            .execute(&ctx.service)
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

        let result = list_cmd().execute(ctx.db()).await.unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_list_excludes_done_by_default() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "task1", "Todo Task", "task", "todo").await;
        create_task(ctx.db(), "task2", "Done Task", "task", "done").await;
        create_task(ctx.db(), "task3", "InProgress Task", "task", "in_progress").await;

        let result = list_cmd().execute(ctx.db()).await.unwrap();

        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|t| t.status != "done"));
    }

    #[tokio::test]
    async fn test_list_includes_done_with_all_flag() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "task1", "Todo Task", "task", "todo").await;
        create_task(ctx.db(), "task2", "Done Task", "task", "done").await;

        let mut cmd = list_cmd();
        cmd.all = true;
        let result = cmd.execute(ctx.db()).await.unwrap();

        assert_eq!(result.len(), 2);
    }

    #[tokio::test]
    async fn test_list_filter_by_level() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "epic1", "Epic", "epic", "todo").await;
        create_task(ctx.db(), "ticket1", "Ticket", "ticket", "todo").await;
        create_task(ctx.db(), "task1", "Task", "task", "todo").await;

        let mut cmd = list_cmd();
        cmd.levels = vec![Level::Epic];
        let result = cmd.execute(ctx.db()).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].level, "epic");
    }

    #[tokio::test]
    async fn test_list_filter_by_status() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "task1", "Backlog", "task", "backlog").await;
        create_task(ctx.db(), "task2", "Todo", "task", "todo").await;
        create_task(ctx.db(), "task3", "InProgress", "task", "in_progress").await;

        let mut cmd = list_cmd();
        cmd.statuses = vec![Status::Backlog];
        let result = cmd.execute(ctx.db()).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, "backlog");
    }

    #[tokio::test]
    async fn test_list_root_only() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "root1", "Root Epic", "epic", "todo").await;
        create_task(ctx.db(), "root2", "Root Ticket", "ticket", "todo").await;
        create_task(ctx.db(), "child1", "Child Task", "task", "todo").await;
        create_child_of(ctx.db(), "child1", "root1").await;

        let mut cmd = list_cmd();
        cmd.root = true;
        let result = cmd.execute(ctx.db()).await.unwrap();

        assert_eq!(result.len(), 2);
        let ids: Vec<_> = result.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"root1"));
        assert!(ids.contains(&"root2"));
        assert!(!ids.contains(&"child1"));
    }

    #[tokio::test]
    async fn test_list_children_of_parent() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "parent", "Parent Epic", "epic", "todo").await;
        create_task(ctx.db(), "child1", "Child 1", "ticket", "todo").await;
        create_task(ctx.db(), "child2", "Child 2", "ticket", "todo").await;
        create_task(ctx.db(), "other", "Other Task", "task", "todo").await;
        create_child_of(ctx.db(), "child1", "parent").await;
        create_child_of(ctx.db(), "child2", "parent").await;

        let mut cmd = list_cmd();
        cmd.children = Some("parent".to_string());
        let result = cmd.execute(ctx.db()).await.unwrap();

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

        create_task(ctx.db(), "task1", "Authentication feature", "task", "todo").await;
        create_task(ctx.db(), "task2", "Database migration", "task", "todo").await;
        create_task(ctx.db(), "task3", "API endpoint", "task", "todo").await;

        let cmd = list_cmd_with_search("auth");
        let result = cmd.execute(ctx.db()).await.unwrap();

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
            ctx.db(),
            "task1",
            "Feature A",
            "task",
            "todo",
            "Implement user authentication system",
        )
        .await;
        create_task_with_description(
            ctx.db(),
            "task2",
            "Feature B",
            "task",
            "todo",
            "Add database caching",
        )
        .await;

        let cmd = list_cmd_with_search("authentication");
        let result = cmd.execute(ctx.db()).await.unwrap();

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

        create_task(ctx.db(), "task1", "AUTHENTICATION Feature", "task", "todo").await;
        create_task(ctx.db(), "task2", "Other task", "task", "todo").await;

        // Search with lowercase should find uppercase title
        let cmd = list_cmd_with_search("authentication");
        let result = cmd.execute(ctx.db()).await.unwrap();

        assert_eq!(result.len(), 1, "Search should be case-insensitive");
        assert_eq!(result[0].id, "task1");

        // Search with uppercase should also find
        let cmd2 = list_cmd_with_search("AUTHENTICATION");
        let result2 = cmd2.execute(ctx.db()).await.unwrap();

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

        create_task(ctx.db(), "task1", "Auth task", "task", "todo").await;
        create_task(ctx.db(), "task2", "Auth in progress", "task", "in_progress").await;
        create_task(ctx.db(), "task3", "Other task", "task", "todo").await;

        // Search for "auth" AND status=in_progress
        let mut cmd = list_cmd_with_search("auth");
        cmd.statuses = vec![Status::InProgress];
        let result = cmd.execute(ctx.db()).await.unwrap();

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

        create_task(ctx.db(), "task1", "Task A", "task", "todo").await;
        create_task(ctx.db(), "task2", "Task B", "task", "todo").await;

        let cmd = list_cmd_with_search("nonexistent");
        let result = cmd.execute(ctx.db()).await.unwrap();

        assert!(
            result.is_empty(),
            "Search with no matches should return empty list"
        );
    }

    #[tokio::test]
    async fn test_tag_behavior_unchanged_or_semantics() {
        let ctx = TestContext::new().await;

        create_task_with_tags(ctx.db(), "task1", "Task 1", "task", "todo", &["backend"]).await;
        create_task_with_tags(ctx.db(), "task2", "Task 2", "task", "todo", &["frontend"]).await;
        create_task_with_tags(
            ctx.db(),
            "task3",
            "Task 3",
            "task",
            "todo",
            &["backend", "api"],
        )
        .await;
        create_task_with_tags(ctx.db(), "task4", "Task 4", "task", "todo", &["other"]).await;

        // Filter by multiple tags (OR semantics)
        let mut cmd = list_cmd();
        cmd.tags = vec!["backend".to_string(), "frontend".to_string()];
        let result = cmd.execute(ctx.db()).await.unwrap();

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

        create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;

        let cmd = list_cmd_with_search("");
        let result = cmd.execute(ctx.db()).await;

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

        let result = triage_cmd("nonexistent").execute(ctx.db()).await;
        assert!(
            matches!(result, Err(DbError::TaskNotFound { task_id }) if task_id == "nonexistent")
        );
    }

    #[tokio::test]
    async fn test_start_nonexistent_task() {
        let ctx = TestContext::new().await;

        let result = start_cmd("nonexistent").execute(ctx.db()).await;
        assert!(matches!(result, Err(DbError::TaskNotFound { .. })));
    }

    #[tokio::test]
    async fn test_done_nonexistent_task() {
        let ctx = TestContext::new().await;

        let result = done_cmd("nonexistent").execute(ctx.db()).await;
        assert!(matches!(result, Err(DbError::TaskNotFound { .. })));
    }

    #[tokio::test]
    async fn test_invalid_status_transition_todo_to_done() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Task", "task", "todo").await;

        let result = done_cmd("task1").execute(ctx.db()).await;
        assert!(matches!(
            result,
            Err(DbError::InvalidStatusTransition { .. })
        ));
    }

    #[tokio::test]
    async fn test_invalid_status_transition_backlog_to_in_progress() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Task", "task", "backlog").await;

        let result = start_cmd("task1").execute(ctx.db()).await;
        assert!(matches!(
            result,
            Err(DbError::InvalidStatusTransition { .. })
        ));
    }

    #[tokio::test]
    async fn test_failed_transition_preserves_status() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Task", "task", "todo").await;

        let _ = done_cmd("task1").execute(ctx.db()).await;

        // Status should be unchanged
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
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
        create_task(ctx.db(), "task1", "Task to delete", "task", "todo").await;

        delete_cmd("task1", false).execute(ctx.db()).await.unwrap();

        assert!(!task_exists(ctx.db(), "task1").await);
    }

    #[tokio::test]
    async fn test_delete_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        let result = delete_cmd("nonexistent", false).execute(ctx.db()).await;
        assert!(matches!(result, Err(DbError::TaskNotFound { .. })));
    }

    #[tokio::test]
    async fn test_delete_cascade_children() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
        create_task(ctx.db(), "child1", "Child 1", "ticket", "todo").await;
        create_task(ctx.db(), "child2", "Child 2", "ticket", "todo").await;
        create_child_of(ctx.db(), "child1", "parent").await;
        create_child_of(ctx.db(), "child2", "parent").await;

        delete_cmd("parent", true).execute(ctx.db()).await.unwrap();

        // All should be deleted
        assert!(!task_exists(ctx.db(), "parent").await);
        assert!(!task_exists(ctx.db(), "child1").await);
        assert!(!task_exists(ctx.db(), "child2").await);
    }

    #[tokio::test]
    async fn test_delete_orphans_children() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
        create_task(ctx.db(), "child1", "Child 1", "ticket", "todo").await;
        create_child_of(ctx.db(), "child1", "parent").await;

        delete_cmd("parent", false).execute(ctx.db()).await.unwrap(); // No cascade

        // Parent deleted
        assert!(!task_exists(ctx.db(), "parent").await);
        // Child still exists but orphaned
        assert!(task_exists(ctx.db(), "child1").await);
    }

    #[tokio::test]
    async fn test_export_empty_database() {
        let ctx = TestContext::new().await;

        let result = export_cmd(None).execute(ctx.db()).await.unwrap();

        assert_eq!(result.tasks, 0);
        assert_eq!(result.child_of_relations, 0);
        assert_eq!(result.depends_on_relations, 0);
    }

    #[tokio::test]
    async fn test_export_with_relationships() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "epic", "Epic", "epic", "todo").await;
        create_task(ctx.db(), "ticket", "Ticket", "ticket", "todo").await;
        create_task(ctx.db(), "blocker", "Blocker", "task", "done").await;
        create_child_of(ctx.db(), "ticket", "epic").await;
        create_depends_on(ctx.db(), "ticket", "blocker").await;

        let result = export_cmd(None).execute(ctx.db()).await.unwrap();

        assert_eq!(result.tasks, 3);
        assert_eq!(result.child_of_relations, 1);
        assert_eq!(result.depends_on_relations, 1);
    }
}

// =============================================================================
// BOUNDARY AND EDGE CASE TESTS
// =============================================================================

// =============================================================================
// TRIAGE VALIDATION TESTS
// =============================================================================

mod triage_validation {
    use super::*;

    #[tokio::test]
    async fn test_triage_blocks_task_without_required_sections() {
        let ctx = TestContext::new().await;
        create_task(
            ctx.db(),
            "task1",
            "Task without sections",
            "task",
            "backlog",
        )
        .await;

        // Use transition with validation enabled
        let result = triage_cmd_with_validation("task1").execute(ctx.db()).await;

        // Should fail due to missing required sections
        match result {
            Err(DbError::TriageValidationFailed {
                task_id,
                error_count,
                ..
            }) => {
                assert_eq!(task_id, "task1");
                assert!(
                    error_count >= 3,
                    "Should have at least 3 errors (testing_criterion, step, constraint)"
                );
            }
            Err(other) => panic!("Expected TriageValidationFailed, got: {:?}", other),
            Ok(_) => panic!("Expected validation to fail for task without required sections"),
        }

        // Task should remain in backlog
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("backlog".to_string())
        );
    }

    #[tokio::test]
    async fn test_triage_succeeds_with_all_required_sections() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "task1", "Well-prepared task", "task", "backlog").await;

        // Add required sections
        section_cmd(
            "task1",
            SectionType::TestingCriterion,
            "Unit test: verify input validation",
        )
        .execute(ctx.db())
        .await
        .unwrap();
        section_cmd(
            "task1",
            SectionType::TestingCriterion,
            "Integration test: verify end-to-end flow",
        )
        .execute(ctx.db())
        .await
        .unwrap();
        section_cmd("task1", SectionType::Step, "1. Implement the feature")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd(
            "task1",
            SectionType::Constraint,
            "Must follow existing code patterns",
        )
        .execute(ctx.db())
        .await
        .unwrap();
        section_cmd(
            "task1",
            SectionType::Constraint,
            "Tests must have specific assertions",
        )
        .execute(ctx.db())
        .await
        .unwrap();
        // Add encouraged sections to avoid warnings
        section_cmd("task1", SectionType::AntiPattern, "Don't hardcode values")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd(
            "task1",
            SectionType::FailureTest,
            "Should fail with invalid input",
        )
        .execute(ctx.db())
        .await
        .unwrap();
        // Add recommended sections
        section_cmd("task1", SectionType::Goal, "Implement feature X")
            .execute(ctx.db())
            .await
            .unwrap();

        // Triage should succeed with validation
        let result = triage_cmd_with_validation("task1").execute(ctx.db()).await;
        assert!(result.is_ok(), "Triage should succeed: {:?}", result.err());

        // Task should be in todo
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("todo".to_string())
        );
    }

    #[tokio::test]
    async fn test_triage_warns_about_missing_encouraged_sections() {
        let ctx = TestContext::new().await;
        create_task(
            ctx.db(),
            "task1",
            "Task with required only",
            "task",
            "backlog",
        )
        .await;

        // Add only required sections (no anti_pattern or failure_test)
        section_cmd("task1", SectionType::TestingCriterion, "Test 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::TestingCriterion, "Test 2")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Step, "Step 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Constraint, "Constraint 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Constraint, "Constraint 2")
            .execute(ctx.db())
            .await
            .unwrap();
        // Add recommended sections to avoid notes
        section_cmd("task1", SectionType::Goal, "Goal")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Context, "Context")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::CurrentBehavior, "Current")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::DesiredBehavior, "Desired")
            .execute(ctx.db())
            .await
            .unwrap();

        // Triage should fail with warnings (need --force)
        let result = triage_cmd_with_validation("task1").execute(ctx.db()).await;

        match result {
            Err(DbError::ValidationError { message }) => {
                assert!(message.contains("validation warnings"));
                assert!(message.contains("--force"));
            }
            Err(other) => panic!("Expected ValidationError for warnings, got: {:?}", other),
            Ok(_) => panic!("Expected validation warning to block triage without --force"),
        }

        // Task should remain in backlog
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("backlog".to_string())
        );
    }

    #[tokio::test]
    async fn test_triage_force_bypasses_warnings() {
        let ctx = TestContext::new().await;
        create_task(
            ctx.db(),
            "task1",
            "Task with required only",
            "task",
            "backlog",
        )
        .await;

        // Add only required sections (no anti_pattern or failure_test)
        section_cmd("task1", SectionType::TestingCriterion, "Test 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::TestingCriterion, "Test 2")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Step, "Step 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Constraint, "Constraint 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Constraint, "Constraint 2")
            .execute(ctx.db())
            .await
            .unwrap();
        // Add recommended sections
        section_cmd("task1", SectionType::Goal, "Goal")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Context, "Context")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::CurrentBehavior, "Current")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::DesiredBehavior, "Desired")
            .execute(ctx.db())
            .await
            .unwrap();

        // Triage with --force should succeed despite warnings
        let result = triage_cmd_force("task1").execute(ctx.db()).await;
        assert!(
            result.is_ok(),
            "Triage with --force should succeed: {:?}",
            result.err()
        );

        // Task should be in todo
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("todo".to_string())
        );

        // Result should indicate warnings were forced
        let transition_result = result.unwrap();
        assert!(transition_result.warnings_forced);
    }

    #[tokio::test]
    async fn test_triage_force_cannot_bypass_errors() {
        let ctx = TestContext::new().await;
        create_task(
            ctx.db(),
            "task1",
            "Task missing required",
            "task",
            "backlog",
        )
        .await;

        // Only add anti_pattern (encouraged) - still missing required sections
        section_cmd("task1", SectionType::AntiPattern, "Don't do X")
            .execute(ctx.db())
            .await
            .unwrap();

        // Triage with --force should still fail due to missing required sections
        let result = triage_cmd_force("task1").execute(ctx.db()).await;

        match result {
            Err(DbError::TriageValidationFailed { error_count, .. }) => {
                assert!(
                    error_count >= 3,
                    "Should have errors for missing required sections"
                );
            }
            Err(other) => panic!("Expected TriageValidationFailed, got: {:?}", other),
            Ok(_) => panic!("--force should not bypass required section errors"),
        }

        // Task should remain in backlog
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("backlog".to_string())
        );
    }

    #[tokio::test]
    async fn test_triage_skip_validation_bypasses_everything() {
        let ctx = TestContext::new().await;
        create_task(
            ctx.db(),
            "task1",
            "Task with no sections",
            "task",
            "backlog",
        )
        .await;

        // Use regular triage command which has skip_validation=true by default
        let result = triage_cmd("task1").execute(ctx.db()).await;
        assert!(
            result.is_ok(),
            "Triage with skip_validation should succeed: {:?}",
            result.err()
        );

        // Task should be in todo
        assert_eq!(
            get_task_status(ctx.db(), "task1").await,
            Some("todo".to_string())
        );

        // Result should indicate validation was skipped
        let transition_result = result.unwrap();
        assert!(transition_result.validation_skipped);
    }

    #[tokio::test]
    async fn test_triage_validation_checks_specific_counts() {
        let ctx = TestContext::new().await;
        create_task(
            ctx.db(),
            "task1",
            "Task with insufficient sections",
            "task",
            "backlog",
        )
        .await;

        // Add goal (satisfies required goal/desired_behavior)
        section_cmd("task1", SectionType::Goal, "Clear objective")
            .execute(ctx.db())
            .await
            .unwrap();
        // Add only 1 testing_criterion (need 2)
        section_cmd("task1", SectionType::TestingCriterion, "Test 1")
            .execute(ctx.db())
            .await
            .unwrap();
        // Add 1 step (sufficient)
        section_cmd("task1", SectionType::Step, "Step 1")
            .execute(ctx.db())
            .await
            .unwrap();
        // Add only 1 constraint (need 2)
        section_cmd("task1", SectionType::Constraint, "Constraint 1")
            .execute(ctx.db())
            .await
            .unwrap();

        let result = triage_cmd_with_validation("task1").execute(ctx.db()).await;

        match result {
            Err(DbError::TriageValidationFailed {
                error_count,
                details,
                ..
            }) => {
                assert_eq!(
                    error_count, 2,
                    "Should have exactly 2 errors (testing_criterion and constraint): {details}"
                );
                assert!(
                    details.contains("testing_criterion"),
                    "Error should mention testing_criterion"
                );
                assert!(
                    details.contains("constraint"),
                    "Error should mention constraint"
                );
            }
            Err(other) => panic!("Expected TriageValidationFailed, got: {:?}", other),
            Ok(_) => panic!("Expected validation to fail with insufficient counts"),
        }
    }

    #[tokio::test]
    async fn test_triage_validation_result_shows_notes() {
        let ctx = TestContext::new().await;
        create_task(
            ctx.db(),
            "task1",
            "Task without recommended sections",
            "task",
            "backlog",
        )
        .await;

        // Add all required and encouraged sections
        section_cmd("task1", SectionType::Goal, "Clear objective")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::TestingCriterion, "Test 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::TestingCriterion, "Test 2")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Step, "Step 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Constraint, "Constraint 1")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::Constraint, "Constraint 2")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::AntiPattern, "Anti-pattern")
            .execute(ctx.db())
            .await
            .unwrap();
        section_cmd("task1", SectionType::FailureTest, "Failure test")
            .execute(ctx.db())
            .await
            .unwrap();
        // No context, current_behavior - should be notes

        // Triage should succeed but have notes
        let result = triage_cmd_with_validation("task1").execute(ctx.db()).await;
        assert!(result.is_ok(), "Triage should succeed: {:?}", result.err());

        let transition_result = result.unwrap();
        assert!(transition_result.validation.is_some());

        let validation = transition_result.validation.unwrap();
        assert!(
            validation.has_notes(),
            "Should have notes about missing recommended sections"
        );
        assert!(!validation.has_warnings());
        assert!(!validation.has_errors());
    }
}

mod boundary_edge_cases {
    use super::*;

    #[tokio::test]
    async fn test_very_long_title() {
        let ctx = TestContext::new().await;

        let long_title = "A".repeat(10000); // 10k characters
        let id = add_cmd(&long_title).execute(ctx.db()).await.unwrap();

        let task = ctx.db().tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.title, long_title);
    }

    #[tokio::test]
    async fn test_title_with_quotes() {
        let ctx = TestContext::new().await;

        let title = r#"Task with "quotes" and 'apostrophes'"#;
        let id = add_cmd(title).execute(ctx.db()).await.unwrap();

        let task = ctx.db().tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.title, title);
    }

    #[tokio::test]
    async fn test_title_with_unicode() {
        let ctx = TestContext::new().await;

        let title = "\u{1F600} Happy Task \u{4E2D}\u{6587}";
        let id = add_cmd(title).execute(ctx.db()).await.unwrap();

        let task = ctx.db().tasks().get(&id).await.unwrap().unwrap();
        assert_eq!(task.title, title);
    }

    #[tokio::test]
    async fn test_case_insensitive_task_id() {
        let ctx = TestContext::new().await;
        create_task(ctx.db(), "abc123", "Task", "task", "backlog").await;

        // Uppercase should work
        triage_cmd("ABC123").execute(ctx.db()).await.unwrap();

        assert_eq!(
            get_task_status(ctx.db(), "abc123").await,
            Some("todo".to_string())
        );
    }

    #[tokio::test]
    async fn test_many_tasks() {
        let ctx = TestContext::new().await;

        // Create 100 tasks
        for i in 0..100 {
            create_task(
                ctx.db(),
                &format!("task{}", i),
                &format!("Task {}", i),
                "task",
                "todo",
            )
            .await;
        }

        let result = list_cmd().execute(ctx.db()).await.unwrap();
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

            create_task(ctx.db(), &id, &format!("Level {}", i), level, "todo").await;

            if let Some(ref parent) = parent_id {
                create_child_of(ctx.db(), &id, parent).await;
            }

            parent_id = Some(id);
        }

        // Verify count
        assert_eq!(count_tasks(ctx.db()).await, 10);
    }
}

// =============================================================================
// WORKFLOW TESTS
// =============================================================================

mod workflows {
    use super::*;

    // =========================================================================
    // WORKFLOW CREATION TESTS
    // =========================================================================

    #[tokio::test]
    async fn test_workflow_add_creates_workflow_with_single_step() {
        let ctx = TestContext::new().await;

        let cmd = workflow_add_cmd("Review Workflow", "review", "code-reviewer");
        let result = cmd.execute(ctx.db()).await.expect("Add should succeed");

        assert!(
            result.starts_with("Created workflow: "),
            "Result should start with 'Created workflow: '"
        );

        let id = extract_workflow_id(&result);
        assert_eq!(id.len(), 6, "Workflow ID should be 6 characters");

        // Verify workflow was persisted
        let workflow = ctx.db().workflows().get(&id).await.unwrap();
        assert!(workflow.is_some(), "Workflow should exist in database");

        let workflow = workflow.unwrap();
        assert_eq!(workflow.name, "Review Workflow");
        assert!(workflow.description.is_none());
        assert_eq!(workflow.steps.len(), 1);
        assert_eq!(workflow.steps[0].name, "review");
        assert_eq!(
            workflow.steps[0].agent_config.model,
            Some("code-reviewer".to_string())
        );
        assert_eq!(workflow.steps[0].order, 0);
    }

    #[tokio::test]
    async fn test_workflow_add_with_description() {
        let ctx = TestContext::new().await;

        let cmd = workflow_add_cmd_with_description(
            "Described Workflow",
            "A workflow for code reviews",
            vec![("review", "code-reviewer")],
        );
        let result = cmd.execute(ctx.db()).await.expect("Add should succeed");
        let id = extract_workflow_id(&result);

        let workflow = ctx.db().workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.name, "Described Workflow");
        assert_eq!(
            workflow.description,
            Some("A workflow for code reviews".to_string())
        );
    }

    #[tokio::test]
    async fn test_workflow_add_with_multiple_steps() {
        let ctx = TestContext::new().await;

        let cmd = workflow_add_cmd_multi_step(
            "Multi-step Workflow",
            vec![
                ("review", "code-reviewer"),
                ("test", "tester"),
                ("deploy", "deployer"),
            ],
        );
        let result = cmd.execute(ctx.db()).await.expect("Add should succeed");
        let id = extract_workflow_id(&result);

        let workflow = ctx.db().workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.steps.len(), 3);

        // Verify steps are ordered correctly
        assert_eq!(workflow.steps[0].name, "review");
        assert_eq!(workflow.steps[0].order, 0);
        assert_eq!(workflow.steps[1].name, "test");
        assert_eq!(workflow.steps[1].order, 1);
        assert_eq!(workflow.steps[2].name, "deploy");
        assert_eq!(workflow.steps[2].order, 2);
    }

    #[tokio::test]
    async fn test_workflow_add_empty_name_fails() {
        let ctx = TestContext::new().await;

        let cmd = workflow_add_cmd("", "step1", "agent1");
        let result = cmd.execute(ctx.db()).await;

        assert!(result.is_err(), "Empty name should fail");
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("name required"),
                    "Error should mention name required: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_workflow_add_whitespace_name_fails() {
        let ctx = TestContext::new().await;

        let cmd = workflow_add_cmd("   ", "step1", "agent1");
        let result = cmd.execute(ctx.db()).await;

        assert!(result.is_err(), "Whitespace-only name should fail");
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("name required"),
                    "Error should mention name required: {}",
                    reason
                );
            }
            _ => panic!("Expected InvalidPath error"),
        }
    }

    #[tokio::test]
    async fn test_workflow_add_no_steps_fails() {
        let ctx = TestContext::new().await;

        let cmd = workflow_add_cmd_multi_step("No Steps Workflow", vec![]);
        let result = cmd.execute(ctx.db()).await;

        assert!(result.is_err(), "No steps should fail");
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("at least one step is required"),
                    "Error should mention step requirement: {}",
                    reason
                );
            }
            _ => panic!("Expected InvalidPath error"),
        }
    }

    #[tokio::test]
    async fn test_workflow_add_generates_unique_ids() {
        let ctx = TestContext::new().await;

        let mut ids = std::collections::HashSet::new();

        for i in 0..10 {
            let cmd = workflow_add_cmd(&format!("Workflow {}", i), "step1", "agent1");
            let result = cmd.execute(ctx.db()).await.unwrap();
            let id = extract_workflow_id(&result);

            assert!(
                ids.insert(id.clone()),
                "Workflow ID {} should be unique",
                id
            );
        }

        assert_eq!(ids.len(), 10, "Should have 10 unique workflow IDs");
    }

    // =========================================================================
    // WORKFLOW PERSISTENCE AND RETRIEVAL TESTS
    // =========================================================================

    #[tokio::test]
    async fn test_workflow_show_displays_details() {
        let ctx = TestContext::new().await;

        // Create a workflow
        let add_cmd = workflow_add_cmd_with_description(
            "Show Test Workflow",
            "Test description",
            vec![("step1", "agent1"), ("step2", "agent2")],
        );
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let id = extract_workflow_id(&result);

        // Show the workflow
        let show_cmd = workflow_show_cmd(&id);
        let output = show_cmd.execute(ctx.db()).await.unwrap();

        assert!(output.contains("Show Test Workflow"));
        assert!(output.contains("Test description"));
        assert!(output.contains("step1"));
        assert!(output.contains("step2"));
        assert!(output.contains("agent1"));
        assert!(output.contains("agent2"));
    }

    #[tokio::test]
    async fn test_workflow_show_nonexistent_fails() {
        let ctx = TestContext::new().await;

        let show_cmd = workflow_show_cmd("nonexistent");
        let result = show_cmd.execute(ctx.db()).await;

        assert!(result.is_err(), "Showing nonexistent workflow should fail");
        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "workflow");
                assert_eq!(id, "nonexistent");
            }
            _ => panic!("Expected NotFound error"),
        }
    }

    #[tokio::test]
    async fn test_workflow_list_includes_created_workflows() {
        let ctx = TestContext::new().await;

        // Create some workflows
        let cmd1 = workflow_add_cmd("Workflow A", "step1", "agent1");
        let cmd2 = workflow_add_cmd("Workflow B", "step1", "agent1");
        cmd1.execute(ctx.db()).await.unwrap();
        cmd2.execute(ctx.db()).await.unwrap();

        // List workflows
        let list_cmd = workflow_list_cmd();
        let output = list_cmd.execute(ctx.db()).await.unwrap();

        assert!(output.contains("Workflow A"));
        assert!(output.contains("Workflow B"));
        // Default workflow should also be present
        assert!(output.contains("Default Workflow"));
    }

    #[tokio::test]
    async fn test_workflow_update_name() {
        let ctx = TestContext::new().await;

        // Create a workflow
        let add_cmd = workflow_add_cmd("Original Name", "step1", "agent1");
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let id = extract_workflow_id(&result);

        // Update the name
        let update_cmd = workflow_update_cmd(&id, Some("Updated Name"), None);
        update_cmd.execute(ctx.db()).await.unwrap();

        // Verify the update
        let workflow = ctx.db().workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.name, "Updated Name");
    }

    #[tokio::test]
    async fn test_workflow_update_description() {
        let ctx = TestContext::new().await;

        // Create a workflow without description
        let add_cmd = workflow_add_cmd("Test Workflow", "step1", "agent1");
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let id = extract_workflow_id(&result);

        // Update with description
        let update_cmd = workflow_update_cmd(&id, None, Some("New description"));
        update_cmd.execute(ctx.db()).await.unwrap();

        // Verify the update
        let workflow = ctx.db().workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.description, Some("New description".to_string()));
    }

    #[tokio::test]
    async fn test_workflow_delete() {
        let ctx = TestContext::new().await;

        // Create a workflow
        let add_cmd = workflow_add_cmd("To Delete", "step1", "agent1");
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let id = extract_workflow_id(&result);

        // Verify it exists
        assert!(workflow_exists(ctx.db(), &id).await);

        // Delete the workflow
        let delete_cmd = workflow_delete_cmd(&id);
        delete_cmd.execute(ctx.db()).await.unwrap();

        // Verify it's gone
        assert!(!workflow_exists(ctx.db(), &id).await);
    }

    #[tokio::test]
    async fn test_workflow_delete_nonexistent_fails() {
        let ctx = TestContext::new().await;

        let delete_cmd = workflow_delete_cmd("nonexistent");
        let result = delete_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "workflow");
                assert_eq!(id, "nonexistent");
            }
            _ => panic!("Expected NotFound error"),
        }
    }

    // =========================================================================
    // MULTI-STEP WORKFLOW SCENARIOS
    // =========================================================================

    #[tokio::test]
    async fn test_workflow_assign_task_to_workflow() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create a workflow
        let add_cmd = workflow_add_cmd_multi_step(
            "Test Workflow",
            vec![("step1", "agent1"), ("step2", "agent2")],
        );
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        // Assign task to workflow
        let assign_cmd = workflow_assign_cmd("task1", &workflow_id);
        let output = assign_cmd.execute(ctx.db()).await.unwrap();

        assert!(output.contains("Assigned task task1"));
        assert!(output.contains(&workflow_id));
        assert!(output.contains("step 1"));

        // Verify assignment
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.workflow_id.is_some());
        assert_eq!(task.current_step, Some(0));
    }

    #[tokio::test]
    async fn test_workflow_advance_through_steps() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create a 3-step workflow
        let add_cmd = workflow_add_cmd_multi_step(
            "Three Step Workflow",
            vec![
                ("step1", "agent1"),
                ("step2", "agent2"),
                ("step3", "agent3"),
            ],
        );
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        // Assign task to workflow
        let assign_cmd = workflow_assign_cmd("task1", &workflow_id);
        assign_cmd.execute(ctx.db()).await.unwrap();

        // Verify at step 0
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(0));

        // Advance to step 1
        let advance_cmd = workflow_advance_cmd("task1");
        let output = advance_cmd.execute(ctx.db()).await.unwrap();
        assert!(output.contains("step 2/3"));

        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(1));

        // Advance to step 2
        let advance_cmd = workflow_advance_cmd("task1");
        let output = advance_cmd.execute(ctx.db()).await.unwrap();
        assert!(output.contains("step 3/3"));

        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(2));
    }

    #[tokio::test]
    async fn test_workflow_advance_at_last_step_without_chaining_fails() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create a single-step workflow
        let add_cmd = workflow_add_cmd("Single Step", "only_step", "agent1");
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        // Assign task to workflow
        let assign_cmd = workflow_assign_cmd("task1", &workflow_id);
        assign_cmd.execute(ctx.db()).await.unwrap();

        // Try to advance - should fail since at last step
        let advance_cmd = workflow_advance_cmd("task1");
        let result = advance_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::ValidationError { message }) => {
                assert!(message.contains("last step"));
            }
            _ => panic!("Expected ValidationError about last step"),
        }
    }

    #[tokio::test]
    async fn test_workflow_retreat_through_steps() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create a workflow
        let add_cmd = workflow_add_cmd_multi_step(
            "Test Workflow",
            vec![("step1", "agent1"), ("step2", "agent2")],
        );
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        // Assign and advance
        let assign_cmd = workflow_assign_cmd("task1", &workflow_id);
        assign_cmd.execute(ctx.db()).await.unwrap();

        let advance_cmd = workflow_advance_cmd("task1");
        advance_cmd.execute(ctx.db()).await.unwrap();

        // Verify at step 1
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(1));

        // Retreat to step 0
        let retreat_cmd = workflow_retreat_cmd("task1");
        let output = retreat_cmd.execute(ctx.db()).await.unwrap();
        assert!(output.contains("step 1/2"));

        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(0));
    }

    #[tokio::test]
    async fn test_workflow_retreat_at_first_step_fails() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create a workflow
        let add_cmd = workflow_add_cmd("Test Workflow", "step1", "agent1");
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        // Assign task
        let assign_cmd = workflow_assign_cmd("task1", &workflow_id);
        assign_cmd.execute(ctx.db()).await.unwrap();

        // Try to retreat - should fail since at first step
        let retreat_cmd = workflow_retreat_cmd("task1");
        let result = retreat_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::ValidationError { message }) => {
                assert!(message.contains("first step"));
            }
            _ => panic!("Expected ValidationError about first step"),
        }
    }

    #[tokio::test]
    async fn test_workflow_unassign_task() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create and assign workflow
        let add_cmd = workflow_add_cmd("Test Workflow", "step1", "agent1");
        let result = add_cmd.execute(ctx.db()).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        let assign_cmd = workflow_assign_cmd("task1", &workflow_id);
        assign_cmd.execute(ctx.db()).await.unwrap();

        // Verify assigned
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.workflow_id.is_some());

        // Unassign
        let unassign_cmd = workflow_unassign_cmd("task1");
        unassign_cmd.execute(ctx.db()).await.unwrap();

        // Verify unassigned
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.workflow_id.is_none());
        assert!(task.current_step.is_none());
    }

    // =========================================================================
    // PIPELINE CHAINING TESTS (on_done/on_reject)
    // =========================================================================

    #[tokio::test]
    async fn test_workflow_add_with_on_done_chaining() {
        let ctx = TestContext::new().await;

        // Create target workflow first
        let target_cmd = workflow_add_cmd("Target Workflow", "deploy", "deployer");
        let target_result = target_cmd.execute(ctx.db()).await.unwrap();
        let target_id = extract_workflow_id(&target_result);

        // Create workflow with on_done chaining
        let cmd = workflow_add_cmd_with_chaining(
            "Review Workflow",
            vec![("review", "reviewer")],
            Some(&target_id),
            None,
        );
        let result = cmd.execute(ctx.db()).await.unwrap();
        let id = extract_workflow_id(&result);

        // Verify on_done_workflow was set
        let workflow = ctx.db().workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.on_done_workflow, Some(target_id));
        assert!(workflow.on_reject_workflow.is_none());
    }

    #[tokio::test]
    async fn test_workflow_add_with_on_reject_chaining() {
        let ctx = TestContext::new().await;

        // Create target workflow first
        let target_cmd = workflow_add_cmd("Rejection Handler", "handle_rejection", "handler");
        let target_result = target_cmd.execute(ctx.db()).await.unwrap();
        let target_id = extract_workflow_id(&target_result);

        // Create workflow with on_reject chaining
        let cmd = workflow_add_cmd_with_chaining(
            "Review Workflow",
            vec![("review", "reviewer")],
            None,
            Some(&target_id),
        );
        let result = cmd.execute(ctx.db()).await.unwrap();
        let id = extract_workflow_id(&result);

        // Verify on_reject_workflow was set
        let workflow = ctx.db().workflows().get(&id).await.unwrap().unwrap();
        assert!(workflow.on_done_workflow.is_none());
        assert_eq!(workflow.on_reject_workflow, Some(target_id));
    }

    #[tokio::test]
    async fn test_workflow_add_with_both_chaining() {
        let ctx = TestContext::new().await;

        // Create target workflows
        let done_cmd = workflow_add_cmd("Done Handler", "deploy", "deployer");
        let done_result = done_cmd.execute(ctx.db()).await.unwrap();
        let done_id = extract_workflow_id(&done_result);

        let reject_cmd = workflow_add_cmd("Reject Handler", "handle_rejection", "handler");
        let reject_result = reject_cmd.execute(ctx.db()).await.unwrap();
        let reject_id = extract_workflow_id(&reject_result);

        // Create workflow with both chains
        let cmd = workflow_add_cmd_with_chaining(
            "Main Workflow",
            vec![("review", "reviewer")],
            Some(&done_id),
            Some(&reject_id),
        );
        let result = cmd.execute(ctx.db()).await.unwrap();
        let id = extract_workflow_id(&result);

        // Verify both were set
        let workflow = ctx.db().workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.on_done_workflow, Some(done_id));
        assert_eq!(workflow.on_reject_workflow, Some(reject_id));
    }

    #[tokio::test]
    async fn test_workflow_advance_triggers_on_done_chaining() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create target workflow
        let target_cmd = workflow_add_cmd_multi_step(
            "Deploy Workflow",
            vec![("stage", "stager"), ("prod", "deployer")],
        );
        let target_result = target_cmd.execute(ctx.db()).await.unwrap();
        let target_id = extract_workflow_id(&target_result);

        // Create source workflow with on_done chaining
        let source_cmd = workflow_add_cmd_with_chaining(
            "Review Workflow",
            vec![("review", "reviewer")],
            Some(&target_id),
            None,
        );
        let source_result = source_cmd.execute(ctx.db()).await.unwrap();
        let source_id = extract_workflow_id(&source_result);

        // Assign task to source workflow
        let assign_cmd = workflow_assign_cmd("task1", &source_id);
        assign_cmd.execute(ctx.db()).await.unwrap();

        // Task is at step 0 (last step of single-step workflow)
        // Advance should trigger chaining
        let advance_cmd = workflow_advance_cmd("task1");
        let output = advance_cmd.execute(ctx.db()).await.unwrap();

        assert!(output.contains("Completed workflow"));
        assert!(output.contains("chained"));
        assert!(output.contains(&target_id));

        // Verify task is now in target workflow at step 0
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.workflow_id.is_some());
        let workflow_thing = task.workflow_id.unwrap();
        assert_eq!(workflow_thing.id.to_raw(), target_id);
        assert_eq!(task.current_step, Some(0));
    }

    #[tokio::test]
    async fn test_workflow_reject_triggers_on_reject_chaining() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create target workflow for rejections
        let target_cmd = workflow_add_cmd("Fix Workflow", "fix", "fixer");
        let target_result = target_cmd.execute(ctx.db()).await.unwrap();
        let target_id = extract_workflow_id(&target_result);

        // Create source workflow with on_reject chaining
        let source_cmd = workflow_add_cmd_with_chaining(
            "Review Workflow",
            vec![("review", "reviewer")],
            None,
            Some(&target_id),
        );
        let source_result = source_cmd.execute(ctx.db()).await.unwrap();
        let source_id = extract_workflow_id(&source_result);

        // Assign task to source workflow
        let assign_cmd = workflow_assign_cmd("task1", &source_id);
        assign_cmd.execute(ctx.db()).await.unwrap();

        // Reject the task
        let reject_cmd = workflow_reject_cmd("task1");
        let output = reject_cmd.execute(ctx.db()).await.unwrap();

        assert!(output.contains("Rejected"));
        assert!(output.contains("chained"));
        assert!(output.contains(&target_id));

        // Verify task is now in target workflow at step 0
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.workflow_id.is_some());
        let workflow_thing = task.workflow_id.unwrap();
        assert_eq!(workflow_thing.id.to_raw(), target_id);
        assert_eq!(task.current_step, Some(0));
    }

    #[tokio::test]
    async fn test_workflow_reject_without_chaining_unassigns() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Create workflow without on_reject chaining
        let cmd = workflow_add_cmd("Review Workflow", "review", "reviewer");
        let result = cmd.execute(ctx.db()).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        // Assign task to workflow
        let assign_cmd = workflow_assign_cmd("task1", &workflow_id);
        assign_cmd.execute(ctx.db()).await.unwrap();

        // Reject the task
        let reject_cmd = workflow_reject_cmd("task1");
        let output = reject_cmd.execute(ctx.db()).await.unwrap();

        assert!(output.contains("Rejected"));
        assert!(output.contains("workflow unassigned"));

        // Verify task is unassigned
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert!(task.workflow_id.is_none());
        assert!(task.current_step.is_none());
    }

    // =========================================================================
    // ERROR HANDLING TESTS
    // =========================================================================

    #[tokio::test]
    async fn test_workflow_assign_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        // Create a workflow
        let cmd = workflow_add_cmd("Test Workflow", "step1", "agent1");
        let result = cmd.execute(ctx.db()).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        // Try to assign nonexistent task
        let assign_cmd = workflow_assign_cmd("nonexistent", &workflow_id);
        let result = assign_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "task");
                assert_eq!(id, "nonexistent");
            }
            _ => panic!("Expected NotFound error for task"),
        }
    }

    #[tokio::test]
    async fn test_workflow_assign_nonexistent_workflow_fails() {
        let ctx = TestContext::new().await;

        // Create a task
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Try to assign to nonexistent workflow
        let assign_cmd = workflow_assign_cmd("task1", "nonexistent");
        let result = assign_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "workflow");
                assert_eq!(id, "nonexistent");
            }
            _ => panic!("Expected NotFound error for workflow"),
        }
    }

    #[tokio::test]
    async fn test_workflow_advance_unassigned_task_fails() {
        let ctx = TestContext::new().await;

        // Create a task without workflow assignment
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Try to advance
        let advance_cmd = workflow_advance_cmd("task1");
        let result = advance_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::ValidationError { message }) => {
                assert!(message.contains("not assigned"));
            }
            _ => panic!("Expected ValidationError about not assigned"),
        }
    }

    #[tokio::test]
    async fn test_workflow_retreat_unassigned_task_fails() {
        let ctx = TestContext::new().await;

        // Create a task without workflow assignment
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Try to retreat
        let retreat_cmd = workflow_retreat_cmd("task1");
        let result = retreat_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::ValidationError { message }) => {
                assert!(message.contains("not assigned"));
            }
            _ => panic!("Expected ValidationError about not assigned"),
        }
    }

    #[tokio::test]
    async fn test_workflow_reject_unassigned_task_fails() {
        let ctx = TestContext::new().await;

        // Create a task without workflow assignment
        create_task(ctx.db(), "task1", "Test Task", "task", "todo").await;

        // Try to reject
        let reject_cmd = workflow_reject_cmd("task1");
        let result = reject_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::ValidationError { message }) => {
                assert!(message.contains("not assigned"));
            }
            _ => panic!("Expected ValidationError about not assigned"),
        }
    }

    #[tokio::test]
    async fn test_workflow_advance_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        let advance_cmd = workflow_advance_cmd("nonexistent");
        let result = advance_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "task");
                assert_eq!(id, "nonexistent");
            }
            _ => panic!("Expected NotFound error"),
        }
    }

    #[tokio::test]
    async fn test_workflow_unassign_nonexistent_task_fails() {
        let ctx = TestContext::new().await;

        let unassign_cmd = workflow_unassign_cmd("nonexistent");
        let result = unassign_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "task");
                assert_eq!(id, "nonexistent");
            }
            _ => panic!("Expected NotFound error"),
        }
    }

    #[tokio::test]
    async fn test_workflow_update_nonexistent_fails() {
        let ctx = TestContext::new().await;

        let update_cmd = workflow_update_cmd("nonexistent", Some("New Name"), None);
        let result = update_cmd.execute(ctx.db()).await;

        assert!(result.is_err());
        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "workflow");
                assert_eq!(id, "nonexistent");
            }
            _ => panic!("Expected NotFound error"),
        }
    }

    #[tokio::test]
    async fn test_workflow_case_insensitive_lookup() {
        let ctx = TestContext::new().await;

        // Create a workflow
        let cmd = workflow_add_cmd("Test Workflow", "step1", "agent1");
        let result = cmd.execute(ctx.db()).await.unwrap();
        let id = extract_workflow_id(&result);

        // Show with uppercase ID
        let uppercase_id = id.to_uppercase();
        let show_cmd = workflow_show_cmd(&uppercase_id);
        let result = show_cmd.execute(ctx.db()).await;

        assert!(result.is_ok(), "Should find workflow with uppercase ID");
    }

    #[tokio::test]
    async fn test_default_workflow_exists_on_init() {
        let ctx = TestContext::new().await;

        // Default workflow should be created during db.init()
        assert!(
            workflow_exists(ctx.db(), "default").await,
            "Default workflow should exist"
        );

        // Verify it has the expected structure
        let workflow = ctx.db().workflows().get("default").await.unwrap().unwrap();
        assert_eq!(workflow.name, "Default Workflow");
        assert_eq!(workflow.steps.len(), 5);
    }
}

// =============================================================================
// EXECUTION TRACKING TESTS
// =============================================================================

mod execution_tracking {
    use super::*;
    use vertebrae_db::ExecutionStatus;

    /// Helper to assign a task to the default workflow
    async fn assign_to_default_workflow(db: &vertebrae_db::Database, task_id: &str) {
        let workflow_thing = surrealdb::sql::Thing::from(("workflow", "default"));
        db.tasks()
            .assign_workflow(task_id, &workflow_thing)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_transition_creates_execution_record() {
        let ctx = TestContext::new().await;

        // Create task and assign to default workflow
        create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;
        assign_to_default_workflow(ctx.db(), "task1").await;

        // Transition to todo
        triage_cmd("task1").execute(ctx.db()).await.unwrap();

        // Verify execution record was created
        let executions = ctx
            .db()
            .executions()
            .list_executions_for_task("task1")
            .await
            .unwrap();
        assert_eq!(executions.len(), 1, "Should have one execution record");
        assert_eq!(executions[0].step_name, "todo");
        assert_eq!(executions[0].status, ExecutionStatus::InProgress);
        assert!(executions[0].completed_at.is_none());
    }

    #[tokio::test]
    async fn test_transition_completes_previous_execution() {
        let ctx = TestContext::new().await;

        // Create task and assign to default workflow
        create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;
        assign_to_default_workflow(ctx.db(), "task1").await;

        // Transition to todo then to in_progress
        triage_cmd("task1").execute(ctx.db()).await.unwrap();
        start_cmd("task1").execute(ctx.db()).await.unwrap();

        // Verify executions
        let executions = ctx
            .db()
            .executions()
            .list_executions_for_task("task1")
            .await
            .unwrap();
        assert_eq!(executions.len(), 2);

        // First execution (todo) should be completed
        assert_eq!(executions[0].step_name, "todo");
        assert_eq!(executions[0].status, ExecutionStatus::Completed);
        assert!(
            executions[0].completed_at.is_some(),
            "First execution should have completed_at"
        );

        // Second execution (in_progress) should be in progress
        assert_eq!(executions[1].step_name, "in_progress");
        assert_eq!(executions[1].status, ExecutionStatus::InProgress);
        assert!(
            executions[1].completed_at.is_none(),
            "Second execution should not have completed_at"
        );
    }

    #[tokio::test]
    async fn test_full_lifecycle_creates_all_executions() {
        let ctx = TestContext::new().await;

        // Create task and assign to default workflow
        create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;
        assign_to_default_workflow(ctx.db(), "task1").await;

        // Full lifecycle: backlog -> todo -> in_progress -> pending_review -> done
        triage_cmd("task1").execute(ctx.db()).await.unwrap();
        start_cmd("task1").execute(ctx.db()).await.unwrap();
        submit_cmd("task1").execute(ctx.db()).await.unwrap();
        done_cmd("task1").execute(ctx.db()).await.unwrap();

        // Verify all executions
        let executions = ctx
            .db()
            .executions()
            .list_executions_for_task("task1")
            .await
            .unwrap();
        assert_eq!(executions.len(), 4, "Should have 4 execution records");

        // Verify step names in order
        assert_eq!(executions[0].step_name, "todo");
        assert_eq!(executions[1].step_name, "in_progress");
        assert_eq!(executions[2].step_name, "pending_review");
        assert_eq!(executions[3].step_name, "done");

        // All except last should be completed
        for (i, exec) in executions.iter().enumerate() {
            if i < 3 {
                assert_eq!(
                    exec.status,
                    ExecutionStatus::Completed,
                    "Execution {} should be completed",
                    i
                );
                assert!(
                    exec.completed_at.is_some(),
                    "Execution {} should have completed_at",
                    i
                );
            } else {
                assert_eq!(
                    exec.status,
                    ExecutionStatus::InProgress,
                    "Last execution should be in progress"
                );
                assert!(
                    exec.completed_at.is_none(),
                    "Last execution should not have completed_at"
                );
            }
        }
    }

    #[tokio::test]
    async fn test_no_execution_for_task_without_workflow() {
        let ctx = TestContext::new().await;

        // Create task WITHOUT workflow assignment
        create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;

        // Transition through lifecycle
        triage_cmd("task1").execute(ctx.db()).await.unwrap();
        start_cmd("task1").execute(ctx.db()).await.unwrap();

        // Verify no execution records
        let executions = ctx
            .db()
            .executions()
            .list_executions_for_task("task1")
            .await
            .unwrap();
        assert!(
            executions.is_empty(),
            "Should have no execution records for task without workflow"
        );
    }

    #[tokio::test]
    async fn test_execution_timestamps_are_chronological() {
        let ctx = TestContext::new().await;

        // Create task and assign to default workflow
        create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;
        assign_to_default_workflow(ctx.db(), "task1").await;

        // Transition through steps
        triage_cmd("task1").execute(ctx.db()).await.unwrap();
        start_cmd("task1").execute(ctx.db()).await.unwrap();
        submit_cmd("task1").execute(ctx.db()).await.unwrap();

        let executions = ctx
            .db()
            .executions()
            .list_executions_for_task("task1")
            .await
            .unwrap();
        assert_eq!(executions.len(), 3);

        // Verify chronological order
        for i in 0..executions.len() - 1 {
            let current = &executions[i];
            let next = &executions[i + 1];

            // Each started_at should be <= next's started_at
            assert!(
                current.started_at <= next.started_at,
                "Execution {} started_at should be <= execution {} started_at",
                i,
                i + 1
            );

            // completed_at should be <= next's started_at
            if let Some(completed_at) = current.completed_at {
                assert!(
                    completed_at <= next.started_at,
                    "Execution {} completed_at should be <= execution {} started_at",
                    i,
                    i + 1
                );
            }
        }
    }

    #[tokio::test]
    async fn test_current_step_updated_on_transition() {
        let ctx = TestContext::new().await;

        // Create task and assign to default workflow
        create_task(ctx.db(), "task1", "Test Task", "task", "backlog").await;
        assign_to_default_workflow(ctx.db(), "task1").await;

        // Initial state - current_step should be 0 (backlog)
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(0));

        // Transition to todo (step 1)
        triage_cmd("task1").execute(ctx.db()).await.unwrap();
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(1));

        // Transition to in_progress (step 2)
        start_cmd("task1").execute(ctx.db()).await.unwrap();
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(2));

        // Transition to pending_review (step 3)
        submit_cmd("task1").execute(ctx.db()).await.unwrap();
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(3));

        // Transition to done (step 4)
        done_cmd("task1").execute(ctx.db()).await.unwrap();
        let task = ctx.db().tasks().get("task1").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(4));
    }
}
