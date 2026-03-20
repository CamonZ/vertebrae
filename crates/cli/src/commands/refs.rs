//! Refs command for listing code references of a task
//!
//! Implements the `vtb refs` command to display all code references for a task,
//! sorted by file path and then line number.

use clap::Args;
use serde::Serialize;
use vertebrae_core::CodeRef;
use vertebrae_core::{ServiceError, VertebraeServices};

/// List all code references for a task
#[derive(Debug, Args)]
pub struct RefsCommand {
    /// Task ID to list code references for (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,
}

/// Result of the refs command execution
#[derive(Debug, Serialize)]
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
