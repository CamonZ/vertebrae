//! Integration tests for the criterion_ref command
//!
//! Tests the `vtb criterion-ref` command which adds code references to testing
//! criterion sections within tasks. This command links test implementations to
//! the criteria they verify.

use super::mock::mock_services;
use vertebrae_cli::commands::*;
use vertebrae_core::{Section, SectionType};

/// Helper to create a task and return its ID
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

// ============================================================================
// Happy path tests: adding criterion refs successfully
// ============================================================================

#[tokio::test]
async fn test_criterion_ref_happy_path() {
    let services = mock_services();
    let task_id = create_task(&services, "Test task").await;

    // Add a testing criterion section
    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Verify the API returns 200 OK".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    // Add criterion ref to the first criterion
    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "tests/api_tests.rs:L45".to_string(),
        name: Some("test_api_200_response".to_string()),
        description: Some("Tests API endpoint for 200 response".to_string()),
    };

    let result = cmd.execute(&services).await.unwrap();

    // Verify the result structure
    assert_eq!(result.task_id, task_id);
    assert_eq!(result.criterion_index, 1);
    assert_eq!(result.criterion_content, "Verify the API returns 200 OK");
    assert_eq!(result.path, "tests/api_tests.rs");
    assert_eq!(result.line_start, Some(45));
    assert_eq!(result.line_end, None);
    assert_eq!(result.name, Some("test_api_200_response".to_string()));
    assert_eq!(
        result.warning,
        Some("file 'tests/api_tests.rs' does not exist".to_string())
    );

    // Verify the code ref was actually added to the section
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.sections.len(), 1);
    assert_eq!(task.sections[0].refs.len(), 1);

    let code_ref = &task.sections[0].refs[0];
    assert_eq!(code_ref.path, "tests/api_tests.rs");
    assert_eq!(code_ref.line_start, Some(45));
    assert_eq!(code_ref.line_end, None);
    assert_eq!(code_ref.name, Some("test_api_200_response".to_string()));
    assert_eq!(
        code_ref.description,
        Some("Tests API endpoint for 200 response".to_string())
    );
}

#[tokio::test]
async fn test_criterion_ref_with_line_range() {
    let services = mock_services();
    let task_id = create_task(&services, "Test with range").await;

    // Add testing criteria
    let criterion1 = Section {
        section_type: SectionType::TestingCriterion,
        content: "First criterion".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    let criterion2 = Section {
        section_type: SectionType::TestingCriterion,
        content: "Second criterion".to_string(),
        order: Some(1),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion1)
        .await
        .unwrap();
    services
        .tasks()
        .add_section(&task_id, criterion2)
        .await
        .unwrap();

    // Add criterion ref with line range to the second criterion
    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 2,
        file_spec: "src/lib.rs:L10-20".to_string(),
        name: Some("test_function".to_string()),
        description: None,
    };

    let result = cmd.execute(&services).await.unwrap();

    // Verify the result
    assert_eq!(result.criterion_index, 2);
    assert_eq!(result.path, "src/lib.rs");
    assert_eq!(result.line_start, Some(10));
    assert_eq!(result.line_end, Some(20));
    assert_eq!(result.name, Some("test_function".to_string()));

    // Verify the code ref was added to the second section (index 1)
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.sections.len(), 2);
    assert_eq!(task.sections[1].refs.len(), 1);

    let code_ref = &task.sections[1].refs[0];
    assert_eq!(code_ref.path, "src/lib.rs");
    assert_eq!(code_ref.line_start, Some(10));
    assert_eq!(code_ref.line_end, Some(20));
}

#[tokio::test]
async fn test_criterion_ref_without_line_numbers() {
    let services = mock_services();
    let task_id = create_task(&services, "File only").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Just check the file exists".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "Cargo.toml".to_string(),
        name: None,
        description: Some("Project manifest".to_string()),
    };

    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.path, "Cargo.toml");
    assert_eq!(result.line_start, None);
    assert_eq!(result.line_end, None);

    let task = services.tasks().get_task(&task_id).await.unwrap();
    let code_ref = &task.sections[0].refs[0];
    assert_eq!(code_ref.path, "Cargo.toml");
    assert_eq!(code_ref.line_start, None);
    assert_eq!(code_ref.line_end, None);
    assert_eq!(code_ref.description, Some("Project manifest".to_string()));
}

#[tokio::test]
async fn test_criterion_ref_case_insensitive_task_id() {
    let services = mock_services();
    let task_id = create_task(&services, "Case insensitive").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Test criterion".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    // Use uppercase version of task ID
    let cmd = CriterionRefCommand {
        id: task_id.to_uppercase(),
        index: 1,
        file_spec: "src/main.rs:L1".to_string(),
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await.unwrap();

    // Result should contain the lowercase ID
    assert_eq!(result.task_id, task_id);
    assert_eq!(result.path, "src/main.rs");
    assert_eq!(result.line_start, Some(1));
}

#[tokio::test]
async fn test_criterion_ref_multiple_criteria() {
    let services = mock_services();
    let task_id = create_task(&services, "Multiple criteria").await;

    // Add three testing criteria
    for i in 0..3 {
        let criterion = Section {
            section_type: SectionType::TestingCriterion,
            content: format!("Criterion {}", i + 1),
            order: Some(i),
            done: None,
            done_at: None,
            refs: vec![],
        };
        services
            .tasks()
            .add_section(&task_id, criterion)
            .await
            .unwrap();
    }

    // Add refs to criteria 1 and 3
    let cmd1 = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "tests/test1.rs:L10".to_string(),
        name: Some("test_one".to_string()),
        description: None,
    };
    cmd1.execute(&services).await.unwrap();

    let cmd3 = CriterionRefCommand {
        id: task_id.clone(),
        index: 3,
        file_spec: "tests/test3.rs:L30".to_string(),
        name: Some("test_three".to_string()),
        description: None,
    };
    cmd3.execute(&services).await.unwrap();

    // Verify refs were added to correct sections
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.sections[0].refs.len(), 1);
    assert_eq!(task.sections[0].refs[0].path, "tests/test1.rs");
    assert_eq!(task.sections[0].refs[0].line_start, Some(10));

    assert_eq!(task.sections[1].refs.len(), 0); // Second criterion should have no refs
    assert_eq!(task.sections[2].refs.len(), 1);
    assert_eq!(task.sections[2].refs[0].path, "tests/test3.rs");
    assert_eq!(task.sections[2].refs[0].line_start, Some(30));
}

#[tokio::test]
async fn test_criterion_ref_mixed_with_other_sections() {
    let services = mock_services();
    let task_id = create_task(&services, "Mixed sections").await;

    // Add different types of sections
    let step = Section {
        section_type: SectionType::Step,
        content: "Do something".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Verify something".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    let constraint = Section {
        section_type: SectionType::Constraint,
        content: "Must be fast".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };

    services.tasks().add_section(&task_id, step).await.unwrap();
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();
    services
        .tasks()
        .add_section(&task_id, constraint)
        .await
        .unwrap();

    // Add criterion ref to the criterion (it's the 2nd section but 1st criterion)
    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "tests/verify.rs:L50".to_string(),
        name: Some("verify_fast".to_string()),
        description: None,
    };

    let result = cmd.execute(&services).await.unwrap();
    assert_eq!(result.criterion_content, "Verify something");

    // Verify ref was added only to the criterion section
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.sections[1].refs.len(), 1);
    assert_eq!(task.sections[1].refs[0].path, "tests/verify.rs");
}

// ============================================================================
// Error cases: validation and edge cases
// ============================================================================

#[tokio::test]
async fn test_criterion_ref_task_not_found() {
    let services = mock_services();

    let cmd = CriterionRefCommand {
        id: "nonexistent".to_string(),
        index: 1,
        file_spec: "src/main.rs:L1".to_string(),
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "Expected 'not found' in error, got: {}",
        err
    );
}

#[tokio::test]
async fn test_criterion_ref_index_zero_fails() {
    let services = mock_services();
    let task_id = create_task(&services, "Test").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Test".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 0, // Invalid: must be >= 1
        file_spec: "src/main.rs:L1".to_string(),
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("1 or greater"),
        "Expected validation error about index >= 1"
    );
}

#[tokio::test]
async fn test_criterion_ref_index_out_of_bounds() {
    let services = mock_services();
    let task_id = create_task(&services, "Test").await;

    // Add only one criterion
    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Only criterion".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    // Try to access criterion at index 2
    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 2, // Out of bounds
        file_spec: "src/main.rs:L1".to_string(),
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "Expected error about criterion not found"
    );
}

#[tokio::test]
async fn test_criterion_ref_no_testing_criteria() {
    let services = mock_services();
    let task_id = create_task(&services, "No criteria").await;

    // Add a non-criterion section
    let step = Section {
        section_type: SectionType::Step,
        content: "Step 1".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services.tasks().add_section(&task_id, step).await.unwrap();

    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "src/main.rs:L1".to_string(),
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("not found"),
        "Expected error about criterion not found"
    );
}

#[tokio::test]
async fn test_criterion_ref_invalid_file_spec_range() {
    let services = mock_services();
    let task_id = create_task(&services, "Test").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Test".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    // Invalid: start > end
    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "src/main.rs:L50-10".to_string(), // Invalid range
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert!(
        err.to_string().to_lowercase().contains("invalid"),
        "Expected validation error for invalid range"
    );
}

#[tokio::test]
async fn test_criterion_ref_invalid_file_spec_format() {
    let services = mock_services();
    let task_id = create_task(&services, "Test").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Test".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    // Invalid: missing 'L' for line specification
    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "src/main.rs:42".to_string(), // Missing 'L'
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await;
    // This should be treated as filename only, so it should succeed
    let result = result.unwrap();
    assert_eq!(result.path, "src/main.rs:42"); // Entire thing becomes the filename
}

#[tokio::test]
async fn test_criterion_ref_empty_file_spec() {
    let services = mock_services();
    let task_id = create_task(&services, "Test").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Test".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    // Invalid: empty file spec
    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "".to_string(),
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_criterion_ref_only_line_spec_fails() {
    let services = mock_services();
    let task_id = create_task(&services, "Test").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Test".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    // Invalid: only :L42 without file path
    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: ":L42".to_string(),
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await;
    assert!(result.is_err());
}

// ============================================================================
// Multiple refs on same criterion
// ============================================================================

#[tokio::test]
async fn test_criterion_ref_multiple_refs_same_criterion() {
    let services = mock_services();
    let task_id = create_task(&services, "Multiple refs").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Test multiple implementations".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    // Add first ref
    let cmd1 = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "tests/unit_tests.rs:L100".to_string(),
        name: Some("unit_test".to_string()),
        description: None,
    };
    cmd1.execute(&services).await.unwrap();

    // Add second ref
    let cmd2 = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "tests/integration_tests.rs:L200".to_string(),
        name: Some("integration_test".to_string()),
        description: None,
    };
    cmd2.execute(&services).await.unwrap();

    // Verify both refs are present
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.sections[0].refs.len(), 2);

    let ref1 = &task.sections[0].refs[0];
    assert_eq!(ref1.path, "tests/unit_tests.rs");
    assert_eq!(ref1.line_start, Some(100));
    assert_eq!(ref1.name, Some("unit_test".to_string()));

    let ref2 = &task.sections[0].refs[1];
    assert_eq!(ref2.path, "tests/integration_tests.rs");
    assert_eq!(ref2.line_start, Some(200));
    assert_eq!(ref2.name, Some("integration_test".to_string()));
}

// ============================================================================
// Display and output format tests
// ============================================================================

#[tokio::test]
async fn test_criterion_ref_display_with_line_range() {
    let services = mock_services();
    let task_id = create_task(&services, "Display test").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Display criterion".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "tests/nonexistent/fake_file.rs:L10-20".to_string(),
        name: Some("format_function".to_string()),
        description: None,
    };

    let result = cmd.execute(&services).await.unwrap();
    let output = format!("{}", result);

    // Verify output contains expected information
    assert!(output.contains(&task_id));
    assert!(output.contains("tests/nonexistent/fake_file.rs:L10-20"));
    assert!(output.contains("1"));
    assert!(output.contains("Display criterion"));
    assert!(output.contains("[format_function]"));
    assert!(output.contains("Warning"));
}

#[tokio::test]
async fn test_criterion_ref_display_with_single_line() {
    let services = mock_services();
    let task_id = create_task(&services, "Line test").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "Single line criterion".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "tests/fake_nonexistent_test.rs:L42".to_string(),
        name: None,
        description: None,
    };

    let result = cmd.execute(&services).await.unwrap();
    let output = format!("{}", result);

    // Should show single line format
    assert!(output.contains("tests/fake_nonexistent_test.rs:L42"));
    assert!(output.contains("Single line criterion"));
}

#[tokio::test]
async fn test_criterion_ref_display_file_only() {
    let services = mock_services();
    let task_id = create_task(&services, "File only test").await;

    let criterion = Section {
        section_type: SectionType::TestingCriterion,
        content: "File only criterion".to_string(),
        order: Some(0),
        done: None,
        done_at: None,
        refs: vec![],
    };
    services
        .tasks()
        .add_section(&task_id, criterion)
        .await
        .unwrap();

    let cmd = CriterionRefCommand {
        id: task_id.clone(),
        index: 1,
        file_spec: "nonexistent_manifest.toml".to_string(),
        name: Some("cargo_manifest".to_string()),
        description: None,
    };

    let result = cmd.execute(&services).await.unwrap();
    let output = format!("{}", result);

    // Should show file without line numbers
    assert!(output.contains("nonexistent_manifest.toml"));
    // When there are no line numbers, we shouldn't see "L" in the output
    assert!(output.contains("[cargo_manifest]"));
}
