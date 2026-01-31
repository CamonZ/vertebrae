//! Ref command for adding code references to tasks
//!
//! Implements the `vtb ref` command to add code references for context curation.
//! Supports GitHub-style file:line notation (file:L45-67, file:L45, or just file).

use clap::Args;
use std::path::Path;
use vertebrae_core::CodeRef;
use vertebrae_core::{ServiceError, VertebraeServices};

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
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - The file specification is invalid
    /// - Database operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<RefResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Parse the file specification
        let parsed = parse_file_ref(&self.file_spec).map_err(|msg| {
            ServiceError::validation_failed(format!("{}: {}", self.file_spec, msg))
        })?;

        // Check if file exists (warning only)
        let warning = if !Path::new(&parsed.path).exists() {
            Some(format!("file '{}' does not exist", parsed.path))
        } else {
            None
        };

        // Build the CodeRef
        let code_ref = CodeRef {
            path: parsed.path.clone(),
            line_start: parsed.line_start,
            line_end: parsed.line_end,
            name: self.name.clone(),
            description: self.description.clone(),
        };

        // Use service to append the ref (handles existence check, timestamp, and notification)
        services.tasks().append_ref(&id, &code_ref).await?;

        Ok(RefResult {
            id,
            path: parsed.path,
            line_start: parsed.line_start,
            line_end: parsed.line_end,
            name: self.name.clone(),
            warning,
        })
    }
}
