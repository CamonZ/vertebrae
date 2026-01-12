//! Unsection command for removing sections from tasks
//!
//! Implements the `vtb unsection` command to remove sections from tasks.
//! Supports removing single-instance types, specific multi-instance sections by index,
//! all sections of a type, or all sections from a task.

use clap::Args;
use serde::Deserialize;
use vertebrae_core::{ServiceError, TaskService};
use vertebrae_db::SectionType;

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
        service: &dyn TaskService,
    ) -> Result<UnsectionResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate command arguments
        self.validate_arguments()?;

        // We need to fetch task sections to determine what to remove
        // Get the service's database connection to verify task exists
        let db_result = service
            .get_task(&id)
            .await
            .map_err(|_| ServiceError::task_not_found(&self.id))?;

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
            id: surrealdb::sql::Thing::from(("task", id.as_str())),
            sections: existing_sections,
        };

        // Determine what to remove and perform the removal
        let removed_count = match (&self.section_type, self.index, self.all) {
            // --all without type: remove all sections
            (None, None, true) => {
                self.remove_all_sections(service, &id, &task.sections)
                    .await?
            }

            // type + --all: remove all sections of that type
            (Some(section_type), None, true) => {
                self.remove_all_of_type(service, &id, section_type, &task.sections)
                    .await?
            }

            // type + --index: remove specific section at ordinal
            (Some(section_type), Some(index), false) => {
                self.remove_at_index(service, &id, section_type, index, &task.sections)
                    .await?
            }

            // type only (no --index, no --all): for single-instance, remove it; for multi-instance, error
            (Some(section_type), None, false) => {
                if is_single_instance_type(section_type) {
                    self.remove_single_instance(service, &id, section_type, &task.sections)
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
        service: &dyn TaskService,
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
            service.remove_sections(id, section_type, None).await?;
        }

        Ok(count)
    }

    /// Remove all sections of a specific type
    async fn remove_all_of_type(
        &self,
        service: &dyn TaskService,
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
        service
            .remove_sections(id, section_type.clone(), None)
            .await?;

        Ok(count)
    }

    /// Remove a specific section at the given ordinal
    async fn remove_at_index(
        &self,
        service: &dyn TaskService,
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
        service
            .remove_section_by_ordinal(id, section_type.clone(), index)
            .await?;

        Ok(1)
    }

    /// Remove a single-instance section
    async fn remove_single_instance(
        &self,
        service: &dyn TaskService,
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
        service
            .remove_sections(id, section_type.clone(), None)
            .await?;

        Ok(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::{CreateTaskOptions, DefaultTaskService};
    use vertebrae_db::{Database, Section};

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> DefaultTaskService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultTaskService::new(db)
    }

    /// Helper to create a task with the service
    async fn create_task(service: &DefaultTaskService, title: &str) -> String {
        let options = CreateTaskOptions::new(title);
        service.create_task(options).await.unwrap()
    }

    /// Helper to add a section to a task
    async fn add_section(
        service: &DefaultTaskService,
        id: &str,
        section_type: SectionType,
        content: &str,
        order: Option<u32>,
    ) {
        let section = if let Some(ord) = order {
            Section::with_order(section_type, content.to_string(), ord)
        } else {
            Section::new(section_type, content.to_string())
        };
        service.add_section(id, section).await.unwrap();
    }

    /// Helper to get sections from a task
    async fn get_sections(service: &DefaultTaskService, id: &str) -> Vec<Section> {
        let task = service.get_task(id).await.unwrap();
        task.sections
    }

    /// Helper to get updated_at timestamp
    async fn get_updated_at(
        service: &DefaultTaskService,
        id: &str,
    ) -> chrono::DateTime<chrono::Utc> {
        let task = service.get_task(id).await.unwrap();
        task.updated_at.unwrap()
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
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Goal, "The goal", None).await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Unsection failed: {:?}", result.err());

        let unsection_result = result.unwrap();
        assert_eq!(unsection_result.removed_count, 1);
        assert_eq!(unsection_result.section_type, Some(SectionType::Goal));

        // Verify section was removed
        let sections = get_sections(&service, &task_id).await;
        assert!(sections.is_empty());
    }

    #[tokio::test]
    async fn test_remove_step_at_index() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Step, "Step 0", Some(1)).await;
        add_section(&service, &task_id, SectionType::Step, "Step 1", Some(2)).await;
        add_section(&service, &task_id, SectionType::Step, "Step 2", Some(3)).await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(2),
            all: false,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Unsection failed: {:?}", result.err());

        // Verify remaining steps are renumbered
        let sections = get_sections(&service, &task_id).await;
        assert_eq!(sections.len(), 2);

        // Find steps and verify renumbering
        let steps: Vec<&Section> = sections
            .iter()
            .filter(|s| s.section_type == SectionType::Step)
            .collect();

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].content, "Step 0");
        assert_eq!(steps[0].order, Some(1));
        assert_eq!(steps[1].content, "Step 2");
        assert_eq!(steps[1].order, Some(2)); // Renumbered from 3 to 2
    }

    #[tokio::test]
    async fn test_remove_all_of_type() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Step, "Step 0", Some(1)).await;
        add_section(&service, &task_id, SectionType::Step, "Step 1", Some(2)).await;
        add_section(&service, &task_id, SectionType::Goal, "The goal", None).await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Step),
            index: None,
            all: true,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let unsection_result = result.unwrap();
        assert_eq!(unsection_result.removed_count, 2);

        // Verify only goal remains
        let sections = get_sections(&service, &task_id).await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].section_type, SectionType::Goal);
    }

    #[tokio::test]
    async fn test_remove_all_sections() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Goal, "The goal", None).await;
        add_section(&service, &task_id, SectionType::Step, "Step 0", Some(1)).await;
        add_section(
            &service,
            &task_id,
            SectionType::AntiPattern,
            "Don't do this",
            Some(0),
        )
        .await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: None,
            index: None,
            all: true,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let unsection_result = result.unwrap();
        assert_eq!(unsection_result.removed_count, 3);

        // Verify all sections are removed
        let sections = get_sections(&service, &task_id).await;
        assert!(sections.is_empty());
    }

    #[tokio::test]
    async fn test_remove_nonexistent_section_fails() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("No goal section found"),
                    "Expected 'No goal section found' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected ValidationFailed error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_remove_at_nonexistent_index_fails() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Step, "Step 0", Some(1)).await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Step),
            index: Some(99),
            all: false,
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("index 99"),
                    "Expected 'index 99' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected ValidationFailed error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_remove_nonexistent_task_fails() {
        let service = setup_test_service().await;

        let cmd = UnsectionCommand {
            id: "nonexistent".to_string(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
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
    async fn test_multi_instance_without_index_or_all_fails() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Step, "Step 0", Some(1)).await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Step),
            index: None,
            all: false,
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("multiple instances"),
                    "Expected 'multiple instances' in error, got: {}",
                    message
                );
                assert!(
                    message.contains("--index"),
                    "Expected '--index' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected ValidationFailed error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_updates_timestamp() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Goal, "The goal", None).await;

        let initial_ts = get_updated_at(&service, &task_id).await;

        // Wait a tiny bit to ensure time passes
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        // Verify timestamp was updated
        let new_ts = get_updated_at(&service, &task_id).await;
        assert!(
            new_ts > initial_ts,
            "updated_at should be refreshed: {:?} > {:?}",
            new_ts,
            initial_ts
        );
    }

    #[tokio::test]
    async fn test_case_insensitive_id() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Goal, "The goal", None).await;

        let cmd = UnsectionCommand {
            id: task_id.to_uppercase(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");
    }

    #[tokio::test]
    async fn test_preserves_other_sections_when_removing() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Goal, "The goal", None).await;
        add_section(
            &service,
            &task_id,
            SectionType::Context,
            "The context",
            None,
        )
        .await;
        add_section(&service, &task_id, SectionType::Step, "Step 0", Some(1)).await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Goal),
            index: None,
            all: false,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        // Verify other sections remain
        let sections = get_sections(&service, &task_id).await;
        assert_eq!(sections.len(), 2);

        let context = sections
            .iter()
            .find(|s| s.section_type == SectionType::Context);
        assert!(context.is_some());

        let step = sections
            .iter()
            .find(|s| s.section_type == SectionType::Step);
        assert!(step.is_some());
    }

    #[tokio::test]
    async fn test_remove_all_of_type_returns_zero_when_none_exist() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;
        add_section(&service, &task_id, SectionType::Goal, "The goal", None).await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: Some(SectionType::Step),
            index: None,
            all: true,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let unsection_result = result.unwrap();
        assert_eq!(unsection_result.removed_count, 0);
    }

    #[tokio::test]
    async fn test_no_type_without_all_flag_fails() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: None,
            index: None,
            all: false,
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("Must specify a section type or use --all"),
                    "Expected 'Must specify a section type or use --all' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected ValidationFailed error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_index_without_type_fails() {
        let service = setup_test_service().await;

        let task_id = create_task(&service, "Test Task").await;

        let cmd = UnsectionCommand {
            id: task_id.clone(),
            section_type: None,
            index: Some(0),
            all: false,
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("--index requires a section type"),
                    "Expected '--index requires a section type' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected ValidationFailed error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
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
            id: "test123".to_string(),
            section_type: Some(SectionType::Goal),
            index: Some(2),
            all: true,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("UnsectionCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("Goal")
                && debug_str.contains("index: Some(2)")
                && debug_str.contains("all: true"),
            "Debug output should contain UnsectionCommand and all field values"
        );
    }

    #[test]
    fn test_unsection_result_debug() {
        let result = UnsectionResult {
            id: "task1".to_string(),
            removed_count: 3,
            section_type: Some(SectionType::Goal),
            removed_all: true,
        };
        let debug_str = format!("{:?}", result);
        assert!(
            debug_str.contains("UnsectionResult")
                && debug_str.contains("id: \"task1\"")
                && debug_str.contains("removed_count: 3")
                && debug_str.contains("Goal")
                && debug_str.contains("removed_all: true"),
            "Debug output should contain UnsectionResult and all field values"
        );
    }
}
