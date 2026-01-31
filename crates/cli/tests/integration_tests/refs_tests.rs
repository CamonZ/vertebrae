//! Integration tests for the `refs` command
//!
//! Tests listing code references for tasks, including:
//! - Listing multiple code references
//! - Listing empty code references
//! - Nonexistent task handling
//! - Sorting by file path and line number

use super::mock::mock_services;
use vertebrae_cli::commands::*;
use vertebrae_core::CodeRef;

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

/// Helper to add a code reference to a task
async fn add_code_ref(
    services: &vertebrae_core::VertebraeServices,
    task_id: &str,
    path: &str,
    line_start: Option<u32>,
    line_end: Option<u32>,
    name: Option<&str>,
    description: Option<&str>,
) {
    let cmd = RefCommand {
        id: task_id.to_string(),
        file_spec: format!(
            "{}{}",
            path,
            match (line_start, line_end) {
                (Some(start), Some(end)) => format!(":L{}-{}", start, end),
                (Some(line), None) => format!(":L{}", line),
                _ => String::new(),
            }
        ),
        name: name.map(|s| s.to_string()),
        description: description.map(|s| s.to_string()),
    };
    cmd.execute(services).await.unwrap();
}

// ============================================================================
// Refs command tests: listing code references
// ============================================================================

#[tokio::test]
async fn test_refs_with_single_code_reference() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with single ref").await;

    // Add one code reference
    add_code_ref(
        &services,
        &task_id,
        "src/main.rs",
        Some(42),
        None,
        Some("entry_point"),
        Some("Main entry function"),
    )
    .await;

    // List refs
    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.id, task_id);
    assert_eq!(result.refs.len(), 1);
    assert_eq!(result.refs[0].path, "src/main.rs");
    assert_eq!(result.refs[0].line_start, Some(42));
    assert_eq!(result.refs[0].line_end, None);
    assert_eq!(result.refs[0].name, Some("entry_point".to_string()));
    assert_eq!(
        result.refs[0].description,
        Some("Main entry function".to_string())
    );
}

#[tokio::test]
async fn test_refs_with_multiple_code_references() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with multiple refs").await;

    // Add three code references with different files and lines
    add_code_ref(
        &services,
        &task_id,
        "src/lib.rs",
        Some(10),
        Some(50),
        None,
        None,
    )
    .await;
    add_code_ref(
        &services,
        &task_id,
        "src/config.rs",
        Some(100),
        None,
        Some("Config"),
        None,
    )
    .await;
    add_code_ref(
        &services,
        &task_id,
        "src/utils.rs",
        Some(5),
        Some(15),
        Some("helper"),
        Some("Helper functions"),
    )
    .await;

    // List refs
    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.id, task_id);
    assert_eq!(result.refs.len(), 3);

    // Verify sorting: should be sorted by file path first, then by line number
    // Expected order: config.rs, lib.rs, utils.rs
    assert_eq!(result.refs[0].path, "src/config.rs");
    assert_eq!(result.refs[0].line_start, Some(100));

    assert_eq!(result.refs[1].path, "src/lib.rs");
    assert_eq!(result.refs[1].line_start, Some(10));
    assert_eq!(result.refs[1].line_end, Some(50));

    assert_eq!(result.refs[2].path, "src/utils.rs");
    assert_eq!(result.refs[2].line_start, Some(5));
    assert_eq!(result.refs[2].line_end, Some(15));
    assert_eq!(result.refs[2].name, Some("helper".to_string()));
}

#[tokio::test]
async fn test_refs_with_same_file_multiple_references_sorted_by_line() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with multi-ref same file").await;

    // Add multiple references to the same file, out of order
    add_code_ref(
        &services,
        &task_id,
        "src/main.rs",
        Some(100),
        None,
        None,
        None,
    )
    .await;
    add_code_ref(
        &services,
        &task_id,
        "src/main.rs",
        Some(50),
        None,
        None,
        None,
    )
    .await;
    add_code_ref(
        &services,
        &task_id,
        "src/main.rs",
        Some(10),
        None,
        None,
        None,
    )
    .await;

    // List refs
    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.refs.len(), 3);
    // All should be same file
    assert_eq!(result.refs[0].path, "src/main.rs");
    assert_eq!(result.refs[1].path, "src/main.rs");
    assert_eq!(result.refs[2].path, "src/main.rs");

    // Should be sorted by line number (10, 50, 100)
    assert_eq!(result.refs[0].line_start, Some(10));
    assert_eq!(result.refs[1].line_start, Some(50));
    assert_eq!(result.refs[2].line_start, Some(100));
}

#[tokio::test]
async fn test_refs_with_no_code_references() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with no refs").await;

    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.id, task_id);
    assert_eq!(result.refs.len(), 0);
}

#[tokio::test]
async fn test_refs_with_line_ranges() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with line ranges").await;

    // Add reference with line range
    add_code_ref(
        &services,
        &task_id,
        "src/parser.rs",
        Some(100),
        Some(250),
        Some("parse_function"),
        Some("Complete parser implementation"),
    )
    .await;

    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.refs.len(), 1);
    assert_eq!(result.refs[0].path, "src/parser.rs");
    assert_eq!(result.refs[0].line_start, Some(100));
    assert_eq!(result.refs[0].line_end, Some(250));
    assert_eq!(result.refs[0].name, Some("parse_function".to_string()));
}

#[tokio::test]
async fn test_refs_with_no_line_info() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with path-only ref").await;

    // Add reference without line numbers
    add_code_ref(
        &services,
        &task_id,
        "docs/README.md",
        None,
        None,
        None,
        None,
    )
    .await;

    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.refs.len(), 1);
    assert_eq!(result.refs[0].path, "docs/README.md");
    assert_eq!(result.refs[0].line_start, None);
    assert_eq!(result.refs[0].line_end, None);
}

#[tokio::test]
async fn test_refs_case_insensitive_task_id() {
    let services = mock_services();
    let task_id = create_task(&services, "Case test task").await;

    // Add a reference
    add_code_ref(
        &services,
        &task_id,
        "src/test.rs",
        Some(42),
        None,
        None,
        None,
    )
    .await;

    // Query with uppercase variant of the ID
    let cmd = RefsCommand {
        id: task_id.to_uppercase(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.refs.len(), 1);
    assert_eq!(result.refs[0].path, "src/test.rs");
}

#[tokio::test]
async fn test_refs_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = RefsCommand {
        id: "nonexistent-task".to_string(),
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_refs_all_fields_preserved() {
    let services = mock_services();
    let task_id = create_task(&services, "Full ref test").await;

    // Add a reference with all fields populated
    let code_ref = CodeRef {
        path: "src/full_example.rs".to_string(),
        line_start: Some(42),
        line_end: Some(100),
        name: Some("complex_function".to_string()),
        description: Some(
            "This is a very detailed description of what this reference points to".to_string(),
        ),
    };

    services
        .tasks()
        .add_code_ref(&task_id, code_ref)
        .await
        .unwrap();

    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.refs.len(), 1);
    let ref_data = &result.refs[0];
    assert_eq!(ref_data.path, "src/full_example.rs");
    assert_eq!(ref_data.line_start, Some(42));
    assert_eq!(ref_data.line_end, Some(100));
    assert_eq!(ref_data.name, Some("complex_function".to_string()));
    assert_eq!(
        ref_data.description,
        Some("This is a very detailed description of what this reference points to".to_string())
    );
}

#[tokio::test]
async fn test_refs_title_preserved() {
    let services = mock_services();
    let task_id = create_task(&services, "Important Task Title").await;

    add_code_ref(
        &services,
        &task_id,
        "src/main.rs",
        Some(1),
        None,
        None,
        None,
    )
    .await;

    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.title, "Important Task Title");
}

#[tokio::test]
async fn test_refs_display_format_no_refs() {
    let services = mock_services();
    let task_id = create_task(&services, "Empty refs task").await;

    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    let output = format!("{}", result);
    assert!(output.contains("No code references defined"));
}

#[tokio::test]
async fn test_refs_display_format_with_refs() {
    let services = mock_services();
    let task_id = create_task(&services, "Display format test").await;

    add_code_ref(
        &services,
        &task_id,
        "src/main.rs",
        Some(42),
        None,
        None,
        None,
    )
    .await;

    let cmd = RefsCommand {
        id: task_id.clone(),
    };
    let result = cmd.execute(&services).await.unwrap();

    let output = format!("{}", result);
    assert!(output.contains(&task_id));
    assert!(output.contains("Display format test"));
    assert!(output.contains("src/main.rs"));
}
