//! Criterion-ref command for adding code references to testing criteria
//!
//! Implements the `vtb criterion-ref` command to add code references to
//! testing_criterion sections. This links testing criteria to actual test
//! implementations that prove the desired functionality works.

use crate::commands::r#ref::parse_file_ref;
use clap::Args;
use serde::Serialize;
use std::path::Path;
use vertebrae_core::CodeRef;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Add a code reference to a testing criterion
#[derive(Debug, Args)]
pub struct CriterionRefCommand {
    /// Task ID containing the testing criterion (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
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
#[derive(Debug, Serialize)]
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

impl CriterionRefCommand {
    /// Execute the criterion-ref command.
    ///
    /// Adds a code reference to the specified testing criterion within a task.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task does not exist
    /// - The criterion index is out of bounds
    /// - The file specification is invalid
    /// - Database operations fail
    ///
    /// Missing files are allowed and reported as warnings in the command result.
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<CriterionRefResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate index is positive
        if self.index == 0 {
            return Err(ServiceError::validation_failed(
                "Testing criterion index must be 1 or greater",
            ));
        }

        // Parse the file specification
        let parsed = parse_file_ref(&self.file_spec).map_err(ServiceError::validation_failed)?;

        // Fetch the task to get sections
        let task = services.tasks().get_task(&id).await?;

        // Filter to only testing_criterion sections and sort by order
        let mut criteria: Vec<(usize, &vertebrae_core::Section)> = task
            .sections
            .iter()
            .enumerate()
            .filter(|(_, s)| s.section_type == vertebrae_core::SectionType::TestingCriterion)
            .collect();
        criteria.sort_by_key(|(_, s)| s.order.unwrap_or(u32::MAX));

        // Find the criterion by index (1-based)
        let criterion_idx = self.index - 1;
        if criterion_idx >= criteria.len() {
            return Err(ServiceError::validation_failed(format!(
                "Testing criterion at index {} not found. Task has {} testing criterion(s).",
                self.index,
                criteria.len()
            )));
        }

        let (original_idx, criterion) = criteria[criterion_idx];
        let criterion_content = criterion.content.clone();

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

        // Use service to append the section ref (handles timestamp and notification)
        services
            .tasks()
            .append_section_ref(&id, original_idx, &code_ref)
            .await?;

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
}
