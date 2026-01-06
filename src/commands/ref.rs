//! Ref command for adding code references to tasks
//!
//! Implements the `vtb ref` command to add code references for context curation.
//! Supports GitHub-style file:line notation (file:L45-67, file:L45, or just file).

use crate::db::{Database, DbError};
use clap::Args;
use serde::Deserialize;
use std::path::Path;

/// Add a code reference to a task
#[derive(Debug, Args)]
pub struct RefCommand {
    /// Task ID to add reference to (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// File specification (file:Lstart-end, file:Lstart, or file)
    #[arg(required = true)]
    pub file_spec: String,

    /// Optional name/label for the reference (e.g., function name)
    #[arg(long)]
    pub name: Option<String>,

    /// Optional description of what this reference points to
    #[arg(long, visible_alias = "desc")]
    pub description: Option<String>,
}

/// Result of parsing a file specification
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFileRef {
    /// Path to the file
    pub path: String,
    /// Optional starting line number
    pub line_start: Option<u32>,
    /// Optional ending line number
    pub line_end: Option<u32>,
}

/// Result of the ref command execution
#[derive(Debug)]
pub struct RefResult {
    /// The task ID that was updated
    pub id: String,
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

impl std::fmt::Display for RefResult {
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

        write!(f, "Added reference {} to task: {}", location, self.id)?;

        if !name_part.is_empty() {
            write!(f, "{}", name_part)?;
        }

        if let Some(ref warning) = self.warning {
            write!(f, "\nWarning: {}", warning)?;
        }

        Ok(())
    }
}

/// Result from querying a task's refs
#[derive(Debug, Deserialize)]
struct TaskRefsRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    #[allow(dead_code)]
    #[serde(default, rename = "refs")]
    code_refs: Vec<CodeRefRow>,
}

/// Code reference row from database
#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
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

/// Parse a file specification into its components.
///
/// Supports:
/// - `file:Lstart-end` -> file with line range
/// - `file:Lstart` -> file with single line
/// - `file` -> file without line numbers
///
/// # Arguments
///
/// * `spec` - The file specification string
///
/// # Returns
///
/// A `ParsedFileRef` on success, or an error message on failure.
pub fn parse_file_ref(spec: &str) -> Result<ParsedFileRef, String> {
    // Check for :L pattern (case-insensitive)
    if let Some(colon_pos) = spec.rfind(':') {
        let after_colon = &spec[colon_pos + 1..];

        // Check if it starts with 'L' or 'l'
        if after_colon.starts_with('L') || after_colon.starts_with('l') {
            let path = spec[..colon_pos].to_string();
            let line_part = &after_colon[1..]; // Skip the 'L'

            if path.is_empty() {
                return Err("file path cannot be empty".to_string());
            }

            // Check for range (start-end)
            if let Some(dash_pos) = line_part.find('-') {
                let start_str = &line_part[..dash_pos];
                let end_str = &line_part[dash_pos + 1..];

                let start: u32 = start_str
                    .parse()
                    .map_err(|_| format!("invalid line number: '{}'", start_str))?;
                let end: u32 = end_str
                    .parse()
                    .map_err(|_| format!("invalid line number: '{}'", end_str))?;

                // Validate range: start must be <= end
                if start > end {
                    return Err(format!(
                        "invalid line range: start ({}) > end ({})",
                        start, end
                    ));
                }

                return Ok(ParsedFileRef {
                    path,
                    line_start: Some(start),
                    line_end: Some(end),
                });
            }

            // Single line number
            if line_part.is_empty() {
                return Err("line number required after 'L'".to_string());
            }

            let line: u32 = line_part
                .parse()
                .map_err(|_| format!("invalid line number: '{}'", line_part))?;

            return Ok(ParsedFileRef {
                path,
                line_start: Some(line),
                line_end: None,
            });
        }
    }

    // No :L pattern, treat entire spec as file path
    if spec.is_empty() {
        return Err("file path cannot be empty".to_string());
    }

    Ok(ParsedFileRef {
        path: spec.to_string(),
        line_start: None,
        line_end: None,
    })
}

impl RefCommand {
    /// Execute the ref command.
    ///
    /// Adds a code reference to the task's refs array.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The file specification is invalid
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<RefResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Parse the file specification
        let parsed = parse_file_ref(&self.file_spec).map_err(|msg| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.file_spec),
            reason: msg,
        })?;

        // Fetch task and verify it exists
        self.fetch_task_refs(db, &id).await?;

        // Check if file exists (warning only)
        let warning = if !Path::new(&parsed.path).exists() {
            Some(format!("file '{}' does not exist", parsed.path))
        } else {
            None
        };

        // Append the new reference
        self.append_ref(db, &id, &parsed).await?;

        // Update timestamp
        self.update_timestamp(db, &id).await?;

        Ok(RefResult {
            id,
            path: parsed.path,
            line_start: parsed.line_start,
            line_end: parsed.line_end,
            name: self.name.clone(),
            warning,
        })
    }

    /// Fetch the task by ID and return its refs (mainly to verify task exists).
    async fn fetch_task_refs(&self, db: &Database, id: &str) -> Result<TaskRefsRow, DbError> {
        let query = format!("SELECT id, refs FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskRefsRow> = result.take(0)?;

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.id),
            reason: format!("Task '{}' not found", self.id),
        })
    }

    /// Append a new code reference to the task.
    async fn append_ref(
        &self,
        db: &Database,
        id: &str,
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

        let query = format!(
            "UPDATE task:{} SET refs = array::append(refs, {})",
            id, ref_obj
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
            "vtb-ref-test-{}-{:?}-{}",
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

    /// Helper to create a task in the database
    async fn create_task(db: &Database, id: &str, title: &str) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "task",
                status = "todo",
                tags = [],
                sections = [],
                refs = []"#,
            id, title
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to get refs from a task
    async fn get_refs(db: &Database, id: &str) -> Vec<CodeRefRow> {
        let query = format!("SELECT refs FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();

        #[derive(Deserialize)]
        struct Row {
            #[serde(default, rename = "refs")]
            code_refs: Vec<CodeRefRow>,
        }

        let row: Option<Row> = result.take(0).unwrap();
        row.map(|r| r.code_refs).unwrap_or_default()
    }

    /// Helper to get updated_at timestamp
    async fn get_updated_at(db: &Database, id: &str) -> surrealdb::sql::Datetime {
        #[derive(Deserialize)]
        struct TimestampRow {
            updated_at: surrealdb::sql::Datetime,
        }

        let query = format!("SELECT updated_at FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let row: Option<TimestampRow> = result.take(0).unwrap();
        row.unwrap().updated_at
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    // ==================== parse_file_ref tests ====================

    #[test]
    fn test_parse_file_ref_simple_file() {
        let result = parse_file_ref("src/main.rs").unwrap();
        assert_eq!(result.path, "src/main.rs");
        assert_eq!(result.line_start, None);
        assert_eq!(result.line_end, None);
    }

    #[test]
    fn test_parse_file_ref_with_single_line() {
        let result = parse_file_ref("src/auth.ex:L45").unwrap();
        assert_eq!(result.path, "src/auth.ex");
        assert_eq!(result.line_start, Some(45));
        assert_eq!(result.line_end, None);
    }

    #[test]
    fn test_parse_file_ref_with_line_range() {
        let result = parse_file_ref("src/auth.ex:L45-67").unwrap();
        assert_eq!(result.path, "src/auth.ex");
        assert_eq!(result.line_start, Some(45));
        assert_eq!(result.line_end, Some(67));
    }

    #[test]
    fn test_parse_file_ref_lowercase_l() {
        let result = parse_file_ref("src/auth.ex:l45-67").unwrap();
        assert_eq!(result.path, "src/auth.ex");
        assert_eq!(result.line_start, Some(45));
        assert_eq!(result.line_end, Some(67));
    }

    #[test]
    fn test_parse_file_ref_invalid_range_start_gt_end() {
        let result = parse_file_ref("src/auth.ex:L67-45");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid line range"));
        assert!(err.contains("67"));
        assert!(err.contains("45"));
    }

    #[test]
    fn test_parse_file_ref_invalid_line_number() {
        let result = parse_file_ref("src/auth.ex:Labcd");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid line number"));
        assert!(err.contains("abcd"));
    }

    #[test]
    fn test_parse_file_ref_empty_path() {
        let result = parse_file_ref("");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn test_parse_file_ref_empty_path_with_line() {
        let result = parse_file_ref(":L45");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn test_parse_file_ref_l_without_number() {
        let result = parse_file_ref("src/auth.ex:L");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("line number required"));
    }

    #[test]
    fn test_parse_file_ref_invalid_end_line() {
        let result = parse_file_ref("src/auth.ex:L45-abc");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid line number"));
        assert!(err.contains("abc"));
    }

    #[test]
    fn test_parse_file_ref_file_with_colon_but_no_l() {
        // Windows-style path or URL-like path
        let result = parse_file_ref("C:/Users/test/file.rs").unwrap();
        assert_eq!(result.path, "C:/Users/test/file.rs");
        assert_eq!(result.line_start, None);
        assert_eq!(result.line_end, None);
    }

    #[test]
    fn test_parse_file_ref_same_start_end() {
        // Edge case: same line for start and end should be valid
        let result = parse_file_ref("src/auth.ex:L45-45").unwrap();
        assert_eq!(result.path, "src/auth.ex");
        assert_eq!(result.line_start, Some(45));
        assert_eq!(result.line_end, Some(45));
    }

    // ==================== RefCommand integration tests ====================

    #[tokio::test]
    async fn test_ref_add_simple_file() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "nonexistent/path/file.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Ref add failed: {:?}", result.err());

        let ref_result = result.unwrap();
        assert_eq!(ref_result.id, "task1");
        assert_eq!(ref_result.path, "nonexistent/path/file.rs");
        assert!(ref_result.line_start.is_none());
        assert!(ref_result.line_end.is_none());
        // File doesn't exist so there should be a warning
        assert!(ref_result.warning.is_some());

        // Verify ref was added
        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].path.as_deref(), Some("nonexistent/path/file.rs"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_add_with_line_range() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:L45-67".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let ref_result = result.unwrap();
        assert_eq!(ref_result.line_start, Some(45));
        assert_eq!(ref_result.line_end, Some(67));

        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].line_start, Some(45));
        assert_eq!(refs[0].line_end, Some(67));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_add_with_single_line() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:L45".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let ref_result = result.unwrap();
        assert_eq!(ref_result.line_start, Some(45));
        assert!(ref_result.line_end.is_none());

        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].line_start, Some(45));
        assert!(refs[0].line_end.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_add_with_name() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:L45-67".to_string(),
            name: Some("hash_password".to_string()),
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name.as_deref(), Some("hash_password"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_add_with_description() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:L45-67".to_string(),
            name: None,
            description: Some("Main authentication function".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);
        assert_eq!(
            refs[0].description.as_deref(),
            Some("Main authentication function")
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_add_with_name_and_description() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:L120".to_string(),
            name: Some("authenticate".to_string()),
            description: Some("Entry point".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name.as_deref(), Some("authenticate"));
        assert_eq!(refs[0].description.as_deref(), Some("Entry point"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_add_multiple_refs() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd1 = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:L45-67".to_string(),
            name: Some("hash_password".to_string()),
            description: None,
        };
        cmd1.execute(&db).await.unwrap();

        let cmd2 = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:L120".to_string(),
            name: Some("authenticate".to_string()),
            description: Some("Entry point".to_string()),
        };
        cmd2.execute(&db).await.unwrap();

        let cmd3 = RefCommand {
            id: "task1".to_string(),
            file_spec: "config/auth.exs".to_string(),
            name: Some("config".to_string()),
            description: None,
        };
        cmd3.execute(&db).await.unwrap();

        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 3);

        // Verify specific ref names and paths
        use std::collections::HashSet;
        let ref_names: HashSet<_> = refs.iter().filter_map(|r| r.name.as_deref()).collect();
        assert!(
            ref_names.contains("hash_password"),
            "Should contain hash_password ref"
        );
        assert!(
            ref_names.contains("authenticate"),
            "Should contain authenticate ref"
        );
        assert!(ref_names.contains("config"), "Should contain config ref");

        let ref_paths: HashSet<_> = refs.iter().filter_map(|r| r.path.as_deref()).collect();
        assert!(
            ref_paths.contains("src/auth.ex"),
            "Should contain src/auth.ex path"
        );
        assert!(
            ref_paths.contains("config/auth.exs"),
            "Should contain config/auth.exs path"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = RefCommand {
            id: "nonexistent".to_string(),
            file_spec: "src/main.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("not found"),
                    "Expected 'not found' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("nonexistent"),
                    "Expected task ID 'nonexistent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_invalid_line_range_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:L67-45".to_string(),
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
    async fn test_ref_invalid_line_number_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/auth.ex:Labcd".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("invalid line number"),
                    "Expected 'invalid line number' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        // Get initial timestamp
        let initial_ts = get_updated_at(&db, "task1").await;

        // Wait a tiny bit to ensure time passes
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/main.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify updated_at was refreshed
        let new_ts = get_updated_at(&db, "task1").await;
        assert!(
            new_ts > initial_ts,
            "updated_at should be refreshed: {:?} > {:?}",
            new_ts,
            initial_ts
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "TASK1".to_string(),
            file_spec: "src/main.rs".to_string(),
            name: None,
            description: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        // Verify ref was added
        let refs = get_refs(&db, "task1").await;
        assert_eq!(refs.len(), 1);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_ref_special_characters_in_content() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = RefCommand {
            id: "task1".to_string(),
            file_spec: "src/main.rs".to_string(),
            name: Some(r#"name with "quotes""#.to_string()),
            description: Some(r#"desc with \backslash"#.to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Special chars failed: {:?}", result.err());

        cleanup(&temp_dir);
    }

    // ==================== Display tests ====================

    #[test]
    fn test_ref_result_display_simple() {
        let result = RefResult {
            id: "task1".to_string(),
            path: "src/main.rs".to_string(),
            line_start: None,
            line_end: None,
            name: None,
            warning: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Added reference src/main.rs to task: task1");
    }

    #[test]
    fn test_ref_result_display_with_line() {
        let result = RefResult {
            id: "task1".to_string(),
            path: "src/main.rs".to_string(),
            line_start: Some(45),
            line_end: None,
            name: None,
            warning: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Added reference src/main.rs:L45 to task: task1");
    }

    #[test]
    fn test_ref_result_display_with_range() {
        let result = RefResult {
            id: "task1".to_string(),
            path: "src/main.rs".to_string(),
            line_start: Some(45),
            line_end: Some(67),
            name: None,
            warning: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Added reference src/main.rs:L45-67 to task: task1");
    }

    #[test]
    fn test_ref_result_display_with_name() {
        let result = RefResult {
            id: "task1".to_string(),
            path: "src/main.rs".to_string(),
            line_start: Some(45),
            line_end: Some(67),
            name: Some("hash_password".to_string()),
            warning: None,
        };

        let output = format!("{}", result);
        assert!(output.contains("Added reference src/main.rs:L45-67 to task: task1"));
        assert!(output.contains("[hash_password]"));
    }

    #[test]
    fn test_ref_result_display_with_warning() {
        let result = RefResult {
            id: "task1".to_string(),
            path: "src/main.rs".to_string(),
            line_start: None,
            line_end: None,
            name: None,
            warning: Some("file 'src/main.rs' does not exist".to_string()),
        };

        let output = format!("{}", result);
        assert!(output.contains("Added reference src/main.rs to task: task1"));
        assert!(output.contains("Warning: file 'src/main.rs' does not exist"));
    }

    #[test]
    fn test_ref_command_debug() {
        let cmd = RefCommand {
            id: "test123".to_string(),
            file_spec: "src/main.rs:10-20".to_string(),
            name: Some("test_fn".to_string()),
            description: Some("Test description".to_string()),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("RefCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("src/main.rs:10-20")
                && debug_str.contains("test_fn")
                && debug_str.contains("Test description"),
            "Debug output should contain RefCommand and all field values"
        );
    }

    #[test]
    fn test_ref_result_debug() {
        let result = RefResult {
            id: "task1".to_string(),
            path: "src/lib.rs".to_string(),
            line_start: Some(10),
            line_end: Some(20),
            name: Some("my_func".to_string()),
            warning: Some("file not found".to_string()),
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("RefResult")
                && debug_str.contains("id: \"task1\"")
                && debug_str.contains("src/lib.rs")
                && debug_str.contains("line_start: Some(10)")
                && debug_str.contains("line_end: Some(20)")
                && debug_str.contains("my_func")
                && debug_str.contains("file not found"),
            "Debug output should contain RefResult and all field values"
        );
    }

    #[test]
    fn test_parsed_file_ref_debug_clone_eq() {
        let parsed = ParsedFileRef {
            path: "src/main.rs".to_string(),
            line_start: Some(45),
            line_end: Some(67),
        };
        let cloned = parsed.clone();
        assert_eq!(parsed, cloned);

        let debug_str = format!("{:?}", parsed);
        assert!(
            debug_str.contains("ParsedFileRef")
                && debug_str.contains("src/main.rs")
                && debug_str.contains("line_start: Some(45)")
                && debug_str.contains("line_end: Some(67)"),
            "Debug output should contain ParsedFileRef and all field values"
        );
    }
}
