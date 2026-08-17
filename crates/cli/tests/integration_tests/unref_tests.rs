//! Integration tests for the `unref` command
//!
//! Tests removing code references from tasks, including:
//! - Removing by file path
//! - Removing all references
//! - Nonexistent task handling
//! - Verification of actual ref removal

use super::mock::mock_services;
use vertebrae_cli::commands::*;

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
        workflow: None,
        worktree: None,
    };
    cmd.execute(services).await.unwrap()
}

/// Helper to add a code reference to a task
async fn add_code_ref(
    services: &vertebrae_core::VertebraeServices,
    task_id: &str,
    path: &str,
    line_start: Option<u32>,
) {
    let cmd = RefCommand {
        id: task_id.to_string(),
        file_spec: format!(
            "{}{}",
            path,
            line_start
                .map(|line| format!(":L{}", line))
                .unwrap_or_default()
        ),
        name: None,
        description: None,
    };
    cmd.execute(services).await.unwrap();
}

// ============================================================================
// Unref command tests: removing code references
// ============================================================================

#[tokio::test]
async fn test_unref_single_ref_by_file_path() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with one ref").await;

    // Add a single reference
    add_code_ref(&services, &task_id, "src/main.rs", Some(42)).await;

    // Verify ref was added
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 1);

    // Remove the reference by file path
    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/main.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.id, task_id);
    assert_eq!(result.file, Some("src/main.rs".to_string()));
    assert!(!result.removed_all);
    assert_eq!(result.removed_count, 1);

    // Verify ref was removed
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 0);
}

#[tokio::test]
async fn test_unref_one_of_multiple_refs_by_file_path() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with multiple refs").await;

    // Add three references to different files
    add_code_ref(&services, &task_id, "src/main.rs", Some(10)).await;
    add_code_ref(&services, &task_id, "src/lib.rs", Some(20)).await;
    add_code_ref(&services, &task_id, "src/utils.rs", Some(30)).await;

    // Verify all refs were added
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 3);

    // Remove reference to src/lib.rs
    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/lib.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.removed_count, 1);
    assert_eq!(result.file, Some("src/lib.rs".to_string()));

    // Verify the correct ref was removed
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 2);

    let paths: Vec<&str> = task.code_refs.iter().map(|r| r.path.as_str()).collect();
    assert!(paths.contains(&"src/main.rs"));
    assert!(paths.contains(&"src/utils.rs"));
    assert!(!paths.contains(&"src/lib.rs"));
}

#[tokio::test]
async fn test_unref_multiple_refs_same_file() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with multi-ref same file").await;

    // Add multiple references to the same file
    add_code_ref(&services, &task_id, "src/main.rs", Some(10)).await;
    add_code_ref(&services, &task_id, "src/main.rs", Some(50)).await;
    add_code_ref(&services, &task_id, "src/main.rs", Some(100)).await;

    // Verify all refs were added
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 3);

    // Remove all references to src/main.rs
    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/main.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.removed_count, 3);

    // Verify all three were removed
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 0);
}

#[tokio::test]
async fn test_unref_all_references() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with many refs").await;

    // Add multiple references
    add_code_ref(&services, &task_id, "src/main.rs", Some(10)).await;
    add_code_ref(&services, &task_id, "src/lib.rs", Some(20)).await;
    add_code_ref(&services, &task_id, "src/config.rs", Some(30)).await;
    add_code_ref(&services, &task_id, "src/utils.rs", Some(40)).await;

    // Verify all refs were added
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 4);

    // Remove all references
    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: None,
        all: true,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert!(result.removed_all);
    assert_eq!(result.removed_count, 4);
    assert_eq!(result.file, None);

    // Verify all refs were removed
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 0);
}

#[tokio::test]
async fn test_unref_all_when_no_refs() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with no refs").await;

    // Remove all from empty task
    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: None,
        all: true,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert!(result.removed_all);
    assert_eq!(result.removed_count, 0);
}

#[tokio::test]
async fn test_unref_nonexistent_file_path() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with refs").await;

    // Add a reference
    add_code_ref(&services, &task_id, "src/main.rs", Some(42)).await;

    // Try to remove a reference to a file that doesn't exist on this task
    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/nonexistent.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.removed_count, 0);

    // Verify the original ref is still there
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 1);
    assert_eq!(task.code_refs[0].path, "src/main.rs");
}

#[tokio::test]
async fn test_unref_case_insensitive_task_id() {
    let services = mock_services();
    let task_id = create_task(&services, "Case test task").await;

    // Add a reference
    add_code_ref(&services, &task_id, "src/test.rs", Some(42)).await;

    // Remove using uppercase task ID
    let cmd = UnrefCommand {
        id: task_id.to_uppercase(),
        file: Some("src/test.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await.unwrap();

    assert_eq!(result.removed_count, 1);

    // Verify ref was removed
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 0);
}

#[tokio::test]
async fn test_unref_nonexistent_task_fails() {
    let services = mock_services();

    let cmd = UnrefCommand {
        id: "nonexistent-task".to_string(),
        file: Some("src/main.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_unref_nonexistent_task_all_fails() {
    let services = mock_services();

    let cmd = UnrefCommand {
        id: "nonexistent-task".to_string(),
        file: None,
        all: true,
    };
    let result = cmd.execute(&services).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_unref_display_format_single_removed() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with ref").await;

    add_code_ref(&services, &task_id, "src/main.rs", Some(42)).await;

    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/main.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await.unwrap();

    let output = format!("{}", result);
    assert!(output.contains("Removed 1 reference(s)"));
    assert!(output.contains("src/main.rs"));
}

#[tokio::test]
async fn test_unref_display_format_multiple_removed() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with refs").await;

    add_code_ref(&services, &task_id, "src/main.rs", Some(10)).await;
    add_code_ref(&services, &task_id, "src/main.rs", Some(50)).await;
    add_code_ref(&services, &task_id, "src/main.rs", Some(100)).await;

    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/main.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await.unwrap();

    let output = format!("{}", result);
    assert!(output.contains("Removed 3 reference(s)"));
}

#[tokio::test]
async fn test_unref_display_format_all_removed() {
    let services = mock_services();
    let task_id = create_task(&services, "Task with refs").await;

    add_code_ref(&services, &task_id, "src/main.rs", Some(10)).await;
    add_code_ref(&services, &task_id, "src/lib.rs", Some(20)).await;

    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: None,
        all: true,
    };
    let result = cmd.execute(&services).await.unwrap();

    let output = format!("{}", result);
    assert!(output.contains("Removed all 2 reference(s)"));
}

#[tokio::test]
async fn test_unref_display_format_no_refs_to_remove() {
    let services = mock_services();
    let task_id = create_task(&services, "Empty task").await;

    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/nonexistent.rs".to_string()),
        all: false,
    };
    let result = cmd.execute(&services).await.unwrap();

    let output = format!("{}", result);
    assert!(output.contains("Warning: No references to src/nonexistent.rs"));
}

#[tokio::test]
async fn test_unref_preserves_remaining_refs_data() {
    let services = mock_services();
    let task_id = create_task(&services, "Multi-ref preservation").await;

    // Add refs with different line numbers to same file
    add_code_ref(&services, &task_id, "src/file_a.rs", Some(10)).await;
    add_code_ref(&services, &task_id, "src/file_b.rs", Some(20)).await;
    add_code_ref(&services, &task_id, "src/file_c.rs", Some(30)).await;

    // Remove file_b.rs
    let cmd = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/file_b.rs".to_string()),
        all: false,
    };
    cmd.execute(&services).await.unwrap();

    // Verify remaining refs have correct data
    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 2);

    let ref_a = task.code_refs.iter().find(|r| r.path == "src/file_a.rs");
    let ref_c = task.code_refs.iter().find(|r| r.path == "src/file_c.rs");

    assert!(ref_a.is_some());
    assert_eq!(ref_a.unwrap().line_start, Some(10));

    assert!(ref_c.is_some());
    assert_eq!(ref_c.unwrap().line_start, Some(30));
}

#[tokio::test]
async fn test_unref_sequential_removals() {
    let services = mock_services();
    let task_id = create_task(&services, "Sequential removal task").await;

    // Add three refs
    add_code_ref(&services, &task_id, "src/main.rs", Some(10)).await;
    add_code_ref(&services, &task_id, "src/lib.rs", Some(20)).await;
    add_code_ref(&services, &task_id, "src/utils.rs", Some(30)).await;

    // Remove first ref
    let cmd1 = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/main.rs".to_string()),
        all: false,
    };
    let result1 = cmd1.execute(&services).await.unwrap();
    assert_eq!(result1.removed_count, 1);

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 2);

    // Remove second ref
    let cmd2 = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/lib.rs".to_string()),
        all: false,
    };
    let result2 = cmd2.execute(&services).await.unwrap();
    assert_eq!(result2.removed_count, 1);

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 1);
    assert_eq!(task.code_refs[0].path, "src/utils.rs");

    // Remove last ref
    let cmd3 = UnrefCommand {
        id: task_id.clone(),
        file: Some("src/utils.rs".to_string()),
        all: false,
    };
    let result3 = cmd3.execute(&services).await.unwrap();
    assert_eq!(result3.removed_count, 1);

    let task = services.tasks().get_task(&task_id).await.unwrap();
    assert_eq!(task.code_refs.len(), 0);
}
