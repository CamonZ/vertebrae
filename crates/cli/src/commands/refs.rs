//! Refs command for listing code references of a task
//!
//! Implements the `vtb refs` command to display all code references for a task,
//! sorted by file path and then line number.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};
use vertebrae_db::CodeRef;

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

impl RefsCommand {
    /// Execute the refs command.
    ///
    /// Fetches all code references for a task, sorted by file path
    /// and then line number.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Service operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<RefsResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task using service
        let task = services
            .tasks()
            .get_task(&id)
            .await
            .map_err(|_e| ServiceError::task_not_found(&self.id))?;

        // Use the task's code_refs directly
        let mut refs = task.code_refs;

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::{CreateTaskOptions, VertebraeServices};
    use vertebrae_db::Database;

    /// Helper to create a test service with in-memory database
    async fn setup_test_service() -> VertebraeServices {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    /// Helper to create a task with the service
    async fn create_task_with_ref(
        services: &VertebraeServices,
        _id: &str,
        title: &str,
        code_ref: Option<CodeRef>,
    ) -> String {
        let options = CreateTaskOptions::new(title);
        let created_id = services.tasks().create_task(options).await.unwrap();

        // If a code ref was provided, add it
        if let Some(ref_to_add) = code_ref {
            services
                .tasks()
                .append_ref(&created_id, &ref_to_add)
                .await
                .unwrap();
        }

        created_id
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
        let services = setup_test_service().await;

        let task_id = create_task_with_ref(&services, "task1", "Implement auth", None).await;

        // Add code references
        services
            .tasks()
            .append_ref(
                &task_id,
                &CodeRef::file("config/auth.exs").with_name("config"),
            )
            .await
            .unwrap();
        services
            .tasks()
            .append_ref(
                &task_id,
                &CodeRef::range("src/lib/auth.ex", 45, 67).with_name("hash_password"),
            )
            .await
            .unwrap();
        services
            .tasks()
            .append_ref(
                &task_id,
                &CodeRef::line("src/lib/auth.ex", 120)
                    .with_name("authenticate")
                    .with_description("Entry point for auth"),
            )
            .await
            .unwrap();

        let cmd = RefsCommand {
            id: task_id.clone(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Refs command failed: {:?}", result.err());

        let refs_result = result.unwrap();
        assert_eq!(refs_result.title, "Implement auth");
        assert_eq!(refs_result.refs.len(), 3);

        // Verify sorting - config/auth.exs first, then src/lib/auth.ex sorted by line
        assert_eq!(refs_result.refs[0].path, "config/auth.exs");
        assert_eq!(refs_result.refs[1].path, "src/lib/auth.ex");
        assert_eq!(refs_result.refs[1].line_start, Some(45));
        assert_eq!(refs_result.refs[2].path, "src/lib/auth.ex");
        assert_eq!(refs_result.refs[2].line_start, Some(120));
    }

    #[tokio::test]
    async fn test_refs_sorted_by_file_then_line() {
        let services = setup_test_service().await;

        let task_id = create_task_with_ref(&services, "task1", "Test Task", None).await;

        // Add in reverse order to test sorting
        services
            .tasks()
            .append_ref(&task_id, &CodeRef::line("src/b.ex", 10))
            .await
            .unwrap();
        services
            .tasks()
            .append_ref(
                &task_id,
                &CodeRef::range("src/a.ex", 50, 60).with_name("function"),
            )
            .await
            .unwrap();
        services
            .tasks()
            .append_ref(
                &task_id,
                &CodeRef::line("src/a.ex", 20).with_name("Important"),
            )
            .await
            .unwrap();

        let cmd = RefsCommand {
            id: task_id.clone(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let refs_result = result.unwrap();

        // Should be sorted: src/a.ex:L20, src/a.ex:L50-60, src/b.ex:L10
        assert_eq!(refs_result.refs[0].path, "src/a.ex");
        assert_eq!(refs_result.refs[0].line_start, Some(20));
        assert_eq!(refs_result.refs[1].path, "src/a.ex");
        assert_eq!(refs_result.refs[1].line_start, Some(50));
        assert_eq!(refs_result.refs[2].path, "src/b.ex");
        assert_eq!(refs_result.refs[2].line_start, Some(10));
    }

    #[tokio::test]
    async fn test_refs_empty() {
        let services = setup_test_service().await;

        let task_id = create_task_with_ref(&services, "task1", "Empty Task", None).await;

        let cmd = RefsCommand {
            id: task_id.clone(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let refs_result = result.unwrap();
        assert!(refs_result.refs.is_empty());

        // Test display
        let output = format!("{}", refs_result);
        assert_eq!(output, "No code references defined");
    }

    #[tokio::test]
    async fn test_refs_nonexistent_task() {
        let services = setup_test_service().await;

        let cmd = RefsCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&services).await;
        match result {
            Err(ServiceError::TaskNotFound { task_id }) => {
                assert_eq!(
                    task_id, "nonexistent",
                    "Expected task_id 'nonexistent', got: {}",
                    task_id
                );
            }
            Err(other) => panic!("Expected TaskNotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_refs_case_insensitive_id() {
        let services = setup_test_service().await;

        let task_id = create_task_with_ref(&services, "task1", "Test Task", None).await;
        services
            .tasks()
            .append_ref(&task_id, &CodeRef::file("src/main.rs"))
            .await
            .unwrap();

        let cmd = RefsCommand {
            id: task_id.to_uppercase(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let refs_result = result.unwrap();
        assert_eq!(refs_result.refs.len(), 1);
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
            id: "test123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("RefsCommand") && debug_str.contains("id: \"test123\""),
            "Debug output should contain RefsCommand and id field value"
        );
    }

    #[test]
    fn test_refs_result_debug() {
        let result = RefsResult {
            id: "task1".to_string(),
            title: "Test Task Title".to_string(),
            refs: vec![],
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("RefsResult")
                && debug_str.contains("id: \"task1\"")
                && debug_str.contains("Test Task Title"),
            "Debug output should contain RefsResult and all field values"
        );
    }

    #[tokio::test]
    async fn test_refs_preserves_all_fields() {
        let services = setup_test_service().await;

        let task_id = create_task_with_ref(&services, "task1", "Test Task", None).await;
        services
            .tasks()
            .append_ref(
                &task_id,
                &CodeRef::range("src/main.rs", 10, 20)
                    .with_name("test_fn")
                    .with_description("Test function"),
            )
            .await
            .unwrap();

        let cmd = RefsCommand {
            id: task_id.clone(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let refs_result = result.unwrap();
        assert_eq!(refs_result.refs.len(), 1);

        let code_ref = &refs_result.refs[0];
        assert_eq!(code_ref.path, "src/main.rs");
        assert_eq!(code_ref.line_start, Some(10));
        assert_eq!(code_ref.line_end, Some(20));
        assert_eq!(code_ref.name, Some("test_fn".to_string()));
        assert_eq!(code_ref.description, Some("Test function".to_string()));
    }

    #[tokio::test]
    async fn test_refs_file_only() {
        let services = setup_test_service().await;

        let task_id = create_task_with_ref(&services, "task1", "Test Task", None).await;
        services
            .tasks()
            .append_ref(&task_id, &CodeRef::file("README.md"))
            .await
            .unwrap();

        let cmd = RefsCommand {
            id: task_id.clone(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let refs_result = result.unwrap();
        assert_eq!(refs_result.refs.len(), 1);
        assert_eq!(refs_result.refs[0].path, "README.md");
        assert!(refs_result.refs[0].line_start.is_none());
        assert!(refs_result.refs[0].line_end.is_none());
    }
}
