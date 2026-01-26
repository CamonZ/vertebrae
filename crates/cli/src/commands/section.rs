//! Section command for adding typed content sections to tasks
//!
//! Implements the `vtb section` command to add sections for context curation.
//! Supports both positive space (goal, context, current_behavior, desired_behavior,
//! step, testing_criterion) and negative space (anti_pattern, failure_test, constraint)
//! section types.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};
use vertebrae_db::{Section, SectionType};

/// Add a typed content section to a task
#[derive(Debug, Args)]
pub struct SectionCommand {
    /// Task ID to add section to (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Section type (goal, context, current_behavior, desired_behavior, step,
    /// testing_criterion, anti_pattern, failure_test, constraint)
    #[arg(required = true, value_parser = parse_section_type)]
    pub section_type: SectionType,

    /// Section content
    #[arg(required = true)]
    pub content: String,
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

/// Result of the section command execution
#[derive(Debug)]
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
    /// For multi-instance types (step, testing_criterion, anti_pattern, failure_test,
    /// constraint), appends with auto-incrementing ordinal.
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
        let (ordinal, replaced) = if is_single_instance_type(&self.section_type) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_section_type_valid() {
        assert_eq!(parse_section_type("goal").unwrap(), SectionType::Goal);
        assert_eq!(parse_section_type("context").unwrap(), SectionType::Context);
        assert_eq!(
            parse_section_type("current_behavior").unwrap(),
            SectionType::CurrentBehavior
        );
        assert_eq!(
            parse_section_type("desired_behavior").unwrap(),
            SectionType::DesiredBehavior
        );
        assert_eq!(parse_section_type("step").unwrap(), SectionType::Step);
        assert_eq!(
            parse_section_type("testing_criterion").unwrap(),
            SectionType::TestingCriterion
        );
        assert_eq!(
            parse_section_type("anti_pattern").unwrap(),
            SectionType::AntiPattern
        );
        assert_eq!(
            parse_section_type("failure_test").unwrap(),
            SectionType::FailureTest
        );
        assert_eq!(
            parse_section_type("constraint").unwrap(),
            SectionType::Constraint
        );
    }

    #[test]
    fn test_parse_section_type_case_insensitive() {
        assert_eq!(parse_section_type("GOAL").unwrap(), SectionType::Goal);
        assert_eq!(parse_section_type("Goal").unwrap(), SectionType::Goal);
        assert_eq!(parse_section_type("STEP").unwrap(), SectionType::Step);
        assert_eq!(
            parse_section_type("CURRENT_BEHAVIOR").unwrap(),
            SectionType::CurrentBehavior
        );
    }

    #[test]
    fn test_parse_section_type_invalid() {
        let result = parse_section_type("invalid");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid section type"));
        assert!(err.contains("goal"));
        assert!(err.contains("step"));
    }

    #[test]
    fn test_is_single_instance_type() {
        // Single-instance types
        assert!(is_single_instance_type(&SectionType::Goal));
        assert!(is_single_instance_type(&SectionType::Context));
        assert!(is_single_instance_type(&SectionType::CurrentBehavior));
        assert!(is_single_instance_type(&SectionType::DesiredBehavior));

        // Multi-instance types
        assert!(!is_single_instance_type(&SectionType::Step));
        assert!(!is_single_instance_type(&SectionType::TestingCriterion));
        assert!(!is_single_instance_type(&SectionType::AntiPattern));
        assert!(!is_single_instance_type(&SectionType::FailureTest));
        assert!(!is_single_instance_type(&SectionType::Constraint));
    }

    #[test]
    fn test_section_result_display_added() {
        let result = SectionResult {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            replaced: false,
            ordinal: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Added goal section to task: task1");
    }

    #[test]
    fn test_section_result_display_replaced() {
        let result = SectionResult {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            replaced: true,
            ordinal: None,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Replaced goal section for task: task1");
    }

    #[test]
    fn test_section_result_display_with_ordinal() {
        let result = SectionResult {
            id: "task1".to_string(),
            section_type: SectionType::Step,
            replaced: false,
            ordinal: Some(2),
        };

        let output = format!("{}", result);
        assert_eq!(output, "Added step section (ordinal 2) to task: task1");
    }

    #[test]
    fn test_section_command_debug() {
        let cmd = SectionCommand {
            id: "test123".to_string(),
            section_type: SectionType::Goal,
            content: "section content".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("SectionCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("Goal")
                && debug_str.contains("section content"),
            "Debug output should contain SectionCommand and all field values"
        );
    }

    #[test]
    fn test_section_result_debug() {
        let result = SectionResult {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            replaced: true,
            ordinal: Some(3),
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("SectionResult")
                && debug_str.contains("id: \"task1\"")
                && debug_str.contains("Goal")
                && debug_str.contains("replaced: true")
                && debug_str.contains("ordinal: Some(3)"),
            "Debug output should contain SectionResult and all field values"
        );
    }
}
