//! Section command for adding typed content sections to tasks
//!
//! Implements the `vtb section` command to add sections for context curation.
//! Supports both positive space (goal, context, current_behavior, desired_behavior,
//! step, testing_criterion) and negative space (anti_pattern, failure_test, constraint)
//! section types.

use clap::Args;
use vertebrae_db::{Database, DbError, Section, SectionType, TaskUpdate};

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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The content is empty
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<SectionResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate content is not empty
        if self.content.trim().is_empty() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from("content"),
                reason: "section content cannot be empty".to_string(),
            });
        }

        // Fetch task and verify it exists
        let sections = self.fetch_task_sections(db, &id).await?;

        // Determine if this is a single-instance or multi-instance type
        let is_single_instance = is_single_instance_type(&self.section_type);

        let (replaced, ordinal, new_sections) = if is_single_instance {
            // Single-instance: filter out existing sections of this type, then add new one
            let had_existing = sections.iter().any(|s| s.section_type == self.section_type);
            let mut new_sections: Vec<Section> = sections
                .into_iter()
                .filter(|s| s.section_type != self.section_type)
                .collect();
            new_sections.push(Section {
                section_type: self.section_type.clone(),
                content: self.content.clone(),
                order: None,
                done: None,
                done_at: None,
            });
            (had_existing, None, new_sections)
        } else {
            // Multi-instance: calculate ordinal and append
            let ordinal = self.calculate_ordinal(&sections);
            let mut new_sections = sections;
            new_sections.push(Section {
                section_type: self.section_type.clone(),
                content: self.content.clone(),
                order: Some(ordinal),
                done: None,
                done_at: None,
            });
            (false, Some(ordinal), new_sections)
        };

        // Update sections and timestamp using repository
        let updates = TaskUpdate::new().with_sections(new_sections);
        db.tasks().update(&id, &updates).await?;

        Ok(SectionResult {
            id,
            section_type: self.section_type.clone(),
            replaced,
            ordinal,
        })
    }

    /// Fetch the task by ID and return its sections.
    async fn fetch_task_sections(&self, db: &Database, id: &str) -> Result<Vec<Section>, DbError> {
        let task = db.tasks().get(id).await?;

        task.map(|t| t.sections)
            .ok_or_else(|| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("Task '{}' not found", self.id),
            })
    }

    /// Calculate the ordinal for a multi-instance section type.
    ///
    /// Returns max ordinal + 1 for sections of this type, or 0 if none exist.
    fn calculate_ordinal(&self, sections: &[Section]) -> u32 {
        sections
            .iter()
            .filter(|s| s.section_type == self.section_type)
            .filter_map(|s| s.order)
            .max()
            .map(|max| max + 1)
            .unwrap_or(0)
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
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-section-test-{}-{:?}-{}",
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

    /// Helper to get sections from a task
    async fn get_sections(db: &Database, id: &str) -> Vec<Section> {
        let task = db.tasks().get(id).await.unwrap().unwrap();
        task.sections
    }

    /// Helper to get updated_at timestamp
    async fn get_updated_at(db: &Database, id: &str) -> chrono::DateTime<chrono::Utc> {
        let task = db.tasks().get(id).await.unwrap().unwrap();
        task.updated_at
            .expect("Task should have updated_at timestamp")
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

    #[tokio::test]
    async fn test_add_goal_section() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: "Implement authentication".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Section add failed: {:?}", result.err());

        let section_result = result.unwrap();
        assert_eq!(section_result.id, "task1");
        assert_eq!(section_result.section_type, SectionType::Goal);
        assert!(!section_result.replaced);
        assert!(section_result.ordinal.is_none());

        // Verify section was added
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].section_type, SectionType::Goal);
        assert_eq!(sections[0].content, "Implement authentication");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_step_section_with_ordinal() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Step,
            content: "Step 1".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let section_result = result.unwrap();
        assert_eq!(section_result.ordinal, Some(0));

        // Verify section was added with ordinal
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].order, Some(0));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_multiple_steps_incrementing_ordinal() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        // Add first step
        let cmd1 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Step,
            content: "Step 1".to_string(),
        };
        let result1 = cmd1.execute(&db).await.unwrap();
        assert_eq!(result1.ordinal, Some(0));

        // Add second step
        let cmd2 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Step,
            content: "Step 2".to_string(),
        };
        let result2 = cmd2.execute(&db).await.unwrap();
        assert_eq!(result2.ordinal, Some(1));

        // Add third step
        let cmd3 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Step,
            content: "Step 3".to_string(),
        };
        let result3 = cmd3.execute(&db).await.unwrap();
        assert_eq!(result3.ordinal, Some(2));

        // Verify all sections exist
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 3);

        // Verify specific step contents
        assert!(
            sections.iter().any(|s| s.content == "Step 1"),
            "Should contain Step 1"
        );
        assert!(
            sections.iter().any(|s| s.content == "Step 2"),
            "Should contain Step 2"
        );
        assert!(
            sections.iter().any(|s| s.content == "Step 3"),
            "Should contain Step 3"
        );

        // Verify ordinals are 0, 1, 2
        assert!(
            sections.iter().any(|s| s.order == Some(0)),
            "Should have ordinal 0"
        );
        assert!(
            sections.iter().any(|s| s.order == Some(1)),
            "Should have ordinal 1"
        );
        assert!(
            sections.iter().any(|s| s.order == Some(2)),
            "Should have ordinal 2"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_replace_single_instance_section() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        // Add first goal
        let cmd1 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: "Original goal".to_string(),
        };
        let result1 = cmd1.execute(&db).await.unwrap();
        assert!(!result1.replaced);

        // Add second goal (should replace first)
        let cmd2 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: "Updated goal".to_string(),
        };
        let result2 = cmd2.execute(&db).await.unwrap();
        assert!(result2.replaced);

        // Verify only one goal exists with new content
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].content, "Updated goal");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_all_section_types() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let section_types = vec![
            (SectionType::Goal, "The goal"),
            (SectionType::Context, "The context"),
            (SectionType::CurrentBehavior, "Current behavior"),
            (SectionType::DesiredBehavior, "Desired behavior"),
            (SectionType::Step, "A step"),
            (SectionType::TestingCriterion, "A test criterion"),
            (SectionType::AntiPattern, "An anti-pattern"),
            (SectionType::FailureTest, "A failure test"),
            (SectionType::Constraint, "A constraint"),
        ];

        for (section_type, content) in section_types {
            let cmd = SectionCommand {
                id: "task1".to_string(),
                section_type: section_type.clone(),
                content: content.to_string(),
            };
            let result = cmd.execute(&db).await;
            assert!(
                result.is_ok(),
                "Failed to add {:?}: {:?}",
                section_type,
                result.err()
            );
        }

        // Verify all 9 sections exist
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 9);

        // Verify all section types are present
        assert!(
            sections.iter().any(|s| s.section_type == SectionType::Goal),
            "Should contain goal section"
        );
        assert!(
            sections
                .iter()
                .any(|s| s.section_type == SectionType::Context),
            "Should contain context section"
        );
        assert!(
            sections
                .iter()
                .any(|s| s.section_type == SectionType::CurrentBehavior),
            "Should contain current_behavior section"
        );
        assert!(
            sections
                .iter()
                .any(|s| s.section_type == SectionType::DesiredBehavior),
            "Should contain desired_behavior section"
        );
        assert!(
            sections.iter().any(|s| s.section_type == SectionType::Step),
            "Should contain step section"
        );
        assert!(
            sections
                .iter()
                .any(|s| s.section_type == SectionType::TestingCriterion),
            "Should contain testing_criterion section"
        );
        assert!(
            sections
                .iter()
                .any(|s| s.section_type == SectionType::AntiPattern),
            "Should contain anti_pattern section"
        );
        assert!(
            sections
                .iter()
                .any(|s| s.section_type == SectionType::FailureTest),
            "Should contain failure_test section"
        );
        assert!(
            sections
                .iter()
                .any(|s| s.section_type == SectionType::Constraint),
            "Should contain constraint section"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_section_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = SectionCommand {
            id: "nonexistent".to_string(),
            section_type: SectionType::Goal,
            content: "The goal".to_string(),
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
    async fn test_section_empty_content_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: "".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("cannot be empty"),
                    "Expected 'cannot be empty' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_section_whitespace_content_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: "   ".to_string(),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("cannot be empty"),
                    "Expected 'cannot be empty' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_section_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        // Get initial timestamp
        let initial_ts = get_updated_at(&db, "task1").await;

        // Wait a tiny bit to ensure time passes
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let cmd = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: "The goal".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify updated_at was refreshed
        let new_ts = get_updated_at(&db, "task1").await;
        assert!(
            new_ts > initial_ts,
            "updated_at should be refreshed: {:?} > {:?}",
            new_ts,
            initial_ts
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_section_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = SectionCommand {
            id: "TASK1".to_string(),
            section_type: SectionType::Goal,
            content: "The goal".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        // Verify section was added
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 1);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_section_preserves_other_types_when_replacing() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        // Add multiple section types
        let cmd1 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: "Original goal".to_string(),
        };
        cmd1.execute(&db).await.unwrap();

        let cmd2 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Context,
            content: "The context".to_string(),
        };
        cmd2.execute(&db).await.unwrap();

        let cmd3 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Step,
            content: "A step".to_string(),
        };
        cmd3.execute(&db).await.unwrap();

        // Now replace goal
        let cmd4 = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: "New goal".to_string(),
        };
        cmd4.execute(&db).await.unwrap();

        // Verify we still have 3 sections with correct content
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 3);

        let goal = sections
            .iter()
            .find(|s| s.section_type == SectionType::Goal);
        assert!(goal.is_some());
        assert_eq!(goal.unwrap().content, "New goal");

        let context = sections
            .iter()
            .find(|s| s.section_type == SectionType::Context);
        assert!(context.is_some());

        let step = sections
            .iter()
            .find(|s| s.section_type == SectionType::Step);
        assert!(step.is_some());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_section_content_with_special_characters() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = SectionCommand {
            id: "task1".to_string(),
            section_type: SectionType::Goal,
            content: r#"Content with "quotes" and \backslashes\"#.to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Special chars failed: {:?}", result.err());

        cleanup(&temp_dir);
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
