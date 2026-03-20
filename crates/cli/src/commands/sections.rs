//! Sections command for listing sections of a task
//!
//! Implements the `vtb sections` command to display all sections for a task,
//! optionally filtered by type and grouped by positive/negative space.

use clap::Args;
use serde::Serialize;
use vertebrae_core::{Section, SectionType};
use vertebrae_core::{ServiceError, VertebraeServices};

/// List all sections for a task
#[derive(Debug, Args)]
pub struct SectionsCommand {
    /// Task ID to list sections for (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Filter by section type (optional)
    #[arg(long = "type")]
    pub section_type: Option<SectionType>,
}

/// Result of the sections command execution
#[derive(Debug, Serialize)]
pub struct SectionsResult {
    /// The task ID
    pub id: String,
    /// The sections found
    pub sections: Vec<Section>,
    /// The type filter that was applied (if any)
    pub filter_type: Option<SectionType>,
}

impl std::fmt::Display for SectionsResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.sections.is_empty() {
            return if let Some(ref filter_type) = self.filter_type {
                write!(f, "No sections of type '{}'", filter_type)
            } else {
                write!(f, "No sections defined")
            };
        }

        // Split sections into positive and negative space
        let positive: Vec<&Section> = self
            .sections
            .iter()
            .filter(|s| is_positive_space(&s.section_type))
            .collect();

        let negative: Vec<&Section> = self
            .sections
            .iter()
            .filter(|s| !is_positive_space(&s.section_type))
            .collect();

        writeln!(f, "Sections for task: {}", self.id)?;
        writeln!(f, "{}", "=".repeat(60))?;

        // Display desired behavior sections
        if !positive.is_empty() {
            writeln!(f)?;
            writeln!(f, "Desired Behavior")?;
            writeln!(f, "{}", "-".repeat(40))?;
            format_section_group(f, &positive, SectionType::Goal, "Goal")?;
            format_section_group(f, &positive, SectionType::Context, "Context")?;
            format_section_group(
                f,
                &positive,
                SectionType::CurrentBehavior,
                "Current Behavior",
            )?;
            format_section_group(
                f,
                &positive,
                SectionType::DesiredBehavior,
                "Desired Behavior",
            )?;
            format_section_group(f, &positive, SectionType::ChecklistItem, "Checklist Items")?;
            format_section_group(
                f,
                &positive,
                SectionType::TestingCriterion,
                "Testing Criteria",
            )?;
        }

        // Display undesired behavior sections
        if !negative.is_empty() {
            writeln!(f)?;
            writeln!(f, "Undesired Behavior")?;
            writeln!(f, "{}", "-".repeat(40))?;
            format_section_group(f, &negative, SectionType::AntiPattern, "Anti-Patterns")?;
            format_section_group(f, &negative, SectionType::FailureTest, "Failure Tests")?;
            format_section_group(f, &negative, SectionType::Constraint, "Constraints")?;
        }

        Ok(())
    }
}

/// Check if a section type belongs to positive space
fn is_positive_space(section_type: &SectionType) -> bool {
    matches!(
        section_type,
        SectionType::Goal
            | SectionType::Context
            | SectionType::CurrentBehavior
            | SectionType::DesiredBehavior
            | SectionType::ChecklistItem
            | SectionType::TestingCriterion
    )
}

/// Format a group of sections by type
fn format_section_group(
    f: &mut std::fmt::Formatter<'_>,
    sections: &[&Section],
    section_type: SectionType,
    label: &str,
) -> std::fmt::Result {
    let matching: Vec<&&Section> = sections
        .iter()
        .filter(|s| s.section_type == section_type)
        .collect();

    if matching.is_empty() {
        return Ok(());
    }

    // Sort by order if available
    let mut sorted: Vec<_> = matching.into_iter().collect();
    sorted.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    // Check if this is a multi-instance type
    let is_multi_instance = !matches!(
        section_type,
        SectionType::Goal
            | SectionType::Context
            | SectionType::CurrentBehavior
            | SectionType::DesiredBehavior
    );

    // Check if this is a testing criterion (show refs inline)
    let is_testing_criterion = section_type == SectionType::TestingCriterion;

    if sorted.len() == 1 && !is_multi_instance {
        writeln!(f, "{}: {}", label, sorted[0].content)?;
        // Show refs for single testing criterion
        if is_testing_criterion && !sorted[0].refs.is_empty() {
            for code_ref in &sorted[0].refs {
                writeln!(f, "     -> {}", format_code_ref_location(code_ref))?;
            }
        }
    } else {
        writeln!(f, "{}:", label)?;
        for section in sorted {
            if let Some(ordinal) = section.order {
                writeln!(f, "  [{}] {}", ordinal, section.content)?;
            } else {
                writeln!(f, "  - {}", section.content)?;
            }
            // Show refs inline for each testing criterion
            if is_testing_criterion && !section.refs.is_empty() {
                for code_ref in &section.refs {
                    writeln!(f, "      -> {}", format_code_ref_location(code_ref))?;
                }
            }
        }
    }

    Ok(())
}

/// Format a code reference location in file:line format
fn format_code_ref_location(code_ref: &vertebrae_core::CodeRef) -> String {
    let location = match (code_ref.line_start, code_ref.line_end) {
        (Some(start), Some(end)) => format!("{}:L{}-{}", code_ref.path, start, end),
        (Some(line), None) => format!("{}:L{}", code_ref.path, line),
        _ => code_ref.path.clone(),
    };

    if let Some(ref name) = code_ref.name {
        format!("{} [{}]", location, name)
    } else {
        location
    }
}

impl SectionsCommand {
    /// Execute the sections command.
    ///
    /// Fetches all sections for a task, optionally filtered by type,
    /// and returns them grouped by positive/negative space.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - Service operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<SectionsResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task using service
        let task = services
            .tasks()
            .get_task(&id)
            .await
            .map_err(|_e| ServiceError::task_not_found(&self.id))?;

        // Use the task's sections directly
        let mut sections = task.sections;

        // Apply type filter if specified
        if let Some(ref filter_type) = self.section_type {
            sections.retain(|s| &s.section_type == filter_type);
        }

        // Sort sections by:
        // 1. Positive/negative space (positive first)
        // 2. Type order within each space
        // 3. Ordinal within type
        sections.sort_by(|a, b| {
            let a_positive = is_positive_space(&a.section_type);
            let b_positive = is_positive_space(&b.section_type);

            // Positive space comes first
            match (a_positive, b_positive) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => {
                    // Same space, sort by type order
                    let a_type_order = type_sort_order(&a.section_type);
                    let b_type_order = type_sort_order(&b.section_type);

                    match a_type_order.cmp(&b_type_order) {
                        std::cmp::Ordering::Equal => {
                            // Same type, sort by ordinal
                            let a_order = a.order.unwrap_or(u32::MAX);
                            let b_order = b.order.unwrap_or(u32::MAX);
                            a_order.cmp(&b_order)
                        }
                        other => other,
                    }
                }
            }
        });

        Ok(SectionsResult {
            id,
            sections,
            filter_type: self.section_type.clone(),
        })
    }
}

/// Get the sort order for a section type within its space
fn type_sort_order(section_type: &SectionType) -> u8 {
    match section_type {
        // Positive space order
        SectionType::Goal => 0,
        SectionType::Context => 1,
        SectionType::CurrentBehavior => 2,
        SectionType::DesiredBehavior => 3,
        SectionType::ChecklistItem => 4,
        SectionType::TestingCriterion => 5,
        // Negative space order
        SectionType::AntiPattern => 6,
        SectionType::FailureTest => 7,
        SectionType::Constraint => 8,
    }
}
