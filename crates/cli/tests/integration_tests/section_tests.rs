//! Section and code reference tests
//!
//! Tests for section management (single and multi-instance types),
//! code references, step-done functionality, and criterion-ref.

use super::common::*;
use vertebrae_db::SectionType;

// =============================================================================
// Single-Instance Section Tests
// =============================================================================

#[tokio::test]
async fn test_section_add_goal() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = section_cmd("task1", SectionType::Goal, "Complete the implementation");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());

    let sections = get_task_sections_of_type(ctx.db(), "task1", SectionType::Goal).await;
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].content, "Complete the implementation");
}

#[tokio::test]
async fn test_section_add_context() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = section_cmd("task1", SectionType::Context, "Background information");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());

    let sections = get_task_sections_of_type(ctx.db(), "task1", SectionType::Context).await;
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].content, "Background information");
}

#[tokio::test]
async fn test_section_add_current_behavior() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = section_cmd("task1", SectionType::CurrentBehavior, "Currently does X");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());

    let sections = get_task_sections_of_type(ctx.db(), "task1", SectionType::CurrentBehavior).await;
    assert_eq!(sections.len(), 1);
}

#[tokio::test]
async fn test_section_add_desired_behavior() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = section_cmd("task1", SectionType::DesiredBehavior, "Should do Y");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());

    let sections = get_task_sections_of_type(ctx.db(), "task1", SectionType::DesiredBehavior).await;
    assert_eq!(sections.len(), 1);
}

#[tokio::test]
async fn test_single_instance_section_replaces_existing() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    // Add first goal
    section_cmd("task1", SectionType::Goal, "First goal")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Add second goal (should replace)
    section_cmd("task1", SectionType::Goal, "Second goal")
        .execute(&ctx.service)
        .await
        .unwrap();

    let sections = get_task_sections_of_type(ctx.db(), "task1", SectionType::Goal).await;
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0].content, "Second goal");
}

// =============================================================================
// Multi-Instance Section Tests
// =============================================================================

#[tokio::test]
async fn test_section_add_multiple_steps() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    section_cmd("task1", SectionType::Step, "First step")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Step, "Second step")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Step, "Third step")
        .execute(&ctx.service)
        .await
        .unwrap();

    let steps = get_task_steps(ctx.db(), "task1").await;
    assert_eq!(steps.len(), 3);
    assert_eq!(steps[0].content, "First step");
    assert_eq!(steps[1].content, "Second step");
    assert_eq!(steps[2].content, "Third step");
}

#[tokio::test]
async fn test_section_add_multiple_testing_criteria() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    section_cmd("task1", SectionType::TestingCriterion, "Should pass test 1")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::TestingCriterion, "Should pass test 2")
        .execute(&ctx.service)
        .await
        .unwrap();

    let criteria =
        get_task_sections_of_type(ctx.db(), "task1", SectionType::TestingCriterion).await;
    assert_eq!(criteria.len(), 2);
}

#[tokio::test]
async fn test_section_add_constraints() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    section_cmd(
        "task1",
        SectionType::Constraint,
        "Must be backwards compatible",
    )
    .execute(&ctx.service)
    .await
    .unwrap();
    section_cmd(
        "task1",
        SectionType::Constraint,
        "Must not break existing tests",
    )
    .execute(&ctx.service)
    .await
    .unwrap();

    let constraints = get_task_sections_of_type(ctx.db(), "task1", SectionType::Constraint).await;
    assert_eq!(constraints.len(), 2);
}

#[tokio::test]
async fn test_section_add_anti_patterns() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    section_cmd("task1", SectionType::AntiPattern, "Don't use global state")
        .execute(&ctx.service)
        .await
        .unwrap();

    let anti_patterns =
        get_task_sections_of_type(ctx.db(), "task1", SectionType::AntiPattern).await;
    assert_eq!(anti_patterns.len(), 1);
}

#[tokio::test]
async fn test_section_add_failure_tests() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    section_cmd(
        "task1",
        SectionType::FailureTest,
        "Should fail on invalid input",
    )
    .execute(&ctx.service)
    .await
    .unwrap();

    let failure_tests =
        get_task_sections_of_type(ctx.db(), "task1", SectionType::FailureTest).await;
    assert_eq!(failure_tests.len(), 1);
}

// =============================================================================
// Unsection Tests
// =============================================================================

#[tokio::test]
async fn test_unsection_remove_single_instance() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::Goal, "The goal")
        .execute(&ctx.service)
        .await
        .unwrap();

    let cmd = unsection_cmd_all_of_type("task1", SectionType::Goal);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let sections = get_task_sections_of_type(ctx.db(), "task1", SectionType::Goal).await;
    assert_eq!(sections.len(), 0);
}

#[tokio::test]
async fn test_unsection_remove_by_index() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::Step, "Step 1")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Step, "Step 2")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Step, "Step 3")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Remove step at index 1 (second step, 0-based)
    let cmd = unsection_cmd("task1", SectionType::Step, 1);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let steps = get_task_steps(ctx.db(), "task1").await;
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].content, "Step 1");
    assert_eq!(steps[1].content, "Step 3");
}

#[tokio::test]
async fn test_unsection_remove_all_of_type() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::Step, "Step 1")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Step, "Step 2")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Constraint, "Constraint")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Remove all steps
    let cmd = unsection_cmd_all_of_type("task1", SectionType::Step);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let steps = get_task_steps(ctx.db(), "task1").await;
    assert_eq!(steps.len(), 0);
    // Constraint should still exist
    let constraints = get_task_sections_of_type(ctx.db(), "task1", SectionType::Constraint).await;
    assert_eq!(constraints.len(), 1);
}

#[tokio::test]
async fn test_unsection_remove_all_sections() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::Goal, "Goal")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Step, "Step")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Constraint, "Constraint")
        .execute(&ctx.service)
        .await
        .unwrap();

    let cmd = unsection_cmd_all("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let all_sections = get_task_sections(ctx.db(), "task1").await;
    assert_eq!(all_sections.len(), 0);
}

// =============================================================================
// Step-Done Tests
// =============================================================================

#[tokio::test]
async fn test_step_done_marks_step_complete() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::Step, "First step")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Step, "Second step")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Mark first step as done (1-based index)
    let cmd = step_done_cmd("task1", 1);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let steps = get_task_steps(ctx.db(), "task1").await;
    assert_eq!(steps[0].done, Some(true));
    assert_eq!(steps[1].done, None);
}

#[tokio::test]
async fn test_step_done_second_step() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::Step, "First step")
        .execute(&ctx.service)
        .await
        .unwrap();
    section_cmd("task1", SectionType::Step, "Second step")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Mark second step as done
    let cmd = step_done_cmd("task1", 2);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let steps = get_task_steps(ctx.db(), "task1").await;
    assert_eq!(steps[0].done, None);
    assert_eq!(steps[1].done, Some(true));
}

#[tokio::test]
async fn test_step_done_invalid_index() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::Step, "Only step")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Try to mark step 5 as done when only 1 exists
    let cmd = step_done_cmd("task1", 5);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_step_done_zero_index_rejected() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::Step, "Step")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Index 0 is invalid (1-based)
    let cmd = step_done_cmd("task1", 0);
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

// =============================================================================
// Code Reference Tests
// =============================================================================

#[tokio::test]
async fn test_ref_add_simple() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = ref_cmd("task1", "src/main.rs");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let refs = get_task_refs(ctx.db(), "task1").await;
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].path, "src/main.rs");
}

#[tokio::test]
async fn test_ref_add_with_line_number() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = ref_cmd("task1", "src/lib.rs:L42");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let refs = get_task_refs(ctx.db(), "task1").await;
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].path, "src/lib.rs");
    assert_eq!(refs[0].line_start, Some(42));
}

#[tokio::test]
async fn test_ref_add_with_line_range() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = ref_cmd("task1", "src/lib.rs:L10-20");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let refs = get_task_refs(ctx.db(), "task1").await;
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].path, "src/lib.rs");
    assert_eq!(refs[0].line_start, Some(10));
    assert_eq!(refs[0].line_end, Some(20));
}

#[tokio::test]
async fn test_ref_add_with_name_and_description() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = ref_cmd_full(
        "task1",
        "src/service.rs:L100",
        Some("process_request"),
        Some("Main entry point"),
    );
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let refs = get_task_refs(ctx.db(), "task1").await;
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].name, Some("process_request".to_string()));
    assert_eq!(refs[0].description, Some("Main entry point".to_string()));
}

#[tokio::test]
async fn test_ref_add_multiple() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    ref_cmd("task1", "src/main.rs")
        .execute(&ctx.service)
        .await
        .unwrap();
    ref_cmd("task1", "src/lib.rs")
        .execute(&ctx.service)
        .await
        .unwrap();
    ref_cmd("task1", "tests/test.rs")
        .execute(&ctx.service)
        .await
        .unwrap();

    let refs = get_task_refs(ctx.db(), "task1").await;
    assert_eq!(refs.len(), 3);
}

// =============================================================================
// Unref Tests
// =============================================================================

#[tokio::test]
async fn test_unref_by_file() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    ref_cmd("task1", "src/main.rs")
        .execute(&ctx.service)
        .await
        .unwrap();
    ref_cmd("task1", "src/lib.rs")
        .execute(&ctx.service)
        .await
        .unwrap();

    let cmd = unref_cmd("task1", "src/main.rs");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let refs = get_task_refs(ctx.db(), "task1").await;
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].path, "src/lib.rs");
}

#[tokio::test]
async fn test_unref_all() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    ref_cmd("task1", "src/main.rs")
        .execute(&ctx.service)
        .await
        .unwrap();
    ref_cmd("task1", "src/lib.rs")
        .execute(&ctx.service)
        .await
        .unwrap();

    let cmd = unref_cmd_all("task1");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let refs = get_task_refs(ctx.db(), "task1").await;
    assert_eq!(refs.len(), 0);
}

// =============================================================================
// Criterion-Ref Tests
// =============================================================================

#[tokio::test]
async fn test_criterion_ref_adds_ref_to_criterion() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::TestingCriterion, "Should pass test")
        .execute(&ctx.service)
        .await
        .unwrap();

    let cmd = criterion_ref_cmd("task1", 1, "tests/test_feature.rs:L50");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());

    // The criterion should now have a ref attached
    let criteria =
        get_task_sections_of_type(ctx.db(), "task1", SectionType::TestingCriterion).await;
    assert_eq!(criteria.len(), 1);
    assert!(!criteria[0].refs.is_empty());
    assert_eq!(criteria[0].refs.len(), 1);
    assert_eq!(criteria[0].refs[0].path, "tests/test_feature.rs");
}

#[tokio::test]
async fn test_criterion_ref_with_name() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd(
        "task1",
        SectionType::TestingCriterion,
        "Should handle edge case",
    )
    .execute(&ctx.service)
    .await
    .unwrap();

    let cmd = criterion_ref_cmd_full(
        "task1",
        1,
        "tests/edge_cases.rs:L100-150",
        Some("test_edge_case"),
        Some("Tests the edge case"),
    );
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn test_criterion_ref_invalid_index() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;
    section_cmd("task1", SectionType::TestingCriterion, "Only criterion")
        .execute(&ctx.service)
        .await
        .unwrap();

    // Try to add ref to criterion 5 when only 1 exists
    let cmd = criterion_ref_cmd("task1", 5, "tests/test.rs");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_err());
}

// =============================================================================
// Case Insensitivity Tests
// =============================================================================

#[tokio::test]
async fn test_section_case_insensitive_id() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = section_cmd("TASK1", SectionType::Goal, "Goal with uppercase ID");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let sections = get_task_sections_of_type(ctx.db(), "task1", SectionType::Goal).await;
    assert_eq!(sections.len(), 1);
}

#[tokio::test]
async fn test_ref_case_insensitive_id() {
    let ctx = TestContext::new().await;

    create_task(ctx.db(), "task1", "Test Task", "task", "in_progress").await;

    let cmd = ref_cmd("TASK1", "src/file.rs");
    let result = cmd.execute(&ctx.service).await;

    assert!(result.is_ok());
    let refs = get_task_refs(ctx.db(), "task1").await;
    assert_eq!(refs.len(), 1);
}
