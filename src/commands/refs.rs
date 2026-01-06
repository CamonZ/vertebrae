//! Refs command for listing code references of a task
//!
//! Implements the `vtb refs` command to display all code references for a task,
//! sorted by file path and then line number.

use crate::db::{CodeRef, Database, DbError};
use clap::Args;
use serde::Deserialize;

/// List all code references for a task
#[derive(Debug, Args)]
pub struct RefsCommand {
    /// Task ID to show references for (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

/// Result of the refs command execution
#[derive(Debug)]
pub struct RefsResult {
    /// The task ID
    pub id: String,
    /// The task title
    pub title: String,
    /// The code references found
    pub refs: Vec<CodeRef>,
}

impl std::fmt::Display for RefsResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.refs.is_empty() {
            return write!(f, "No code references defined");
        }

        // Header
        writeln!(f, "Code references for: {} \"{}\"", self.id, self.title)?;
        writeln!(f, "{}", "\u{2550}".repeat(60))?;
        writeln!(f)?;

        // Calculate column widths
        let file_width = self
            .refs
            .iter()
            .map(|r| r.path.len())
            .max()
            .unwrap_or(4)
            .max(4); // Minimum "File" width

        let lines_width = self
            .refs
            .iter()
            .map(|r| format_lines(r.line_start, r.line_end).len())
            .max()
            .unwrap_or(5)
            .max(5); // Minimum "Lines" width

        let name_width = self
            .refs
            .iter()
            .filter_map(|r| r.name.as_ref().map(|n| n.len()))
            .max()
            .unwrap_or(4)
            .max(4); // Minimum "Name" width

        // Table header
        writeln!(
            f,
            "{:<file_width$}  {:<lines_width$}  {:<name_width$}  Description",
            "File",
            "Lines",
            "Name",
            file_width = file_width,
            lines_width = lines_width,
            name_width = name_width
        )?;
        writeln!(
            f,
            "{}  {}  {}  {}",
            "\u{2500}".repeat(file_width),
            "\u{2500}".repeat(lines_width),
            "\u{2500}".repeat(name_width),
            "\u{2500}".repeat(23)
        )?;

        // Table rows
        for code_ref in &self.refs {
            let lines = format_lines(code_ref.line_start, code_ref.line_end);
            let name = code_ref.name.as_deref().unwrap_or("-");
            let description = code_ref.description.as_deref().unwrap_or("");

            writeln!(
                f,
                "{:<file_width$}  {:<lines_width$}  {:<name_width$}  {}",
                code_ref.path,
                lines,
                name,
                description,
                file_width = file_width,
                lines_width = lines_width,
                name_width = name_width
            )?;
        }

        Ok(())
    }
}

/// Format line numbers for display
fn format_lines(line_start: Option<u32>, line_end: Option<u32>) -> String {
    match (line_start, line_end) {
        (Some(start), Some(end)) => format!("L{}-{}", start, end),
        (Some(line), None) => format!("L{}", line),
        _ => "-".to_string(),
    }
}

/// Result from querying a task's refs
#[derive(Debug, Deserialize)]
struct TaskRefsRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    title: String,
    #[serde(default, rename = "refs")]
    code_refs: Vec<CodeRefRow>,
}

/// Code reference row from database
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

impl RefsCommand {
    /// Execute the refs command.
    ///
    /// Fetches all code references for a task, sorted by file path
    /// and then line number.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<RefsResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task refs
        let task = self.fetch_task_refs(db, &id).await?;

        // Convert code refs, filtering out any without required fields
        let mut refs: Vec<CodeRef> = task
            .code_refs
            .into_iter()
            .filter_map(|r| {
                let path = r.path?;
                let mut code_ref = if let (Some(start), Some(end)) = (r.line_start, r.line_end) {
                    CodeRef::range(path, start, end)
                } else if let Some(line) = r.line_start {
                    CodeRef::line(path, line)
                } else {
                    CodeRef::file(path)
                };
                if let Some(name) = r.name {
                    code_ref = code_ref.with_name(name);
                }
                if let Some(desc) = r.description {
                    code_ref = code_ref.with_description(desc);
                }
                Some(code_ref)
            })
            .collect();

        // Sort by file path, then by line_start
        refs.sort_by(|a, b| {
            match a.path.cmp(&b.path) {
                std::cmp::Ordering::Equal => {
                    // Same file, sort by line number
                    let a_line = a.line_start.unwrap_or(0);
                    let b_line = b.line_start.unwrap_or(0);
                    a_line.cmp(&b_line)
                }
                other => other,
            }
        });

        Ok(RefsResult {
            id,
            title: task.title,
            refs,
        })
    }

    /// Fetch the task by ID and return its refs.
    async fn fetch_task_refs(&self, db: &Database, id: &str) -> Result<TaskRefsRow, DbError> {
        let query = format!("SELECT id, title, refs FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskRefsRow> = result.take(0)?;

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.id),
            reason: format!("Task '{}' not found", self.id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-refs-test-{}-{:?}-{}",
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

    /// Helper to add a code reference to a task
    async fn add_ref(
        db: &Database,
        id: &str,
        path: &str,
        line_start: Option<u32>,
        line_end: Option<u32>,
        name: Option<&str>,
        description: Option<&str>,
    ) {
        let escaped_path = path.replace('\\', "\\\\").replace('"', "\\\"");
        let mut ref_parts = vec![format!(r#""path": "{}""#, escaped_path)];

        if let Some(start) = line_start {
            ref_parts.push(format!(r#""line_start": {}"#, start));
        }

        if let Some(end) = line_end {
            ref_parts.push(format!(r#""line_end": {}"#, end));
        }

        if let Some(n) = name {
            let escaped_name = n.replace('\\', "\\\\").replace('"', "\\\"");
            ref_parts.push(format!(r#""name": "{}""#, escaped_name));
        }

        if let Some(d) = description {
            let escaped_desc = d.replace('\\', "\\\\").replace('"', "\\\"");
            ref_parts.push(format!(r#""description": "{}""#, escaped_desc));
        }

        let ref_obj = format!("{{ {} }}", ref_parts.join(", "));

        let query = format!(
            "UPDATE task:{} SET refs = array::append(refs, {})",
            id, ref_obj
        );
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn test_format_lines_range() {
        assert_eq!(format_lines(Some(45), Some(67)), "L45-67");
    }

    #[test]
    fn test_format_lines_single() {
        assert_eq!(format_lines(Some(120), None), "L120");
    }

    #[test]
    fn test_format_lines_none() {
        assert_eq!(format_lines(None, None), "-");
    }

    #[tokio::test]
    async fn test_refs_all() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Implement auth").await;
        add_ref(
            &db,
            "task1",
            "config/auth.exs",
            None,
            None,
            Some("config"),
            None,
        )
        .await;
        add_ref(
            &db,
            "task1",
            "src/lib/auth.ex",
            Some(45),
            Some(67),
            Some("hash_password"),
            None,
        )
        .await;
        add_ref(
            &db,
            "task1",
            "src/lib/auth.ex",
            Some(120),
            None,
            Some("authenticate"),
            Some("Entry point for auth"),
        )
        .await;

        let cmd = RefsCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Refs command failed: {:?}", result.err());

        let refs_result = result.unwrap();
        assert_eq!(refs_result.id, "task1");
        assert_eq!(refs_result.title, "Implement auth");
        assert_eq!(refs_result.refs.len(), 3);

        // Verify sorting - config/auth.exs first, then src/lib/auth.ex sorted by line
        assert_eq!(refs_result.refs[0].path, "config/auth.exs");
        assert_eq!(refs_result.refs[1].path, "src/lib/auth.ex");
        assert_eq!(refs_result.refs[1].line_start, Some(45));
        assert_eq!(refs_result.refs[2].path, "src/lib/auth.ex");
        assert_eq!(refs_result.refs[2].line_start, Some(120));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_refs_sorted_by_file_then_line() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        // Add in reverse order to test sorting
        add_ref(&db, "task1", "src/b.ex", Some(10), None, None, None).await;
        add_ref(
            &db,
            "task1",
            "src/a.ex",
            Some(50),
            Some(60),
            Some("function"),
            None,
        )
        .await;
        add_ref(
            &db,
            "task1",
            "src/a.ex",
            Some(20),
            None,
            None,
            Some("Important"),
        )
        .await;

        let cmd = RefsCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let refs_result = result.unwrap();

        // Should be sorted: src/a.ex:L20, src/a.ex:L50-60, src/b.ex:L10
        assert_eq!(refs_result.refs[0].path, "src/a.ex");
        assert_eq!(refs_result.refs[0].line_start, Some(20));
        assert_eq!(refs_result.refs[1].path, "src/a.ex");
        assert_eq!(refs_result.refs[1].line_start, Some(50));
        assert_eq!(refs_result.refs[2].path, "src/b.ex");
        assert_eq!(refs_result.refs[2].line_start, Some(10));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_refs_empty() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Empty Task").await;

        let cmd = RefsCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let refs_result = result.unwrap();
        assert!(refs_result.refs.is_empty());

        // Test display
        let output = format!("{}", refs_result);
        assert_eq!(output, "No code references defined");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_refs_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = RefsCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());

        let err = result.unwrap_err().to_string();
        assert!(err.contains("not found"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_refs_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "src/main.rs", None, None, None, None).await;

        let cmd = RefsCommand {
            id: "TASK1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let refs_result = result.unwrap();
        assert_eq!(refs_result.refs.len(), 1);

        cleanup(&temp_dir);
    }

    #[test]
    fn test_refs_result_display_with_refs() {
        let result = RefsResult {
            id: "a1b2c3".to_string(),
            title: "Implement auth".to_string(),
            refs: vec![
                CodeRef::file("config/auth.exs").with_name("config"),
                CodeRef::range("src/lib/auth.ex", 45, 67).with_name("hash_password"),
                CodeRef::line("src/lib/auth.ex", 120)
                    .with_name("authenticate")
                    .with_description("Entry point for auth"),
            ],
        };

        let output = format!("{}", result);

        assert!(output.contains("Code references for: a1b2c3 \"Implement auth\""));
        assert!(output.contains("File"));
        assert!(output.contains("Lines"));
        assert!(output.contains("Name"));
        assert!(output.contains("Description"));
        assert!(output.contains("config/auth.exs"));
        assert!(output.contains("src/lib/auth.ex"));
        assert!(output.contains("L45-67"));
        assert!(output.contains("L120"));
        assert!(output.contains("hash_password"));
        assert!(output.contains("authenticate"));
        assert!(output.contains("Entry point for auth"));
    }

    #[test]
    fn test_refs_result_display_empty() {
        let result = RefsResult {
            id: "task1".to_string(),
            title: "Empty Task".to_string(),
            refs: vec![],
        };

        let output = format!("{}", result);
        assert_eq!(output, "No code references defined");
    }

    #[test]
    fn test_refs_command_debug() {
        let cmd = RefsCommand {
            id: "test".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("RefsCommand"));
    }

    #[test]
    fn test_refs_result_debug() {
        let result = RefsResult {
            id: "task1".to_string(),
            title: "Test".to_string(),
            refs: vec![],
        };
        let debug_str = format!("{:?}", result);
        assert!(debug_str.contains("RefsResult"));
    }

    #[tokio::test]
    async fn test_refs_preserves_all_fields() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(
            &db,
            "task1",
            "src/main.rs",
            Some(10),
            Some(20),
            Some("test_fn"),
            Some("Test function"),
        )
        .await;

        let cmd = RefsCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let refs_result = result.unwrap();
        assert_eq!(refs_result.refs.len(), 1);

        let code_ref = &refs_result.refs[0];
        assert_eq!(code_ref.path, "src/main.rs");
        assert_eq!(code_ref.line_start, Some(10));
        assert_eq!(code_ref.line_end, Some(20));
        assert_eq!(code_ref.name, Some("test_fn".to_string()));
        assert_eq!(code_ref.description, Some("Test function".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_refs_file_only() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_ref(&db, "task1", "README.md", None, None, None, None).await;

        let cmd = RefsCommand {
            id: "task1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let refs_result = result.unwrap();
        assert_eq!(refs_result.refs.len(), 1);
        assert_eq!(refs_result.refs[0].path, "README.md");
        assert!(refs_result.refs[0].line_start.is_none());
        assert!(refs_result.refs[0].line_end.is_none());

        cleanup(&temp_dir);
    }
}
