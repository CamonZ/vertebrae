//! Sections command for listing sections of a task
//!
//! Implements the `vtb sections` command to display all sections for a task,
//! optionally filtered by type and grouped by positive/negative space.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError, Section, SectionType};

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

        // Display positive space sections
        if !positive.is_empty() {
            writeln!(f)?;
            writeln!(f, "Positive Space")?;
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

        // Display negative space sections
        if !negative.is_empty() {
            writeln!(f)?;
            writeln!(f, "Negative Space")?;
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

    if sorted.len() == 1 && !is_multi_instance {
        writeln!(f, "{}: {}", label, sorted[0].content)?;
    } else {
        writeln!(f, "{}:", label)?;
        for section in sorted {
            if let Some(ordinal) = section.order {
                writeln!(f, "  [{}] {}", ordinal, section.content)?;
            } else {
                writeln!(f, "  - {}", section.content)?;
            }
        }
    }

    Ok(())
}

/// Result from querying a task's sections
#[derive(Debug, Deserialize)]
struct TaskSectionsRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    #[serde(default)]
    sections: Vec<SectionRow>,
}

/// Section row from database
#[derive(Debug, Deserialize, Clone)]
struct SectionRow {
    #[serde(rename = "type", default)]
    section_type: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    order: Option<u32>,
}

impl SectionsCommand {
    /// Execute the sections command.
    ///
    /// Fetches all sections for a task, optionally filtered by type,
    /// and returns them grouped by positive/negative space.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<SectionsResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task sections
        let task = self.fetch_task_sections(db, &id).await?;

        // Convert and filter sections
        let mut sections: Vec<Section> = task
            .sections
            .into_iter()
            .filter_map(|s| {
                let section_type_str = s.section_type?;
                let content = s.content?;
                let section_type = self.parse_section_type_from_db(&section_type_str);
                Some(if let Some(order) = s.order {
                    Section::with_order(section_type, content, order)
                } else {
                    Section::new(section_type, content)
                })
            })
            .collect();

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

    /// Fetch the task by ID and return its sections.
    async fn fetch_task_sections(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<TaskSectionsRow, DbError> {
        let query = format!("SELECT id, sections FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskSectionsRow> = result.take(0)?;

        task.ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&self.id),
            reason: format!("Task '{}' not found", self.id),
        })
    }

    /// Parse a section type string from the database into SectionType enum
    fn parse_section_type_from_db(&self, s: &str) -> SectionType {
        match s {
            "goal" => SectionType::Goal,
            "context" => SectionType::Context,
            "current_behavior" => SectionType::CurrentBehavior,
            "desired_behavior" => SectionType::DesiredBehavior,
            "step" => SectionType::Step,
            "testing_criterion" => SectionType::TestingCriterion,
            "anti_pattern" => SectionType::AntiPattern,
            "failure_test" => SectionType::FailureTest,
            "constraint" => SectionType::Constraint,
            // Default to Goal if unknown (should not happen with schema validation)
            _ => SectionType::Goal,
        }
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
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-sections-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let db = Database::connect(&temp_dir).await.unwrap();
        db.init().await.unwrap();

        (db, temp_dir)
    }

    /// Helper to create a task in the database
    async fn create_task(db: &Database, id: &str, title: &str) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "task",
                status = "todo",
                tags = [],
                sections = [],
                refs = []"#,
            id, title
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to add a section to a task
    async fn add_section(
        db: &Database,
        id: &str,
        section_type: &str,
        content: &str,
        order: Option<u32>,
    ) {
        let escaped_content = content.replace('\\', "\\\\").replace('"', "\\\"");
        let section_obj = if let Some(ord) = order {
            format!(
                r#"{{ "type": "{}", "content": "{}", "order": {} }}"#,
                section_type, escaped_content, ord
            )
        } else {
            format!(
                r#"{{ "type": "{}", "content": "{}" }}"#,
                section_type, escaped_content
            )
        };

        let query = format!(
            "UPDATE task:{} SET sections = array::append(sections, {})",
            id, section_obj
        );
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
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
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;
        add_section(&db, "task1", "step", "Step 1", Some(0)).await;
        add_section(&db, "task1", "step", "Step 2", Some(1)).await;
        add_section(&db, "task1", "anti_pattern", "Don't do this", Some(0)).await;

        let cmd = SectionsCommand {
            id: "task1".to_string(),
            section_type: None,
        };

        let result = cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Sections command failed: {:?}",
            result.err()
        );

        let sections_result = result.unwrap();
        assert_eq!(sections_result.id, "task1");
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_sections_filter_by_type() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;
        add_section(&db, "task1", "step", "Step 1", Some(0)).await;
        add_section(&db, "task1", "step", "Step 2", Some(1)).await;
        add_section(&db, "task1", "anti_pattern", "Don't do this", Some(0)).await;

        let cmd = SectionsCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Step),
        };

        let result = cmd.execute(&db).await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_sections_filter_anti_pattern() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;
        add_section(&db, "task1", "anti_pattern", "Don't do this", Some(0)).await;
        add_section(&db, "task1", "anti_pattern", "Avoid that", Some(1)).await;

        let cmd = SectionsCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::AntiPattern),
        };

        let result = cmd.execute(&db).await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_sections_empty() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = SectionsCommand {
            id: "task1".to_string(),
            section_type: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let sections_result = result.unwrap();
        assert!(sections_result.sections.is_empty());

        // Test display
        let output = format!("{}", sections_result);
        assert_eq!(output, "No sections defined");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_sections_filter_no_matches() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;

        let cmd = SectionsCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::AntiPattern),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let sections_result = result.unwrap();
        assert!(sections_result.sections.is_empty());

        // Test display
        let output = format!("{}", sections_result);
        assert_eq!(output, "No sections of type 'anti_pattern'");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_sections_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = SectionsCommand {
            id: "nonexistent".to_string(),
            section_type: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("not found"),
                    "Expected 'not found' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("nonexistent"),
                    "Expected task ID 'nonexistent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_sections_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;

        let cmd = SectionsCommand {
            id: "TASK1".to_string(),
            section_type: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let sections_result = result.unwrap();
        assert_eq!(sections_result.sections.len(), 1);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_sections_ordered_by_ordinal() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        // Add in reverse order
        add_section(&db, "task1", "step", "Step 3", Some(2)).await;
        add_section(&db, "task1", "step", "Step 1", Some(0)).await;
        add_section(&db, "task1", "step", "Step 2", Some(1)).await;

        let cmd = SectionsCommand {
            id: "task1".to_string(),
            section_type: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let sections_result = result.unwrap();
        assert_eq!(sections_result.sections.len(), 3);
        assert_eq!(sections_result.sections[0].content, "Step 1");
        assert_eq!(sections_result.sections[1].content, "Step 2");
        assert_eq!(sections_result.sections[2].content, "Step 3");

        cleanup(&temp_dir);
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

        // Find Positive Space section
        let pos_idx = lines.iter().position(|l| *l == "Positive Space").unwrap();
        assert!(
            lines[pos_idx + 1].starts_with("-"),
            "Should have separator after Positive Space"
        );

        // Check goal and steps appear
        assert!(
            lines.iter().any(|l| *l == "Goal: The goal"),
            "Should have Goal line"
        );
        assert!(
            lines.iter().any(|l| *l == "Steps:"),
            "Should have Steps header"
        );
        assert!(
            lines.iter().any(|l| l.trim() == "[0] Step 1"),
            "Should have Step 1 with ordinal"
        );
        assert!(
            lines.iter().any(|l| l.trim() == "[1] Step 2"),
            "Should have Step 2 with ordinal"
        );

        // Find Negative Space section
        let neg_idx = lines.iter().position(|l| *l == "Negative Space").unwrap();
        assert!(
            neg_idx > pos_idx,
            "Negative Space should come after Positive Space"
        );
        assert!(
            lines.iter().any(|l| *l == "Anti-Patterns:"),
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

        // Check Positive Space exists
        assert!(
            lines.iter().any(|l| *l == "Positive Space"),
            "Should have Positive Space header"
        );
        assert!(
            lines.iter().any(|l| *l == "Goal: The goal"),
            "Should have Goal line"
        );
        assert!(
            lines.iter().any(|l| *l == "Context: Some context"),
            "Should have Context line"
        );
        assert!(
            !lines.iter().any(|l| *l == "Negative Space"),
            "Should not have Negative Space header"
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
            !lines.iter().any(|l| *l == "Positive Space"),
            "Should not have Positive Space header"
        );
        assert!(
            lines.iter().any(|l| *l == "Negative Space"),
            "Should have Negative Space header"
        );
        assert!(
            lines.iter().any(|l| *l == "Anti-Patterns:"),
            "Should have Anti-Patterns header"
        );
        assert!(
            lines.iter().any(|l| *l == "Constraints:"),
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
