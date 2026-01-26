//! Workflow transition repository for managing workflow-to-workflow transitions
//!
//! Provides a repository pattern implementation for workflow transition edge operations,
//! encapsulating SurrealDB RELATE queries for workflow_transitions edges.

use crate::error::DbResult;
use crate::models::WorkflowTransition;
use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;

/// Repository for workflow transition (edge) operations
///
/// Manages the workflow_transitions relationship type in Vertebrae:
/// - `workflow_transitions`: Valid transitions between workflows (from_workflow -> to_workflow)
pub struct WorkflowTransitionRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Row for fetching workflow transition data
#[derive(Debug, Deserialize)]
struct TransitionRow {
    id: surrealdb::sql::Thing,
    r#in: surrealdb::sql::Thing,
    out: surrealdb::sql::Thing,
    label: String,
    target_step: Option<surrealdb::sql::Thing>,
}

impl<'a> WorkflowTransitionRepository<'a> {
    /// Create a new WorkflowTransitionRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Create a workflow transition between two workflows.
    ///
    /// The edge direction is: from_workflow -> workflow_transitions -> to_workflow
    ///
    /// # Arguments
    ///
    /// * `from_workflow_id` - The ID of the source workflow
    /// * `to_workflow_id` - The ID of the target workflow
    /// * `label` - Human-readable label for this transition
    /// * `target_step_id` - Optional ID of the step to start at in the target workflow
    ///
    /// # Returns
    ///
    /// The created WorkflowTransition with its ID populated.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create(
        &self,
        from_workflow_id: &str,
        to_workflow_id: &str,
        label: &str,
        target_step_id: Option<&str>,
    ) -> DbResult<WorkflowTransition> {
        let target_step_clause = match target_step_id {
            Some(step_id) => format!("target_step = step:{}", step_id),
            None => "target_step = NONE".to_string(),
        };

        let query = format!(
            r#"RELATE workflow:{} -> workflow_transitions -> workflow:{} SET
                label = "{}",
                {}"#,
            from_workflow_id, to_workflow_id, label, target_step_clause
        );

        let mut result = self.client.query(&query).await?;
        let rows: Vec<TransitionRow> = result.take(0)?;

        if let Some(row) = rows.into_iter().next() {
            Ok(WorkflowTransition {
                id: Some(row.id),
                from_workflow: row.r#in,
                to_workflow: row.out,
                label: row.label,
                target_step: row.target_step,
                created_at: None,
            })
        } else {
            // Return a transition without an ID if creation didn't return one
            Ok(WorkflowTransition {
                id: None,
                from_workflow: surrealdb::sql::Thing::from(("workflow", from_workflow_id)),
                to_workflow: surrealdb::sql::Thing::from(("workflow", to_workflow_id)),
                label: label.to_string(),
                target_step: target_step_id.map(|id| surrealdb::sql::Thing::from(("step", id))),
                created_at: None,
            })
        }
    }

    /// Get a workflow transition by its ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The ID of the transition (just the ID part, not "workflow_transitions:id")
    ///
    /// # Returns
    ///
    /// `Some(WorkflowTransition)` if found, `None` otherwise.
    pub async fn get(&self, id: &str) -> DbResult<Option<WorkflowTransition>> {
        let query = format!("SELECT * FROM workflow_transitions:{}", id);
        let mut result = self.client.query(&query).await?;
        let rows: Vec<TransitionRow> = result.take(0)?;

        Ok(rows.into_iter().next().map(|row| WorkflowTransition {
            id: Some(row.id),
            from_workflow: row.r#in,
            to_workflow: row.out,
            label: row.label,
            target_step: row.target_step,
            created_at: None,
        }))
    }

    /// Get all transitions from a specific workflow.
    ///
    /// # Arguments
    ///
    /// * `from_workflow_id` - The ID of the source workflow
    ///
    /// # Returns
    ///
    /// A vector of WorkflowTransition items that start from the given workflow.
    pub async fn get_from_workflow(
        &self,
        from_workflow_id: &str,
    ) -> DbResult<Vec<WorkflowTransition>> {
        let query = format!(
            "SELECT * FROM workflow_transitions WHERE in = workflow:{}",
            from_workflow_id
        );
        let mut result = self.client.query(&query).await?;
        let rows: Vec<TransitionRow> = result.take(0)?;

        Ok(rows
            .into_iter()
            .map(|row| WorkflowTransition {
                id: Some(row.id),
                from_workflow: row.r#in,
                to_workflow: row.out,
                label: row.label,
                target_step: row.target_step,
                created_at: None,
            })
            .collect())
    }

    /// Get all transitions to a specific workflow.
    ///
    /// # Arguments
    ///
    /// * `to_workflow_id` - The ID of the target workflow
    ///
    /// # Returns
    ///
    /// A vector of WorkflowTransition items that lead to the given workflow.
    pub async fn get_to_workflow(&self, to_workflow_id: &str) -> DbResult<Vec<WorkflowTransition>> {
        let query = format!(
            "SELECT * FROM workflow_transitions WHERE out = workflow:{}",
            to_workflow_id
        );
        let mut result = self.client.query(&query).await?;
        let rows: Vec<TransitionRow> = result.take(0)?;

        Ok(rows
            .into_iter()
            .map(|row| WorkflowTransition {
                id: Some(row.id),
                from_workflow: row.r#in,
                to_workflow: row.out,
                label: row.label,
                target_step: row.target_step,
                created_at: None,
            })
            .collect())
    }

    /// Check if a transition exists between two workflows.
    ///
    /// # Arguments
    ///
    /// * `from_workflow_id` - The ID of the source workflow
    /// * `to_workflow_id` - The ID of the target workflow
    ///
    /// # Returns
    ///
    /// `true` if a transition exists, `false` otherwise.
    pub async fn exists(&self, from_workflow_id: &str, to_workflow_id: &str) -> DbResult<bool> {
        let query = format!(
            "SELECT id FROM workflow_transitions WHERE in = workflow:{} AND out = workflow:{}",
            from_workflow_id, to_workflow_id
        );
        let mut result = self.client.query(&query).await?;

        #[derive(Debug, Deserialize)]
        struct IdRow {
            #[allow(dead_code)]
            id: surrealdb::sql::Thing,
        }

        let rows: Vec<IdRow> = result.take(0)?;
        Ok(!rows.is_empty())
    }

    /// Delete a specific transition between two workflows.
    ///
    /// # Arguments
    ///
    /// * `from_workflow_id` - The ID of the source workflow
    /// * `to_workflow_id` - The ID of the target workflow
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete(&self, from_workflow_id: &str, to_workflow_id: &str) -> DbResult<()> {
        let query = format!(
            "DELETE workflow_transitions WHERE in = workflow:{} AND out = workflow:{}",
            from_workflow_id, to_workflow_id
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Delete a transition by its ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The full transition ID (e.g., "workflow_transitions:abc123")
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete_by_id(&self, id: &str) -> DbResult<()> {
        let query = format!("DELETE workflow_transitions:{}", id);
        self.client.query(&query).await?;
        Ok(())
    }

    /// Delete all transitions from a workflow.
    ///
    /// # Arguments
    ///
    /// * `from_workflow_id` - The ID of the source workflow
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete_all_from(&self, from_workflow_id: &str) -> DbResult<()> {
        let query = format!(
            "DELETE workflow_transitions WHERE in = workflow:{}",
            from_workflow_id
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// Delete all transitions to a workflow.
    ///
    /// # Arguments
    ///
    /// * `to_workflow_id` - The ID of the target workflow
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete_all_to(&self, to_workflow_id: &str) -> DbResult<()> {
        let query = format!(
            "DELETE workflow_transitions WHERE out = workflow:{}",
            to_workflow_id
        );
        self.client.query(&query).await?;
        Ok(())
    }

    /// List all workflow transitions.
    ///
    /// # Returns
    ///
    /// A vector of all WorkflowTransition items in the database.
    pub async fn list_all(&self) -> DbResult<Vec<WorkflowTransition>> {
        let query = "SELECT * FROM workflow_transitions";
        let mut result = self.client.query(query).await?;
        let rows: Vec<TransitionRow> = result.take(0)?;

        Ok(rows
            .into_iter()
            .map(|row| WorkflowTransition {
                id: Some(row.id),
                from_workflow: row.r#in,
                to_workflow: row.out,
                label: row.label,
                target_step: row.target_step,
                created_at: None,
            })
            .collect())
    }

    /// Get a transition from a specific workflow by its label.
    ///
    /// # Arguments
    ///
    /// * `from_workflow_id` - The ID of the source workflow
    /// * `label` - The label of the transition to find
    ///
    /// # Returns
    ///
    /// `Some(WorkflowTransition)` if found, `None` otherwise.
    pub async fn get_by_label(
        &self,
        from_workflow_id: &str,
        label: &str,
    ) -> DbResult<Option<WorkflowTransition>> {
        let query = format!(
            r#"SELECT * FROM workflow_transitions WHERE in = workflow:{} AND label = "{}""#,
            from_workflow_id, label
        );
        let mut result = self.client.query(&query).await?;
        let rows: Vec<TransitionRow> = result.take(0)?;

        Ok(rows.into_iter().next().map(|row| WorkflowTransition {
            id: Some(row.id),
            from_workflow: row.r#in,
            to_workflow: row.out,
            label: row.label,
            target_step: row.target_step,
            created_at: None,
        }))
    }

    /// Seed default workflow transitions for the standard workflow system.
    ///
    /// Creates transitions between the default workflow and itself for common
    /// status progressions. This is idempotent - if transitions already exist,
    /// it returns Ok(false) without making changes.
    ///
    /// The default workflow has steps: backlog -> in_progress -> pending_review -> done
    /// Transitions allow:
    /// - Advancing forward through the workflow
    /// - Going back for revisions (pending_review -> in_progress)
    ///
    /// # Returns
    ///
    /// `Ok(true)` if transitions were created, `Ok(false)` if they already exist.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if database operations fail.
    pub async fn seed_default_transitions(&self) -> DbResult<bool> {
        // Check if transitions already exist
        let existing = self.list_all().await?;
        if !existing.is_empty() {
            return Ok(false);
        }

        // Create self-transitions for the default workflow
        // These allow tasks to progress through the workflow steps
        self.create("default", "default", "Progress through workflow", None)
            .await?;

        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    /// Helper to create a test database
    async fn setup_test_db() -> Database {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        db
    }

    /// Helper to create a workflow in the database
    async fn create_workflow(db: &Database, id: &str, name: &str) {
        let query = format!(
            r#"CREATE workflow:{} SET
                name = "{}",
                description = "Test workflow",
                steps = [],
                metadata = {{}}"#,
            id, name
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a step in the database
    async fn create_step(db: &Database, id: &str, name: &str, workflow_id: &str) {
        let query = format!(
            r#"CREATE step:{} SET
                name = "{}",
                workflow_id = workflow:{}"#,
            id, name, workflow_id
        );
        db.client().query(&query).await.unwrap();
    }

    /// Clean up test database
    // No cleanup needed for in-memory database

    #[tokio::test]
    async fn test_create_transition() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;

        let transition = repo
            .create("wf1", "wf2", "Go to Workflow 2", None)
            .await
            .unwrap();

        assert_eq!(transition.label, "Go to Workflow 2");
        assert_eq!(transition.from_workflow.id.to_raw(), "wf1");
        assert_eq!(transition.to_workflow.id.to_raw(), "wf2");
        assert!(transition.target_step.is_none());
    }

    #[tokio::test]
    async fn test_create_transition_with_target_step() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;
        create_step(&db, "step1", "Step 1", "wf2").await;

        let transition = repo
            .create("wf1", "wf2", "Go to Workflow 2 Step 1", Some("step1"))
            .await
            .unwrap();

        assert_eq!(transition.label, "Go to Workflow 2 Step 1");
        assert!(transition.target_step.is_some());
        assert_eq!(transition.target_step.unwrap().id.to_raw(), "step1");
    }

    #[tokio::test]
    async fn test_get_from_workflow() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;
        create_workflow(&db, "wf3", "Workflow 3").await;

        repo.create("wf1", "wf2", "To WF2", None).await.unwrap();
        repo.create("wf1", "wf3", "To WF3", None).await.unwrap();

        let transitions = repo.get_from_workflow("wf1").await.unwrap();
        assert_eq!(transitions.len(), 2);

        let labels: Vec<&str> = transitions.iter().map(|t| t.label.as_str()).collect();
        assert!(labels.contains(&"To WF2"));
        assert!(labels.contains(&"To WF3"));
    }

    #[tokio::test]
    async fn test_get_to_workflow() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;
        create_workflow(&db, "wf3", "Workflow 3").await;

        repo.create("wf1", "wf3", "WF1 to WF3", None).await.unwrap();
        repo.create("wf2", "wf3", "WF2 to WF3", None).await.unwrap();

        let transitions = repo.get_to_workflow("wf3").await.unwrap();
        assert_eq!(transitions.len(), 2);

        let labels: Vec<&str> = transitions.iter().map(|t| t.label.as_str()).collect();
        assert!(labels.contains(&"WF1 to WF3"));
        assert!(labels.contains(&"WF2 to WF3"));
    }

    #[tokio::test]
    async fn test_exists() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;

        // Should not exist initially
        assert!(!repo.exists("wf1", "wf2").await.unwrap());

        // Create transition
        repo.create("wf1", "wf2", "Test", None).await.unwrap();

        // Should exist now
        assert!(repo.exists("wf1", "wf2").await.unwrap());

        // Reverse direction should not exist
        assert!(!repo.exists("wf2", "wf1").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;

        repo.create("wf1", "wf2", "Test", None).await.unwrap();
        assert!(repo.exists("wf1", "wf2").await.unwrap());

        repo.delete("wf1", "wf2").await.unwrap();
        assert!(!repo.exists("wf1", "wf2").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_all_from() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;
        create_workflow(&db, "wf3", "Workflow 3").await;

        repo.create("wf1", "wf2", "To WF2", None).await.unwrap();
        repo.create("wf1", "wf3", "To WF3", None).await.unwrap();

        assert_eq!(repo.get_from_workflow("wf1").await.unwrap().len(), 2);

        repo.delete_all_from("wf1").await.unwrap();

        assert_eq!(repo.get_from_workflow("wf1").await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_delete_all_to() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;
        create_workflow(&db, "wf3", "Workflow 3").await;

        repo.create("wf1", "wf3", "WF1 to WF3", None).await.unwrap();
        repo.create("wf2", "wf3", "WF2 to WF3", None).await.unwrap();

        assert_eq!(repo.get_to_workflow("wf3").await.unwrap().len(), 2);

        repo.delete_all_to("wf3").await.unwrap();

        assert_eq!(repo.get_to_workflow("wf3").await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_list_all() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;
        create_workflow(&db, "wf3", "Workflow 3").await;

        // Note: init() seeds default transitions, so list is not initially empty
        let initial_count = repo.list_all().await.unwrap().len();

        repo.create("wf1", "wf2", "1 to 2", None).await.unwrap();
        repo.create("wf2", "wf3", "2 to 3", None).await.unwrap();

        let all = repo.list_all().await.unwrap();
        assert_eq!(all.len(), initial_count + 2);
    }

    #[tokio::test]
    async fn test_get_from_workflow_empty() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;

        let transitions = repo.get_from_workflow("wf1").await.unwrap();
        assert!(transitions.is_empty());
    }

    #[tokio::test]
    async fn test_get_to_workflow_empty() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;

        let transitions = repo.get_to_workflow("wf1").await.unwrap();
        assert!(transitions.is_empty());
    }

    #[tokio::test]
    async fn test_delete_nonexistent_transition() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;

        // Should not error when deleting non-existent transition
        repo.delete("wf1", "wf2").await.unwrap();
    }

    #[tokio::test]
    async fn test_seed_default_transitions() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        // Note: setup_test_db calls db.init() which already seeds default transitions
        // So we expect list_all to return at least 1 transition
        let transitions = repo.list_all().await.unwrap();
        assert!(
            !transitions.is_empty(),
            "Default transitions should be seeded during init"
        );

        // Calling seed again should return false (already exists)
        let seeded = repo.seed_default_transitions().await.unwrap();
        assert!(!seeded, "Should not re-seed if transitions already exist");
    }

    #[tokio::test]
    async fn test_seed_default_transitions_creates_default_workflow_transition() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        // After init, there should be a transition for the default workflow
        let transitions = repo.get_from_workflow("default").await.unwrap();
        assert!(
            !transitions.is_empty(),
            "Default workflow should have transitions"
        );
    }

    #[tokio::test]
    async fn test_get_by_label() {
        let db = setup_test_db().await;
        let repo = WorkflowTransitionRepository::new(db.client());

        create_workflow(&db, "wf1", "Workflow 1").await;
        create_workflow(&db, "wf2", "Workflow 2").await;
        create_workflow(&db, "wf3", "Workflow 3").await;

        repo.create("wf1", "wf2", "approve", None).await.unwrap();
        repo.create("wf1", "wf3", "escalate", None).await.unwrap();

        // Should find by label
        let transition = repo.get_by_label("wf1", "approve").await.unwrap();
        assert!(transition.is_some());
        let t = transition.unwrap();
        assert_eq!(t.label, "approve");
        assert_eq!(t.to_workflow.id.to_raw(), "wf2");

        // Should find the other label too
        let transition = repo.get_by_label("wf1", "escalate").await.unwrap();
        assert!(transition.is_some());
        let t = transition.unwrap();
        assert_eq!(t.label, "escalate");
        assert_eq!(t.to_workflow.id.to_raw(), "wf3");

        // Non-existent label should return None
        let transition = repo.get_by_label("wf1", "nonexistent").await.unwrap();
        assert!(transition.is_none());

        // Non-existent workflow should return None
        let transition = repo.get_by_label("wf999", "approve").await.unwrap();
        assert!(transition.is_none());
    }
}
