//! Add command for creating new tasks
//!
//! Implements the `vtb add` command to create new tasks with all supported options.

use crate::id::IdGenerator;
use clap::Args;
use vertebrae_db::{DEFAULT_WORKFLOW_ID, Database, DbError, Level, Priority, Status, Task};

/// Create a new task
#[derive(Debug, Args)]
pub struct AddCommand {
    /// Title of the task
    #[arg(required = true)]
    pub title: String,

    /// Task level (epic, ticket, task)
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

    /// Mark task as needing human review before completion
    #[arg(long = "needs-review")]
    pub needs_review: bool,

    /// Workflow ID to assign task to (defaults to 'default')
    #[arg(long)]
    pub workflow: Option<String>,
}

/// Parse a level string into a Level enum
fn parse_level(s: &str) -> Result<Level, String> {
    match s.to_lowercase().as_str() {
        "epic" => Ok(Level::Epic),
        "ticket" => Ok(Level::Ticket),
        "task" => Ok(Level::Task),
        _ => Err(format!(
            "invalid level '{}'. Valid values: epic, ticket, task",
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
    /// Automatically assigns the task to a workflow (defaults to "default") to enable
    /// execution history tracking when transitioning through workflow steps.
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
    /// - Specified workflow doesn't exist
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

        // Determine which workflow to use (default to "default")
        let workflow_id = self.workflow.as_deref().unwrap_or(DEFAULT_WORKFLOW_ID);

        // Validate workflow exists before creating task
        if !self.workflow_exists(db, workflow_id).await? {
            return Err(DbError::NotFound {
                entity: "workflow".to_string(),
                id: workflow_id.to_string(),
            });
        }

        // Generate unique ID with collision detection
        let id = self.generate_unique_id(db).await?;

        // Create the task
        let level = self.level.clone().unwrap_or(Level::Task);
        let mut task = Task::new(self.title.clone(), level).with_status(Status::Backlog);

        if let Some(description) = &self.description {
            task = task.with_description(description.clone());
        }

        if let Some(priority) = &self.priority {
            task = task.with_priority(priority.clone());
        }

        if !self.tags.is_empty() {
            task = task.with_tags(self.tags.clone());
        }

        if self.needs_review {
            task = task.with_needs_human_review(true);
        }

        // Store the task in the database
        self.create_task(db, &id, &task).await?;

        // Update task with fields that create() doesn't persist (description, needs_review)
        let mut needs_update = false;
        let mut update = vertebrae_db::TaskUpdate::new();

        if self.description.is_some() {
            update = update.with_description(task.description.clone().unwrap_or_default());
            needs_update = true;
        }

        if self.needs_review {
            update = update.with_needs_human_review(true);
            needs_update = true;
        }

        if needs_update {
            db.tasks().update(&id, &update).await?;
        }

        // Create parent relationship if specified
        if let Some(parent_id) = &self.parent {
            self.create_child_of_edge(db, &id, parent_id).await?;
        }

        // Create dependency relationships
        for dep_id in &self.depends_on {
            self.create_depends_on_edge(db, &id, dep_id).await?;
        }

        // Assign the task to the validated workflow
        let workflow_thing = surrealdb::sql::Thing::from(("workflow", workflow_id));
        self.assign_workflow(db, &id, &workflow_thing).await?;

        Ok(id)
    }

    /// Check if a task with the given ID exists.
    async fn task_exists(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        db.tasks().exists(id).await
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
        db.tasks().create(id, task).await
    }

    /// Create a child_of edge between tasks.
    async fn create_child_of_edge(
        &self,
        db: &Database,
        child_id: &str,
        parent_id: &str,
    ) -> Result<(), DbError> {
        db.relationships()
            .create_child_of(child_id, parent_id)
            .await
    }

    /// Create a depends_on edge between tasks.
    async fn create_depends_on_edge(
        &self,
        db: &Database,
        task_id: &str,
        dep_id: &str,
    ) -> Result<(), DbError> {
        db.relationships().create_depends_on(task_id, dep_id).await
    }

    /// Check if a workflow with the given ID exists.
    async fn workflow_exists(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        db.workflows().exists(id).await
    }

    /// Assign a task to a workflow.
    async fn assign_workflow(
        &self,
        db: &Database,
        task_id: &str,
        workflow_id: &surrealdb::sql::Thing,
    ) -> Result<(), DbError> {
        db.tasks().assign_workflow(task_id, workflow_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Database {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        db
    }

    #[test]
    fn test_parse_level_valid() {
        assert_eq!(parse_level("epic").unwrap(), Level::Epic);
        assert_eq!(parse_level("ticket").unwrap(), Level::Ticket);
        assert_eq!(parse_level("task").unwrap(), Level::Task);
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

    /// Helper to get a task from the database
    async fn get_task(db: &Database, id: &str) -> Option<TaskRow> {
        let task = db.tasks().get(id).await.ok()??;
        Some(TaskRow {
            title: task.title,
            level: task.level.as_str().to_string(),
            status: task.status.as_str().to_string(),
            priority: task.priority.as_ref().map(|p| p.as_str().to_string()),
            tags: task.tags,
        })
    }

    /// Struct for querying task fields
    #[derive(Debug, serde::Deserialize)]
    struct TaskRow {
        title: String,
        level: String,
        status: String,
        priority: Option<String>,
        #[serde(default)]
        tags: Vec<String>,
    }

    /// Helper to check if an edge exists between two tasks
    async fn edge_exists(db: &Database, relation: &str, from_id: &str, to_id: &str) -> bool {
        match relation {
            "child_of" => {
                // Check if to_id is the parent of from_id
                db.relationships()
                    .get_parent(from_id)
                    .await
                    .ok()
                    .flatten()
                    .map(|p| p == to_id)
                    .unwrap_or(false)
            }
            "depends_on" => db
                .relationships()
                .depends_on_exists(from_id, to_id)
                .await
                .unwrap_or(false),
            _ => false,
        }
    }

    /// Helper to count edges from a task for a given relation
    async fn count_edges(db: &Database, relation: &str, from_id: &str) -> usize {
        match relation {
            "child_of" => {
                // For child_of, we count if this task has a parent (0 or 1)
                db.relationships()
                    .get_parent(from_id)
                    .await
                    .ok()
                    .flatten()
                    .map(|_| 1)
                    .unwrap_or(0)
            }
            "depends_on" => {
                // Count the number of dependencies
                db.relationships()
                    .get_dependencies(from_id)
                    .await
                    .unwrap_or_default()
                    .len()
            }
            _ => 0,
        }
    }

    #[tokio::test]
    async fn test_add_simple_task() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "My first task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");
        assert_eq!(id.len(), 6);

        // Verify task was persisted with correct fields
        let task = get_task(&db, &id).await.expect("Task should exist in DB");
        assert_eq!(task.title, "My first task");
        assert_eq!(task.level, "task"); // Default level
        assert_eq!(task.status, "backlog"); // Default status
        assert!(task.priority.is_none());
        assert!(task.tags.is_empty());
    }

    #[tokio::test]
    async fn test_add_task_with_level() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Epic task".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        // Verify level was persisted correctly
        let task = get_task(&db, &id).await.expect("Task should exist in DB");
        assert_eq!(task.title, "Epic task");
        assert_eq!(task.level, "epic");
    }

    #[tokio::test]
    async fn test_add_task_with_priority() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Urgent task".to_string(),
            level: None,
            description: None,
            priority: Some(Priority::High),
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        // Verify priority was persisted correctly
        let task = get_task(&db, &id).await.expect("Task should exist in DB");
        assert_eq!(task.title, "Urgent task");
        assert_eq!(task.priority, Some("high".to_string()));
    }

    #[tokio::test]
    async fn test_add_task_with_tags() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Tagged task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec!["backend".to_string(), "urgent".to_string()],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        // Verify tags were persisted correctly
        let task = get_task(&db, &id).await.expect("Task should exist in DB");
        assert_eq!(task.title, "Tagged task");
        assert_eq!(task.tags.len(), 2);
        assert!(task.tags.contains(&"backend".to_string()));
        assert!(task.tags.contains(&"urgent".to_string()));
    }

    #[tokio::test]
    async fn test_add_task_empty_title_fails() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("title required"),
                    "Expected 'title required' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_add_task_whitespace_title_fails() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "   ".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("title required"),
                    "Expected 'title required' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_add_task_with_nonexistent_parent_fails() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Child task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: Some("nonexistent".to_string()),
            depends_on: vec![],
            needs_review: false,
            workflow: None,
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
    async fn test_add_task_with_nonexistent_dependency_fails() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Dependent task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec!["nonexistent".to_string()],
            needs_review: false,
            workflow: None,
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
                    "Expected dependency ID 'nonexistent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_add_task_with_parent() {
        let db = setup_test_db().await;

        // First create a parent task
        let parent_cmd = AddCommand {
            title: "Parent task".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let parent_id = parent_cmd.execute(&db).await.unwrap();

        // Now create a child task
        let child_cmd = AddCommand {
            title: "Child task".to_string(),
            level: Some(Level::Ticket),
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let child_id = child_cmd.execute(&db).await.unwrap();

        // Verify child_of edge was created in the database
        assert!(
            edge_exists(&db, "child_of", &child_id, &parent_id).await,
            "child_of edge should exist from child {} to parent {}",
            child_id,
            parent_id
        );

        // Verify exactly one child_of edge from child
        assert_eq!(
            count_edges(&db, "child_of", &child_id).await,
            1,
            "child should have exactly one child_of edge"
        );
    }

    #[tokio::test]
    async fn test_add_task_with_dependency() {
        let db = setup_test_db().await;

        // First create a dependency task
        let dep_cmd = AddCommand {
            title: "Dependency task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
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
            needs_review: false,
            workflow: None,
        };

        let task_id = task_cmd.execute(&db).await.unwrap();

        // Verify depends_on edge was created in the database
        assert!(
            edge_exists(&db, "depends_on", &task_id, &dep_id).await,
            "depends_on edge should exist from task {} to dependency {}",
            task_id,
            dep_id
        );

        // Verify exactly one depends_on edge from task
        assert_eq!(
            count_edges(&db, "depends_on", &task_id).await,
            1,
            "task should have exactly one depends_on edge"
        );
    }

    #[tokio::test]
    async fn test_add_task_with_multiple_dependencies() {
        let db = setup_test_db().await;

        // Create two dependency tasks
        let dep1_cmd = AddCommand {
            title: "Dependency 1".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
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
            needs_review: false,
            workflow: None,
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
            needs_review: false,
            workflow: None,
        };

        let task_id = task_cmd.execute(&db).await.unwrap();

        // Verify both depends_on edges were created in the database
        assert!(
            edge_exists(&db, "depends_on", &task_id, &dep1_id).await,
            "depends_on edge should exist from task {} to dependency {}",
            task_id,
            dep1_id
        );
        assert!(
            edge_exists(&db, "depends_on", &task_id, &dep2_id).await,
            "depends_on edge should exist from task {} to dependency {}",
            task_id,
            dep2_id
        );

        // Verify exactly two depends_on edges from task
        assert_eq!(
            count_edges(&db, "depends_on", &task_id).await,
            2,
            "task should have exactly two depends_on edges"
        );
    }

    #[tokio::test]
    async fn test_add_task_with_all_options() {
        let db = setup_test_db().await;

        // Create a parent task
        let parent_cmd = AddCommand {
            title: "Parent".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let parent_id = parent_cmd
            .execute(&db)
            .await
            .expect("Parent should be created");

        // Create a dependency
        let dep_cmd = AddCommand {
            title: "Dependency".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let dep_id = dep_cmd
            .execute(&db)
            .await
            .expect("Dependency should be created");

        // Create task with all options
        let cmd = AddCommand {
            title: "Complete task".to_string(),
            level: Some(Level::Ticket),
            description: Some("Detailed description".to_string()),
            priority: Some(Priority::Critical),
            tags: vec!["urgent".to_string(), "backend".to_string()],
            parent: Some(parent_id.clone()),
            depends_on: vec![dep_id.clone()],
            needs_review: false,
            workflow: None,
        };

        let task_id = cmd.execute(&db).await.expect("Task should be created");
        assert_eq!(task_id.len(), 6);

        // Verify all task fields were persisted correctly
        let task = get_task(&db, &task_id)
            .await
            .expect("Task should exist in DB");
        assert_eq!(task.title, "Complete task");
        assert_eq!(task.level, "ticket");
        assert_eq!(task.status, "backlog");
        assert_eq!(task.priority, Some("critical".to_string()));
        assert_eq!(task.tags.len(), 2);
        assert!(task.tags.contains(&"urgent".to_string()));
        assert!(task.tags.contains(&"backend".to_string()));

        // Verify parent relationship was created
        assert!(
            edge_exists(&db, "child_of", &task_id, &parent_id).await,
            "child_of edge should exist"
        );

        // Verify dependency relationship was created
        assert!(
            edge_exists(&db, "depends_on", &task_id, &dep_id).await,
            "depends_on edge should exist"
        );
    }

    #[tokio::test]
    async fn test_add_task_returns_6_char_id() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "ID test".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let result = cmd.execute(&db).await.unwrap();
        assert_eq!(result.len(), 6);
        assert!(result.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn test_task_exists_returns_false_for_nonexistent() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Test".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let exists = cmd.task_exists(&db, "xxxxxx").await.unwrap();
        assert!(!exists);
    }

    #[tokio::test]
    async fn test_task_exists_returns_true_for_existing() {
        let db = setup_test_db().await;

        // Create a task
        let cmd = AddCommand {
            title: "Existing task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let id = cmd.execute(&db).await.unwrap();

        // Check it exists
        let exists = cmd.task_exists(&db, &id).await.unwrap();
        assert!(exists);
    }

    #[tokio::test]
    async fn test_default_level_is_task() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Default level".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let id = cmd.execute(&db).await.unwrap();

        // Verify level is task by default
        let task = get_task(&db, &id).await.expect("Task should exist");
        assert_eq!(task.level, "task");
    }

    #[tokio::test]
    async fn test_default_status_is_backlog() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Default status".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let id = cmd.execute(&db).await.unwrap();

        // Verify status is backlog by default
        let task = get_task(&db, &id).await.expect("Task should exist");
        assert_eq!(task.status, "backlog");
    }

    #[tokio::test]
    async fn test_unique_ids_for_multiple_tasks() {
        let db = setup_test_db().await;

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
                needs_review: false,
                workflow: None,
            };

            let id = cmd.execute(&db).await.unwrap();
            assert!(ids.insert(id), "Duplicate ID generated");
        }
    }

    #[tokio::test]
    async fn test_add_task_with_needs_review() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Task needing review".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: true,
            workflow: None,
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        // Verify needs_human_review was persisted correctly
        let task = db
            .tasks()
            .get(&id)
            .await
            .expect("DB error")
            .expect("Task should exist");
        assert!(
            task.needs_human_review.unwrap_or(false),
            "needs_human_review should be true"
        );
    }

    #[tokio::test]
    async fn test_add_task_default_needs_review_is_false() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Task without review flag".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        // Verify needs_human_review defaults to false
        let task = db
            .tasks()
            .get(&id)
            .await
            .expect("DB error")
            .expect("Task should exist");
        assert!(
            !task.needs_human_review.unwrap_or(false),
            "needs_human_review should be false by default"
        );
    }

    #[tokio::test]
    async fn test_add_task_assigns_default_workflow() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Task with default workflow".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None, // Should default to "default" workflow
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        // Verify task was assigned to default workflow with current_step = 0
        let task = db
            .tasks()
            .get(&id)
            .await
            .expect("DB error")
            .expect("Task should exist");
        assert!(
            task.workflow_id.is_some(),
            "Task should have workflow_id assigned"
        );
        let workflow_id = task.workflow_id.unwrap();
        assert_eq!(
            workflow_id.id.to_raw(),
            "default",
            "Task should be assigned to 'default' workflow"
        );
        assert_eq!(
            task.current_step,
            Some(0),
            "Task should have current_step = 0"
        );
    }

    #[tokio::test]
    async fn test_add_task_with_custom_workflow() {
        let db = setup_test_db().await;

        // Create a custom workflow
        use vertebrae_db::{AgentConfig, Workflow, WorkflowStep};
        let custom_workflow = Workflow::new("Custom Workflow")
            .with_step(WorkflowStep::new(
                "start",
                AgentConfig::new().with_model("test"),
                0,
            ))
            .with_step(WorkflowStep::new(
                "end",
                AgentConfig::new().with_model("test"),
                1,
            ));
        db.workflows()
            .create("custom", &custom_workflow)
            .await
            .expect("Should create custom workflow");

        let cmd = AddCommand {
            title: "Task with custom workflow".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: Some("custom".to_string()),
        };

        let id = cmd.execute(&db).await.expect("Add should succeed");

        // Verify task was assigned to custom workflow
        let task = db
            .tasks()
            .get(&id)
            .await
            .expect("DB error")
            .expect("Task should exist");
        assert!(
            task.workflow_id.is_some(),
            "Task should have workflow_id assigned"
        );
        let workflow_id = task.workflow_id.unwrap();
        assert_eq!(
            workflow_id.id.to_raw(),
            "custom",
            "Task should be assigned to 'custom' workflow"
        );
        assert_eq!(
            task.current_step,
            Some(0),
            "Task should have current_step = 0"
        );
    }

    #[tokio::test]
    async fn test_add_task_with_nonexistent_workflow_fails() {
        let db = setup_test_db().await;

        let cmd = AddCommand {
            title: "Task with nonexistent workflow".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: Some("nonexistent".to_string()),
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "workflow", "Expected workflow entity in error");
                assert_eq!(id, "nonexistent", "Expected workflow ID in error");
            }
            Err(other) => panic!("Expected NotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }
}
