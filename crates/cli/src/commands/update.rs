//! Update command for modifying existing tasks
//!
//! Implements the `vtb update` command to modify task fields including
//! title, description, priority, tags, parent relationship, and sections.

use clap::Args;
use serde::Deserialize;
use vertebrae_core::{ServiceError, TaskService};
use vertebrae_db::{Database, Priority, SectionType, TaskUpdate};

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
    /// Fetches the existing task, applies the specified changes,
    /// and updates the task in the database.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - The parent task doesn't exist (if specified)
    /// - Attempting to set self as parent
    /// - Database operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        let db = service.database();
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Verify task exists
        if !service.task_exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        // Check if any updates were specified
        if !self.has_updates() {
            return Ok(id);
        }

        // Validate parent if specified
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
            if !service.task_exists(&parent_id_lower).await? {
                return Err(ServiceError::parent_not_found(&parent_id_lower));
            }
        }

        // Apply field updates
        self.apply_field_updates(db, &id).await?;

        // Handle tag updates
        self.apply_tag_updates(db, &id).await?;

        // Handle parent update
        self.apply_parent_update(db, &id).await?;

        // Handle section updates
        self.apply_section_updates(db, &id).await?;

        // Update timestamp
        self.update_timestamp(db, &id).await?;

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

    /// Apply field updates (title, description, priority).
    async fn apply_field_updates(&self, db: &Database, id: &str) -> Result<(), ServiceError> {
        let mut updates = TaskUpdate::new();

        if let Some(title) = &self.title {
            updates = updates.with_title(title.clone());
        }

        if let Some(description) = &self.description {
            if description.is_empty() {
                updates = updates.clear_description();
            } else {
                updates = updates.with_description(description.clone());
            }
        }

        if let Some(priority) = &self.priority {
            updates = updates.with_priority(priority.clone());
        }

        if updates.has_updates() {
            db.tasks().update(id, &updates).await?;
        }

        Ok(())
    }

    /// Apply tag updates (add and remove).
    async fn apply_tag_updates(&self, db: &Database, id: &str) -> Result<(), ServiceError> {
        if self.add_tags.is_empty() && self.remove_tags.is_empty() {
            return Ok(());
        }

        let mut updates = TaskUpdate::new();

        // Remove tags
        for tag in &self.remove_tags {
            updates = updates.remove_tag(tag.clone());
        }

        // Add tags
        for tag in &self.add_tags {
            updates = updates.add_tag(tag.clone());
        }

        db.tasks().update(id, &updates).await?;

        Ok(())
    }

    /// Apply parent update.
    async fn apply_parent_update(&self, db: &Database, id: &str) -> Result<(), ServiceError> {
        let Some(parent_id) = &self.parent else {
            return Ok(());
        };

        // First, delete any existing child_of edge from this task
        db.relationships().remove_child_of(id).await?;

        // If parent is not empty, create new edge
        if !parent_id.is_empty() {
            let parent_id_lower = parent_id.to_lowercase();
            db.relationships()
                .create_child_of(id, &parent_id_lower)
                .await?;
        }

        Ok(())
    }

    /// Apply section updates (edit and remove).
    async fn apply_section_updates(&self, db: &Database, id: &str) -> Result<(), ServiceError> {
        // Handle edit section
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
            self.edit_section_at(db, id, &section_type, ordinal, new_content)
                .await?;
        }

        // Handle remove section
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

            self.remove_section_at(db, id, &section_type, ordinal)
                .await?;
        }

        Ok(())
    }

    /// Edit a section at a specific ordinal.
    async fn edit_section_at(
        &self,
        db: &Database,
        id: &str,
        section_type: &SectionType,
        ordinal: u32,
        new_content: &str,
    ) -> Result<(), ServiceError> {
        use vertebrae_db::Section;

        // Fetch current sections
        let sections = self.fetch_sections(db, id).await?;
        let type_str = section_type.as_str();

        // Find sections of this type and locate the one at ordinal
        let mut found = false;
        let mut new_sections: Vec<Section> = Vec::new();

        for section in &sections {
            if section.section_type.as_deref() == Some(type_str) && section.order == Some(ordinal) {
                // Replace this section's content
                found = true;
                new_sections.push(Section {
                    section_type: section_type.clone(),
                    content: new_content.to_string(),
                    order: Some(ordinal),
                    done: Some(false),
                    done_at: None,
                    refs: vec![],
                });
            } else {
                // Keep section as-is
                if let (Some(st), Some(content)) = (&section.section_type, &section.content)
                    && let Ok(parsed_type) = parse_section_type(st)
                {
                    new_sections.push(Section {
                        section_type: parsed_type,
                        content: content.clone(),
                        order: section.order,
                        done: section.done,
                        done_at: section.done_at,
                        refs: vec![],
                    });
                }
            }
        }

        if !found {
            return Err(ServiceError::validation_failed(format!(
                "No {} section found at ordinal {}",
                section_type, ordinal
            )));
        }

        // Update sections in database
        let updates = TaskUpdate::new().with_sections(new_sections);
        db.tasks().update(id, &updates).await?;

        Ok(())
    }

    /// Remove a section at a specific ordinal.
    async fn remove_section_at(
        &self,
        db: &Database,
        id: &str,
        section_type: &SectionType,
        ordinal: u32,
    ) -> Result<(), ServiceError> {
        use vertebrae_db::Section;

        // Fetch current sections
        let sections = self.fetch_sections(db, id).await?;
        let type_str = section_type.as_str();

        // Check if the section exists at this ordinal
        let exists = sections
            .iter()
            .any(|s| s.section_type.as_deref() == Some(type_str) && s.order == Some(ordinal));

        if !exists {
            return Err(ServiceError::validation_failed(format!(
                "No {} section found at ordinal {}",
                section_type, ordinal
            )));
        }

        // Build new sections array:
        // 1. Keep all sections that are NOT of this type
        // 2. Keep sections of this type that don't have the target ordinal
        // 3. Renumber the remaining sections of this type
        let mut new_sections: Vec<Section> = Vec::new();

        // First, add all non-matching type sections
        for s in &sections {
            if s.section_type.as_deref() != Some(type_str)
                && let (Some(st), Some(content)) = (&s.section_type, &s.content)
                && let Ok(parsed_type) = parse_section_type(st)
            {
                new_sections.push(Section {
                    section_type: parsed_type,
                    content: content.clone(),
                    order: s.order,
                    done: s.done,
                    done_at: s.done_at,
                    refs: vec![],
                });
            }
        }

        // Collect matching sections (excluding the one at ordinal) and renumber
        let mut sections_of_type: Vec<&SectionRow> = sections
            .iter()
            .filter(|s| s.section_type.as_deref() == Some(type_str) && s.order != Some(ordinal))
            .collect();

        // Sort by original order
        sections_of_type.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

        // Add with renumbered ordinals
        for (new_ordinal, s) in sections_of_type.iter().enumerate() {
            if let (Some(st), Some(content)) = (&s.section_type, &s.content)
                && let Ok(parsed_type) = parse_section_type(st)
            {
                new_sections.push(Section {
                    section_type: parsed_type,
                    content: content.clone(),
                    order: Some(new_ordinal as u32),
                    done: s.done,
                    done_at: s.done_at,
                    refs: vec![],
                });
            }
        }

        // Update sections in database
        let updates = TaskUpdate::new().with_sections(new_sections);
        db.tasks().update(id, &updates).await?;

        Ok(())
    }

    /// Fetch sections from a task.
    async fn fetch_sections(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<Vec<SectionRow>, ServiceError> {
        // Get the task to access its sections
        if let Some(task) = db.tasks().get(id).await? {
            let sections = task
                .sections
                .into_iter()
                .map(|s| SectionRow {
                    section_type: Some(s.section_type.to_string()),
                    content: Some(s.content),
                    order: s.order,
                    done: s.done,
                    done_at: s.done_at,
                })
                .collect();
            Ok(sections)
        } else {
            Ok(Vec::new())
        }
    }

    /// Update the updated_at timestamp.
    async fn update_timestamp(&self, db: &Database, id: &str) -> Result<(), ServiceError> {
        db.tasks().update_timestamp(id).await?;
        Ok(())
    }
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
    #[serde(default)]
    done: Option<bool>,
    #[serde(default)]
    done_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use vertebrae_core::DefaultTaskService;

    /// Helper to create an in-memory test database wrapped in a service
    async fn setup_test_db() -> DefaultTaskService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultTaskService::new(db)
    }

    /// Helper to create a task in the database
    async fn create_task(
        db: &Database,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
        priority: Option<&str>,
        tags: &[&str],
    ) {
        use vertebrae_db::{Level, Status, Task};

        let level_enum = match level {
            "epic" => Level::Epic,
            "ticket" => Level::Ticket,
            _ => Level::Task,
        };

        let status_enum = match status {
            "done" => Status::Done,
            "in_progress" => Status::InProgress,
            "todo" => Status::Todo,
            _ => Status::Backlog,
        };

        let priority_enum = priority.and_then(|p| match p {
            "low" => Some(vertebrae_db::Priority::Low),
            "medium" => Some(vertebrae_db::Priority::Medium),
            "high" => Some(vertebrae_db::Priority::High),
            "critical" => Some(vertebrae_db::Priority::Critical),
            _ => None,
        });

        let task = Task {
            title: title.to_string(),
            description: None,
            level: level_enum,
            status: status_enum,
            priority: priority_enum,
            tags: tags.iter().map(|t| t.to_string()).collect(),
            sections: vec![],
            code_refs: vec![],
            needs_human_review: None,
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
            id: None,
            workflow_id: None,
            current_step: None,
        };

        db.tasks().create(id, &task).await.unwrap();
    }

    /// Helper to create a child_of relationship
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        db.relationships()
            .create_child_of(child_id, parent_id)
            .await
            .unwrap();
    }

    /// Struct for querying task fields
    #[derive(Debug, Deserialize)]
    struct TaskFields {
        title: String,
        priority: Option<String>,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        updated_at: Option<chrono::DateTime<chrono::Utc>>,
    }

    /// Helper to get a task's fields
    async fn get_task(db: &Database, id: &str) -> Option<TaskFields> {
        let task = db.tasks().get(id).await.ok()??;
        Some(TaskFields {
            title: task.title,
            priority: task.priority.map(|p| p.to_string()),
            tags: task.tags,
            updated_at: task.updated_at,
        })
    }

    /// Helper to get parent ID for a task
    async fn get_parent_id(db: &Database, id: &str) -> Option<String> {
        db.relationships().get_parent(id).await.ok()?
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
        let service = setup_test_db().await;

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

        let result = cmd.execute(&service).await;
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
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Original title",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        // Verify title was changed
        let task = get_task(service.database(), "abc123")
            .await
            .expect("Task should exist");
        assert_eq!(task.title, "New title");

        // Verify other fields were not changed
        assert_eq!(task.priority, Some("low".to_string()));
        assert!(task.tags.contains(&"backend".to_string()));
    }

    #[tokio::test]
    async fn test_update_priority() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        // Verify priority was changed
        let task = get_task(service.database(), "abc123")
            .await
            .expect("Task should exist");
        assert_eq!(task.priority, Some("high".to_string()));

        // Verify other fields were not changed
        assert_eq!(task.title, "Test task");
        assert!(task.tags.contains(&"api".to_string()));
    }

    #[tokio::test]
    async fn test_update_add_tag() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let task = get_task(service.database(), "abc123").await.unwrap();
        assert!(task.tags.contains(&"initial".to_string()));
        assert!(task.tags.contains(&"urgent".to_string()));
    }

    #[tokio::test]
    async fn test_update_remove_tag() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let task = get_task(service.database(), "abc123").await.unwrap();
        assert!(task.tags.contains(&"initial".to_string()));
        assert!(!task.tags.contains(&"toremove".to_string()));
    }

    #[tokio::test]
    async fn test_update_add_duplicate_tag() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let task = get_task(service.database(), "abc123").await.unwrap();
        // Should only have one instance of the tag
        assert_eq!(task.tags.len(), 1);
        assert_eq!(task.tags[0], "existing");
    }

    #[tokio::test]
    async fn test_update_set_parent() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "parent1",
            "Parent task",
            "epic",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(
            service.database(),
            "child1",
            "Child task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(service.database(), "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));
    }

    #[tokio::test]
    async fn test_update_change_parent() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "parent1",
            "Parent 1",
            "epic",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(
            service.database(),
            "parent2",
            "Parent 2",
            "epic",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(
            service.database(),
            "child1",
            "Child task",
            "task",
            "todo",
            None,
            &[],
        )
        .await;
        create_child_of(service.database(), "child1", "parent1").await;

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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(service.database(), "child1").await;
        assert_eq!(parent_id, Some("parent2".to_string()));
    }

    #[tokio::test]
    async fn test_update_remove_parent() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "parent1",
            "Parent task",
            "epic",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(
            service.database(),
            "child1",
            "Child task",
            "task",
            "todo",
            None,
            &[],
        )
        .await;
        create_child_of(service.database(), "child1", "parent1").await;

        // Verify parent exists before
        let parent_id = get_parent_id(service.database(), "child1").await;
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(service.database(), "child1").await;
        assert!(parent_id.is_none());
    }

    #[tokio::test]
    #[serial]
    async fn test_update_self_parent_fails() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
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
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
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
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let task = get_task(service.database(), "abc123").await.unwrap();
        assert!(task.updated_at.is_some());
    }

    #[tokio::test]
    async fn test_update_case_insensitive_id() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let task = get_task(service.database(), "abc123").await.unwrap();
        assert_eq!(task.title, "New title");
    }

    #[tokio::test]
    async fn test_update_no_changes() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "abc123");
    }

    #[tokio::test]
    async fn test_update_multiple_fields() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Original",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let task = get_task(service.database(), "abc123").await.unwrap();
        assert_eq!(task.title, "Updated");
        assert_eq!(task.priority, Some("critical".to_string()));
        assert!(task.tags.contains(&"new".to_string()));
        assert!(!task.tags.contains(&"old".to_string()));
    }

    #[tokio::test]
    async fn test_update_preserves_other_fields() {
        use vertebrae_db::{CodeRef, Level, Section, SectionType, Status, Task};

        let service = setup_test_db().await;

        // Create task with specific values
        let task = Task {
            title: "Original".to_string(),
            description: None,
            level: Level::Ticket,
            status: Status::InProgress,
            priority: Some(vertebrae_db::Priority::High),
            tags: vec!["backend".to_string(), "api".to_string()],
            sections: vec![Section {
                section_type: SectionType::Goal,
                content: "Important goal".to_string(),
                order: None,
                done: None,
                done_at: None,
                refs: vec![],
            }],
            code_refs: vec![CodeRef {
                path: "src/main.rs".to_string(),
                name: None,
                description: None,
                line_start: Some(10),
                line_end: None,
            }],
            needs_human_review: None,
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
            id: None,
            workflow_id: None,
            current_step: None,
        };
        service
            .database()
            .tasks()
            .create("abc123", &task)
            .await
            .unwrap();

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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        // Verify other fields preserved
        let task = service
            .database()
            .tasks()
            .get("abc123")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(task.title, "Updated title");
        assert_eq!(task.level, Level::Ticket);
        assert_eq!(task.status, Status::InProgress);
        assert_eq!(task.priority, Some(vertebrae_db::Priority::High));
        // Verify tags and other fields are preserved
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
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "parent1",
            "Parent task",
            "epic",
            "todo",
            None,
            &[],
        )
        .await;
        create_task(
            service.database(),
            "child1",
            "Child task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(service.database(), "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));
    }

    // ========== Description Tests ==========

    #[tokio::test]
    async fn test_update_description() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        // Verify description was set
        let task = service
            .database()
            .tasks()
            .get("abc123")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(task.description, Some("New description".to_string()));
    }

    #[tokio::test]
    async fn test_update_clear_description() {
        use vertebrae_db::{Level, Status, Task};

        let service = setup_test_db().await;

        // Create task with description
        let task = Task {
            title: "Test task".to_string(),
            description: Some("Original description".to_string()),
            level: Level::Task,
            status: Status::Todo,
            priority: None,
            tags: vec![],
            sections: vec![],
            code_refs: vec![],
            needs_human_review: None,
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
            id: None,
            workflow_id: None,
            current_step: None,
        };
        service
            .database()
            .tasks()
            .create("abc123", &task)
            .await
            .unwrap();

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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok());

        // Verify description was cleared
        let task = service
            .database()
            .tasks()
            .get("abc123")
            .await
            .unwrap()
            .unwrap();
        assert!(task.description.is_none());
    }

    // ========== Section Tests ==========

    /// Helper to add a section to a task
    async fn add_section(
        db: &Database,
        id: &str,
        section_type: &str,
        content: &str,
        order: Option<u32>,
    ) {
        use vertebrae_db::{Section, TaskUpdate};

        // Get current task and sections
        let task = db.tasks().get(id).await.unwrap().unwrap();
        let mut sections = task.sections;

        // Parse section type
        if let Ok(section_enum) = parse_section_type(section_type) {
            // Add new section
            sections.push(Section {
                section_type: section_enum,
                content: content.to_string(),
                order,
                done: None,
                done_at: None,
                refs: vec![],
            });

            // Update task with new sections
            let update = TaskUpdate::new().with_sections(sections);
            db.tasks().update(id, &update).await.unwrap();
        }
    }

    /// Helper to get sections from a task
    async fn get_sections(db: &Database, id: &str) -> Vec<SectionRow> {
        let task = db.tasks().get(id).await.unwrap().unwrap();
        task.sections
            .into_iter()
            .map(|s| SectionRow {
                section_type: Some(s.section_type.to_string()),
                content: Some(s.content),
                order: s.order,
                done: s.done,
                done_at: s.done_at,
            })
            .collect()
    }

    #[tokio::test]
    async fn test_update_remove_section() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
            None,
            &[],
        )
        .await;
        add_section(service.database(), "abc123", "step", "Step 0", Some(0)).await;
        add_section(service.database(), "abc123", "step", "Step 1", Some(1)).await;
        add_section(service.database(), "abc123", "step", "Step 2", Some(2)).await;

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

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Remove section failed: {:?}", result.err());

        // Verify section was removed and others renumbered
        let sections = get_sections(service.database(), "abc123").await;
        assert_eq!(sections.len(), 2);

        // Find steps and verify renumbering
        let steps: Vec<&SectionRow> = sections
            .iter()
            .filter(|s| s.section_type.as_deref() == Some("step"))
            .collect();

        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].content.as_deref(), Some("Step 1"));
        assert_eq!(steps[0].order, Some(0)); // Renumbered from 1 to 0
        assert_eq!(steps[1].content.as_deref(), Some("Step 2"));
        assert_eq!(steps[1].order, Some(1)); // Renumbered from 2 to 1
    }

    #[tokio::test]
    async fn test_update_edit_section() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
            None,
            &[],
        )
        .await;
        add_section(
            service.database(),
            "abc123",
            "step",
            "Original step",
            Some(0),
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
                "0".to_string(),
                "Updated step content".to_string(),
            ]),
            remove_section: None,
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Edit section failed: {:?}", result.err());

        // Verify section was updated
        let sections = get_sections(service.database(), "abc123").await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].content.as_deref(), Some("Updated step content"));
    }

    #[tokio::test]
    async fn test_update_remove_nonexistent_section_fails() {
        let service = setup_test_db().await;

        create_task(
            service.database(),
            "abc123",
            "Test task",
            "task",
            "todo",
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

        let result = cmd.execute(&service).await;
        match result {
            Err(ServiceError::ValidationFailed { message }) => {
                assert!(
                    message.contains("No step section found at ordinal 99"),
                    "Expected 'No step section found' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected ValidationFailed error, got {:?}", other),
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
}
