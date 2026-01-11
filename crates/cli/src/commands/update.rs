//! Update command for modifying existing tasks
//!
//! Implements the `vtb update` command to modify task fields including
//! title, description, priority, tags, parent relationship, and sections.

use clap::Args;
use serde::Deserialize;
use vertebrae_db::{Database, DbError, Priority, SectionType};

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

/// Result from querying a task - minimal fields for update
#[derive(Debug, Deserialize)]
struct TaskRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    #[serde(default)]
    tags: Vec<String>,
}

impl UpdateCommand {
    /// Execute the update command.
    ///
    /// Fetches the existing task, applies the specified changes,
    /// and updates the task in the database.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The parent task doesn't exist (if specified)
    /// - Attempting to set self as parent
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Verify task exists
        if !self.task_exists(db, &id).await? {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("Task '{}' not found", self.id),
            });
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
                return Err(DbError::InvalidPath {
                    path: std::path::PathBuf::from(parent_id),
                    reason: "Cannot set task as its own parent".to_string(),
                });
            }

            // Check parent exists
            if !self.task_exists(db, &parent_id_lower).await? {
                return Err(DbError::InvalidPath {
                    path: std::path::PathBuf::from(parent_id),
                    reason: format!("Parent task '{}' does not exist", parent_id),
                });
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

    /// Check if a task with the given ID exists.
    async fn task_exists(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        #[derive(serde::Deserialize)]
        struct IdOnly {
            #[allow(dead_code)]
            id: surrealdb::sql::Thing,
        }

        let query = format!("SELECT id FROM task:{} LIMIT 1", id);
        let mut result = db.client().query(&query).await?;

        let tasks: Vec<IdOnly> = result.take(0)?;
        Ok(!tasks.is_empty())
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
    async fn apply_field_updates(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let mut updates = Vec::new();

        if let Some(title) = &self.title {
            // Escape quotes in title
            let escaped_title = title.replace('\"', "\\\"");
            updates.push(format!("title = \"{}\"", escaped_title));
        }

        if let Some(description) = &self.description {
            if description.is_empty() {
                // Empty string clears description
                updates.push("description = NONE".to_string());
            } else {
                let escaped_desc = description.replace('\"', "\\\"");
                updates.push(format!("description = \"{}\"", escaped_desc));
            }
        }

        if let Some(priority) = &self.priority {
            updates.push(format!("priority = \"{}\"", priority.as_str()));
        }

        if !updates.is_empty() {
            let query = format!("UPDATE task:{} SET {}", id, updates.join(", "));
            db.client().query(&query).await?;
        }

        Ok(())
    }

    /// Apply tag updates (add and remove).
    async fn apply_tag_updates(&self, db: &Database, id: &str) -> Result<(), DbError> {
        if self.add_tags.is_empty() && self.remove_tags.is_empty() {
            return Ok(());
        }

        // Fetch current tags
        let query = format!("SELECT id, tags FROM task:{}", id);
        let mut result = db.client().query(&query).await?;
        let task: Option<TaskRow> = result.take(0)?;

        let mut current_tags: Vec<String> = task.map(|t| t.tags).unwrap_or_default();

        // Remove tags
        for tag in &self.remove_tags {
            current_tags.retain(|t| t != tag);
        }

        // Add tags (avoiding duplicates)
        for tag in &self.add_tags {
            if !current_tags.contains(tag) {
                current_tags.push(tag.clone());
            }
        }

        // Update tags in database
        let tags_str = if current_tags.is_empty() {
            "[]".to_string()
        } else {
            format!(
                "[{}]",
                current_tags
                    .iter()
                    .map(|t| format!("\"{}\"", t.replace('\"', "\\\"")))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let update_query = format!("UPDATE task:{} SET tags = {}", id, tags_str);
        db.client().query(&update_query).await?;

        Ok(())
    }

    /// Apply parent update.
    async fn apply_parent_update(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let Some(parent_id) = &self.parent else {
            return Ok(());
        };

        // First, delete any existing child_of edge from this task
        let delete_query = format!("DELETE child_of WHERE in = task:{}", id);
        db.client().query(&delete_query).await?;

        // If parent is not empty, create new edge
        if !parent_id.is_empty() {
            let parent_id_lower = parent_id.to_lowercase();
            let create_query =
                format!("RELATE task:{} -> child_of -> task:{}", id, parent_id_lower);
            db.client().query(&create_query).await?;
        }

        Ok(())
    }

    /// Apply section updates (edit and remove).
    async fn apply_section_updates(&self, db: &Database, id: &str) -> Result<(), DbError> {
        // Handle edit section
        if let Some(args) = &self.edit_section {
            if args.len() != 3 {
                return Err(DbError::InvalidPath {
                    path: std::path::PathBuf::from(&self.id),
                    reason: "edit-section requires: <type> <ordinal> <content>".to_string(),
                });
            }

            let section_type = parse_section_type(&args[0]).map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: e,
            })?;

            let ordinal: u32 = args[1].parse().map_err(|_| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("invalid ordinal '{}': expected a number", args[1]),
            })?;

            let new_content = &args[2];
            self.edit_section_at(db, id, &section_type, ordinal, new_content)
                .await?;
        }

        // Handle remove section
        if let Some(args) = &self.remove_section {
            if args.len() != 2 {
                return Err(DbError::InvalidPath {
                    path: std::path::PathBuf::from(&self.id),
                    reason: "remove-section requires: <type> <ordinal>".to_string(),
                });
            }

            let section_type = parse_section_type(&args[0]).map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: e,
            })?;

            let ordinal: u32 = args[1].parse().map_err(|_| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("invalid ordinal '{}': expected a number", args[1]),
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
    ) -> Result<(), DbError> {
        // Fetch current sections
        let sections = self.fetch_sections(db, id).await?;
        let type_str = section_type.as_str();

        // Find sections of this type and locate the one at ordinal
        let mut found = false;
        let mut new_sections: Vec<String> = Vec::new();

        for section in &sections {
            if section.section_type.as_deref() == Some(type_str) && section.order == Some(ordinal) {
                // Replace this section's content
                found = true;
                let escaped_content = new_content.replace('\\', "\\\\").replace('"', "\\\"");
                new_sections.push(format!(
                    r#"{{ "type": "{}", "content": "{}", "order": {} }}"#,
                    type_str, escaped_content, ordinal
                ));
            } else {
                // Keep section as-is
                if let Some(section_str) = self.section_to_string(section) {
                    new_sections.push(section_str);
                }
            }
        }

        if !found {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("No {} section found at ordinal {}", section_type, ordinal),
            });
        }

        // Update sections in database
        let sections_array = format!("[{}]", new_sections.join(", "));
        let query = format!("UPDATE task:{} SET sections = {}", id, sections_array);
        db.client().query(&query).await?;

        Ok(())
    }

    /// Remove a section at a specific ordinal.
    async fn remove_section_at(
        &self,
        db: &Database,
        id: &str,
        section_type: &SectionType,
        ordinal: u32,
    ) -> Result<(), DbError> {
        // Fetch current sections
        let sections = self.fetch_sections(db, id).await?;
        let type_str = section_type.as_str();

        // Check if the section exists at this ordinal
        let exists = sections
            .iter()
            .any(|s| s.section_type.as_deref() == Some(type_str) && s.order == Some(ordinal));

        if !exists {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("No {} section found at ordinal {}", section_type, ordinal),
            });
        }

        // Build new sections array:
        // 1. Keep all sections that are NOT of this type
        // 2. Keep sections of this type that don't have the target ordinal
        // 3. Renumber the remaining sections of this type
        let mut new_sections: Vec<String> = Vec::new();

        // First, add all non-matching type sections
        for s in &sections {
            if s.section_type.as_deref() != Some(type_str)
                && let Some(section_str) = self.section_to_string(s)
            {
                new_sections.push(section_str);
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
            if let (Some(content), Some(_)) = (&s.content, &s.section_type) {
                let escaped_content = content.replace('\\', "\\\\").replace('"', "\\\"");
                new_sections.push(format!(
                    r#"{{ "type": "{}", "content": "{}", "order": {} }}"#,
                    type_str, escaped_content, new_ordinal
                ));
            }
        }

        // Update sections in database
        let sections_array = format!("[{}]", new_sections.join(", "));
        let query = format!("UPDATE task:{} SET sections = {}", id, sections_array);
        db.client().query(&query).await?;

        Ok(())
    }

    /// Fetch sections from a task.
    async fn fetch_sections(&self, db: &Database, id: &str) -> Result<Vec<SectionRow>, DbError> {
        let query = format!("SELECT sections FROM task:{}", id);
        let mut result = db.client().query(&query).await?;

        #[derive(Deserialize)]
        struct SectionsRow {
            #[serde(default)]
            sections: Vec<SectionRow>,
        }

        let row: Option<SectionsRow> = result.take(0)?;
        Ok(row.map(|r| r.sections).unwrap_or_default())
    }

    /// Convert a SectionRow to its string representation for the query.
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

    /// Update the updated_at timestamp.
    async fn update_timestamp(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
        db.client().query(&query).await?;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Database {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        db
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
        let priority_str = match priority {
            Some(p) => format!("\"{}\"", p),
            None => "NONE".to_string(),
        };

        let tags_str = if tags.is_empty() {
            "[]".to_string()
        } else {
            format!(
                "[{}]",
                tags.iter()
                    .map(|t| format!("\"{}\"", t))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "{}",
                status = "{}",
                priority = {},
                tags = {},
                sections = [],
                refs = []"#,
            id, title, level, status, priority_str, tags_str
        );

        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a child_of relationship
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await.unwrap();
    }

    /// Struct for querying task fields
    #[derive(Debug, Deserialize)]
    struct TaskFields {
        title: String,
        priority: Option<String>,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        updated_at: Option<surrealdb::sql::Datetime>,
    }

    /// Helper to get a task's fields
    async fn get_task(db: &Database, id: &str) -> Option<TaskFields> {
        let query = format!("SELECT title, priority, tags, updated_at FROM task:{}", id);
        let mut result = db.client().query(&query).await.ok()?;
        result.take(0).ok()?
    }

    /// Helper to get parent ID for a task
    async fn get_parent_id(db: &Database, id: &str) -> Option<String> {
        #[derive(Debug, Deserialize)]
        struct ParentRow {
            id: surrealdb::sql::Thing,
        }

        let query = format!(
            "SELECT id FROM task WHERE <-child_of<-task CONTAINS task:{}",
            id
        );
        let mut result = db.client().query(&query).await.ok()?;
        let parents: Vec<ParentRow> = result.take(0).ok()?;
        parents.first().map(|p| p.id.id.to_string())
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
        let db = setup_test_db().await;

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
    }

    #[tokio::test]
    async fn test_update_title() {
        let db = setup_test_db().await;

        create_task(
            &db,
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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify title was changed
        let task = get_task(&db, "abc123").await.expect("Task should exist");
        assert_eq!(task.title, "New title");

        // Verify other fields were not changed
        assert_eq!(task.priority, Some("low".to_string()));
        assert!(task.tags.contains(&"backend".to_string()));
    }

    #[tokio::test]
    async fn test_update_priority() {
        let db = setup_test_db().await;

        create_task(
            &db,
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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify priority was changed
        let task = get_task(&db, "abc123").await.expect("Task should exist");
        assert_eq!(task.priority, Some("high".to_string()));

        // Verify other fields were not changed
        assert_eq!(task.title, "Test task");
        assert!(task.tags.contains(&"api".to_string()));
    }

    #[tokio::test]
    async fn test_update_add_tag() {
        let db = setup_test_db().await;

        create_task(
            &db,
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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert!(task.tags.contains(&"initial".to_string()));
        assert!(task.tags.contains(&"urgent".to_string()));
    }

    #[tokio::test]
    async fn test_update_remove_tag() {
        let db = setup_test_db().await;

        create_task(
            &db,
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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert!(task.tags.contains(&"initial".to_string()));
        assert!(!task.tags.contains(&"toremove".to_string()));
    }

    #[tokio::test]
    async fn test_update_add_duplicate_tag() {
        let db = setup_test_db().await;

        create_task(
            &db,
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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        // Should only have one instance of the tag
        assert_eq!(task.tags.len(), 1);
        assert_eq!(task.tags[0], "existing");
    }

    #[tokio::test]
    async fn test_update_set_parent() {
        let db = setup_test_db().await;

        create_task(&db, "parent1", "Parent task", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&db, "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));
    }

    #[tokio::test]
    async fn test_update_change_parent() {
        let db = setup_test_db().await;

        create_task(&db, "parent1", "Parent 1", "epic", "todo", None, &[]).await;
        create_task(&db, "parent2", "Parent 2", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child task", "task", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&db, "child1").await;
        assert_eq!(parent_id, Some("parent2".to_string()));
    }

    #[tokio::test]
    async fn test_update_remove_parent() {
        let db = setup_test_db().await;

        create_task(&db, "parent1", "Parent task", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child task", "task", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;

        // Verify parent exists before
        let parent_id = get_parent_id(&db, "child1").await;
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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&db, "child1").await;
        assert!(parent_id.is_none());
    }

    #[tokio::test]
    #[serial]
    async fn test_update_self_parent_fails() {
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("own parent"),
                    "Expected 'own parent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_update_nonexistent_parent_fails() {
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("does not exist"),
                    "Expected 'does not exist' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("nonexistent"),
                    "Expected parent ID 'nonexistent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_update_timestamp_updated() {
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert!(task.updated_at.is_some());
    }

    #[tokio::test]
    async fn test_update_case_insensitive_id() {
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert_eq!(task.title, "New title");
    }

    #[tokio::test]
    async fn test_update_no_changes() {
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "abc123");
    }

    #[tokio::test]
    async fn test_update_multiple_fields() {
        let db = setup_test_db().await;

        create_task(
            &db,
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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert_eq!(task.title, "Updated");
        assert_eq!(task.priority, Some("critical".to_string()));
        assert!(task.tags.contains(&"new".to_string()));
        assert!(!task.tags.contains(&"old".to_string()));
    }

    #[tokio::test]
    async fn test_update_preserves_other_fields() {
        let db = setup_test_db().await;

        // Create task with specific values
        let query = r#"CREATE task:abc123 SET
            title = "Original",
            level = "ticket",
            status = "in_progress",
            priority = "high",
            tags = ["backend", "api"],
            sections = [{ type: "goal", content: "Important goal" }],
            refs = [{ path: "src/main.rs", line_start: 10 }]"#;
        db.client().query(query).await.unwrap();

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify other fields preserved
        #[derive(Debug, Deserialize)]
        struct FullTask {
            title: String,
            level: String,
            status: String,
            priority: Option<String>,
            #[serde(default)]
            tags: Vec<String>,
            #[serde(default)]
            sections: Vec<serde_json::Value>,
            #[serde(default, rename = "refs")]
            code_refs: Vec<serde_json::Value>,
        }

        let query = "SELECT * FROM task:abc123";
        let mut result = db.client().query(query).await.unwrap();
        let task: Option<FullTask> = result.take(0).unwrap();
        let task = task.unwrap();

        assert_eq!(task.title, "Updated title");
        assert_eq!(task.level, "ticket");
        assert_eq!(task.status, "in_progress");
        assert_eq!(task.priority, Some("high".to_string()));
        assert_eq!(task.tags, vec!["backend", "api"]);
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.code_refs.len(), 1);
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
        let db = setup_test_db().await;

        create_task(&db, "parent1", "Parent task", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&db, "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));
    }

    // ========== Description Tests ==========

    #[tokio::test]
    async fn test_update_description() {
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify description was set
        #[derive(Debug, Deserialize)]
        struct TaskWithDesc {
            description: Option<String>,
        }

        let query = "SELECT description FROM task:abc123";
        let mut result = db.client().query(query).await.unwrap();
        let task: Option<TaskWithDesc> = result.take(0).unwrap();
        assert_eq!(
            task.unwrap().description,
            Some("New description".to_string())
        );
    }

    #[tokio::test]
    async fn test_update_clear_description() {
        let db = setup_test_db().await;

        // Create task with description
        let query = r#"CREATE task:abc123 SET
            title = "Test task",
            description = "Original description",
            level = "task",
            status = "todo",
            tags = [],
            sections = [],
            refs = []"#;
        db.client().query(query).await.unwrap();

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        // Verify description was cleared
        #[derive(Debug, Deserialize)]
        struct TaskWithDesc {
            description: Option<String>,
        }

        let query = "SELECT description FROM task:abc123";
        let mut result = db.client().query(query).await.unwrap();
        let task: Option<TaskWithDesc> = result.take(0).unwrap();
        assert!(task.unwrap().description.is_none());
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

    #[tokio::test]
    async fn test_update_remove_section() {
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;
        add_section(&db, "abc123", "step", "Step 0", Some(0)).await;
        add_section(&db, "abc123", "step", "Step 1", Some(1)).await;
        add_section(&db, "abc123", "step", "Step 2", Some(2)).await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Remove section failed: {:?}", result.err());

        // Verify section was removed and others renumbered
        let sections = get_sections(&db, "abc123").await;
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
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;
        add_section(&db, "abc123", "step", "Original step", Some(0)).await;

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

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Edit section failed: {:?}", result.err());

        // Verify section was updated
        let sections = get_sections(&db, "abc123").await;
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].content.as_deref(), Some("Updated step content"));
    }

    #[tokio::test]
    async fn test_update_remove_nonexistent_section_fails() {
        let db = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

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

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("No step section found at ordinal 99"),
                    "Expected 'No step section found' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
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
