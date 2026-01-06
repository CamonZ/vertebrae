//! Unsection command for removing sections from tasks
//!
//! Implements the `vtb unsection` command to remove sections from tasks.
//! Supports removing single-instance types, specific multi-instance sections by index,
//! all sections of a type, or all sections from a task.

use crate::db::{Database, DbError, SectionType};
use clap::Args;
use serde::Deserialize;

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
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The section to remove does not exist
    /// - For multi-instance types without --index or --all
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<UnsectionResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate command arguments
        self.validate_arguments()?;

        // Fetch task and verify it exists
        let task = self.fetch_task_sections(db, &id).await?;

        // Determine what to remove and perform the removal
        let removed_count = match (&self.section_type, self.index, self.all) {
            // --all without type: remove all sections
            (None, None, true) => self.remove_all_sections(db, &id, &task.sections).await?,

            // type + --all: remove all sections of that type
            (Some(section_type), None, true) => {
                self.remove_all_of_type(db, &id, section_type, &task.sections)
                    .await?
            }

            // type + --index: remove specific section at ordinal
            (Some(section_type), Some(index), false) => {
                self.remove_at_index(db, &id, section_type, index, &task.sections)
                    .await?
            }

            // type only (no --index, no --all): for single-instance, remove it; for multi-instance, error
            (Some(section_type), None, false) => {
                if is_single_instance_type(section_type) {
                    self.remove_single_instance(db, &id, section_type, &task.sections)
                        .await?
                } else {
                    return Err(DbError::InvalidPath {
                        path: std::path::PathBuf::from(&self.id),
                        reason: format!(
                            "Section type '{}' can have multiple instances. Use --index <n> to remove a specific one or --all to remove all",
                            section_type
                        ),
                    });
                }
            }

            // No type, no --all, with or without index: invalid
            (None, _, false) => {
                return Err(DbError::InvalidPath {
                    path: std::path::PathBuf::from(&self.id),
                    reason: "Must specify a section type or use --all to remove all sections"
                        .to_string(),
                });
            }

            // type + --index + --all would be caught by clap conflicts_with
            _ => unreachable!(),
        };

        // Update timestamp if any sections were removed
        if removed_count > 0 {
            self.update_timestamp(db, &id).await?;
        }

        Ok(UnsectionResult {
            id,
            removed_count,
            section_type: self.section_type.clone(),
            removed_all: self.all,
        })
    }

    /// Validate command arguments
    fn validate_arguments(&self) -> Result<(), DbError> {
        // --index without type is invalid
        if self.index.is_some() && self.section_type.is_none() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: "--index requires a section type".to_string(),
            });
        }
        Ok(())
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

    /// Remove all sections from the task
    async fn remove_all_sections(
        &self,
        db: &Database,
        id: &str,
        existing_sections: &[SectionRow],
    ) -> Result<usize, DbError> {
        let count = existing_sections.len();

        let query = format!("UPDATE task:{} SET sections = []", id);
        db.client().query(&query).await?;

        Ok(count)
    }

    /// Remove all sections of a specific type
    async fn remove_all_of_type(
        &self,
        db: &Database,
        id: &str,
        section_type: &SectionType,
        existing_sections: &[SectionRow],
    ) -> Result<usize, DbError> {
        let type_str = section_type.as_str();

        // Count how many we'll remove
        let count = existing_sections
            .iter()
            .filter(|s| s.section_type.as_deref() == Some(type_str))
            .count();

        if count == 0 {
            return Ok(0);
        }

        // Keep sections that are NOT of this type
        let new_sections = self.filter_sections_excluding_type(existing_sections, type_str);
        self.update_sections(db, id, &new_sections).await?;

        Ok(count)
    }

    /// Remove a specific section at the given ordinal
    async fn remove_at_index(
        &self,
        db: &Database,
        id: &str,
        section_type: &SectionType,
        index: u32,
        existing_sections: &[SectionRow],
    ) -> Result<usize, DbError> {
        let type_str = section_type.as_str();

        // Find sections of this type and check if index exists
        let matching_sections: Vec<&SectionRow> = existing_sections
            .iter()
            .filter(|s| s.section_type.as_deref() == Some(type_str))
            .collect();

        // Check if the index exists
        let exists = matching_sections.iter().any(|s| s.order == Some(index));

        if !exists {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("No {} section found at index {}", section_type, index),
            });
        }

        // Build new sections array:
        // 1. Keep all sections that are NOT of this type
        // 2. Keep sections of this type that don't have the target index
        // 3. Renumber the remaining sections of this type
        let mut new_sections: Vec<String> = Vec::new();

        // First, add all non-matching type sections
        for s in existing_sections {
            if s.section_type.as_deref() != Some(type_str)
                && let Some(section_str) = self.section_to_string(s)
            {
                new_sections.push(section_str);
            }
        }

        // Now add matching sections (excluding the one at index) with renumbered ordinals
        let mut new_ordinal = 0u32;
        let mut sections_of_type: Vec<&SectionRow> = matching_sections
            .iter()
            .filter(|s| s.order != Some(index))
            .copied()
            .collect();

        // Sort by original order
        sections_of_type.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

        for s in sections_of_type {
            if let (Some(content), Some(_type_str)) = (&s.content, &s.section_type) {
                let escaped_content = content.replace('\\', "\\\\").replace('"', "\\\"");
                new_sections.push(format!(
                    r#"{{ "type": "{}", "content": "{}", "order": {} }}"#,
                    type_str, escaped_content, new_ordinal
                ));
                new_ordinal += 1;
            }
        }

        self.update_sections(db, id, &new_sections).await?;

        Ok(1)
    }

    /// Remove a single-instance section
    async fn remove_single_instance(
        &self,
        db: &Database,
        id: &str,
        section_type: &SectionType,
        existing_sections: &[SectionRow],
    ) -> Result<usize, DbError> {
        let type_str = section_type.as_str();

        // Check if the section exists
        let exists = existing_sections
            .iter()
            .any(|s| s.section_type.as_deref() == Some(type_str));

        if !exists {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("No {} section found", section_type),
            });
        }

        // Keep sections that are NOT of this type
        let new_sections = self.filter_sections_excluding_type(existing_sections, type_str);
        self.update_sections(db, id, &new_sections).await?;

        Ok(1)
    }

    /// Filter sections to exclude a specific type
    fn filter_sections_excluding_type(
        &self,
        sections: &[SectionRow],
        exclude_type: &str,
    ) -> Vec<String> {
        sections
            .iter()
            .filter(|s| s.section_type.as_deref() != Some(exclude_type))
            .filter_map(|s| self.section_to_string(s))
            .collect()
    }

    /// Convert a SectionRow to its string representation for the query
    fn section_to_string(&self, section: &SectionRow) -> Option<String> {
        let section_type = section.section_type.as_ref()?;
        let content = section.content.as_ref()?;
        let escaped_content = content.replace('\\', "\\\\").replace('"', "\\\"");

        if let Some(order) = section.order {
            Some(format!(
                r#"{{ "type": "{}", "content": "{}", "order": {} }}"#,
                section_type, escaped_content, order
            ))
        } else {
            Some(format!(
                r#"{{ "type": "{}", "content": "{}" }}"#,
                section_type, escaped_content
            ))
        }
    }

    /// Update the task's sections array
    async fn update_sections(
        &self,
        db: &Database,
        id: &str,
        sections: &[String],
    ) -> Result<(), DbError> {
        let sections_array = format!("[{}]", sections.join(", "));
        let query = format!("UPDATE task:{} SET sections = {}", id, sections_array);
        db.client().query(&query).await?;
        Ok(())
    }

    /// Update the task's updated_at timestamp.
    async fn update_timestamp(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
        db.client().query(&query).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-unsection-test-{}-{:?}-{}",
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

    /// Helper to get sections from a task
    async fn get_sections(db: &Database, id: &str) -> Vec<SectionRow> {
        let query = format!("SELECT sections FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();

        #[derive(Deserialize)]
        struct Row {
            #[serde(default)]
            sections: Vec<SectionRow>,
        }

        let row: Option<Row> = result.take(0).unwrap();
        row.map(|r| r.sections).unwrap_or_default()
    }

    /// Helper to get updated_at timestamp
    async fn get_updated_at(db: &Database, id: &str) -> surrealdb::sql::Datetime {
        #[derive(Deserialize)]
        struct TimestampRow {
            updated_at: surrealdb::sql::Datetime,
        }

        let query = format!("SELECT updated_at FROM task:{}", id);
        let mut result = db.client().query(&query).await.unwrap();
        let row: Option<TimestampRow> = result.take(0).unwrap();
        row.unwrap().updated_at
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
    async fn test_remove_goal_section() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Unsection failed: {:?}", result.err());

        let unsection_result = result.unwrap();
        assert_eq!(unsection_result.removed_count, 1);
        assert_eq!(unsection_result.section_type, Some(SectionType::Goal));

        // Verify section was removed
        let sections = get_sections(&db, "task1").await;
        assert!(sections.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_step_at_index() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "step", "Step 0", Some(0)).await;
        add_section(&db, "task1", "step", "Step 1", Some(1)).await;
        add_section(&db, "task1", "step", "Step 2", Some(2)).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Step),
            index: Some(1),
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Unsection failed: {:?}", result.err());

        // Verify remaining steps are renumbered
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 2);

        // Find steps and verify renumbering
        let steps: Vec<&SectionRow> = sections
            .iter()
            .filter(|s| s.section_type.as_deref() == Some("step"))
            .collect();

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].content.as_deref(), Some("Step 0"));
        assert_eq!(steps[0].order, Some(0));
        assert_eq!(steps[1].content.as_deref(), Some("Step 2"));
        assert_eq!(steps[1].order, Some(1)); // Renumbered from 2 to 1

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_all_of_type() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "step", "Step 0", Some(0)).await;
        add_section(&db, "task1", "step", "Step 1", Some(1)).await;
        add_section(&db, "task1", "goal", "The goal", None).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Step),
            index: None,
            all: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let unsection_result = result.unwrap();
        assert_eq!(unsection_result.removed_count, 2);

        // Verify only goal remains
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].section_type.as_deref(), Some("goal"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_all_sections() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;
        add_section(&db, "task1", "step", "Step 0", Some(0)).await;
        add_section(&db, "task1", "anti_pattern", "Don't do this", Some(0)).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: None,
            index: None,
            all: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let unsection_result = result.unwrap();
        assert_eq!(unsection_result.removed_count, 3);

        // Verify all sections are removed
        let sections = get_sections(&db, "task1").await;
        assert!(sections.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_section_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("No goal section found"),
                    "Expected 'No goal section found' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_at_nonexistent_index_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "step", "Step 0", Some(0)).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Step),
            index: Some(99),
            all: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("index 99"),
                    "Expected 'index 99' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = UnsectionCommand {
            id: "nonexistent".to_string(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
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
    async fn test_multi_instance_without_index_or_all_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "step", "Step 0", Some(0)).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Step),
            index: None,
            all: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("multiple instances"),
                    "Expected 'multiple instances' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("--index"),
                    "Expected '--index' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_updates_timestamp() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;

        let initial_ts = get_updated_at(&db, "task1").await;

        // Wait a tiny bit to ensure time passes
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify timestamp was updated
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
    async fn test_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;

        let cmd = UnsectionCommand {
            id: "TASK1".to_string(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_preserves_other_sections_when_removing() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;
        add_section(&db, "task1", "context", "The context", None).await;
        add_section(&db, "task1", "step", "Step 0", Some(0)).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify other sections remain
        let sections = get_sections(&db, "task1").await;
        assert_eq!(sections.len(), 2);

        let context = sections
            .iter()
            .find(|s| s.section_type.as_deref() == Some("context"));
        assert!(context.is_some());

        let step = sections
            .iter()
            .find(|s| s.section_type.as_deref() == Some("step"));
        assert!(step.is_some());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_all_of_type_returns_zero_when_none_exist() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;
        add_section(&db, "task1", "goal", "The goal", None).await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: Some(SectionType::Step),
            index: None,
            all: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let unsection_result = result.unwrap();
        assert_eq!(unsection_result.removed_count, 0);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_no_type_without_all_flag_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: None,
            index: None,
            all: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("Must specify a section type or use --all"),
                    "Expected 'Must specify a section type or use --all' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_index_without_type_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task").await;

        let cmd = UnsectionCommand {
            id: "task1".to_string(),
            section_type: None,
            index: Some(0),
            all: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("--index requires a section type"),
                    "Expected '--index requires a section type' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[test]
    fn test_unsection_result_display_single_removed() {
        let result = UnsectionResult {
            id: "task1".to_string(),
            removed_count: 1,
            section_type: Some(SectionType::Goal),
            removed_all: false,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Removed goal section from task: task1");
    }

    #[test]
    fn test_unsection_result_display_multiple_removed() {
        let result = UnsectionResult {
            id: "task1".to_string(),
            removed_count: 3,
            section_type: Some(SectionType::Step),
            removed_all: true,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Removed 3 step sections from task: task1");
    }

    #[test]
    fn test_unsection_result_display_all_removed() {
        let result = UnsectionResult {
            id: "task1".to_string(),
            removed_count: 5,
            section_type: None,
            removed_all: true,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Removed all 5 sections from task: task1");
    }

    #[test]
    fn test_unsection_result_display_none_found() {
        let result = UnsectionResult {
            id: "task1".to_string(),
            removed_count: 0,
            section_type: Some(SectionType::Goal),
            removed_all: false,
        };

        let output = format!("{}", result);
        assert_eq!(output, "No goal sections found to remove");
    }

    #[test]
    fn test_unsection_result_display_none_found_all() {
        let result = UnsectionResult {
            id: "task1".to_string(),
            removed_count: 0,
            section_type: None,
            removed_all: true,
        };

        let output = format!("{}", result);
        assert_eq!(output, "No sections found to remove");
    }

    #[test]
    fn test_unsection_command_debug() {
        let cmd = UnsectionCommand {
            id: "test".to_string(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("UnsectionCommand"));
    }

    #[test]
    fn test_unsection_result_debug() {
        let result = UnsectionResult {
            id: "task1".to_string(),
            removed_count: 1,
            section_type: Some(SectionType::Goal),
            removed_all: false,
        };
        let debug_str = format!("{:?}", result);
        assert!(debug_str.contains("UnsectionResult"));
    }
}
