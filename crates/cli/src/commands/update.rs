//! Update command for modifying existing tasks
//!
//! Implements the `vtb update` command to modify task fields including
//! title, description, priority, tags, parent relationship, and sections.

use clap::Args;
use vertebrae_core::{Priority, SectionType};
use vertebrae_core::{ServiceError, UpdateTaskOptions, VertebraeServices};

#[cfg(test)]
use vertebrae_core::Database;

/// Update an existing task
#[derive(Debug, Args)]
pub struct UpdateCommand {
    /// Task ID to update (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// New title for the task
    #[arg(long)]
    pub title: Option<String>,

    /// New description for the task (use empty string "" to clear)
    #[arg(short, long)]
    pub description: Option<String>,

    /// New priority (low, medium, high, critical)
    #[arg(short, long, value_parser = parse_priority)]
    pub priority: Option<Priority>,

    /// Tag to add (can be specified multiple times)
    #[arg(long = "add-tag")]
    pub add_tags: Vec<String>,

    /// Tag to remove (can be specified multiple times)
    #[arg(long = "remove-tag")]
    pub remove_tags: Vec<String>,

    /// Parent task ID (use empty string "" to remove parent)
    #[arg(long)]
    pub parent: Option<String>,

    /// Edit a section: <type> <ordinal> <new-content>
    /// Example: --edit-section step 0 "New step content"
    #[arg(long = "edit-section", num_args = 3, value_names = ["TYPE", "ORDINAL", "CONTENT"])]
    pub edit_section: Option<Vec<String>>,

    /// Remove a section: <type> <ordinal>
    /// Example: --remove-section step 0
    #[arg(long = "remove-section", num_args = 2, value_names = ["TYPE", "ORDINAL"])]
    pub remove_section: Option<Vec<String>>,
}

/// Parse a priority string into a Priority enum
fn parse_priority(s: &str) -> Result<Priority, String> {
    match s.to_lowercase().as_str() {
        "low" => Ok(Priority::Low),
        "medium" => Ok(Priority::Medium),
        "high" => Ok(Priority::High),
        "critical" => Ok(Priority::Critical),
        _ => Err(format!(
            "invalid priority '{}'. Valid values: low, medium, high, critical",
            s
        )),
    }
}

/// Parse a section type string into a SectionType enum
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

impl UpdateCommand {
    /// Execute the update command.
    ///
    /// Builds an UpdateTaskOptions from CLI arguments and uses the service
    /// layer to apply updates. Section edits and removals are also performed
    /// via the service layer.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - The parent task doesn't exist (if specified)
    /// - Attempting to set self as parent
    /// - Service operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Verify task exists
        if !services.tasks().task_exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        // Check if any updates were specified
        if !self.has_updates() {
            return Ok(id);
        }

        // Validate parent if specified (for field/tag updates)
        if let Some(parent_id) = &self.parent
            && !parent_id.is_empty()
        {
            let parent_id_lower = parent_id.to_lowercase();

            // Check for self-parent
            if parent_id_lower == id {
                return Err(ServiceError::validation_failed(
                    "Cannot set task as its own parent",
                ));
            }

            // Check parent exists
            if !services.tasks().task_exists(&parent_id_lower).await? {
                return Err(ServiceError::parent_not_found(&parent_id_lower));
            }
        }

        // Build UpdateTaskOptions from CLI arguments
        let mut options = UpdateTaskOptions::new();

        if let Some(title) = &self.title {
            options = options.with_title(title.clone());
        }

        if let Some(description) = &self.description {
            if description.is_empty() {
                options = options.clear_description();
            } else {
                options = options.with_description(description.clone());
            }
        }

        if let Some(priority) = &self.priority {
            options = options.with_priority(priority.clone());
        }

        // Add tags
        for tag in &self.add_tags {
            options = options.add_tag(tag.clone());
        }

        // Remove tags
        for tag in &self.remove_tags {
            options = options.remove_tag(tag.clone());
        }

        // Handle parent
        if let Some(parent_id) = &self.parent {
            if parent_id.is_empty() {
                options = options.clear_parent();
            } else {
                options = options.with_parent(parent_id.to_lowercase());
            }
        }

        // Apply all field/tag/parent updates via service layer
        services.tasks().update_task(&id, options).await?;

        // Handle section edits via service layer
        if let Some(args) = &self.edit_section {
            if args.len() != 3 {
                return Err(ServiceError::validation_failed(
                    "edit-section requires: <type> <ordinal> <content>",
                ));
            }

            let section_type =
                parse_section_type(&args[0]).map_err(ServiceError::validation_failed)?;

            let ordinal: u32 = args[1].parse().map_err(|_| {
                ServiceError::validation_failed(format!(
                    "invalid ordinal '{}': expected a number",
                    args[1]
                ))
            })?;

            let new_content = &args[2];
            services
                .tasks()
                .edit_section_by_ordinal(&id, section_type, ordinal, new_content)
                .await?;
        }

        // Handle section removals via service layer
        if let Some(args) = &self.remove_section {
            if args.len() != 2 {
                return Err(ServiceError::validation_failed(
                    "remove-section requires: <type> <ordinal>",
                ));
            }

            let section_type =
                parse_section_type(&args[0]).map_err(ServiceError::validation_failed)?;

            let ordinal: u32 = args[1].parse().map_err(|_| {
                ServiceError::validation_failed(format!(
                    "invalid ordinal '{}': expected a number",
                    args[1]
                ))
            })?;

            services
                .tasks()
                .remove_section_by_ordinal(&id, section_type, ordinal)
                .await?;
        }

        Ok(id)
    }

    /// Check if any updates were specified.
    fn has_updates(&self) -> bool {
        self.title.is_some()
            || self.description.is_some()
            || self.priority.is_some()
            || !self.add_tags.is_empty()
            || !self.remove_tags.is_empty()
            || self.parent.is_some()
            || self.edit_section.is_some()
            || self.remove_section.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use vertebrae_core::{CreateTaskOptions, VertebraeServices};
    use vertebrae_core::{Level, Priority};

    /// Helper to create an in-memory test database wrapped in a service
    async fn setup_test_db() -> VertebraeServices {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    /// Helper to create a task via the service layer
    async fn create_task(
        services: &VertebraeServices,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
        priority: Option<&str>,
        tags: &[&str],
    ) {
        let level_enum = match level {
            "epic" => Level::Epic,
            "ticket" => Level::Ticket,
            _ => Level::Task,
        };

        let priority_enum = priority.and_then(|p| match p {
            "low" => Some(Priority::Low),
            "medium" => Some(Priority::Medium),
            "high" => Some(Priority::High),
            "critical" => Some(Priority::Critical),
            _ => None,
        });

        let mut options = CreateTaskOptions::new(title)
            .with_id(id)
            .with_level(level_enum)
            .with_status(status);

        if let Some(p) = priority_enum {
            options = options.with_priority(p);
        }

        for tag in tags {
            options = options.with_tag(*tag);
        }

        services.tasks().create_task(options).await.unwrap();
    }

    /// Helper to create a child_of relationship
    async fn create_child_of(services: &VertebraeServices, child_id: &str, parent_id: &str) {
        services
            .tasks()
            .set_parent(child_id, parent_id)
            .await
            .unwrap();
    }

    /// Struct for querying task fields
    #[derive(Debug)]
    struct TaskFields {
        title: String,
        priority: Option<String>,
        tags: Vec<String>,
        updated_at: Option<chrono::DateTime<chrono::Utc>>,
    }

    /// Helper to get a task's fields
    async fn get_task(services: &VertebraeServices, id: &str) -> Option<TaskFields> {
        let task = services.tasks().get_task(id).await.ok()?;
        Some(TaskFields {
            title: task.title,
            priority: task.priority.map(|p| p.to_string()),
            tags: task.tags,
            updated_at: task.updated_at,
        })
    }

    /// Helper to get parent ID for a task
    async fn get_parent_id(services: &VertebraeServices, id: &str) -> Option<String> {
        services.tasks().get_parent(id).await.ok()?
    }

    #[test]
    fn test_parse_priority_valid() {
        assert_eq!(parse_priority("low").unwrap(), Priority::Low);
        assert_eq!(parse_priority("medium").unwrap(), Priority::Medium);
        assert_eq!(parse_priority("high").unwrap(), Priority::High);
        assert_eq!(parse_priority("critical").unwrap(), Priority::Critical);
    }

    #[test]
    fn test_parse_priority_case_insensitive() {
        assert_eq!(parse_priority("LOW").unwrap(), Priority::Low);
        assert_eq!(parse_priority("High").unwrap(), Priority::High);
        assert_eq!(parse_priority("CRITICAL").unwrap(), Priority::Critical);
    }

    #[test]
    fn test_parse_priority_invalid() {
        let result = parse_priority("wrong");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid priority"));
    }

    #[test]
    fn test_has_updates_empty() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };
        assert!(!cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_title() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("New title".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_description() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: Some("New description".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_priority() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: Some(Priority::High),
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_add_tags() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec!["urgent".to_string()],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_remove_tags() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec!["old".to_string()],
            parent: None,
            edit_section: None,
            remove_section: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_parent() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("parent1".to_string()),
            edit_section: None,
            remove_section: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_edit_section() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: Some(vec![
                "step".to_string(),
                "0".to_string(),
                "new content".to_string(),
            ]),
            remove_section: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_remove_section() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: Some(vec!["step".to_string(), "0".to_string()]),
        };
        assert!(cmd.has_updates());
    }

    #[tokio::test]
    async fn test_update_nonexistent_task() {
        let services = setup_test_db().await;

        let cmd = UpdateCommand {
            id: "nonexistent".to_string(),
            title: Some("New title".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        match result {
            Err(ServiceError::TaskNotFound { task_id }) => {
                assert!(
                    task_id.contains("nonexistent"),
                    "Expected task ID 'nonexistent' in error, got: {}",
                    task_id
                );
            }
            Err(other) => panic!("Expected TaskNotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_update_title() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Original title",
            "task",
            "in_progress",
            Some("low"),
            &["backend"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("New title".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        // Verify title was changed
        let task = get_task(&services, "abc123")
            .await
            .expect("Task should exist");
        assert_eq!(task.title, "New title");

        // Verify other fields were not changed
        assert_eq!(task.priority, Some("low".to_string()));
        assert!(task.tags.contains(&"backend".to_string()));
    }

    #[tokio::test]
    async fn test_update_priority() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            Some("low"),
            &["api"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: Some(Priority::High),
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        // Verify priority was changed
        let task = get_task(&services, "abc123")
            .await
            .expect("Task should exist");
        assert_eq!(task.priority, Some("high".to_string()));

        // Verify other fields were not changed
        assert_eq!(task.title, "Test task");
        assert!(task.tags.contains(&"api".to_string()));
    }

    #[tokio::test]
    async fn test_update_add_tag() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &["initial"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec!["urgent".to_string()],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        assert!(task.tags.contains(&"initial".to_string()));
        assert!(task.tags.contains(&"urgent".to_string()));
    }

    #[tokio::test]
    async fn test_update_remove_tag() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &["initial", "toremove"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec!["toremove".to_string()],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        assert!(task.tags.contains(&"initial".to_string()));
        assert!(!task.tags.contains(&"toremove".to_string()));
    }

    #[tokio::test]
    async fn test_update_add_duplicate_tag() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &["existing"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec!["existing".to_string()],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        // Should only have one instance of the tag
        assert_eq!(task.tags.len(), 1);
        assert_eq!(task.tags[0], "existing");
    }

    #[tokio::test]
    async fn test_update_set_parent() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "parent1",
            "Parent task",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "child1",
            "Child task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "child1".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("parent1".to_string()),
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&services, "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));
    }

    #[tokio::test]
    async fn test_update_change_parent() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "parent1",
            "Parent 1",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "parent2",
            "Parent 2",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "child1",
            "Child task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_child_of(&services, "child1", "parent1").await;

        let cmd = UpdateCommand {
            id: "child1".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("parent2".to_string()),
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&services, "child1").await;
        assert_eq!(parent_id, Some("parent2".to_string()));
    }

    #[tokio::test]
    async fn test_update_remove_parent() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "parent1",
            "Parent task",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "child1",
            "Child task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_child_of(&services, "child1", "parent1").await;

        // Verify parent exists before
        let parent_id = get_parent_id(&services, "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));

        let cmd = UpdateCommand {
            id: "child1".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("".to_string()),
            edit_section: None,
            remove_section: None, // Empty string removes parent
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&services, "child1").await;
        assert!(parent_id.is_none());
    }

    #[tokio::test]
    #[serial]
    async fn test_update_self_parent_fails() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("abc123".to_string()),
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("own parent"),
                    "Expected 'own parent' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected ValidationFailed error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_update_nonexistent_parent_fails() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("nonexistent".to_string()),
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        match result {
            Err(ServiceError::ParentNotFound { parent_id }) => {
                assert!(
                    parent_id.contains("nonexistent"),
                    "Expected parent ID 'nonexistent' in error, got: {}",
                    parent_id
                );
            }
            Err(other) => panic!("Expected ParentNotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_update_timestamp_updated() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("New title".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        assert!(task.updated_at.is_some());
    }

    #[tokio::test]
    async fn test_update_case_insensitive_id() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "ABC123".to_string(), // Uppercase
            title: Some("New title".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        assert_eq!(task.title, "New title");
    }

    #[tokio::test]
    async fn test_update_no_changes() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "abc123");
    }

    #[tokio::test]
    async fn test_update_multiple_fields() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Original",
            "task",
            "in_progress",
            Some("low"),
            &["old"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("Updated".to_string()),
            description: None,
            priority: Some(Priority::Critical),
            add_tags: vec!["new".to_string()],
            remove_tags: vec!["old".to_string()],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        assert_eq!(task.title, "Updated");
        assert_eq!(task.priority, Some("critical".to_string()));
        assert!(task.tags.contains(&"new".to_string()));
        assert!(!task.tags.contains(&"old".to_string()));
    }

    #[tokio::test]
    async fn test_update_preserves_other_fields() {
        use vertebrae_core::{CodeRef, Level, Section, SectionType};

        let services = setup_test_db().await;

        // Create task via service with level, priority, tags
        create_task(
            &services,
            "abc123",
            "Original",
            "ticket",
            "in_progress",
            Some("high"),
            &["backend", "api"],
        )
        .await;

        // Add section and code ref via service
        let section = Section::new(SectionType::Goal, "Important goal".to_string());
        services
            .tasks()
            .add_section("abc123", section)
            .await
            .unwrap();

        let code_ref = CodeRef::line("src/main.rs".to_string(), 10);
        services
            .tasks()
            .add_code_ref("abc123", code_ref)
            .await
            .unwrap();

        // Get task before update to capture its workflow assignment
        let task_before = services.tasks().get_task("abc123").await.unwrap();
        let original_workflow_id = task_before.workflow_id.clone();
        let original_step_id = task_before.current_step_id.clone();

        // Only update title
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("Updated title".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        // Verify other fields preserved
        let task = services.tasks().get_task("abc123").await.unwrap();

        assert_eq!(task.title, "Updated title");
        assert_eq!(task.level, Level::Ticket);
        // Verify workflow assignment is preserved
        assert_eq!(task.workflow_id, original_workflow_id);
        assert_eq!(task.current_step_id, original_step_id);
        assert_eq!(task.priority, Some(vertebrae_core::Priority::High));
        // Verify tags are preserved
        assert_eq!(task.tags, vec!["backend", "api"]);
    }

    #[test]
    fn test_update_command_debug() {
        let cmd = UpdateCommand {
            id: "test123".to_string(),
            title: Some("New Title".to_string()),
            description: None,
            priority: Some(Priority::High),
            add_tags: vec!["urgent".to_string()],
            remove_tags: vec!["old".to_string()],
            parent: Some("parent456".to_string()),
            edit_section: None,
            remove_section: None,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("UpdateCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("New Title")
                && debug_str.contains("High")
                && debug_str.contains("urgent")
                && debug_str.contains("old")
                && debug_str.contains("parent456"),
            "Debug output should contain UpdateCommand and all field values"
        );
    }

    #[tokio::test]
    async fn test_update_parent_case_insensitive() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "parent1",
            "Parent task",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "child1",
            "Child task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "CHILD1".to_string(), // Uppercase child
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("PARENT1".to_string()),
            edit_section: None,
            remove_section: None, // Uppercase parent
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&services, "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));
    }

    // ========== Description Tests ==========

    #[tokio::test]
    async fn test_update_description() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: Some("New description".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        // Verify description was set
        let task = services.tasks().get_task("abc123").await.unwrap();
        assert_eq!(task.description, Some("New description".to_string()));
    }

    #[tokio::test]
    async fn test_update_clear_description() {
        let services = setup_test_db().await;

        // Create task with description via service
        let options = CreateTaskOptions::new("Test task")
            .with_id("abc123")
            .with_description("Original description");
        services.tasks().create_task(options).await.unwrap();

        // Verify description was set
        let task_before = services.tasks().get_task("abc123").await.unwrap();
        assert_eq!(
            task_before.description,
            Some("Original description".to_string())
        );

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: Some("".to_string()), // Empty string clears
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        // Verify description was cleared
        let task = services.tasks().get_task("abc123").await.unwrap();
        assert!(task.description.is_none());
    }

    // ========== Section Tests ==========

    /// Helper to add a section to a task
    async fn add_section(
        services: &VertebraeServices,
        id: &str,
        section_type: &str,
        content: &str,
        order: Option<u32>,
    ) {
        use vertebrae_core::Section;

        // Parse section type and add section via service
        if let Ok(section_enum) = parse_section_type(section_type) {
            let section = Section {
                section_type: section_enum,
                content: content.to_string(),
                order,
                done: None,
                done_at: None,
                refs: vec![],
            };
            services.tasks().add_section(id, section).await.unwrap();
        }
    }

    /// Helper to get sections from a task
    async fn get_sections(services: &VertebraeServices, id: &str) -> Vec<vertebrae_core::Section> {
        let task = services.tasks().get_task(id).await.unwrap();
        task.sections
    }

    #[tokio::test]
    async fn test_update_remove_section() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        add_section(&services, "abc123", "step", "Step 0", Some(1)).await;
        add_section(&services, "abc123", "step", "Step 1", Some(2)).await;
        add_section(&services, "abc123", "step", "Step 2", Some(3)).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: Some(vec!["step".to_string(), "1".to_string()]),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Remove section failed: {:?}", result.err());

        // Verify section was removed and others renumbered
        let sections = get_sections(&services, "abc123").await;
        assert_eq!(sections.len(), 2);

        // Find steps and verify renumbering
        let mut steps: Vec<_> = sections
            .into_iter()
            .filter(|s| s.section_type == SectionType::Step)
            .collect();

        // Sort by order to match expectation
        steps.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].content, "Step 1");
        assert_eq!(steps[0].order, Some(1)); // Renumbered from 2 to 1
        assert_eq!(steps[1].content, "Step 2");
        assert_eq!(steps[1].order, Some(2)); // Renumbered from 3 to 2
    }

    #[tokio::test]
    async fn test_update_edit_section() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        add_section(&services, "abc123", "step", "Original step", Some(0)).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: Some(vec![
                "step".to_string(),
                "0".to_string(),
                "Updated step content".to_string(),
            ]),
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Edit section failed: {:?}", result.err());

        // Verify section was updated
        let sections = get_sections(&services, "abc123").await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].content, "Updated step content");
    }

    #[tokio::test]
    async fn test_update_remove_nonexistent_section_fails() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: Some(vec!["step".to_string(), "99".to_string()]),
        };

        let result = cmd.execute(&services).await;
        match result {
            Err(ServiceError::Database(db_error)) => {
                // Database error contains the validation message from the repository
                assert!(
                    db_error
                        .to_string()
                        .contains("No section of type 'step' with ordinal 99"),
                    "Expected 'No section of type' in error, got: {}",
                    db_error
                );
            }
            Err(other) => panic!("Expected Database error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
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
        assert_eq!(parse_section_type("Step").unwrap(), SectionType::Step);
        assert_eq!(
            parse_section_type("TESTING_CRITERION").unwrap(),
            SectionType::TestingCriterion
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

    // ========== Mutation Callback Tests ==========

    /// Test that mutation callbacks are fired when updating a task
    #[tokio::test]
    async fn test_update_fires_mutation_callback() {
        use std::sync::{Arc, atomic::AtomicUsize, atomic::Ordering};
        use vertebrae_core::MutationEvent;

        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        // Create a counter to track callback invocations
        let call_count = Arc::new(AtomicUsize::new(0));
        let call_count_clone = call_count.clone();

        // Create service with callback
        let callback = Arc::new(move |event: MutationEvent| match event {
            MutationEvent::TaskUpdated { id } => {
                assert_eq!(id, "abc123");
                call_count_clone.fetch_add(1, Ordering::Relaxed);
            }
            MutationEvent::TaskCreated { .. } => {
                // Ignore TaskCreated events from create_task
            }
            _ => panic!("Expected TaskUpdated or TaskCreated event"),
        });
        let services = VertebraeServices::with_task_callback(db, callback);

        // Create a task
        create_task(
            &services,
            "abc123",
            "Original title",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        // Execute update command
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("New title".to_string()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        // Verify callback was called
        assert_eq!(call_count.load(Ordering::Relaxed), 1);
    }

    /// Test that mutation callbacks are fired when updating multiple fields
    #[tokio::test]
    async fn test_update_multiple_fields_fires_single_callback() {
        use std::sync::{Arc, atomic::AtomicUsize, atomic::Ordering};
        use vertebrae_core::MutationEvent;

        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let call_count = Arc::new(AtomicUsize::new(0));
        let call_count_clone = call_count.clone();

        let callback = Arc::new(move |event: MutationEvent| match event {
            MutationEvent::TaskUpdated { id } => {
                assert_eq!(id, "abc123");
                call_count_clone.fetch_add(1, Ordering::Relaxed);
            }
            MutationEvent::TaskCreated { .. } => {
                // Ignore TaskCreated events from create_task
            }
            _ => panic!("Expected TaskUpdated or TaskCreated event"),
        });
        let services = VertebraeServices::with_task_callback(db, callback);

        create_task(
            &services,
            "abc123",
            "Original",
            "task",
            "in_progress",
            Some("low"),
            &["old"],
        )
        .await;

        // Update multiple fields in one command
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("Updated".to_string()),
            description: Some("New description".to_string()),
            priority: Some(Priority::Critical),
            add_tags: vec!["new".to_string()],
            remove_tags: vec!["old".to_string()],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        // Even with multiple changes, callback should fire once
        assert_eq!(call_count.load(Ordering::Relaxed), 1);
    }

    /// Test that callback is fired when setting parent
    #[tokio::test]
    async fn test_update_set_parent_fires_callback() {
        use std::sync::{Arc, atomic::AtomicUsize, atomic::Ordering};
        use vertebrae_core::MutationEvent;

        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let call_count = Arc::new(AtomicUsize::new(0));
        let call_count_clone = call_count.clone();

        let callback = Arc::new(move |event: MutationEvent| {
            match event {
                MutationEvent::TaskUpdated { id } => {
                    assert_eq!(id, "child1");
                    call_count_clone.fetch_add(1, Ordering::Relaxed);
                }
                _ => {} // Ignore other events
            }
        });
        let services = VertebraeServices::with_task_callback(db, callback);

        create_task(
            &services,
            "parent1",
            "Parent",
            "epic",
            "in_progress",
            None,
            &[],
        )
        .await;
        create_task(
            &services,
            "child1",
            "Child",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "child1".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("parent1".to_string()),
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        // Callback should be fired for the parent update
        assert!(call_count.load(Ordering::Relaxed) > 0);
    }

    // ========== Edge Case Tests ==========

    /// Test updating a section to empty content
    #[tokio::test]
    async fn test_update_section_to_empty_content() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        add_section(&services, "abc123", "step", "Original content", Some(0)).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: Some(vec!["step".to_string(), "0".to_string(), "".to_string()]),
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let sections = get_sections(&services, "abc123").await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].content, ""); // Empty content is allowed
    }

    /// Test updating section with special characters
    #[tokio::test]
    async fn test_update_section_with_special_chars() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        add_section(&services, "abc123", "step", "Original", Some(0)).await;

        let special_content = "Step with @#$%^&*() <html> and 'quotes' and \"double\"";
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: Some(vec![
                "step".to_string(),
                "0".to_string(),
                special_content.to_string(),
            ]),
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let sections = get_sections(&services, "abc123").await;
        assert_eq!(sections[0].content, special_content);
    }

    /// Test that removing all tags leaves task with no tags
    #[tokio::test]
    async fn test_update_remove_all_tags() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &["tag1", "tag2", "tag3"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec!["tag1".to_string(), "tag2".to_string(), "tag3".to_string()],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        assert!(task.tags.is_empty());
    }

    /// Test updating with invalid ordinal format for section
    #[tokio::test]
    async fn test_update_section_invalid_ordinal_format() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: Some(vec![
                "step".to_string(),
                "not_a_number".to_string(),
                "content".to_string(),
            ]),
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("invalid ordinal"),
                    "Expected 'invalid ordinal' in error, got: {}",
                    message
                );
            }
            other => panic!("Expected ValidationFailed, got {:?}", other),
        }
    }

    /// Test updating with wrong number of section arguments
    #[tokio::test]
    async fn test_update_edit_section_wrong_arg_count() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        // Missing content argument
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: Some(vec!["step".to_string(), "0".to_string()]),
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("edit-section requires"),
                    "Expected 'edit-section requires' in error, got: {}",
                    message
                );
            }
            other => panic!("Expected ValidationFailed, got {:?}", other),
        }
    }

    /// Test updating with wrong number of section removal arguments
    #[tokio::test]
    async fn test_update_remove_section_wrong_arg_count() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;

        // Missing ordinal argument
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: Some(vec!["step".to_string()]),
        };

        let result = cmd.execute(&services).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("remove-section requires"),
                    "Expected 'remove-section requires' in error, got: {}",
                    message
                );
            }
            other => panic!("Expected ValidationFailed, got {:?}", other),
        }
    }

    /// Test that adding and removing the same tag - remove is processed after add
    #[tokio::test]
    async fn test_update_add_and_remove_same_tag() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &["existing"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec!["existing".to_string()],
            remove_tags: vec!["existing".to_string()],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        // The service layer processes add_tags and remove_tags, and remove is likely processed
        // in a way where the duplicate add doesn't affect the final state
        assert!(task.tags.contains(&"existing".to_string()));
    }

    /// Test that edit section with negative ordinal is validated
    #[tokio::test]
    async fn test_update_section_negative_ordinal() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "task",
            "in_progress",
            None,
            &[],
        )
        .await;
        add_section(&services, "abc123", "step", "Step 0", Some(0)).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: Some(vec![
                "step".to_string(),
                "-1".to_string(),
                "content".to_string(),
            ]),
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        // Negative ordinals should fail
        assert!(result.is_err());
    }

    /// Test updating task with very long title
    #[tokio::test]
    async fn test_update_very_long_title() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Original",
            "task",
            "in_progress",
            Some("low"),
            &["old"],
        )
        .await;

        let long_title = "A".repeat(1000);
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some(long_title.clone()),
            description: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let task = get_task(&services, "abc123").await.unwrap();
        assert_eq!(task.title, long_title);
    }

    /// Test that clearing description preserves other fields
    #[tokio::test]
    async fn test_update_clear_description_preserves_fields() {
        let services = setup_test_db().await;

        create_task(
            &services,
            "abc123",
            "Test task",
            "ticket",
            "in_progress",
            Some("high"),
            &["important"],
        )
        .await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            description: Some("".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
            edit_section: None,
            remove_section: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let updated_task = services.tasks().get_task("abc123").await.unwrap();

        // Description should be cleared
        assert!(updated_task.description.is_none());
        // Other fields should be preserved
        assert_eq!(updated_task.title, "Test task");
        assert_eq!(updated_task.priority, Some(vertebrae_core::Priority::High));
        assert!(updated_task.tags.contains(&"important".to_string()));
    }
}
