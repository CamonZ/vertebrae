//! Relationship repository for managing task relationships
//!
//! Provides a repository pattern implementation for graph edge operations,
//! encapsulating SurrealDB RELATE queries for child_of and depends_on edges.

use crate::error::DbResult;
use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;

/// Repository for task relationship (edge) operations
///
/// Manages the two relationship types in Vertebrae:
/// - `child_of`: Parent-child hierarchy (child -> parent)
/// - `depends_on`: Task dependencies (dependent -> dependency/blocker)
pub struct RelationshipRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Minimal row for checking edge existence
#[derive(Debug, Deserialize)]
struct EdgeRow {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
}

/// Row for fetching task IDs from edge queries
#[derive(Debug, Deserialize)]
struct TaskIdRow {
    id: surrealdb::sql::Thing,
}

impl<'a> RelationshipRepository<'a> {
    /// Create a new RelationshipRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    // ========================================
    // child_of relationship methods
    // ========================================

    /// Create a child_of relationship between two tasks.
    ///
    /// The edge direction is: child -> child_of -> parent
    ///
    /// # Arguments
    ///
    /// * `child_id` - The ID of the child task
    /// * `parent_id` - The ID of the parent task
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create_child_of(&self, child_id: &str, parent_id: &str) -> DbResult<()> {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        self.client.query(&query).await?;
        Ok(())
    }

    /// Remove the child_of relationship for a task.
    ///
    /// # Arguments
    ///
    /// * `child_id` - The ID of the child task
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn remove_child_of(&self, child_id: &str) -> DbResult<()> {
        let query = format!("DELETE child_of WHERE in = task:{}", child_id);
        self.client.query(&query).await?;
        Ok(())
    }

    /// Get the parent of a task.
    ///
    /// # Arguments
    ///
    /// * `child_id` - The ID of the child task
    ///
    /// # Returns
    ///
    /// `Some(parent_id)` if the task has a parent, `None` otherwise.
    pub async fn get_parent(&self, child_id: &str) -> DbResult<Option<String>> {
        // child_of edge goes: child -> child_of -> parent
        // So we query the out direction from the child
        let query = format!("SELECT VALUE out FROM task:{}->child_of", child_id);
        let mut result = self.client.query(&query).await?;
        let parents: Vec<surrealdb::sql::Thing> = result.take(0)?;

        Ok(parents.first().map(|thing| thing.id.to_string()))
    }

    /// Get all children of a task.
    ///
    /// # Arguments
    ///
    /// * `parent_id` - The ID of the parent task
    ///
    /// # Returns
    ///
    /// A vector of child task IDs.
    pub async fn get_children(&self, parent_id: &str) -> DbResult<Vec<String>> {
        // child_of edge goes: child -> child_of -> parent
        // To find children, we query tasks that have a child_of edge pointing to this parent
        let query = format!(
            "SELECT id FROM task WHERE ->child_of->task CONTAINS task:{}",
            parent_id
        );
        let mut result = self.client.query(&query).await?;
        let rows: Vec<TaskIdRow> = result.take(0)?;

        Ok(rows.into_iter().map(|r| r.id.id.to_string()).collect())
    }

    /// Remove all child_of edges pointing to a parent task.
    ///
    /// This orphans all children of the given parent, making them root tasks.
    ///
    /// # Arguments
    ///
    /// * `parent_id` - The ID of the parent task
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn orphan_children(&self, parent_id: &str) -> DbResult<()> {
        let query = format!("DELETE child_of WHERE out = task:{}", parent_id);
        self.client.query(&query).await?;
        Ok(())
    }

    // ========================================
    // depends_on relationship methods
    // ========================================

    /// Create a depends_on relationship between two tasks.
    ///
    /// The edge direction is: dependent -> depends_on -> blocker
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task that depends on another
    /// * `depends_on_id` - The ID of the task being depended on (the blocker)
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create_depends_on(&self, task_id: &str, depends_on_id: &str) -> DbResult<()> {
        let query = format!(
            "RELATE task:{} -> depends_on -> task:{}",
            task_id, depends_on_id
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Remove a specific depends_on relationship between two tasks.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task that depends on another
    /// * `depends_on_id` - The ID of the task being depended on
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn remove_depends_on(&self, task_id: &str, depends_on_id: &str) -> DbResult<()> {
        let query = format!(
            "DELETE depends_on WHERE in = task:{} AND out = task:{}",
            task_id, depends_on_id
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Check if a depends_on relationship exists between two tasks.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task that might depend on another
    /// * `depends_on_id` - The ID of the task that might be depended on
    ///
    /// # Returns
    ///
    /// `true` if the dependency exists, `false` otherwise.
    pub async fn depends_on_exists(&self, task_id: &str, depends_on_id: &str) -> DbResult<bool> {
        let query = format!(
            "SELECT id FROM depends_on WHERE in = task:{} AND out = task:{}",
            task_id, depends_on_id
        );
        let mut result = self.client.query(&query).await?;
        let edges: Vec<EdgeRow> = result.take(0)?;
        Ok(!edges.is_empty())
    }

    /// Get all tasks that a task depends on (its blockers/dependencies).
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task
    ///
    /// # Returns
    ///
    /// A vector of task IDs that this task depends on.
    pub async fn get_dependencies(&self, task_id: &str) -> DbResult<Vec<String>> {
        // depends_on edge goes: dependent -> depends_on -> blocker
        // So we query the out direction from the dependent
        let query = format!("SELECT VALUE out FROM task:{}->depends_on", task_id);
        let mut result = self.client.query(&query).await?;
        let deps: Vec<surrealdb::sql::Thing> = result.take(0)?;

        Ok(deps.into_iter().map(|thing| thing.id.to_string()).collect())
    }

    /// Get all tasks that depend on a task (its dependents).
    ///
    /// This is the reverse lookup - finding who is blocked by this task.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task (blocker)
    ///
    /// # Returns
    ///
    /// A vector of task IDs that depend on this task.
    pub async fn get_dependents(&self, task_id: &str) -> DbResult<Vec<String>> {
        // depends_on edge goes: dependent -> depends_on -> blocker
        // To find dependents, we query tasks that have a depends_on edge pointing to this blocker
        let query = format!(
            "SELECT id FROM task WHERE ->depends_on->task CONTAINS task:{}",
            task_id
        );
        let mut result = self.client.query(&query).await?;
        let rows: Vec<TaskIdRow> = result.take(0)?;

        Ok(rows.into_iter().map(|r| r.id.id.to_string()).collect())
    }

    /// Remove all depends_on edges from a task (where task is the dependent).
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn remove_all_dependencies(&self, task_id: &str) -> DbResult<()> {
        let query = format!("DELETE depends_on WHERE in = task:{}", task_id);
        self.client.query(&query).await?;
        Ok(())
    }

    /// Remove all depends_on edges to a task (where task is the blocker).
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn remove_all_dependents(&self, task_id: &str) -> DbResult<()> {
        let query = format!("DELETE depends_on WHERE out = task:{}", task_id);
        self.client.query(&query).await?;
        Ok(())
    }

    // ========================================
    // Export methods
    // ========================================

    /// Export all child_of relationships.
    ///
    /// Returns a vector of (child_id, parent_id) tuples.
    ///
    /// # Returns
    ///
    /// All child_of relationships in the database.
    pub async fn export_all_child_of(&self) -> DbResult<Vec<(String, String)>> {
        #[derive(Debug, Deserialize)]
        struct Relation {
            r#in: surrealdb::sql::Thing,
            out: surrealdb::sql::Thing,
        }

        let mut result = self.client.query("SELECT in, out FROM child_of").await?;
        let relations: Vec<Relation> = result.take(0)?;

        // child_of: child -> parent (in is child, out is parent)
        Ok(relations
            .into_iter()
            .map(|r| (r.r#in.id.to_raw(), r.out.id.to_raw()))
            .collect())
    }

    /// Export all depends_on relationships.
    ///
    /// Returns a vector of (task_id, blocker_id) tuples.
    ///
    /// # Returns
    ///
    /// All depends_on relationships in the database.
    pub async fn export_all_depends_on(&self) -> DbResult<Vec<(String, String)>> {
        #[derive(Debug, Deserialize)]
        struct Relation {
            r#in: surrealdb::sql::Thing,
            out: surrealdb::sql::Thing,
        }

        let mut result = self.client.query("SELECT in, out FROM depends_on").await?;
        let relations: Vec<Relation> = result.take(0)?;

        // depends_on: task -> blocker (in is task, out is blocker)
        Ok(relations
            .into_iter()
            .map(|r| (r.r#in.id.to_raw(), r.out.id.to_raw()))
            .collect())
    }

    // ========================================
    // Cleanup methods
    // ========================================

    /// Remove all relationships connected to a task.
    ///
    /// This removes:
    /// - child_of edge where task is the child
    /// - child_of edges where task is the parent (orphaning children)
    /// - depends_on edges where task is the dependent
    /// - depends_on edges where task is the blocker
    ///
    /// # Arguments
    ///
    /// * `task_id` - The ID of the task
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if any database operation fails.
    pub async fn remove_all_relationships(&self, task_id: &str) -> DbResult<()> {
        // Remove child_of where this task is the child
        let query = format!("DELETE child_of WHERE in = task:{}", task_id);
        self.client.query(&query).await?;

        // Remove child_of where this task is the parent (orphan children)
        let query = format!("DELETE child_of WHERE out = task:{}", task_id);
        self.client.query(&query).await?;

        // Remove depends_on where this task is the dependent
        let query = format!("DELETE depends_on WHERE in = task:{}", task_id);
        self.client.query(&query).await?;

        // Remove depends_on where this task is the blocker
        let query = format!("DELETE depends_on WHERE out = task:{}", task_id);
        self.client.query(&query).await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-rel-repo-test-{}-{:?}-{}",
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

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    // ========================================
    // child_of tests
    // ========================================

    #[tokio::test]
    async fn test_create_and_get_parent() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "parent1", "Parent Task").await;
        create_task(&db, "child1", "Child Task").await;

        // Create relationship
        repo.create_child_of("child1", "parent1").await.unwrap();

        // Verify parent
        let parent = repo.get_parent("child1").await.unwrap();
        assert_eq!(parent, Some("parent1".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_parent_no_parent() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "orphan", "Orphan Task").await;

        let parent = repo.get_parent("orphan").await.unwrap();
        assert!(parent.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_children() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "parent1", "Parent Task").await;
        create_task(&db, "child1", "Child 1").await;
        create_task(&db, "child2", "Child 2").await;

        repo.create_child_of("child1", "parent1").await.unwrap();
        repo.create_child_of("child2", "parent1").await.unwrap();

        let children = repo.get_children("parent1").await.unwrap();
        assert_eq!(children.len(), 2);
        assert!(children.contains(&"child1".to_string()));
        assert!(children.contains(&"child2".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_children_no_children() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "lonely", "Lonely Task").await;

        let children = repo.get_children("lonely").await.unwrap();
        assert!(children.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_child_of() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "parent1", "Parent Task").await;
        create_task(&db, "child1", "Child Task").await;

        repo.create_child_of("child1", "parent1").await.unwrap();

        // Verify relationship exists
        let parent = repo.get_parent("child1").await.unwrap();
        assert!(parent.is_some());

        // Remove relationship
        repo.remove_child_of("child1").await.unwrap();

        // Verify relationship is gone
        let parent = repo.get_parent("child1").await.unwrap();
        assert!(parent.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_orphan_children() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "parent1", "Parent Task").await;
        create_task(&db, "child1", "Child 1").await;
        create_task(&db, "child2", "Child 2").await;

        repo.create_child_of("child1", "parent1").await.unwrap();
        repo.create_child_of("child2", "parent1").await.unwrap();

        // Orphan all children
        repo.orphan_children("parent1").await.unwrap();

        // Verify children have no parent
        let parent1 = repo.get_parent("child1").await.unwrap();
        let parent2 = repo.get_parent("child2").await.unwrap();
        assert!(parent1.is_none());
        assert!(parent2.is_none());

        // Verify parent has no children
        let children = repo.get_children("parent1").await.unwrap();
        assert!(children.is_empty());

        cleanup(&temp_dir);
    }

    // ========================================
    // depends_on tests
    // ========================================

    #[tokio::test]
    async fn test_create_and_check_depends_on() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "blocker", "Blocker Task").await;
        create_task(&db, "dependent", "Dependent Task").await;

        // Create dependency
        repo.create_depends_on("dependent", "blocker")
            .await
            .unwrap();

        // Verify dependency exists
        let exists = repo
            .depends_on_exists("dependent", "blocker")
            .await
            .unwrap();
        assert!(exists);

        // Verify reverse does not exist
        let reverse = repo
            .depends_on_exists("blocker", "dependent")
            .await
            .unwrap();
        assert!(!reverse);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_depends_on_exists_no_dependency() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "task1", "Task 1").await;
        create_task(&db, "task2", "Task 2").await;

        let exists = repo.depends_on_exists("task1", "task2").await.unwrap();
        assert!(!exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_dependencies() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "blocker1", "Blocker 1").await;
        create_task(&db, "blocker2", "Blocker 2").await;
        create_task(&db, "dependent", "Dependent Task").await;

        repo.create_depends_on("dependent", "blocker1")
            .await
            .unwrap();
        repo.create_depends_on("dependent", "blocker2")
            .await
            .unwrap();

        let deps = repo.get_dependencies("dependent").await.unwrap();
        assert_eq!(deps.len(), 2);
        assert!(deps.contains(&"blocker1".to_string()));
        assert!(deps.contains(&"blocker2".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_dependencies_none() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "independent", "Independent Task").await;

        let deps = repo.get_dependencies("independent").await.unwrap();
        assert!(deps.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_dependents() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "blocker", "Blocker Task").await;
        create_task(&db, "dep1", "Dependent 1").await;
        create_task(&db, "dep2", "Dependent 2").await;

        repo.create_depends_on("dep1", "blocker").await.unwrap();
        repo.create_depends_on("dep2", "blocker").await.unwrap();

        let dependents = repo.get_dependents("blocker").await.unwrap();
        assert_eq!(dependents.len(), 2);
        assert!(dependents.contains(&"dep1".to_string()));
        assert!(dependents.contains(&"dep2".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_dependents_none() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "noblockers", "No Blockers Task").await;

        let dependents = repo.get_dependents("noblockers").await.unwrap();
        assert!(dependents.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_depends_on() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "blocker", "Blocker Task").await;
        create_task(&db, "dependent", "Dependent Task").await;

        repo.create_depends_on("dependent", "blocker")
            .await
            .unwrap();

        // Verify exists
        let exists = repo
            .depends_on_exists("dependent", "blocker")
            .await
            .unwrap();
        assert!(exists);

        // Remove
        repo.remove_depends_on("dependent", "blocker")
            .await
            .unwrap();

        // Verify gone
        let exists = repo
            .depends_on_exists("dependent", "blocker")
            .await
            .unwrap();
        assert!(!exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_depends_on_specific() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "blocker1", "Blocker 1").await;
        create_task(&db, "blocker2", "Blocker 2").await;
        create_task(&db, "dependent", "Dependent Task").await;

        repo.create_depends_on("dependent", "blocker1")
            .await
            .unwrap();
        repo.create_depends_on("dependent", "blocker2")
            .await
            .unwrap();

        // Remove only one dependency
        repo.remove_depends_on("dependent", "blocker1")
            .await
            .unwrap();

        // Verify one is gone, one remains
        let exists1 = repo
            .depends_on_exists("dependent", "blocker1")
            .await
            .unwrap();
        let exists2 = repo
            .depends_on_exists("dependent", "blocker2")
            .await
            .unwrap();
        assert!(!exists1);
        assert!(exists2);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_all_dependencies() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "blocker1", "Blocker 1").await;
        create_task(&db, "blocker2", "Blocker 2").await;
        create_task(&db, "dependent", "Dependent Task").await;

        repo.create_depends_on("dependent", "blocker1")
            .await
            .unwrap();
        repo.create_depends_on("dependent", "blocker2")
            .await
            .unwrap();

        // Remove all dependencies
        repo.remove_all_dependencies("dependent").await.unwrap();

        // Verify all gone
        let deps = repo.get_dependencies("dependent").await.unwrap();
        assert!(deps.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_all_dependents() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "blocker", "Blocker Task").await;
        create_task(&db, "dep1", "Dependent 1").await;
        create_task(&db, "dep2", "Dependent 2").await;

        repo.create_depends_on("dep1", "blocker").await.unwrap();
        repo.create_depends_on("dep2", "blocker").await.unwrap();

        // Remove all dependents
        repo.remove_all_dependents("blocker").await.unwrap();

        // Verify all dependents removed
        let dependents = repo.get_dependents("blocker").await.unwrap();
        assert!(dependents.is_empty());

        cleanup(&temp_dir);
    }

    // ========================================
    // remove_all_relationships tests
    // ========================================

    #[tokio::test]
    async fn test_remove_all_relationships() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        // Create a complex relationship structure
        create_task(&db, "parent", "Parent").await;
        create_task(&db, "target", "Target Task").await;
        create_task(&db, "child", "Child").await;
        create_task(&db, "blocker", "Blocker").await;
        create_task(&db, "dependent", "Dependent").await;

        // target is child of parent
        repo.create_child_of("target", "parent").await.unwrap();
        // child is child of target
        repo.create_child_of("child", "target").await.unwrap();
        // target depends on blocker
        repo.create_depends_on("target", "blocker").await.unwrap();
        // dependent depends on target
        repo.create_depends_on("dependent", "target").await.unwrap();

        // Verify setup
        assert_eq!(
            repo.get_parent("target").await.unwrap(),
            Some("parent".to_string())
        );
        assert!(
            repo.get_children("target")
                .await
                .unwrap()
                .contains(&"child".to_string())
        );
        assert!(
            repo.get_dependencies("target")
                .await
                .unwrap()
                .contains(&"blocker".to_string())
        );
        assert!(
            repo.get_dependents("target")
                .await
                .unwrap()
                .contains(&"dependent".to_string())
        );

        // Remove all relationships for target
        repo.remove_all_relationships("target").await.unwrap();

        // Verify all relationships are gone
        assert!(repo.get_parent("target").await.unwrap().is_none());
        assert!(repo.get_children("target").await.unwrap().is_empty());
        assert!(repo.get_dependencies("target").await.unwrap().is_empty());
        assert!(repo.get_dependents("target").await.unwrap().is_empty());

        // Child should now be orphaned
        assert!(repo.get_parent("child").await.unwrap().is_none());

        // Dependent should have lost its dependency
        assert!(!repo.depends_on_exists("dependent", "target").await.unwrap());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_all_relationships_no_relationships() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "lonely", "Lonely Task").await;

        // Should not error even if no relationships exist
        repo.remove_all_relationships("lonely").await.unwrap();

        cleanup(&temp_dir);
    }

    // ========================================
    // Edge case tests
    // ========================================

    #[tokio::test]
    async fn test_create_duplicate_child_of() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "parent", "Parent").await;
        create_task(&db, "child", "Child").await;

        repo.create_child_of("child", "parent").await.unwrap();
        // Creating again should not error (SurrealDB allows duplicate edges)
        repo.create_child_of("child", "parent").await.unwrap();

        // Parent should still be correct
        let parent = repo.get_parent("child").await.unwrap();
        assert_eq!(parent, Some("parent".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_duplicate_depends_on() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "blocker", "Blocker").await;
        create_task(&db, "dependent", "Dependent").await;

        repo.create_depends_on("dependent", "blocker")
            .await
            .unwrap();
        // Creating again should not error
        repo.create_depends_on("dependent", "blocker")
            .await
            .unwrap();

        // Dependency should still exist
        let exists = repo
            .depends_on_exists("dependent", "blocker")
            .await
            .unwrap();
        assert!(exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_child_of() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "task", "Task").await;

        // Should not error when removing non-existent relationship
        repo.remove_child_of("task").await.unwrap();

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_depends_on() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = RelationshipRepository::new(db.client());

        create_task(&db, "task1", "Task 1").await;
        create_task(&db, "task2", "Task 2").await;

        // Should not error when removing non-existent relationship
        repo.remove_depends_on("task1", "task2").await.unwrap();

        cleanup(&temp_dir);
    }
}
