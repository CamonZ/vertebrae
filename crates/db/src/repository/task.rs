//! Task repository for CRUD operations on tasks
//!
//! Provides a repository pattern implementation for task operations,
//! encapsulating SurrealDB queries and providing a clean API.

use crate::error::DbResult;
use crate::models::{Priority, Status, Task};
use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;

/// Repository for task CRUD operations
///
/// Encapsulates database queries for tasks, providing a clean API
/// that hides the underlying SurrealDB implementation details.
pub struct TaskRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Update structure for partial task updates
#[derive(Debug, Default)]
pub struct TaskUpdate {
    /// New title (if Some)
    pub title: Option<String>,
    /// New priority (if Some)
    pub priority: Option<Option<Priority>>,
    /// Tags to add
    pub add_tags: Vec<String>,
    /// Tags to remove
    pub remove_tags: Vec<String>,
}

impl TaskUpdate {
    /// Create a new empty update
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a new title
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Set a new priority
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = Some(Some(priority));
        self
    }

    /// Clear the priority
    pub fn clear_priority(mut self) -> Self {
        self.priority = Some(None);
        self
    }

    /// Add a tag
    pub fn add_tag(mut self, tag: impl Into<String>) -> Self {
        self.add_tags.push(tag.into());
        self
    }

    /// Remove a tag
    pub fn remove_tag(mut self, tag: impl Into<String>) -> Self {
        self.remove_tags.push(tag.into());
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.title.is_some()
            || self.priority.is_some()
            || !self.add_tags.is_empty()
            || !self.remove_tags.is_empty()
    }
}

/// Minimal row for checking task existence
#[derive(Debug, Deserialize)]
struct IdOnly {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
}

/// Row for fetching task with tags
#[derive(Debug, Deserialize)]
struct TaskTagsRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
    #[serde(default)]
    tags: Vec<String>,
}

impl<'a> TaskRepository<'a> {
    /// Create a new TaskRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Check if a task with the given ID exists.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to check
    ///
    /// # Returns
    ///
    /// `true` if the task exists, `false` otherwise.
    pub async fn exists(&self, id: &str) -> DbResult<bool> {
        let query = format!("SELECT id FROM task:{} LIMIT 1", id);
        let mut result = self.client.query(&query).await?;
        let tasks: Vec<IdOnly> = result.take(0)?;
        Ok(!tasks.is_empty())
    }

    /// Create a new task with the specified ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The unique task ID
    /// * `task` - The task data to create
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create(&self, id: &str, task: &Task) -> DbResult<()> {
        let priority_str = match &task.priority {
            Some(p) => format!("\"{}\"", p.as_str()),
            None => "NONE".to_string(),
        };

        let tags_str = if task.tags.is_empty() {
            "[]".to_string()
        } else {
            format!(
                "[{}]",
                task.tags
                    .iter()
                    .map(|t| format!("\"{}\"", t.replace('\"', "\\\"")))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let title = task.title.clone();

        let query = format!(
            r#"CREATE task:{} SET
                title = $title,
                level = "{}",
                status = "{}",
                priority = {},
                tags = {}"#,
            id,
            task.level.as_str(),
            task.status.as_str(),
            priority_str,
            tags_str
        );

        self.client.query(&query).bind(("title", title)).await?;
        Ok(())
    }

    /// Get a task by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to fetch
    ///
    /// # Returns
    ///
    /// `Some(Task)` if found, `None` otherwise.
    pub async fn get(&self, id: &str) -> DbResult<Option<Task>> {
        let query = format!(
            "SELECT id, title, level, status, priority, tags, \
             created_at, updated_at, sections, refs FROM task:{}",
            id
        );

        let mut result = self.client.query(&query).await?;
        let task: Option<Task> = result.take(0)?;
        Ok(task)
    }

    /// Update the status of a task.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `status` - The new status
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_status(&self, id: &str, status: Status) -> DbResult<()> {
        let query = format!(
            "UPDATE task:{} SET status = '{}', updated_at = time::now()",
            id,
            status.as_str()
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Update the updated_at timestamp of a task.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_timestamp(&self, id: &str) -> DbResult<()> {
        let query = format!("UPDATE task:{} SET updated_at = time::now()", id);
        self.client.query(&query).await?;
        Ok(())
    }

    /// Apply partial updates to a task.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to update
    /// * `updates` - The updates to apply
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update(&self, id: &str, updates: &TaskUpdate) -> DbResult<()> {
        if !updates.has_updates() {
            return Ok(());
        }

        // Apply field updates (title, priority)
        let mut field_updates = Vec::new();

        if let Some(title) = &updates.title {
            let escaped_title = title.replace('\"', "\\\"");
            field_updates.push(format!("title = \"{}\"", escaped_title));
        }

        if let Some(priority_opt) = &updates.priority {
            match priority_opt {
                Some(p) => field_updates.push(format!("priority = \"{}\"", p.as_str())),
                None => field_updates.push("priority = NONE".to_string()),
            }
        }

        if !field_updates.is_empty() {
            let query = format!("UPDATE task:{} SET {}", id, field_updates.join(", "));
            self.client.query(&query).await?;
        }

        // Handle tag updates
        if !updates.add_tags.is_empty() || !updates.remove_tags.is_empty() {
            self.apply_tag_updates(id, &updates.add_tags, &updates.remove_tags)
                .await?;
        }

        Ok(())
    }

    /// Apply tag updates (add and remove tags).
    async fn apply_tag_updates(
        &self,
        id: &str,
        add_tags: &[String],
        remove_tags: &[String],
    ) -> DbResult<()> {
        // Fetch current tags
        let query = format!("SELECT id, tags FROM task:{}", id);
        let mut result = self.client.query(&query).await?;
        let task: Option<TaskTagsRow> = result.take(0)?;

        let mut current_tags: Vec<String> = task.map(|t| t.tags).unwrap_or_default();

        // Remove tags
        for tag in remove_tags {
            current_tags.retain(|t| t != tag);
        }

        // Add tags (avoiding duplicates)
        for tag in add_tags {
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
        self.client.query(&update_query).await?;

        Ok(())
    }

    /// Delete a task by ID.
    ///
    /// This only deletes the task record itself. Edges (child_of, depends_on)
    /// must be cleaned up separately using RelationshipRepository.
    ///
    /// # Arguments
    ///
    /// * `id` - The task ID to delete
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete(&self, id: &str) -> DbResult<()> {
        let query = format!("DELETE task:{}", id);
        self.client.query(&query).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use crate::models::Level;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-task-repo-test-{}-{:?}-{}",
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

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_exists_returns_false_for_nonexistent() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let exists = repo.exists("nonexistent").await.unwrap();
        assert!(!exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_and_exists() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Test Task", Level::Task);
        repo.create("test1", &task).await.unwrap();

        let exists = repo.exists("test1").await.unwrap();
        assert!(exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_with_all_fields() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Full Task", Level::Epic)
            .with_status(Status::InProgress)
            .with_priority(Priority::High)
            .with_tags(["backend", "urgent"]);

        repo.create("full1", &task).await.unwrap();

        // Verify by querying directly
        #[derive(Debug, Deserialize)]
        struct TaskRow {
            title: String,
            level: String,
            status: String,
            priority: Option<String>,
            #[serde(default)]
            tags: Vec<String>,
        }

        let query = "SELECT title, level, status, priority, tags FROM task:full1";
        let mut result = db.client().query(query).await.unwrap();
        let row: Option<TaskRow> = result.take(0).unwrap();
        let row = row.unwrap();

        assert_eq!(row.title, "Full Task");
        assert_eq!(row.level, "epic");
        assert_eq!(row.status, "in_progress");
        assert_eq!(row.priority, Some("high".to_string()));
        assert!(row.tags.contains(&"backend".to_string()));
        assert!(row.tags.contains(&"urgent".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_existing_task() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Get Test", Level::Ticket)
            .with_status(Status::Todo)
            .with_priority(Priority::Medium);

        repo.create("get1", &task).await.unwrap();

        let retrieved = repo.get("get1").await.unwrap();
        assert!(retrieved.is_some());

        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.title, "Get Test");
        assert_eq!(retrieved.level, Level::Ticket);
        assert_eq!(retrieved.status, Status::Todo);
        assert_eq!(retrieved.priority, Some(Priority::Medium));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_nonexistent_task() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let retrieved = repo.get("nonexistent").await.unwrap();
        assert!(retrieved.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_status() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Status Test", Level::Task);
        repo.create("status1", &task).await.unwrap();

        // Update status
        repo.update_status("status1", Status::InProgress)
            .await
            .unwrap();

        // Verify
        let retrieved = repo.get("status1").await.unwrap().unwrap();
        assert_eq!(retrieved.status, Status::InProgress);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_timestamp() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Timestamp Test", Level::Task);
        repo.create("ts1", &task).await.unwrap();

        // Update timestamp
        repo.update_timestamp("ts1").await.unwrap();

        // Verify updated_at is set
        #[derive(Debug, Deserialize)]
        struct TimestampRow {
            updated_at: Option<surrealdb::sql::Datetime>,
        }

        let query = "SELECT updated_at FROM task:ts1";
        let mut result = db.client().query(query).await.unwrap();
        let row: Option<TimestampRow> = result.take(0).unwrap();

        assert!(row.is_some());
        assert!(row.unwrap().updated_at.is_some());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_title() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Original Title", Level::Task);
        repo.create("upd1", &task).await.unwrap();

        let updates = TaskUpdate::new().with_title("New Title");
        repo.update("upd1", &updates).await.unwrap();

        let retrieved = repo.get("upd1").await.unwrap().unwrap();
        assert_eq!(retrieved.title, "New Title");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_priority() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Priority Test", Level::Task);
        repo.create("upd2", &task).await.unwrap();

        let updates = TaskUpdate::new().with_priority(Priority::Critical);
        repo.update("upd2", &updates).await.unwrap();

        let retrieved = repo.get("upd2").await.unwrap().unwrap();
        assert_eq!(retrieved.priority, Some(Priority::Critical));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_clear_priority() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Clear Priority", Level::Task).with_priority(Priority::High);
        repo.create("upd3", &task).await.unwrap();

        let updates = TaskUpdate::new().clear_priority();
        repo.update("upd3", &updates).await.unwrap();

        let retrieved = repo.get("upd3").await.unwrap().unwrap();
        assert!(retrieved.priority.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_add_tags() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Tag Test", Level::Task).with_tag("existing");
        repo.create("upd4", &task).await.unwrap();

        let updates = TaskUpdate::new().add_tag("new1").add_tag("new2");
        repo.update("upd4", &updates).await.unwrap();

        let retrieved = repo.get("upd4").await.unwrap().unwrap();
        assert!(retrieved.tags.contains(&"existing".to_string()));
        assert!(retrieved.tags.contains(&"new1".to_string()));
        assert!(retrieved.tags.contains(&"new2".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_remove_tags() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Remove Tag Test", Level::Task).with_tags(["keep", "remove"]);
        repo.create("upd5", &task).await.unwrap();

        let updates = TaskUpdate::new().remove_tag("remove");
        repo.update("upd5", &updates).await.unwrap();

        let retrieved = repo.get("upd5").await.unwrap().unwrap();
        assert!(retrieved.tags.contains(&"keep".to_string()));
        assert!(!retrieved.tags.contains(&"remove".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_add_duplicate_tag() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Duplicate Tag Test", Level::Task).with_tag("existing");
        repo.create("upd6", &task).await.unwrap();

        let updates = TaskUpdate::new().add_tag("existing");
        repo.update("upd6", &updates).await.unwrap();

        let retrieved = repo.get("upd6").await.unwrap().unwrap();
        // Should only have one instance of the tag
        assert_eq!(retrieved.tags.len(), 1);
        assert_eq!(retrieved.tags[0], "existing");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_no_changes() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("No Change Test", Level::Task);
        repo.create("upd7", &task).await.unwrap();

        let updates = TaskUpdate::new();
        assert!(!updates.has_updates());

        // Should not error
        repo.update("upd7", &updates).await.unwrap();

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        let task = Task::new("Delete Test", Level::Task);
        repo.create("del1", &task).await.unwrap();

        assert!(repo.exists("del1").await.unwrap());

        repo.delete("del1").await.unwrap();

        assert!(!repo.exists("del1").await.unwrap());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_nonexistent() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = TaskRepository::new(db.client());

        // Should not error when deleting non-existent task
        repo.delete("nonexistent").await.unwrap();

        cleanup(&temp_dir);
    }

    #[test]
    fn test_task_update_builder() {
        let update = TaskUpdate::new()
            .with_title("New Title")
            .with_priority(Priority::High)
            .add_tag("tag1")
            .add_tag("tag2")
            .remove_tag("old");

        assert_eq!(update.title, Some("New Title".to_string()));
        assert_eq!(update.priority, Some(Some(Priority::High)));
        assert_eq!(update.add_tags, vec!["tag1", "tag2"]);
        assert_eq!(update.remove_tags, vec!["old"]);
        assert!(update.has_updates());
    }

    #[test]
    fn test_task_update_default() {
        let update = TaskUpdate::default();

        assert!(update.title.is_none());
        assert!(update.priority.is_none());
        assert!(update.add_tags.is_empty());
        assert!(update.remove_tags.is_empty());
        assert!(!update.has_updates());
    }
}
