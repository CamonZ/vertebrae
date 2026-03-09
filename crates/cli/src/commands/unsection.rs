//! Unsection command for removing sections from tasks
//!
//! Implements the `vtb unsection` command to remove sections from tasks.
//! Supports removing single-instance types or specific multi-instance sections by index.

use clap::Args;
use serde::Deserialize;
use vertebrae_core::SectionType;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Remove sections from a task
#[derive(Debug, Args)]
pub struct UnsectionCommand {
    /// Task ID to remove section from (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Section type to remove (goal, context, current_behavior, desired_behavior, checklist_item,
    /// testing_criterion, anti_pattern, failure_test, constraint)
    #[arg(required = true)]
    pub section_type: SectionType,

    /// Remove specific section by ordinal (for multi-instance types)
    #[arg(long, short = 'i')]
    pub index: Option<u32>,
}

/// Result of the unsection command execution
#[derive(Debug)]
pub struct UnsectionResult {
    /// The task ID that was updated
    pub id: String,
    /// Number of sections removed
    pub removed_count: usize,
    /// The section type that was removed
    pub section_type: SectionType,
}

impl std::fmt::Display for UnsectionResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.removed_count {
            0 => write!(f, "No {} sections found to remove", self.section_type),
            1 => write!(
                f,
                "Removed {} section from task: {}",
                self.section_type, self.id
            ),
            count => write!(
                f,
                "Removed {} {} sections from task: {}",
                count, self.section_type, self.id
            ),
        }
    }
}

/// Result from querying a task's sections
#[derive(Debug, Deserialize)]
struct TaskSectionsRow {
    #[allow(dead_code)]
    id: vertebrae_core::Thing,
    #[serde(default)]
    sections: Vec<SectionRow>,
}

/// Section row from database
#[derive(Debug, Deserialize, Clone)]
struct SectionRow {
    #[serde(rename = "type", default)]
    section_type: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    content: Option<String>,
    #[serde(default)]
    order: Option<u32>,
}

impl UnsectionCommand {
    /// Execute the unsection command.
    ///
    /// Removes sections from a task based on the provided options:
    /// - If type + index: remove specific section at ordinal
    /// - If type + --all: remove all sections of that type
    /// - If type only (single-instance): remove the single instance
    /// - If type only (multi-instance) without --index: error
    /// - If --all only: remove all sections
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - The section to remove does not exist
    /// - For multi-instance types without --index
    /// - Database operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<UnsectionResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // We need to fetch task sections to determine what to remove
        // Get the service's database connection to verify task exists
        let db_result = services.tasks().get_task(&id).await?;

        // Convert task to sections for analysis
        let existing_sections: Vec<SectionRow> = db_result
            .sections
            .iter()
            .map(|s| SectionRow {
                section_type: Some(s.section_type.as_str().to_string()),
                content: Some(s.content.clone()),
                order: s.order,
            })
            .collect();

        let task = TaskSectionsRow {
            id: vertebrae_core::Thing::from(("task", id.as_str())),
            sections: existing_sections,
        };

        // Determine what to remove and perform the removal
        let removed_count = match self.index {
            // type + --index: remove specific section at ordinal
            Some(index) => {
                self.remove_at_index(services, &id, &self.section_type, index, &task.sections)
                    .await?
            }

            // type only (no --index): for single-instance, remove it; for multi-instance, error
            None => {
                if self.section_type.is_single_instance() {
                    self.remove_single_instance(services, &id, &self.section_type, &task.sections)
                        .await?
                } else {
                    return Err(ServiceError::validation_failed(format!(
                        "Section type '{}' can have multiple instances. Use --index <n> to remove a specific one",
                        self.section_type
                    )));
                }
            }
        };

        Ok(UnsectionResult {
            id,
            removed_count,
            section_type: self.section_type.clone(),
        })
    }

    /// Remove a specific section at the given ordinal
    async fn remove_at_index(
        &self,
        services: &VertebraeServices,
        id: &str,
        section_type: &SectionType,
        index: u32,
        existing_sections: &[SectionRow],
    ) -> Result<usize, ServiceError> {
        let type_str = section_type.as_str();

        // Find sections of this type and check if index exists
        let matching_sections: Vec<&SectionRow> = existing_sections
            .iter()
            .filter(|s| s.section_type.as_deref() == Some(type_str))
            .collect();

        // Check if the index exists
        let exists = matching_sections.iter().any(|s| s.order == Some(index));

        if !exists {
            return Err(ServiceError::validation_failed(format!(
                "No {} section found at index {}",
                section_type, index
            )));
        }

        // Use service method which handles finding by ordinal and renumbering
        services
            .tasks()
            .remove_section_by_ordinal(id, section_type.clone(), index)
            .await?;

        Ok(1)
    }

    /// Remove a single-instance section
    async fn remove_single_instance(
        &self,
        services: &VertebraeServices,
        id: &str,
        section_type: &SectionType,
        existing_sections: &[SectionRow],
    ) -> Result<usize, ServiceError> {
        let type_str = section_type.as_str();

        // Check if the section exists
        let exists = existing_sections
            .iter()
            .any(|s| s.section_type.as_deref() == Some(type_str));

        if !exists {
            return Err(ServiceError::validation_failed(format!(
                "No {} section found",
                section_type
            )));
        }

        // Use service layer to remove all sections of this type
        services
            .tasks()
            .remove_sections(id, section_type.clone(), None)
            .await?;

        Ok(1)
    }
}
