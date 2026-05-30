//! Section command for adding typed content sections to tasks
//!
//! Implements the `vtb section` command to add sections for context curation.
//! Supports both positive space (goal, context, current_behavior, desired_behavior,
//! checklist_item, testing_criterion) and negative space (anti_pattern, failure_test,
//! constraint) section types.

use clap::Args;
use serde::Serialize;
use vertebrae_core::{Section, SectionType};
use vertebrae_core::{ServiceError, VertebraeServices};

/// Add a typed content section to a task.
///
/// Single-instance section types replace the existing section of that type.
/// Multi-instance section types append a new section with a zero-based index.
#[derive(Debug, Args)]
pub struct SectionCommand {
    /// Task ID to add section to (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Section type (goal, context, current_behavior, desired_behavior, checklist_item,
    /// testing_criterion, anti_pattern, failure_test, constraint)
    #[arg(required = true)]
    pub section_type: SectionType,

    /// Section content (must not be empty)
    #[arg(required = true)]
    pub content: String,
}

/// Result of the section command execution
#[derive(Debug, Serialize)]
pub struct SectionResult {
    /// The task ID that was updated
    pub id: String,
    /// The section type that was added
    pub section_type: SectionType,
    /// Whether this replaced an existing section (for single-instance types)
    pub replaced: bool,
    /// The ordinal assigned (for multi-instance types)
    pub ordinal: Option<u32>,
}

impl std::fmt::Display for SectionResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.replaced {
            write!(
                f,
                "Replaced {} section for task: {}",
                self.section_type, self.id
            )
        } else if let Some(ordinal) = self.ordinal {
            write!(
                f,
                "Added {} section (ordinal {}) to task: {}",
                self.section_type, ordinal, self.id
            )
        } else {
            write!(
                f,
                "Added {} section to task: {}",
                self.section_type, self.id
            )
        }
    }
}

impl SectionCommand {
    /// Execute the section command.
    ///
    /// Adds a typed section to the task's sections array.
    /// For single-instance types (goal, context, current_behavior, desired_behavior),
    /// replaces any existing section of that type.
    /// For multi-instance types (checklist_item, testing_criterion, anti_pattern,
    /// failure_test, constraint), appends with auto-incrementing ordinal.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - The content is empty
    /// - Service operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<SectionResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate content is not empty
        if self.content.trim().is_empty() {
            return Err(ServiceError::validation_failed(
                "section content cannot be empty",
            ));
        }

        // Fetch the task first to count existing sections of this type
        let task = services.tasks().get_task(&id).await?;

        // Handle single-instance vs multi-instance section types
        let (ordinal, replaced) = if self.section_type.is_single_instance() {
            // For single-instance types, check if one already exists
            let existing = task
                .sections
                .iter()
                .any(|s| s.section_type == self.section_type);
            if existing {
                // Remove existing section first
                services
                    .tasks()
                    .remove_sections(&id, self.section_type.clone(), None)
                    .await?;
            }
            (None, existing)
        } else {
            // For multi-instance types, calculate the next ordinal
            let count = task
                .sections
                .iter()
                .filter(|s| s.section_type == self.section_type)
                .count();
            (Some(count as u32), false)
        };

        // Create the section with the calculated order
        let section = Section {
            section_type: self.section_type.clone(),
            content: self.content.clone(),
            order: ordinal,
            done: None,
            done_at: None,
            refs: Vec::new(),
        };

        // Add the section using service layer (which fires MutationCallback)
        services.tasks().add_section(&id, section).await?;

        Ok(SectionResult {
            id,
            section_type: self.section_type.clone(),
            replaced,
            ordinal,
        })
    }
}
