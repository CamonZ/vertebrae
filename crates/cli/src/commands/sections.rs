//! Sections command for listing sections of a task
//!
//! Implements the `vtb sections` command to display all sections for a task,
//! optionally filtered by type and grouped by positive/negative space.

use clap::Args;
use vertebrae_core::{ServiceError, TaskService};
use vertebrae_db::{Section, SectionType};

/// List all sections for a task
#[derive(Debug, Args)]
pub struct SectionsCommand {
    /// Task ID to show sections for (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Filter by section type (optional)
    #[arg(long = "type", value_parser = parse_section_type)]
    pub section_type: Option<SectionType>,
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

/// Result of the sections command execution
#[derive(Debug)]
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
            format_section_group(f, &positive, SectionType::Step, "Steps")?;
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
            | SectionType::Step
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
fn format_code_ref_location(code_ref: &vertebrae_db::CodeRef) -> String {
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
    pub async fn execute(&self, service: &dyn TaskService) -> Result<SectionsResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task using service
        let task = service
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
        SectionType::Step => 4,
        SectionType::TestingCriterion => 5,
        // Negative space order
        SectionType::AntiPattern => 6,
        SectionType::FailureTest => 7,
        SectionType::Constraint => 8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::{CreateTaskOptions, DefaultTaskService};
    use vertebrae_db::Database;

    /// Helper to create a test service with in-memory database
    async fn setup_test_service() -> DefaultTaskService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultTaskService::new(db)
    }

    /// Helper to create a task with the service
    async fn create_task_with_section(
        service: &DefaultTaskService,
        title: &str,
        section_type: SectionType,
        content: &str,
        order: Option<u32>,
    ) -> String {
        let options = CreateTaskOptions::new(title);
        let created_id = service.create_task(options).await.unwrap();

        // Create section and append it
        let mut section = if let Some(ord) = order {
            Section::with_order(section_type, content.to_string(), ord)
        } else {
            Section::new(section_type, content.to_string())
        };
        section.refs = vec![];
        service.add_section(&created_id, section).await.unwrap();

        created_id
    }

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
            parse_section_type("ANTI_PATTERN").unwrap(),
            SectionType::AntiPattern
        );
    }

    #[test]
    fn test_parse_section_type_invalid() {
        let result = parse_section_type("invalid");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("invalid section type 'invalid'"),
            "Error should indicate the invalid section type"
        );
        assert!(
            err.contains("goal"),
            "Error should list valid section types"
        );
    }

    #[test]
    fn test_is_positive_space() {
        // Positive space types
        assert!(is_positive_space(&SectionType::Goal));
        assert!(is_positive_space(&SectionType::Context));
        assert!(is_positive_space(&SectionType::CurrentBehavior));
        assert!(is_positive_space(&SectionType::DesiredBehavior));
        assert!(is_positive_space(&SectionType::Step));
        assert!(is_positive_space(&SectionType::TestingCriterion));

        // Negative space types
        assert!(!is_positive_space(&SectionType::AntiPattern));
        assert!(!is_positive_space(&SectionType::FailureTest));
        assert!(!is_positive_space(&SectionType::Constraint));
    }

    #[test]
    fn test_type_sort_order() {
        // Verify positive space comes before negative space
        assert!(type_sort_order(&SectionType::Goal) < type_sort_order(&SectionType::AntiPattern));

        // Verify order within positive space
        assert!(type_sort_order(&SectionType::Goal) < type_sort_order(&SectionType::Context));
        assert!(type_sort_order(&SectionType::Context) < type_sort_order(&SectionType::Step));

        // Verify order within negative space
        assert!(
            type_sort_order(&SectionType::AntiPattern) < type_sort_order(&SectionType::FailureTest)
        );
        assert!(
            type_sort_order(&SectionType::FailureTest) < type_sort_order(&SectionType::Constraint)
        );
    }

    #[tokio::test]
    async fn test_sections_all() {
        let service = setup_test_service().await;

        let task_id =
            create_task_with_section(&service, "Test Task", SectionType::Goal, "The goal", None)
                .await;
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::Step, "Step 1".to_string(), 0),
            )
            .await
            .unwrap();
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::Step, "Step 2".to_string(), 1),
            )
            .await
            .unwrap();
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::AntiPattern, "Don't do this".to_string(), 0),
            )
            .await
            .unwrap();

        let cmd = SectionsCommand {
            id: task_id.clone(),
            section_type: None,
        };

        let result = cmd.execute(&service).await;
        assert!(
            result.is_ok(),
            "Sections command failed: {:?}",
            result.err()
        );

        let sections_result = result.unwrap();
        assert_eq!(sections_result.id, task_id.to_lowercase());
        assert_eq!(sections_result.sections.len(), 4);
        assert!(sections_result.filter_type.is_none());

        // Verify ordering - positive space first, then type order, then ordinal
        assert_eq!(sections_result.sections[0].section_type, SectionType::Goal);
        assert_eq!(sections_result.sections[1].section_type, SectionType::Step);
        assert_eq!(sections_result.sections[1].order, Some(0));
        assert_eq!(sections_result.sections[2].section_type, SectionType::Step);
        assert_eq!(sections_result.sections[2].order, Some(1));
        assert_eq!(
            sections_result.sections[3].section_type,
            SectionType::AntiPattern
        );
    }

    #[tokio::test]
    async fn test_sections_filter_by_type() {
        let service = setup_test_service().await;

        let task_id =
            create_task_with_section(&service, "Test Task", SectionType::Goal, "The goal", None)
                .await;
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::Step, "Step 1".to_string(), 0),
            )
            .await
            .unwrap();
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::Step, "Step 2".to_string(), 1),
            )
            .await
            .unwrap();
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::AntiPattern, "Don't do this".to_string(), 0),
            )
            .await
            .unwrap();

        let cmd = SectionsCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Step),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let sections_result = result.unwrap();
        assert_eq!(sections_result.sections.len(), 2);
        assert!(
            sections_result
                .sections
                .iter()
                .all(|s| s.section_type == SectionType::Step)
        );

        // Verify ordinals are preserved
        assert_eq!(sections_result.sections[0].order, Some(0));
        assert_eq!(sections_result.sections[1].order, Some(1));

        // Verify specific step contents
        use std::collections::HashSet;
        let step_contents: HashSet<_> = sections_result
            .sections
            .iter()
            .map(|s| s.content.as_str())
            .collect();
        assert!(step_contents.contains("Step 1"), "Should contain 'Step 1'");
        assert!(step_contents.contains("Step 2"), "Should contain 'Step 2'");
    }

    #[tokio::test]
    async fn test_sections_filter_anti_pattern() {
        let service = setup_test_service().await;

        let task_id =
            create_task_with_section(&service, "Test Task", SectionType::Goal, "The goal", None)
                .await;
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::AntiPattern, "Don't do this".to_string(), 0),
            )
            .await
            .unwrap();
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::AntiPattern, "Avoid that".to_string(), 1),
            )
            .await
            .unwrap();

        let cmd = SectionsCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::AntiPattern),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let sections_result = result.unwrap();
        assert_eq!(sections_result.sections.len(), 2);
        assert!(
            sections_result
                .sections
                .iter()
                .all(|s| s.section_type == SectionType::AntiPattern)
        );

        // Verify specific anti-pattern contents
        use std::collections::HashSet;
        let contents: HashSet<_> = sections_result
            .sections
            .iter()
            .map(|s| s.content.as_str())
            .collect();
        assert!(
            contents.contains("Don't do this"),
            "Should contain 'Don't do this'"
        );
        assert!(
            contents.contains("Avoid that"),
            "Should contain 'Avoid that'"
        );
    }

    #[tokio::test]
    async fn test_sections_empty() {
        let service = setup_test_service().await;

        let options = CreateTaskOptions::new("Test Task");
        let task_id = service.create_task(options).await.unwrap();

        let cmd = SectionsCommand {
            id: task_id.clone(),
            section_type: None,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let sections_result = result.unwrap();
        assert!(sections_result.sections.is_empty());

        // Test display
        let output = format!("{}", sections_result);
        assert_eq!(output, "No sections defined");
    }

    #[tokio::test]
    async fn test_sections_filter_no_matches() {
        let service = setup_test_service().await;

        let task_id =
            create_task_with_section(&service, "Test Task", SectionType::Goal, "The goal", None)
                .await;

        let cmd = SectionsCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::AntiPattern),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let sections_result = result.unwrap();
        assert!(sections_result.sections.is_empty());

        // Test display
        let output = format!("{}", sections_result);
        assert_eq!(output, "No sections of type 'anti_pattern'");
    }

    #[tokio::test]
    async fn test_sections_nonexistent_task() {
        let service = setup_test_service().await;

        let cmd = SectionsCommand {
            id: "nonexistent".to_string(),
            section_type: None,
        };

        let result = cmd.execute(&service).await;
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
    async fn test_sections_case_insensitive_id() {
        let service = setup_test_service().await;

        let task_id =
            create_task_with_section(&service, "Test Task", SectionType::Goal, "The goal", None)
                .await;

        let cmd = SectionsCommand {
            id: task_id.to_uppercase(),
            section_type: None,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let sections_result = result.unwrap();
        assert_eq!(sections_result.sections.len(), 1);
    }

    #[tokio::test]
    async fn test_sections_ordered_by_ordinal() {
        let service = setup_test_service().await;

        let options = CreateTaskOptions::new("Test Task");
        let task_id = service.create_task(options).await.unwrap();

        // Add in reverse order
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::Step, "Step 3".to_string(), 2),
            )
            .await
            .unwrap();
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::Step, "Step 1".to_string(), 0),
            )
            .await
            .unwrap();
        service
            .add_section(
                &task_id,
                Section::with_order(SectionType::Step, "Step 2".to_string(), 1),
            )
            .await
            .unwrap();

        let cmd = SectionsCommand {
            id: task_id.clone(),
            section_type: None,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let sections_result = result.unwrap();
        assert_eq!(sections_result.sections.len(), 3);
        assert_eq!(sections_result.sections[0].content, "Step 1");
        assert_eq!(sections_result.sections[1].content, "Step 2");
        assert_eq!(sections_result.sections[2].content, "Step 3");
    }

    #[test]
    fn test_sections_result_display_all() {
        let result = SectionsResult {
            id: "task1".to_string(),
            sections: vec![
                Section::new(SectionType::Goal, "The goal"),
                Section::with_order(SectionType::Step, "Step 1", 0),
                Section::with_order(SectionType::Step, "Step 2", 1),
                Section::with_order(SectionType::AntiPattern, "Don't do this", 0),
            ],
            filter_type: None,
        };

        let output = format!("{}", result);
        let lines: Vec<&str> = output.lines().collect();

        // Check structured output
        assert_eq!(lines[0], "Sections for task: task1");
        assert!(lines[1].starts_with("="), "Second line should be separator");

        // Find Desired Behavior section
        let pos_idx = lines.iter().position(|l| *l == "Desired Behavior").unwrap();
        assert!(
            lines[pos_idx + 1].starts_with("-"),
            "Should have separator after Desired Behavior"
        );

        // Check goal and steps appear
        assert!(lines.contains(&"Goal: The goal"), "Should have Goal line");
        assert!(lines.contains(&"Steps:"), "Should have Steps header");
        assert!(
            lines.iter().any(|l| l.trim() == "[0] Step 1"),
            "Should have Step 1 with ordinal"
        );
        assert!(
            lines.iter().any(|l| l.trim() == "[1] Step 2"),
            "Should have Step 2 with ordinal"
        );

        // Find Undesired Behavior section
        let neg_idx = lines
            .iter()
            .position(|l| *l == "Undesired Behavior")
            .unwrap();
        assert!(
            neg_idx > pos_idx,
            "Undesired Behavior should come after Desired Behavior"
        );
        assert!(
            lines.contains(&"Anti-Patterns:"),
            "Should have Anti-Patterns header"
        );
        assert!(
            lines.iter().any(|l| l.trim() == "[0] Don't do this"),
            "Should have anti-pattern with ordinal"
        );
    }

    #[test]
    fn test_sections_result_display_only_positive() {
        let result = SectionsResult {
            id: "task1".to_string(),
            sections: vec![
                Section::new(SectionType::Goal, "The goal"),
                Section::new(SectionType::Context, "Some context"),
            ],
            filter_type: None,
        };

        let output = format!("{}", result);
        let lines: Vec<&str> = output.lines().collect();

        // Check Desired Behavior exists
        assert!(
            lines.contains(&"Desired Behavior"),
            "Should have Desired Behavior header"
        );
        assert!(lines.contains(&"Goal: The goal"), "Should have Goal line");
        assert!(
            lines.contains(&"Context: Some context"),
            "Should have Context line"
        );
        assert!(
            !lines.contains(&"Undesired Behavior"),
            "Should not have Undesired Behavior header"
        );
    }

    #[test]
    fn test_sections_result_display_only_negative() {
        let result = SectionsResult {
            id: "task1".to_string(),
            sections: vec![
                Section::with_order(SectionType::AntiPattern, "Don't do this", 0),
                Section::with_order(SectionType::Constraint, "Must be fast", 0),
            ],
            filter_type: None,
        };

        let output = format!("{}", result);
        let lines: Vec<&str> = output.lines().collect();

        assert!(
            !lines.contains(&"Desired Behavior"),
            "Should not have Desired Behavior header"
        );
        assert!(
            lines.contains(&"Undesired Behavior"),
            "Should have Undesired Behavior header"
        );
        assert!(
            lines.contains(&"Anti-Patterns:"),
            "Should have Anti-Patterns header"
        );
        assert!(
            lines.contains(&"Constraints:"),
            "Should have Constraints header"
        );
    }

    #[test]
    fn test_sections_command_debug() {
        let cmd = SectionsCommand {
            id: "test".to_string(),
            section_type: None,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("SectionsCommand") && debug_str.contains("id: \"test\""),
            "Debug output should contain SectionsCommand and id field"
        );
    }

    #[test]
    fn test_sections_result_debug() {
        let result = SectionsResult {
            id: "task1".to_string(),
            sections: vec![],
            filter_type: None,
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("SectionsResult") && debug_str.contains("id: \"task1\""),
            "Debug output should contain SectionsResult and id field"
        );
    }
}
