//! Criterion-ref command for adding code references to testing criteria
//!
//! Implements the `vtb criterion-ref` command to add code references to
//! testing_criterion sections. This links testing criteria to actual test
//! implementations that prove the desired functionality works.

use crate::commands::r#ref::{ParsedFileRef, parse_file_ref};
use clap::Args;
use serde::Deserialize;
use std::path::Path;
use vertebrae_db::{Database, DbError};

/// Add a code reference to a testing criterion
#[derive(Debug, Args)]
pub struct CriterionRefCommand {
    /// Task ID containing the testing criterion (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Testing criterion index (1-based) to add the reference to
    #[arg(required = true)]
    pub index: usize,

    /// File specification (file:Lstart-end, file:Lstart, or file)
    #[arg(required = true)]
    pub file_spec: String,

    /// Optional name/label for the reference (e.g., test function name)
    #[arg(long)]
    pub name: Option<String>,

    /// Optional description of what this reference points to
    #[arg(long, visible_alias = "desc")]
    pub description: Option<String>,
}

/// Result of executing the criterion-ref command
#[derive(Debug)]
pub struct CriterionRefResult {
    /// The task ID
    pub task_id: String,
    /// The criterion index that received the ref
    pub criterion_index: usize,
    /// The content of the criterion
    pub criterion_content: String,
    /// The file path that was added
    pub path: String,
    /// Optional line range that was added
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    /// Optional name that was added
    pub name: Option<String>,
    /// Whether a warning was issued (e.g., file doesn't exist)
    pub warning: Option<String>,
}

impl std::fmt::Display for CriterionRefResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let location = match (self.line_start, self.line_end) {
            (Some(start), Some(end)) => format!("{}:L{}-{}", self.path, start, end),
            (Some(line), None) => format!("{}:L{}", self.path, line),
            _ => self.path.clone(),
        };

        let name_part = self
            .name
            .as_ref()
            .map(|n| format!(" [{}]", n))
            .unwrap_or_default();

        write!(
            f,
            "Added reference {} to testing criterion {} in {}: {}{}",
            location, self.criterion_index, self.task_id, self.criterion_content, name_part
        )?;

        if let Some(ref warning) = self.warning {
            write!(f, "\nWarning: {}", warning)?;
        }

        Ok(())
    }
}

/// Section row from database
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct SectionRow {
    #[serde(rename = "type", default)]
    section_type: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    order: Option<u32>,
    #[serde(default)]
    done: Option<bool>,
    #[serde(default)]
    done_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    refs: Vec<CodeRefRow>,
}

/// Code reference row from database
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct CodeRefRow {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line_start: Option<u32>,
    #[serde(default)]
    line_end: Option<u32>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

impl CriterionRefCommand {
    /// Execute the criterion-ref command.
    ///
    /// Adds a code reference to the specified testing criterion within a task.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task does not exist
    /// - The criterion index is out of bounds
    /// - The section at the index is not a testing_criterion
    /// - The file specification is invalid
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<CriterionRefResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate index is positive
        if self.index == 0 {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: "Testing criterion index must be 1 or greater".to_string(),
            });
        }

        // Parse the file specification
        let parsed = parse_file_ref(&self.file_spec).map_err(|msg| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.file_spec),
            reason: msg,
        })?;

        // Fetch current sections
        let sections = self.fetch_sections(db, &id).await?;

        // Filter to only testing_criterion sections and sort by order
        let mut criteria: Vec<(usize, SectionRow)> = sections
            .into_iter()
            .enumerate()
            .filter(|(_, s)| s.section_type.as_deref() == Some("testing_criterion"))
            .collect();
        criteria.sort_by_key(|(_, s)| s.order.unwrap_or(u32::MAX));

        // Find the criterion by index (1-based)
        let criterion_idx = self.index - 1;
        if criterion_idx >= criteria.len() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!(
                    "Testing criterion at index {} not found. Task has {} testing criterion(s).",
                    self.index,
                    criteria.len()
                ),
            });
        }

        let (original_idx, criterion) = &criteria[criterion_idx];
        let criterion_content = criterion.content.clone().unwrap_or_default();

        // Check if file exists (warning only)
        let warning = if !Path::new(&parsed.path).exists() {
            Some(format!("file '{}' does not exist", parsed.path))
        } else {
            None
        };

        // Append the new reference to the criterion's refs array
        self.append_criterion_ref(db, &id, *original_idx, &parsed)
            .await?;

        // Update the task's updated_at timestamp
        self.update_timestamp(db, &id).await?;

        Ok(CriterionRefResult {
            task_id: id,
            criterion_index: self.index,
            criterion_content,
            path: parsed.path,
            line_start: parsed.line_start,
            line_end: parsed.line_end,
            name: self.name.clone(),
            warning,
        })
    }

    /// Fetch sections from a task.
    async fn fetch_sections(&self, db: &Database, id: &str) -> Result<Vec<SectionRow>, DbError> {
        #[derive(Debug, Deserialize)]
        struct TaskRow {
            #[serde(default)]
            sections: Vec<SectionRow>,
        }

        let query = format!("SELECT sections FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskRow> = result.take(0)?;

        match task {
            Some(t) => Ok(t.sections),
            None => Err(DbError::NotFound {
                task_id: self.id.clone(),
            }),
        }
    }

    /// Append a code reference to a specific section's refs array.
    async fn append_criterion_ref(
        &self,
        db: &Database,
        id: &str,
        section_index: usize,
        parsed: &ParsedFileRef,
    ) -> Result<(), DbError> {
        let escaped_path = parsed.path.replace('\\', "\\\\").replace('"', "\\\"");

        // Build the ref object
        let mut ref_parts = vec![format!(r#""path": "{}""#, escaped_path)];

        if let Some(start) = parsed.line_start {
            ref_parts.push(format!(r#""line_start": {}"#, start));
        }

        if let Some(end) = parsed.line_end {
            ref_parts.push(format!(r#""line_end": {}"#, end));
        }

        if let Some(ref name) = self.name {
            let escaped_name = name.replace('\\', "\\\\").replace('"', "\\\"");
            ref_parts.push(format!(r#""name": "{}""#, escaped_name));
        }

        if let Some(ref desc) = self.description {
            let escaped_desc = desc.replace('\\', "\\\\").replace('"', "\\\"");
            ref_parts.push(format!(r#""description": "{}""#, escaped_desc));
        }

        let ref_obj = format!("{{ {} }}", ref_parts.join(", "));

        // Use SurrealDB array append to add the ref to the section's refs array
        let query = format!(
            "UPDATE task:{} SET sections[{}].refs = array::append(sections[{}].refs ?? [], {})",
            id, section_index, section_index, ref_obj
        );
        db.client().query(&query).await?;

        Ok(())
    }

    /// Update the task's updated_at timestamp.
    async fn update_timestamp(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
        db.client().query(&query).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-criterion-ref-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let db = Database::connect(&temp_dir).await.unwrap();
        db.init().await.unwrap();

        (db, temp_dir)
    }

    /// Helper to create a task with testing criteria
    async fn create_task_with_criteria(db: &Database, id: &str, criteria: &[&str]) {
        let sections: Vec<String> = criteria
            .iter()
            .enumerate()
            .map(|(i, content)| {
                format!(
                    r#"{{ type: "testing_criterion", content: "{}", order: {}, refs: [] }}"#,
                    content,
                    i + 1
                )
            })
            .collect();

        let query = format!(
            r#"CREATE task:{} SET
                title = "Test Task",
                level = "task",
                status = "todo",
                sections = [{}]"#,
            id,
            sections.join(", ")
        );

        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a task with mixed section types
    async fn create_task_with_mixed_sections(db: &Database, id: &str) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "Test Task",
                level = "task",
                status = "todo",
                sections = [
                    {{ type: "step", content: "First step", order: 1 }},
                    {{ type: "testing_criterion", content: "First criterion", order: 1, refs: [] }},
                    {{ type: "constraint", content: "Some constraint", order: 1 }},
                    {{ type: "testing_criterion", content: "Second criterion", order: 2, refs: [] }}
                ]"#,
            id
        );

        db.client().query(&query).await.unwrap();
    }

    /// Helper to get criterion refs from a task
    async fn get_criterion_refs(db: &Database, id: &str, section_index: usize) -> Vec<CodeRefRow> {
        #[derive(Debug, Deserialize)]
        struct TaskRow {
            #[serde(default)]
            sections: Vec<SectionRow>,
        }

        let query = format!("SELECT sections FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let task: Option<TaskRow> = result.take(0).unwrap();
        task.and_then(|t| t.sections.get(section_index).cloned())
            .map(|s| s.refs)
            .unwrap_or_default()
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_criterion_ref_adds_ref_to_correct_criterion() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_criteria(&db, "abc123", &["Criterion 1", "Criterion 2"]).await;

        let cmd = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 1,
            file_spec: "tests/auth_test.rs:L45-67".to_string(),
            name: Some("test_auth".to_string()),
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "criterion-ref failed: {:?}", result.err());

        let result = result.unwrap();
        assert_eq!(result.task_id, "abc123");
        assert_eq!(result.criterion_index, 1);
        assert_eq!(result.criterion_content, "Criterion 1");
        assert_eq!(result.path, "tests/auth_test.rs");
        assert_eq!(result.line_start, Some(45));
        assert_eq!(result.line_end, Some(67));
        assert_eq!(result.name, Some("test_auth".to_string()));

        // Verify ref was added to the correct section (index 0 in sections array)
        let refs = get_criterion_refs(&db, "abc123", 0).await;
        assert_eq!(refs.len(), 1, "Should have exactly 1 ref");
        assert_eq!(refs[0].path.as_deref(), Some("tests/auth_test.rs"));
        assert_eq!(refs[0].line_start, Some(45));
        assert_eq!(refs[0].line_end, Some(67));
        assert_eq!(refs[0].name.as_deref(), Some("test_auth"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_second_criterion() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_criteria(&db, "abc123", &["Criterion 1", "Criterion 2"]).await;

        let cmd = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 2,
            file_spec: "tests/api_test.rs:L100".to_string(),
            name: None,
            description: Some("API validation test".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let result = result.unwrap();
        assert_eq!(result.criterion_index, 2);
        assert_eq!(result.criterion_content, "Criterion 2");

        // Verify ref was added to the second criterion (index 1 in sections array)
        let refs = get_criterion_refs(&db, "abc123", 1).await;
        assert_eq!(refs.len(), 1, "Should have exactly 1 ref");
        assert_eq!(refs[0].path.as_deref(), Some("tests/api_test.rs"));
        assert_eq!(refs[0].line_start, Some(100));
        assert_eq!(refs[0].line_end, None);
        assert_eq!(refs[0].description.as_deref(), Some("API validation test"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_with_mixed_sections() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_mixed_sections(&db, "abc123").await;

        let cmd = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 2, // Second testing_criterion
            file_spec: "tests/test.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let result = result.unwrap();
        assert_eq!(result.criterion_index, 2);
        assert_eq!(result.criterion_content, "Second criterion");

        // The second testing_criterion is at index 3 in the sections array
        let refs = get_criterion_refs(&db, "abc123", 3).await;
        assert_eq!(refs.len(), 1, "Should have exactly 1 ref");
        assert_eq!(refs[0].path.as_deref(), Some("tests/test.rs"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_rejects_out_of_bounds_index() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_criteria(&db, "abc123", &["Criterion 1"]).await;

        let cmd = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 5, // Out of bounds
            file_spec: "tests/test.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("Testing criterion at index 5 not found"),
                    "Expected 'Testing criterion at index 5 not found' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("1 testing criterion(s)"),
                    "Expected count of criteria in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_rejects_zero_index() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_criteria(&db, "abc123", &["Criterion 1"]).await;

        let cmd = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 0,
            file_spec: "tests/test.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("1 or greater"),
                    "Expected '1 or greater' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = CriterionRefCommand {
            id: "nonexistent".to_string(),
            index: 1,
            file_spec: "tests/test.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::NotFound { task_id }) => {
                assert_eq!(
                    task_id, "nonexistent",
                    "Expected task_id 'nonexistent', got: {}",
                    task_id
                );
            }
            Err(other) => panic!("Expected NotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_invalid_file_spec() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_criteria(&db, "abc123", &["Criterion 1"]).await;

        let cmd = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 1,
            file_spec: "tests/test.rs:L67-45".to_string(), // Invalid: start > end
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("invalid line range"),
                    "Expected 'invalid line range' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_multiple_refs_to_same_criterion() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_criteria(&db, "abc123", &["Criterion 1"]).await;

        // Add first ref
        let cmd1 = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 1,
            file_spec: "tests/test1.rs:L10".to_string(),
            name: Some("first_test".to_string()),
            description: None,
        };
        cmd1.execute(&db).await.unwrap();

        // Add second ref
        let cmd2 = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 1,
            file_spec: "tests/test2.rs:L20-30".to_string(),
            name: Some("second_test".to_string()),
            description: None,
        };
        cmd2.execute(&db).await.unwrap();

        // Verify both refs were added
        let refs = get_criterion_refs(&db, "abc123", 0).await;
        assert_eq!(refs.len(), 2, "Should have 2 refs");

        // Verify specific refs by name
        use std::collections::HashSet;
        let ref_names: HashSet<_> = refs.iter().filter_map(|r| r.name.as_deref()).collect();
        assert!(
            ref_names.contains("first_test"),
            "Should contain first_test ref"
        );
        assert!(
            ref_names.contains("second_test"),
            "Should contain second_test ref"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_criteria(&db, "abc123", &["Criterion 1"]).await;

        let cmd = CriterionRefCommand {
            id: "ABC123".to_string(),
            index: 1,
            file_spec: "tests/test.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_criterion_ref_file_not_found_warning() {
        let (db, temp_dir) = setup_test_db().await;

        create_task_with_criteria(&db, "abc123", &["Criterion 1"]).await;

        let cmd = CriterionRefCommand {
            id: "abc123".to_string(),
            index: 1,
            file_spec: "nonexistent/path/test.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let result = result.unwrap();
        assert!(result.warning.is_some());
        assert!(
            result.warning.as_ref().unwrap().contains("does not exist"),
            "Warning should indicate file doesn't exist"
        );

        cleanup(&temp_dir);
    }

    #[test]
    fn test_criterion_ref_result_display() {
        let result = CriterionRefResult {
            task_id: "abc123".to_string(),
            criterion_index: 1,
            criterion_content: "Test criterion".to_string(),
            path: "tests/test.rs".to_string(),
            line_start: Some(45),
            line_end: Some(67),
            name: Some("test_func".to_string()),
            warning: None,
        };

        let output = format!("{}", result);
        assert!(output.contains("tests/test.rs:L45-67"));
        assert!(output.contains("testing criterion 1"));
        assert!(output.contains("abc123"));
        assert!(output.contains("Test criterion"));
        assert!(output.contains("[test_func]"));
    }

    #[test]
    fn test_criterion_ref_result_display_with_warning() {
        let result = CriterionRefResult {
            task_id: "abc123".to_string(),
            criterion_index: 1,
            criterion_content: "Test criterion".to_string(),
            path: "tests/test.rs".to_string(),
            line_start: None,
            line_end: None,
            name: None,
            warning: Some("file 'tests/test.rs' does not exist".to_string()),
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning:"));
        assert!(output.contains("does not exist"));
    }

    #[test]
    fn test_criterion_ref_command_debug() {
        let cmd = CriterionRefCommand {
            id: "test123".to_string(),
            index: 1,
            file_spec: "tests/test.rs:L10-20".to_string(),
            name: Some("test_fn".to_string()),
            description: Some("Test description".to_string()),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("CriterionRefCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("index: 1"),
            "Debug output should contain CriterionRefCommand and field values"
        );
    }

    #[test]
    fn test_criterion_ref_result_debug() {
        let result = CriterionRefResult {
            task_id: "abc123".to_string(),
            criterion_index: 1,
            criterion_content: "Test".to_string(),
            path: "test.rs".to_string(),
            line_start: Some(10),
            line_end: Some(20),
            name: None,
            warning: None,
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("CriterionRefResult")
                && debug_str.contains("task_id: \"abc123\"")
                && debug_str.contains("criterion_index: 1"),
            "Debug output should contain CriterionRefResult and field values"
        );
    }
}
