//! Unsection command for removing sections from tasks
//!
//! Implements the `vtb unsection` command to remove sections from tasks.
//! Supports removing single-instance types, specific multi-instance sections by index,
//! all sections of a type, or all sections from a task.

use clap::Args;
use serde::Deserialize;
use vertebrae_core::SectionType;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Remove sections from a task
#[derive(Debug, Args)]
pub struct UnsectionCommand {
    /// Task ID to remove section from (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Section type to remove (goal, context, current_behavior, desired_behavior, step,
    /// testing_criterion, anti_pattern, failure_test, constraint)
    #[arg(value_parser = parse_section_type)]
    pub section_type: Option<SectionType>,

    /// Remove specific section by ordinal (for multi-instance types)
    #[arg(long, short = 'i', conflicts_with = "all")]
    pub index: Option<u32>,

    /// Remove all sections of the specified type, or all sections if no type is specified
    #[arg(long, short = 'a')]
    pub all: bool,
}

/// Parse a section type string into SectionType enum (case-insensitive)
fn parse_section_type(s: &str) -> Result<SectionType, String> {
    match s.to_lowercase().as_str() {
        "goal" => Ok(SectionType::Goal),
        "context" => Ok(SectionType::Context),
        "current_behavior" => Ok(SectionType::CurrentBehavior),
        "desired_behavior" => Ok(SectionType::DesiredBehavior),
        "step" => Ok(SectionType::Step),
        "testing_criterion" => Ok(SectionType::TestingCriterion),
        "anti_pattern" => Ok(SectionType::AntiPattern),
        "failure_test" => Ok(SectionType::FailureTest),
        "constraint" => Ok(SectionType::Constraint),
        _ => Err(format!(
            "invalid section type '{}'. Valid types: goal, context, current_behavior, \
             desired_behavior, step, testing_criterion, anti_pattern, failure_test, constraint",
            s
        )),
    }
}

/// Result of the unsection command execution
#[derive(Debug)]
pub struct UnsectionResult {
    /// The task ID that was updated
    pub id: String,
    /// Number of sections removed
    pub removed_count: usize,
    /// The section type that was removed (if specified)
    pub section_type: Option<SectionType>,
    /// Whether --all flag was used
    pub removed_all: bool,
}

impl std::fmt::Display for UnsectionResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (self.removed_count, &self.section_type, self.removed_all) {
            (0, Some(section_type), _) => {
                write!(f, "No {} sections found to remove", section_type)
            }
            (0, None, true) => {
                write!(f, "No sections found to remove")
            }
            (0, None, false) => {
                write!(f, "No sections found to remove")
            }
            (1, Some(section_type), _) => {
                write!(f, "Removed {} section from task: {}", section_type, self.id)
            }
            (count, Some(section_type), true) => {
                write!(
                    f,
                    "Removed {} {} sections from task: {}",
                    count, section_type, self.id
                )
            }
            (count, None, true) => {
                write!(f, "Removed all {} sections from task: {}", count, self.id)
            }
            (count, _, _) => {
                write!(f, "Removed {} section(s) from task: {}", count, self.id)
            }
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

/// Check if a section type is single-instance (can only have one per task).
///
/// Single-instance types: goal, context, current_behavior, desired_behavior
/// Multi-instance types: step, testing_criterion, anti_pattern, failure_test, constraint
fn is_single_instance_type(section_type: &SectionType) -> bool {
    matches!(
        section_type,
        SectionType::Goal
            | SectionType::Context
            | SectionType::CurrentBehavior
            | SectionType::DesiredBehavior
    )
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
    /// - For multi-instance types without --index or --all
    /// - Database operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<UnsectionResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate command arguments
        self.validate_arguments()?;

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
        let removed_count = match (&self.section_type, self.index, self.all) {
            // --all without type: remove all sections
            (None, None, true) => {
                self.remove_all_sections(services, &id, &task.sections)
                    .await?
            }

            // type + --all: remove all sections of that type
            (Some(section_type), None, true) => {
                self.remove_all_of_type(services, &id, section_type, &task.sections)
                    .await?
            }

            // type + --index: remove specific section at ordinal
            (Some(section_type), Some(index), false) => {
                self.remove_at_index(services, &id, section_type, index, &task.sections)
                    .await?
            }

            // type only (no --index, no --all): for single-instance, remove it; for multi-instance, error
            (Some(section_type), None, false) => {
                if is_single_instance_type(section_type) {
                    self.remove_single_instance(services, &id, section_type, &task.sections)
                        .await?
                } else {
                    return Err(ServiceError::validation_failed(format!(
                        "Section type '{}' can have multiple instances. Use --index <n> to remove a specific one or --all to remove all",
                        section_type
                    )));
                }
            }

            // No type, no --all, with or without index: invalid
            (None, _, false) => {
                return Err(ServiceError::validation_failed(
                    "Must specify a section type or use --all to remove all sections",
                ));
            }

            // type + --index + --all would be caught by clap conflicts_with
            _ => unreachable!(),
        };

        Ok(UnsectionResult {
            id,
            removed_count,
            section_type: self.section_type.clone(),
            removed_all: self.all,
        })
    }

    /// Validate command arguments
    fn validate_arguments(&self) -> Result<(), ServiceError> {
        // --index without type is invalid
        if self.index.is_some() && self.section_type.is_none() {
            return Err(ServiceError::validation_failed(
                "--index requires a section type",
            ));
        }
        Ok(())
    }

    /// Remove all sections from the task
    async fn remove_all_sections(
        &self,
        services: &VertebraeServices,
        id: &str,
        existing_sections: &[SectionRow],
    ) -> Result<usize, ServiceError> {
        let count = existing_sections.len();

        if count == 0 {
            return Ok(0);
        }

        // Remove all sections of each type that exists
        let mut types_to_remove = Vec::new();
        for section in existing_sections {
            if let Some(type_str) = &section.section_type
                && !types_to_remove
                    .iter()
                    .any(|t: &SectionType| t.as_str() == type_str)
                && let Ok(section_type) = parse_section_type(type_str)
            {
                types_to_remove.push(section_type);
            }
        }

        // Remove all sections of each type
        for section_type in types_to_remove {
            services
                .tasks()
                .remove_sections(id, section_type, None)
                .await?;
        }

        Ok(count)
    }

    /// Remove all sections of a specific type
    async fn remove_all_of_type(
        &self,
        services: &VertebraeServices,
        id: &str,
        section_type: &SectionType,
        existing_sections: &[SectionRow],
    ) -> Result<usize, ServiceError> {
        let type_str = section_type.as_str();

        // Count how many we'll remove
        let count = existing_sections
            .iter()
            .filter(|s| s.section_type.as_deref() == Some(type_str))
            .count();

        if count == 0 {
            return Ok(0);
        }

        // Use service layer to remove all sections of this type
        services
            .tasks()
            .remove_sections(id, section_type.clone(), None)
            .await?;

        Ok(count)
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
