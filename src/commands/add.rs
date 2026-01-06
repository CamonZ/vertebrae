//! Add command for creating new tasks
//!
//! Implements the `vtb add` command to create new tasks with all supported options.

use crate::db::{Database, DbError, Level, Priority, Status, Task};
use crate::id::IdGenerator;
use clap::Args;

/// Create a new task
#[derive(Debug, Args)]
pub struct AddCommand {
    /// Title of the task
    #[arg(required = true)]
    pub title: String,

    /// Task level (epic, ticket, task, subtask)
    #[arg(short, long, value_parser = parse_level)]
    pub level: Option<Level>,

    /// Detailed description
    #[arg(short, long)]
    pub description: Option<String>,

    /// Priority (low, medium, high, critical)
    #[arg(short, long, value_parser = parse_priority)]
    pub priority: Option<Priority>,

    /// Tags (can be specified multiple times)
    #[arg(short, long = "tag")]
    pub tags: Vec<String>,

    /// Parent task ID (creates child_of relationship)
    #[arg(long)]
    pub parent: Option<String>,

    /// Dependency task ID (can be specified multiple times)
    #[arg(long = "depends-on")]
    pub depends_on: Vec<String>,
}

/// Parse a level string into a Level enum
fn parse_level(s: &str) -> Result<Level, String> {
    match s.to_lowercase().as_str() {
        "epic" => Ok(Level::Epic),
        "ticket" => Ok(Level::Ticket),
        "task" => Ok(Level::Task),
        "subtask" => Ok(Level::Subtask),
        _ => Err(format!(
            "invalid level '{}'. Valid values: epic, ticket, task, subtask",
            s
        )),
    }
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

impl AddCommand {
    /// Execute the add command.
    ///
    /// Creates a new task with the specified options and stores it in the database.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The title is empty
    /// - Parent task doesn't exist
    /// - Dependency tasks don't exist
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Validate title is not empty
        if self.title.trim().is_empty() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from("title"),
                reason: "title required".to_string(),
            });
        }

        // Validate parent exists if specified
        if let Some(parent_id) = &self.parent
            && !self.task_exists(db, parent_id).await?
        {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(parent_id),
                reason: format!("parent task '{}' does not exist", parent_id),
            });
        }

        // Validate dependencies exist
        for dep_id in &self.depends_on {
            if !self.task_exists(db, dep_id).await? {
                return Err(DbError::InvalidPath {
                    path: std::path::PathBuf::from(dep_id),
                    reason: format!("dependency task '{}' does not exist", dep_id),
                });
            }
        }

        // Generate unique ID with collision detection
        let id = self.generate_unique_id(db).await?;

        // Create the task
        let level = self.level.clone().unwrap_or(Level::Task);
        let mut task = Task::new(self.title.clone(), level).with_status(Status::Todo);

        if let Some(priority) = &self.priority {
            task = task.with_priority(priority.clone());
        }

        if !self.tags.is_empty() {
            task = task.with_tags(self.tags.clone());
        }

        // Store the task in the database
        self.create_task(db, &id, &task).await?;

        // Create parent relationship if specified
        if let Some(parent_id) = &self.parent {
            self.create_child_of_edge(db, &id, parent_id).await?;
        }

        // Create dependency relationships
        for dep_id in &self.depends_on {
            self.create_depends_on_edge(db, &id, dep_id).await?;
        }

        Ok(id)
    }

    /// Check if a task with the given ID exists.
    async fn task_exists(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        // Use a simple struct to avoid deserializing full Task
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

    /// Generate a unique ID that doesn't collide with existing tasks.
    async fn generate_unique_id(&self, db: &Database) -> Result<String, DbError> {
        let mut generator = IdGenerator::new(&self.title);

        while let Some(id) = generator.next_id() {
            if !self.task_exists(db, &id).await? {
                return Ok(id);
            }
        }

        Err(DbError::InvalidPath {
            path: std::path::PathBuf::from("id"),
            reason: "failed to generate unique ID after maximum retries".to_string(),
        })
    }

    /// Create a task in the database.
    async fn create_task(&self, db: &Database, id: &str, task: &Task) -> Result<(), DbError> {
        // Build the query with proper escaping
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

        // Clone title to avoid lifetime issues with async query
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

        db.client().query(&query).bind(("title", title)).await?;

        Ok(())
    }

    /// Create a child_of edge between tasks.
    async fn create_child_of_edge(
        &self,
        db: &Database,
        child_id: &str,
        parent_id: &str,
    ) -> Result<(), DbError> {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await?;
        Ok(())
    }

    /// Create a depends_on edge between tasks.
    async fn create_depends_on_edge(
        &self,
        db: &Database,
        task_id: &str,
        dep_id: &str,
    ) -> Result<(), DbError> {
        let query = format!("RELATE task:{} -> depends_on -> task:{}", task_id, dep_id);
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
            "vtb-add-test-{}-{:?}-{}",
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

    #[test]
    fn test_parse_level_valid() {
        assert_eq!(parse_level("epic").unwrap(), Level::Epic);
        assert_eq!(parse_level("ticket").unwrap(), Level::Ticket);
        assert_eq!(parse_level("task").unwrap(), Level::Task);
        assert_eq!(parse_level("subtask").unwrap(), Level::Subtask);
    }

    #[test]
    fn test_parse_level_case_insensitive() {
        assert_eq!(parse_level("EPIC").unwrap(), Level::Epic);
        assert_eq!(parse_level("Epic").unwrap(), Level::Epic);
        assert_eq!(parse_level("TICKET").unwrap(), Level::Ticket);
    }

    #[test]
    fn test_parse_level_invalid() {
        let result = parse_level("invalid");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid level"));
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

    #[tokio::test]
    async fn test_add_simple_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "My first task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Add failed: {:?}", result.err());

        let id = result.unwrap();
        assert_eq!(id.len(), 6);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_level() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "Epic task".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_priority() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "Urgent task".to_string(),
            level: None,
            description: None,
            priority: Some(Priority::High),
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_tags() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "Tagged task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec!["backend".to_string(), "urgent".to_string()],
            parent: None,
            depends_on: vec![],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_empty_title_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("title required"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_whitespace_title_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "   ".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_nonexistent_parent_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "Child task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: Some("nonexistent".to_string()),
            depends_on: vec![],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("does not exist"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_nonexistent_dependency_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "Dependent task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec!["nonexistent".to_string()],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("does not exist"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_parent() {
        let (db, temp_dir) = setup_test_db().await;

        // First create a parent task
        let parent_cmd = AddCommand {
            title: "Parent task".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let parent_id = parent_cmd.execute(&db).await.unwrap();

        // Now create a child task
        let child_cmd = AddCommand {
            title: "Child task".to_string(),
            level: Some(Level::Subtask),
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
        };

        let result = child_cmd.execute(&db).await;
        assert!(result.is_ok(), "Child creation failed: {:?}", result.err());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_dependency() {
        let (db, temp_dir) = setup_test_db().await;

        // First create a dependency task
        let dep_cmd = AddCommand {
            title: "Dependency task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let dep_id = dep_cmd.execute(&db).await.unwrap();

        // Now create a dependent task
        let task_cmd = AddCommand {
            title: "Dependent task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![dep_id.clone()],
        };

        let result = task_cmd.execute(&db).await;
        assert!(
            result.is_ok(),
            "Dependent creation failed: {:?}",
            result.err()
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_multiple_dependencies() {
        let (db, temp_dir) = setup_test_db().await;

        // Create two dependency tasks
        let dep1_cmd = AddCommand {
            title: "Dependency 1".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };
        let dep1_id = dep1_cmd.execute(&db).await.unwrap();

        let dep2_cmd = AddCommand {
            title: "Dependency 2".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };
        let dep2_id = dep2_cmd.execute(&db).await.unwrap();

        // Now create a task depending on both
        let task_cmd = AddCommand {
            title: "Multi-dependency task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![dep1_id.clone(), dep2_id.clone()],
        };

        let result = task_cmd.execute(&db).await;
        assert!(result.is_ok());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_with_all_options() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a parent task
        let parent_cmd = AddCommand {
            title: "Parent".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };
        let parent_id = parent_cmd.execute(&db).await.unwrap();

        // Create a dependency
        let dep_cmd = AddCommand {
            title: "Dependency".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };
        let dep_id = dep_cmd.execute(&db).await.unwrap();

        // Create task with all options
        let cmd = AddCommand {
            title: "Complete task".to_string(),
            level: Some(Level::Ticket),
            description: Some("Detailed description".to_string()),
            priority: Some(Priority::Critical),
            tags: vec!["urgent".to_string(), "backend".to_string()],
            parent: Some(parent_id),
            depends_on: vec![dep_id],
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 6);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_add_task_returns_6_char_id() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "ID test".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let result = cmd.execute(&db).await.unwrap();
        assert_eq!(result.len(), 6);
        assert!(result.chars().all(|c| c.is_ascii_hexdigit()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_exists_returns_false_for_nonexistent() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "Test".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let exists = cmd.task_exists(&db, "xxxxxx").await.unwrap();
        assert!(!exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_exists_returns_true_for_existing() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a task
        let cmd = AddCommand {
            title: "Existing task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let id = cmd.execute(&db).await.unwrap();

        // Check it exists
        let exists = cmd.task_exists(&db, &id).await.unwrap();
        assert!(exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_default_level_is_task() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "Default level".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let id = cmd.execute(&db).await.unwrap();

        // Query the task to verify level
        let mut result = db
            .client()
            .query(format!("SELECT level FROM task:{}", id))
            .await
            .unwrap();

        #[derive(Debug, serde::Deserialize)]
        struct LevelRow {
            level: String,
        }

        let row: Option<LevelRow> = result.take(0).unwrap();
        assert_eq!(row.unwrap().level, "task");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_default_status_is_todo() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = AddCommand {
            title: "Default status".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
        };

        let id = cmd.execute(&db).await.unwrap();

        // Query the task to verify status
        let mut result = db
            .client()
            .query(format!("SELECT status FROM task:{}", id))
            .await
            .unwrap();

        #[derive(Debug, serde::Deserialize)]
        struct StatusRow {
            status: String,
        }

        let row: Option<StatusRow> = result.take(0).unwrap();
        assert_eq!(row.unwrap().status, "todo");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_unique_ids_for_multiple_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        let mut ids = std::collections::HashSet::new();

        for i in 0..10 {
            let cmd = AddCommand {
                title: format!("Task {}", i),
                level: None,
                description: None,
                priority: None,
                tags: vec![],
                parent: None,
                depends_on: vec![],
            };

            let id = cmd.execute(&db).await.unwrap();
            assert!(ids.insert(id), "Duplicate ID generated");
        }

        cleanup(&temp_dir);
    }
}
