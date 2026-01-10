//! Workflow repository for CRUD operations on workflows
//!
//! Provides a repository pattern implementation for workflow operations,
//! encapsulating SurrealDB queries and providing a clean API.

use crate::error::{DbError, DbResult};
use crate::models::{Workflow, WorkflowStep};

/// The ID of the default workflow that matches the standard status flow.
///
/// This workflow is automatically created during database initialization
/// and provides backwards compatibility for tasks without explicit workflow assignment.
pub const DEFAULT_WORKFLOW_ID: &str = "default";
use serde::Deserialize;
use serde_json;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;
use tracing::{debug, trace};

/// Repository for workflow CRUD operations
///
/// Encapsulates database queries for workflows, providing a clean API
/// that hides the underlying SurrealDB implementation details.
pub struct WorkflowRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Update structure for partial workflow updates
#[derive(Debug, Default)]
pub struct WorkflowUpdate {
    /// New name (if Some)
    pub name: Option<String>,
    /// New description (if Some, None clears it, absent leaves unchanged)
    pub description: Option<Option<String>>,
    /// Steps to set (replaces entire steps array)
    pub steps: Option<Vec<WorkflowStep>>,
    /// Metadata to set (replaces entire metadata object)
    pub metadata: Option<std::collections::HashMap<String, String>>,
    /// Workflow to chain to when done (Some(Some(id)) to set, Some(None) to clear, None to leave unchanged)
    pub on_done_workflow: Option<Option<String>>,
    /// Workflow to chain to when rejected (Some(Some(id)) to set, Some(None) to clear, None to leave unchanged)
    pub on_reject_workflow: Option<Option<String>>,
}

impl WorkflowUpdate {
    /// Create a new empty update
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a new name
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Set a new description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(Some(description.into()));
        self
    }

    /// Clear the description
    pub fn clear_description(mut self) -> Self {
        self.description = Some(None);
        self
    }

    /// Set steps
    pub fn with_steps(mut self, steps: Vec<WorkflowStep>) -> Self {
        self.steps = Some(steps);
        self
    }

    /// Set metadata
    pub fn with_metadata(mut self, metadata: std::collections::HashMap<String, String>) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Set the on_done_workflow (workflow to chain to when done)
    pub fn with_on_done_workflow(mut self, workflow_id: impl Into<String>) -> Self {
        self.on_done_workflow = Some(Some(workflow_id.into()));
        self
    }

    /// Clear the on_done_workflow
    pub fn clear_on_done_workflow(mut self) -> Self {
        self.on_done_workflow = Some(None);
        self
    }

    /// Set the on_reject_workflow (workflow to chain to when rejected)
    pub fn with_on_reject_workflow(mut self, workflow_id: impl Into<String>) -> Self {
        self.on_reject_workflow = Some(Some(workflow_id.into()));
        self
    }

    /// Clear the on_reject_workflow
    pub fn clear_on_reject_workflow(mut self) -> Self {
        self.on_reject_workflow = Some(None);
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.name.is_some()
            || self.description.is_some()
            || self.steps.is_some()
            || self.metadata.is_some()
            || self.on_done_workflow.is_some()
            || self.on_reject_workflow.is_some()
    }
}

/// Minimal row for checking workflow existence
#[derive(Debug, Deserialize)]
struct IdOnly {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
}

impl<'a> WorkflowRepository<'a> {
    /// Create a new WorkflowRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Check if a workflow with the given ID exists.
    ///
    /// # Arguments
    ///
    /// * `id` - The workflow ID to check
    ///
    /// # Returns
    ///
    /// `true` if the workflow exists, `false` otherwise.
    pub async fn exists(&self, id: &str) -> DbResult<bool> {
        let query = format!("SELECT id FROM workflow:{}", id);
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let workflow: Option<IdOnly> = result.take(0)?;
        Ok(workflow.is_some())
    }

    /// Create a new workflow with the specified ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The unique workflow ID
    /// * `workflow` - The workflow data to create
    ///
    /// # Errors
    ///
    /// Returns `DbError::ValidationError` if workflow validation fails.
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create(&self, id: &str, workflow: &Workflow) -> DbResult<()> {
        debug!("Creating workflow: {} with name: {}", id, workflow.name);
        trace!("Workflow data: {:?}", workflow);

        // Validate workflow configuration
        workflow
            .validate()
            .map_err(|msg| DbError::ValidationError { message: msg })?;

        let description_str = match &workflow.description {
            Some(d) => format!("\"{}\"", d.replace('\"', "\\\"")),
            None => "NONE".to_string(),
        };

        let steps_json =
            serde_json::to_string(&workflow.steps).map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(id),
                reason: format!("Failed to serialize steps: {}", e),
            })?;

        let metadata_json =
            serde_json::to_string(&workflow.metadata).map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(id),
                reason: format!("Failed to serialize metadata: {}", e),
            })?;

        let on_done_str = match &workflow.on_done_workflow {
            Some(w) => format!("\"{}\"", w.replace('\"', "\\\"")),
            None => "NONE".to_string(),
        };

        let on_reject_str = match &workflow.on_reject_workflow {
            Some(w) => format!("\"{}\"", w.replace('\"', "\\\"")),
            None => "NONE".to_string(),
        };

        let name = workflow.name.clone();

        let query = format!(
            r#"CREATE workflow:{} SET
                name = $name,
                description = {},
                steps = {},
                metadata = {},
                on_done_workflow = {},
                on_reject_workflow = {}"#,
            id, description_str, steps_json, metadata_json, on_done_str, on_reject_str
        );

        self.client.query(&query).bind(("name", name)).await?;
        Ok(())
    }

    /// Get a workflow by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The workflow ID to fetch
    ///
    /// # Returns
    ///
    /// `Some(Workflow)` if found, `None` otherwise.
    pub async fn get(&self, id: &str) -> DbResult<Option<Workflow>> {
        debug!("Fetching workflow: {}", id);
        let query = format!("SELECT * FROM workflow:{}", id);
        let mut result = self.client.query(&query).await.map_err(|e| {
            debug!("Failed to fetch workflow: {}: {}", id, e);
            DbError::Query(Box::new(e))
        })?;
        let workflow: Option<Workflow> = result.take(0)?;
        if workflow.is_some() {
            debug!("Successfully fetched workflow: {}", id);
        } else {
            debug!("Workflow not found: {}", id);
        }
        Ok(workflow)
    }

    /// List all workflows.
    ///
    /// # Returns
    ///
    /// A vector of all workflows in the database.
    pub async fn list(&self) -> DbResult<Vec<Workflow>> {
        debug!("Listing all workflows");
        let mut result = self
            .client
            .query("SELECT * FROM workflow ORDER BY created_at DESC")
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let workflows: Vec<Workflow> = result.take(0)?;
        debug!("Found {} workflows", workflows.len());
        Ok(workflows)
    }

    /// Update a workflow.
    ///
    /// # Arguments
    ///
    /// * `id` - The workflow ID to update
    /// * `updates` - The updates to apply
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the workflow doesn't exist.
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update(&self, id: &str, updates: &WorkflowUpdate) -> DbResult<()> {
        debug!("Updating workflow: {}", id);
        trace!("Updates: {:?}", updates);

        if !updates.has_updates() {
            debug!("No updates specified for workflow: {}", id);
            return Ok(());
        }

        // Check if workflow exists
        if !self.exists(id).await? {
            return Err(DbError::NotFound {
                entity: "workflow".to_string(),
                id: id.to_string(),
            });
        }

        let mut field_updates = Vec::new();

        if let Some(name) = &updates.name {
            let escaped_name = name.replace('\"', "\\\"");
            field_updates.push(format!("name = \"{}\"", escaped_name));
        }

        if let Some(description_opt) = &updates.description {
            match description_opt {
                Some(d) => {
                    let escaped = d.replace('\"', "\\\"");
                    field_updates.push(format!("description = \"{}\"", escaped));
                }
                None => field_updates.push("description = NONE".to_string()),
            }
        }

        if let Some(steps) = &updates.steps {
            // Validate steps before updating
            if steps.is_empty() {
                return Err(DbError::ValidationError {
                    message: "workflow must have at least one step".to_string(),
                });
            }

            // Check for unique step names
            let mut seen_names = std::collections::HashSet::new();
            for step in steps {
                if !seen_names.insert(&step.name) {
                    return Err(DbError::ValidationError {
                        message: format!("duplicate step name '{}' in workflow", step.name),
                    });
                }
            }

            let steps_json = serde_json::to_string(steps).map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(id),
                reason: format!("Failed to serialize steps: {}", e),
            })?;
            field_updates.push(format!("steps = {}", steps_json));
        }

        if let Some(metadata) = &updates.metadata {
            let metadata_json =
                serde_json::to_string(metadata).map_err(|e| DbError::InvalidPath {
                    path: std::path::PathBuf::from(id),
                    reason: format!("Failed to serialize metadata: {}", e),
                })?;
            field_updates.push(format!("metadata = {}", metadata_json));
        }

        if let Some(on_done_opt) = &updates.on_done_workflow {
            match on_done_opt {
                Some(w) => {
                    let escaped = w.replace('\"', "\\\"");
                    field_updates.push(format!("on_done_workflow = \"{}\"", escaped));
                }
                None => field_updates.push("on_done_workflow = NONE".to_string()),
            }
        }

        if let Some(on_reject_opt) = &updates.on_reject_workflow {
            match on_reject_opt {
                Some(w) => {
                    let escaped = w.replace('\"', "\\\"");
                    field_updates.push(format!("on_reject_workflow = \"{}\"", escaped));
                }
                None => field_updates.push("on_reject_workflow = NONE".to_string()),
            }
        }

        if !field_updates.is_empty() {
            field_updates.push("updated_at = time::now()".to_string());
            let query = format!("UPDATE workflow:{} SET {}", id, field_updates.join(", "));
            debug!("Executing field updates for workflow: {}", id);
            trace!("Query: {}", query);
            match self.client.query(&query).await {
                Ok(_) => debug!("Field updates succeeded for workflow: {}", id),
                Err(e) => {
                    debug!("Field updates failed for workflow: {}: {}", id, e);
                    return Err(DbError::Query(Box::new(e)));
                }
            }
        }

        Ok(())
    }

    /// Delete a workflow by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The workflow ID to delete
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete(&self, id: &str) -> DbResult<()> {
        debug!("Deleting workflow: {}", id);
        let query = format!("DELETE workflow:{}", id);
        match self.client.query(&query).await {
            Ok(_) => {
                debug!("Successfully deleted workflow: {}", id);
                Ok(())
            }
            Err(e) => {
                debug!("Failed to delete workflow: {}: {}", id, e);
                Err(DbError::Query(Box::new(e)))
            }
        }
    }

    /// Create the default workflow if it doesn't already exist.
    ///
    /// The default workflow matches the standard task status flow:
    /// backlog -> todo -> in_progress -> pending_review -> done
    ///
    /// This workflow is used for backwards compatibility and is automatically
    /// assigned to tasks that don't have an explicit workflow.
    ///
    /// # Returns
    ///
    /// `Ok(true)` if the workflow was created, `Ok(false)` if it already existed.
    pub async fn create_default_workflow(&self) -> DbResult<bool> {
        debug!("Checking for default workflow");

        // Check if default workflow already exists
        if self.exists(DEFAULT_WORKFLOW_ID).await? {
            debug!("Default workflow already exists");
            return Ok(false);
        }

        debug!("Creating default workflow");

        let default_workflow = Workflow::new("Default Workflow")
            .with_description(
                "Standard task workflow matching the status flow: \
                backlog -> todo -> in_progress -> pending_review -> done",
            )
            .with_step(WorkflowStep::new("backlog", "task-agent", 0))
            .with_step(WorkflowStep::new("todo", "task-agent", 1))
            .with_step(WorkflowStep::new("in_progress", "task-agent", 2))
            .with_step(WorkflowStep::new("pending_review", "task-agent", 3))
            .with_step(WorkflowStep::new("done", "task-agent", 4));

        self.create(DEFAULT_WORKFLOW_ID, &default_workflow).await?;

        debug!("Default workflow created successfully");
        Ok(true)
    }

    /// Export all workflows from the database.
    ///
    /// Returns all workflows with their IDs for backup or migration purposes.
    ///
    /// # Returns
    ///
    /// A vector of (workflow_id, Workflow) tuples.
    pub async fn export_all(&self) -> DbResult<Vec<(String, Workflow)>> {
        debug!("Exporting all workflows");

        #[derive(Debug, Deserialize)]
        struct WorkflowWithId {
            id: surrealdb::sql::Thing,
            #[serde(flatten)]
            workflow: Workflow,
        }

        let mut result = self.client.query("SELECT * FROM workflow").await?;
        let workflows: Vec<WorkflowWithId> = result.take(0)?;

        debug!("Exported {} workflows", workflows.len());
        Ok(workflows
            .into_iter()
            .map(|w| (w.id.id.to_raw(), w.workflow))
            .collect())
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
            "vtb-workflow-repo-test-{}-{:?}-{}",
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
        let repo = WorkflowRepository::new(db.client());

        let exists = repo.exists("nonexistent").await.unwrap();
        assert!(!exists);

        cleanup(&temp_dir);
    }

    /// Helper to create a valid workflow with at least one step
    fn valid_workflow(name: &str) -> Workflow {
        Workflow::new(name).with_step(WorkflowStep::new("default_step", "default_agent", 0))
    }

    #[tokio::test]
    async fn test_create_and_exists() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Test Workflow");
        repo.create("test1", &workflow).await.unwrap();

        let exists = repo.exists("test1").await.unwrap();
        assert!(exists);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_generates_unique_id() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        // Create two workflows with different IDs
        let workflow1 = valid_workflow("Workflow 1");
        let workflow2 = valid_workflow("Workflow 2");

        repo.create("wf1", &workflow1).await.unwrap();
        repo.create("wf2", &workflow2).await.unwrap();

        // Both should exist with their respective IDs
        assert!(repo.exists("wf1").await.unwrap());
        assert!(repo.exists("wf2").await.unwrap());

        // Get them and verify they're different
        let fetched1 = repo.get("wf1").await.unwrap().unwrap();
        let fetched2 = repo.get("wf2").await.unwrap().unwrap();
        assert_eq!(fetched1.name, "Workflow 1");
        assert_eq!(fetched2.name, "Workflow 2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_with_all_fields() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = Workflow::new("Full Workflow")
            .with_description("A complete workflow")
            .with_step(WorkflowStep::new("Step 1", "agent1", 0).with_skill("skill1"))
            .with_step(WorkflowStep::new("Step 2", "agent2", 1))
            .with_metadata("version", "1.0")
            .with_metadata("team", "platform");

        repo.create("full1", &workflow).await.unwrap();

        let retrieved = repo.get("full1").await.unwrap().unwrap();
        assert_eq!(retrieved.name, "Full Workflow");
        assert_eq!(
            retrieved.description,
            Some("A complete workflow".to_string())
        );
        assert_eq!(retrieved.steps.len(), 2);
        assert_eq!(retrieved.steps[0].name, "Step 1");
        assert_eq!(retrieved.steps[0].skills, vec!["skill1"]);
        assert_eq!(retrieved.steps[1].name, "Step 2");
        assert_eq!(retrieved.metadata.get("version"), Some(&"1.0".to_string()));
        assert_eq!(
            retrieved.metadata.get("team"),
            Some(&"platform".to_string())
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_existing_workflow() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Get Test").with_description("Test description");

        repo.create("get1", &workflow).await.unwrap();

        let retrieved = repo.get("get1").await.unwrap();
        assert!(retrieved.is_some());

        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.name, "Get Test");
        assert_eq!(retrieved.description, Some("Test description".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_get_nonexistent_workflow() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let retrieved = repo.get("nonexistent").await.unwrap();
        assert!(retrieved.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_contains_default_workflow() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        // Default workflow is created by db.init()
        let workflows = repo.list().await.unwrap();
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0].name, "Default Workflow");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_list_multiple() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        repo.create("wf1", &valid_workflow("Workflow 1"))
            .await
            .unwrap();
        repo.create("wf2", &valid_workflow("Workflow 2"))
            .await
            .unwrap();
        repo.create("wf3", &valid_workflow("Workflow 3"))
            .await
            .unwrap();

        let workflows = repo.list().await.unwrap();
        // 3 created + 1 default workflow
        assert_eq!(workflows.len(), 4);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_name() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Original Name");
        repo.create("upd1", &workflow).await.unwrap();

        let updates = WorkflowUpdate::new().with_name("New Name");
        repo.update("upd1", &updates).await.unwrap();

        let retrieved = repo.get("upd1").await.unwrap().unwrap();
        assert_eq!(retrieved.name, "New Name");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_description() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Description Test");
        repo.create("upd2", &workflow).await.unwrap();

        let updates = WorkflowUpdate::new().with_description("New description");
        repo.update("upd2", &updates).await.unwrap();

        let retrieved = repo.get("upd2").await.unwrap().unwrap();
        assert_eq!(retrieved.description, Some("New description".to_string()));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_clear_description() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Clear Desc Test").with_description("Original description");
        repo.create("upd3", &workflow).await.unwrap();

        let updates = WorkflowUpdate::new().clear_description();
        repo.update("upd3", &updates).await.unwrap();

        let retrieved = repo.get("upd3").await.unwrap().unwrap();
        assert!(retrieved.description.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_steps() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow =
            Workflow::new("Steps Test").with_step(WorkflowStep::new("Original Step", "agent1", 0));
        repo.create("upd4", &workflow).await.unwrap();

        let new_steps = vec![
            WorkflowStep::new("New Step 1", "new_agent1", 0),
            WorkflowStep::new("New Step 2", "new_agent2", 1),
        ];
        let updates = WorkflowUpdate::new().with_steps(new_steps);
        repo.update("upd4", &updates).await.unwrap();

        let retrieved = repo.get("upd4").await.unwrap().unwrap();
        assert_eq!(retrieved.steps.len(), 2);
        assert_eq!(retrieved.steps[0].name, "New Step 1");
        assert_eq!(retrieved.steps[1].name, "New Step 2");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_metadata() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Metadata Test").with_metadata("old_key", "old_value");
        repo.create("upd5", &workflow).await.unwrap();

        let mut new_metadata = std::collections::HashMap::new();
        new_metadata.insert("new_key".to_string(), "new_value".to_string());
        let updates = WorkflowUpdate::new().with_metadata(new_metadata);
        repo.update("upd5", &updates).await.unwrap();

        let retrieved = repo.get("upd5").await.unwrap().unwrap();
        assert!(retrieved.metadata.get("old_key").is_none());
        assert_eq!(
            retrieved.metadata.get("new_key"),
            Some(&"new_value".to_string())
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_nonexistent_fails() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let updates = WorkflowUpdate::new().with_name("New Name");
        let result = repo.update("nonexistent", &updates).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::NotFound { entity, id } => {
                assert_eq!(entity, "workflow");
                assert_eq!(id, "nonexistent");
            }
            e => panic!("Expected NotFound error, got: {:?}", e),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_no_changes() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("No Change Test");
        repo.create("upd6", &workflow).await.unwrap();

        let updates = WorkflowUpdate::new();
        assert!(!updates.has_updates());

        // Should not error
        repo.update("upd6", &updates).await.unwrap();

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Delete Test");
        repo.create("del1", &workflow).await.unwrap();

        assert!(repo.exists("del1").await.unwrap());

        repo.delete("del1").await.unwrap();

        assert!(!repo.exists("del1").await.unwrap());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_nonexistent() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        // Should not error when deleting non-existent workflow
        repo.delete("nonexistent").await.unwrap();

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_export_all() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        repo.create("wf1", &valid_workflow("Workflow 1"))
            .await
            .unwrap();
        repo.create("wf2", &valid_workflow("Workflow 2"))
            .await
            .unwrap();

        let exported = repo.export_all().await.unwrap();
        // 2 created + 1 default workflow
        assert_eq!(exported.len(), 3);

        let ids: Vec<&str> = exported.iter().map(|(id, _)| id.as_str()).collect();
        assert!(ids.contains(&"wf1"));
        assert!(ids.contains(&"wf2"));
        assert!(ids.contains(&"default"));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_full_crud_lifecycle() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        // Create
        let workflow = Workflow::new("CRUD Test")
            .with_description("Initial description")
            .with_step(WorkflowStep::new("Step 1", "agent1", 0));
        repo.create("crud1", &workflow).await.unwrap();

        // Read
        let retrieved = repo.get("crud1").await.unwrap().unwrap();
        assert_eq!(retrieved.name, "CRUD Test");
        assert_eq!(
            retrieved.description,
            Some("Initial description".to_string())
        );
        assert_eq!(retrieved.steps.len(), 1);

        // Update
        let updates = WorkflowUpdate::new()
            .with_name("Updated CRUD Test")
            .with_description("Updated description")
            .with_steps(vec![
                WorkflowStep::new("Updated Step 1", "agent1", 0),
                WorkflowStep::new("New Step 2", "agent2", 1),
            ]);
        repo.update("crud1", &updates).await.unwrap();

        let updated = repo.get("crud1").await.unwrap().unwrap();
        assert_eq!(updated.name, "Updated CRUD Test");
        assert_eq!(updated.description, Some("Updated description".to_string()));
        assert_eq!(updated.steps.len(), 2);

        // List - should include crud1 + default workflow
        let list = repo.list().await.unwrap();
        assert_eq!(list.len(), 2);

        // Delete
        repo.delete("crud1").await.unwrap();
        assert!(!repo.exists("crud1").await.unwrap());
        assert!(repo.get("crud1").await.unwrap().is_none());

        // List should only have default workflow
        let list = repo.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Default Workflow");

        cleanup(&temp_dir);
    }

    #[test]
    fn test_workflow_update_builder() {
        let mut metadata = std::collections::HashMap::new();
        metadata.insert("key".to_string(), "value".to_string());

        let update = WorkflowUpdate::new()
            .with_name("New Name")
            .with_description("New Description")
            .with_steps(vec![WorkflowStep::new("Step", "agent", 0)])
            .with_metadata(metadata);

        assert_eq!(update.name, Some("New Name".to_string()));
        assert_eq!(
            update.description,
            Some(Some("New Description".to_string()))
        );
        assert!(update.steps.is_some());
        assert!(update.metadata.is_some());
        assert!(update.has_updates());
    }

    #[test]
    fn test_workflow_update_default() {
        let update = WorkflowUpdate::default();

        assert!(update.name.is_none());
        assert!(update.description.is_none());
        assert!(update.steps.is_none());
        assert!(update.metadata.is_none());
        assert!(!update.has_updates());
    }

    // ========================================
    // Validation tests
    // ========================================

    #[tokio::test]
    async fn test_create_empty_steps_fails() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = Workflow::new("Empty Steps");
        let result = repo.create("test1", &workflow).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert_eq!(message, "workflow must have at least one step");
            }
            e => panic!("Expected ValidationError, got: {:?}", e),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_duplicate_step_names_fails() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = Workflow::new("Duplicate Steps")
            .with_step(WorkflowStep::new("review", "agent1", 0))
            .with_step(WorkflowStep::new("test", "agent2", 1))
            .with_step(WorkflowStep::new("review", "agent3", 2));

        let result = repo.create("test1", &workflow).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert_eq!(message, "duplicate step name 'review' in workflow");
            }
            e => panic!("Expected ValidationError, got: {:?}", e),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_to_empty_steps_fails() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Test Workflow");
        repo.create("test1", &workflow).await.unwrap();

        let updates = WorkflowUpdate::new().with_steps(vec![]);
        let result = repo.update("test1", &updates).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert_eq!(message, "workflow must have at least one step");
            }
            e => panic!("Expected ValidationError, got: {:?}", e),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_to_duplicate_step_names_fails() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = valid_workflow("Test Workflow");
        repo.create("test1", &workflow).await.unwrap();

        let new_steps = vec![
            WorkflowStep::new("build", "agent1", 0),
            WorkflowStep::new("deploy", "agent2", 1),
            WorkflowStep::new("build", "agent3", 2), // duplicate
        ];
        let updates = WorkflowUpdate::new().with_steps(new_steps);
        let result = repo.update("test1", &updates).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert_eq!(message, "duplicate step name 'build' in workflow");
            }
            e => panic!("Expected ValidationError, got: {:?}", e),
        }

        cleanup(&temp_dir);
    }

    // ========================================
    // Default workflow tests
    // ========================================

    #[tokio::test]
    async fn test_create_default_workflow_creates_workflow() {
        // setup_test_db() calls db.init() which creates the default workflow,
        // so we verify it exists and has the correct structure
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        // Default workflow should exist (created by db.init())
        assert!(repo.exists(DEFAULT_WORKFLOW_ID).await.unwrap());

        // Verify the workflow has correct structure
        let workflow = repo.get(DEFAULT_WORKFLOW_ID).await.unwrap().unwrap();
        assert_eq!(workflow.name, "Default Workflow");
        assert!(workflow.description.is_some());
        assert_eq!(workflow.steps.len(), 5);

        // Verify step order matches standard status flow
        assert_eq!(workflow.steps[0].name, "backlog");
        assert_eq!(workflow.steps[0].order, 0);
        assert_eq!(workflow.steps[1].name, "todo");
        assert_eq!(workflow.steps[1].order, 1);
        assert_eq!(workflow.steps[2].name, "in_progress");
        assert_eq!(workflow.steps[2].order, 2);
        assert_eq!(workflow.steps[3].name, "pending_review");
        assert_eq!(workflow.steps[3].order, 3);
        assert_eq!(workflow.steps[4].name, "done");
        assert_eq!(workflow.steps[4].order, 4);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_default_workflow_is_idempotent() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        // Default workflow already exists from db.init()
        // Calling create_default_workflow again should return false
        let created = repo.create_default_workflow().await.unwrap();
        assert!(!created, "Should return false when workflow already exists");

        // Workflow should still exist and be unchanged
        let workflow = repo.get(DEFAULT_WORKFLOW_ID).await.unwrap().unwrap();
        assert_eq!(workflow.name, "Default Workflow");
        assert_eq!(workflow.steps.len(), 5);

        // Verify there's only one default workflow
        let all_workflows = repo.list().await.unwrap();
        let default_count = all_workflows
            .iter()
            .filter(|w| w.name == "Default Workflow")
            .count();
        assert_eq!(default_count, 1, "Should only have one default workflow");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_default_workflow_when_no_workflows_exist() {
        // Use in-memory database with schema init but no db.init()
        // to test creation when default workflow doesn't exist
        use surrealdb::engine::local::Mem;

        let client = Surreal::new::<Mem>(()).await.unwrap();
        client.use_ns("vertebrae").use_db("test").await.unwrap();
        crate::schema::init_schema(&client).await.unwrap();

        let repo = WorkflowRepository::new(&client);

        // Default workflow should not exist yet
        assert!(!repo.exists(DEFAULT_WORKFLOW_ID).await.unwrap());

        // Create default workflow
        let created = repo.create_default_workflow().await.unwrap();
        assert!(created, "Should return true when creating workflow");

        // Verify it exists now
        assert!(repo.exists(DEFAULT_WORKFLOW_ID).await.unwrap());
    }

    #[test]
    fn test_default_workflow_id_constant() {
        assert_eq!(DEFAULT_WORKFLOW_ID, "default");
    }
}
