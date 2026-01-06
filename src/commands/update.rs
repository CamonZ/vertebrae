//! Update command for modifying existing tasks
//!
//! Implements the `vtb update` command to modify task fields including
//! title, priority, tags, and parent relationship.
//!
//! Note: Description support (via --description/-d) is not currently implemented
//! because it requires storing data in sections, which have limitations with
//! SurrealDB's SCHEMAFULL mode and array<object> types.

use crate::db::{Database, DbError, Priority};
use clap::Args;
use serde::Deserialize;

/// Update an existing task
#[derive(Debug, Args)]
pub struct UpdateCommand {
    /// Task ID to update (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// New title for the task
    #[arg(long)]
    pub title: Option<String>,

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
            || self.priority.is_some()
            || !self.add_tags.is_empty()
            || !self.remove_tags.is_empty()
            || self.parent.is_some()
    }

    /// Apply field updates (title, priority).
    async fn apply_field_updates(&self, db: &Database, id: &str) -> Result<(), DbError> {
        let mut updates = Vec::new();

        if let Some(title) = &self.title {
            // Escape quotes in title
            let escaped_title = title.replace('\"', "\\\"");
            updates.push(format!("title = \"{}\"", escaped_title));
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

    /// Update the updated_at timestamp.
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
            "vtb-update-test-{}-{:?}-{}",
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

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
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
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };
        assert!(!cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_title() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("New title".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_priority() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            priority: Some(Priority::High),
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_add_tags() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            priority: None,
            add_tags: vec!["urgent".to_string()],
            remove_tags: vec![],
            parent: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_remove_tags() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec!["old".to_string()],
            parent: None,
        };
        assert!(cmd.has_updates());
    }

    #[test]
    fn test_has_updates_with_parent() {
        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("parent1".to_string()),
        };
        assert!(cmd.has_updates());
    }

    #[tokio::test]
    async fn test_update_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = UpdateCommand {
            id: "nonexistent".to_string(),
            title: Some("New title".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("not found"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_title() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Original title", "task", "todo", None, &[]).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("New title".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert_eq!(task.title, "New title");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_priority() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", Some("low"), &[]).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            priority: Some(Priority::High),
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert_eq!(task.priority, Some("high".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_add_tag() {
        let (db, temp_dir) = setup_test_db().await;

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
            priority: None,
            add_tags: vec!["urgent".to_string()],
            remove_tags: vec![],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert!(task.tags.contains(&"initial".to_string()));
        assert!(task.tags.contains(&"urgent".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_remove_tag() {
        let (db, temp_dir) = setup_test_db().await;

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
            priority: None,
            add_tags: vec![],
            remove_tags: vec!["toremove".to_string()],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert!(task.tags.contains(&"initial".to_string()));
        assert!(!task.tags.contains(&"toremove".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_add_duplicate_tag() {
        let (db, temp_dir) = setup_test_db().await;

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
            priority: None,
            add_tags: vec!["existing".to_string()],
            remove_tags: vec![],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        // Should only have one instance of the tag
        assert_eq!(task.tags.len(), 1);
        assert_eq!(task.tags[0], "existing");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_set_parent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent task", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child task", "task", "todo", None, &[]).await;

        let cmd = UpdateCommand {
            id: "child1".to_string(),
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("parent1".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&db, "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_change_parent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent 1", "epic", "todo", None, &[]).await;
        create_task(&db, "parent2", "Parent 2", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child task", "task", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;

        let cmd = UpdateCommand {
            id: "child1".to_string(),
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("parent2".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&db, "child1").await;
        assert_eq!(parent_id, Some("parent2".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_remove_parent() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent task", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child task", "task", "todo", None, &[]).await;
        create_child_of(&db, "child1", "parent1").await;

        // Verify parent exists before
        let parent_id = get_parent_id(&db, "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));

        let cmd = UpdateCommand {
            id: "child1".to_string(),
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("".to_string()), // Empty string removes parent
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&db, "child1").await;
        assert!(parent_id.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_self_parent_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("abc123".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("own parent"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_nonexistent_parent_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("nonexistent".to_string()),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("does not exist"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_timestamp_updated() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: Some("New title".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert!(task.updated_at.is_some());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

        let cmd = UpdateCommand {
            id: "ABC123".to_string(), // Uppercase
            title: Some("New title".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert_eq!(task.title, "New title");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_no_changes() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "abc123", "Test task", "task", "todo", None, &[]).await;

        let cmd = UpdateCommand {
            id: "abc123".to_string(),
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "abc123");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_multiple_fields() {
        let (db, temp_dir) = setup_test_db().await;

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
            priority: Some(Priority::Critical),
            add_tags: vec!["new".to_string()],
            remove_tags: vec!["old".to_string()],
            parent: None,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let task = get_task(&db, "abc123").await.unwrap();
        assert_eq!(task.title, "Updated");
        assert_eq!(task.priority, Some("critical".to_string()));
        assert!(task.tags.contains(&"new".to_string()));
        assert!(!task.tags.contains(&"old".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_preserves_other_fields() {
        let (db, temp_dir) = setup_test_db().await;

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
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
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

        cleanup(&temp_dir);
    }

    #[test]
    fn test_update_command_debug() {
        let cmd = UpdateCommand {
            id: "test".to_string(),
            title: Some("Title".to_string()),
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: None,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("UpdateCommand"));
    }

    #[tokio::test]
    async fn test_update_parent_case_insensitive() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent1", "Parent task", "epic", "todo", None, &[]).await;
        create_task(&db, "child1", "Child task", "task", "todo", None, &[]).await;

        let cmd = UpdateCommand {
            id: "CHILD1".to_string(), // Uppercase child
            title: None,
            priority: None,
            add_tags: vec![],
            remove_tags: vec![],
            parent: Some("PARENT1".to_string()), // Uppercase parent
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let parent_id = get_parent_id(&db, "child1").await;
        assert_eq!(parent_id, Some("parent1".to_string()));

        cleanup(&temp_dir);
    }
}
