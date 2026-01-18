//! Step repository for CRUD operations on first-class workflow steps
//!
//! Provides a repository pattern implementation for step operations,
//! encapsulating SurrealDB queries and providing a clean API.

use crate::error::{DbError, DbResult};
use crate::models::Step;
use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;
use surrealdb::sql::Thing;
use tracing::{debug, trace};

/// Repository for step CRUD operations
///
/// Encapsulates database queries for steps, providing a clean API
/// that hides the underlying SurrealDB implementation details.
pub struct StepRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Update structure for partial step updates
#[derive(Debug, Default)]
pub struct StepUpdate {
    /// New name (if Some)
    pub name: Option<String>,
    /// New agent config (if Some)
    pub agent_config: Option<serde_json::Value>,
    /// New is_final value (if Some)
    pub is_final: Option<bool>,
    /// New transitions_to list (if Some, replaces entire list)
    pub transitions_to: Option<Vec<Thing>>,
    /// New order value (if Some)
    pub order: Option<i32>,
}

impl StepUpdate {
    /// Create a new empty update
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a new name
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Set a new agent config
    pub fn with_agent_config(mut self, config: serde_json::Value) -> Self {
        self.agent_config = Some(config);
        self
    }

    /// Set the is_final flag
    pub fn with_is_final(mut self, is_final: bool) -> Self {
        self.is_final = Some(is_final);
        self
    }

    /// Set transitions_to list
    pub fn with_transitions_to(mut self, transitions: Vec<Thing>) -> Self {
        self.transitions_to = Some(transitions);
        self
    }

    /// Set the order
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = Some(order);
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.name.is_some()
            || self.agent_config.is_some()
            || self.is_final.is_some()
            || self.transitions_to.is_some()
            || self.order.is_some()
    }
}

/// Minimal row for checking step existence
#[derive(Debug, Deserialize)]
struct IdOnly {
    #[allow(dead_code)]
    id: Thing,
}

impl<'a> StepRepository<'a> {
    /// Create a new StepRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Create a new step.
    ///
    /// # Arguments
    ///
    /// * `step` - The step data to create
    ///
    /// # Returns
    ///
    /// The created step with its assigned ID.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create(&self, step: &Step) -> DbResult<Step> {
        debug!(
            "Creating step: {} for workflow {:?}",
            step.name, step.workflow_id
        );
        trace!("Step data: {:?}", step);

        let agent_config_json =
            serde_json::to_string(&step.agent_config).map_err(|e| DbError::ValidationError {
                message: format!("Failed to serialize agent_config: {}", e),
            })?;

        let transitions_json =
            serde_json::to_string(&step.transitions_to).map_err(|e| DbError::ValidationError {
                message: format!("Failed to serialize transitions_to: {}", e),
            })?;

        let query = format!(
            r#"CREATE step SET
                name = $name,
                workflow_id = {},
                agent_config = {},
                is_final = $is_final,
                transitions_to = {},
                order = $order"#,
            step.workflow_id, agent_config_json, transitions_json
        );

        let mut result = self
            .client
            .query(&query)
            .bind(("name", step.name.clone()))
            .bind(("is_final", step.is_final))
            .bind(("order", step.order))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        let created: Option<Step> = result.take(0)?;
        created.ok_or_else(|| DbError::ValidationError {
            message: "Failed to create step".to_string(),
        })
    }

    /// Create a step with a specific ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The unique step ID
    /// * `step` - The step data to create
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create_with_id(&self, id: &str, step: &Step) -> DbResult<Step> {
        debug!(
            "Creating step with id {}: {} for workflow {:?}",
            id, step.name, step.workflow_id
        );
        trace!("Step data: {:?}", step);

        let agent_config_json =
            serde_json::to_string(&step.agent_config).map_err(|e| DbError::ValidationError {
                message: format!("Failed to serialize agent_config: {}", e),
            })?;

        let transitions_json =
            serde_json::to_string(&step.transitions_to).map_err(|e| DbError::ValidationError {
                message: format!("Failed to serialize transitions_to: {}", e),
            })?;

        let query = format!(
            r#"CREATE step:{} SET
                name = $name,
                workflow_id = {},
                agent_config = {},
                is_final = $is_final,
                transitions_to = {},
                order = $order"#,
            id, step.workflow_id, agent_config_json, transitions_json
        );

        let mut result = self
            .client
            .query(&query)
            .bind(("name", step.name.clone()))
            .bind(("is_final", step.is_final))
            .bind(("order", step.order))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        let created: Option<Step> = result.take(0)?;
        created.ok_or_else(|| DbError::ValidationError {
            message: format!("Failed to create step with id {}", id),
        })
    }

    /// Get a step by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The step ID to fetch
    ///
    /// # Returns
    ///
    /// `Some(Step)` if found, `None` otherwise.
    pub async fn get(&self, id: &str) -> DbResult<Option<Step>> {
        debug!("Fetching step: {}", id);
        let query = format!("SELECT * FROM step:{}", id);
        let mut result = self.client.query(&query).await.map_err(|e| {
            debug!("Failed to fetch step: {}: {}", id, e);
            DbError::Query(Box::new(e))
        })?;
        let step: Option<Step> = result.take(0)?;
        if step.is_some() {
            debug!("Successfully fetched step: {}", id);
        } else {
            debug!("Step not found: {}", id);
        }
        Ok(step)
    }

    /// Get a step by Thing reference.
    ///
    /// # Arguments
    ///
    /// * `thing` - The step Thing reference
    ///
    /// # Returns
    ///
    /// `Some(Step)` if found, `None` otherwise.
    pub async fn get_by_thing(&self, thing: &Thing) -> DbResult<Option<Step>> {
        debug!("Fetching step by thing: {}", thing);
        let query = format!("SELECT * FROM {}", thing);
        let mut result = self.client.query(&query).await.map_err(|e| {
            debug!("Failed to fetch step: {}: {}", thing, e);
            DbError::Query(Box::new(e))
        })?;
        let step: Option<Step> = result.take(0)?;
        Ok(step)
    }

    /// Check if a step with the given ID exists.
    ///
    /// # Arguments
    ///
    /// * `id` - The step ID to check
    ///
    /// # Returns
    ///
    /// `true` if the step exists, `false` otherwise.
    pub async fn exists(&self, id: &str) -> DbResult<bool> {
        let query = format!("SELECT id FROM step:{}", id);
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let step: Option<IdOnly> = result.take(0)?;
        Ok(step.is_some())
    }

    /// List all steps for a workflow.
    ///
    /// # Arguments
    ///
    /// * `workflow_id` - The workflow Thing reference
    ///
    /// # Returns
    ///
    /// A vector of steps belonging to the workflow, ordered by order field.
    pub async fn list_by_workflow(&self, workflow_id: &Thing) -> DbResult<Vec<Step>> {
        debug!("Listing steps for workflow: {}", workflow_id);
        let query = format!(
            "SELECT * FROM step WHERE workflow_id = {} ORDER BY order ASC",
            workflow_id
        );
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let steps: Vec<Step> = result.take(0)?;
        debug!("Found {} steps for workflow {}", steps.len(), workflow_id);
        Ok(steps)
    }

    /// List all steps.
    ///
    /// # Returns
    ///
    /// A vector of all steps in the database.
    pub async fn list(&self) -> DbResult<Vec<Step>> {
        debug!("Listing all steps");
        let mut result = self
            .client
            .query("SELECT * FROM step ORDER BY workflow_id, order ASC")
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let steps: Vec<Step> = result.take(0)?;
        debug!("Found {} steps", steps.len());
        Ok(steps)
    }

    /// Update a step.
    ///
    /// # Arguments
    ///
    /// * `id` - The step ID to update
    /// * `updates` - The updates to apply
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the step doesn't exist.
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update(&self, id: &str, updates: &StepUpdate) -> DbResult<()> {
        debug!("Updating step: {}", id);
        trace!("Updates: {:?}", updates);

        if !updates.has_updates() {
            debug!("No updates specified for step: {}", id);
            return Ok(());
        }

        // Check if step exists
        if !self.exists(id).await? {
            return Err(DbError::NotFound {
                entity: "step".to_string(),
                id: id.to_string(),
            });
        }

        let mut set_clauses = Vec::new();

        if let Some(name) = &updates.name {
            set_clauses.push(format!("name = \"{}\"", name.replace('\"', "\\\"")));
        }

        if let Some(agent_config) = &updates.agent_config {
            let json =
                serde_json::to_string(agent_config).map_err(|e| DbError::ValidationError {
                    message: format!("Failed to serialize agent_config: {}", e),
                })?;
            set_clauses.push(format!("agent_config = {}", json));
        }

        if let Some(is_final) = updates.is_final {
            set_clauses.push(format!("is_final = {}", is_final));
        }

        if let Some(transitions) = &updates.transitions_to {
            let json =
                serde_json::to_string(transitions).map_err(|e| DbError::ValidationError {
                    message: format!("Failed to serialize transitions_to: {}", e),
                })?;
            set_clauses.push(format!("transitions_to = {}", json));
        }

        if let Some(order) = updates.order {
            set_clauses.push(format!("order = {}", order));
        }

        set_clauses.push("updated_at = time::now()".to_string());

        let query = format!("UPDATE step:{} SET {}", id, set_clauses.join(", "));

        self.client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        debug!("Successfully updated step: {}", id);
        Ok(())
    }

    /// Delete a step.
    ///
    /// # Arguments
    ///
    /// * `id` - The step ID to delete
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the step doesn't exist.
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete(&self, id: &str) -> DbResult<()> {
        debug!("Deleting step: {}", id);

        // Check if step exists
        if !self.exists(id).await? {
            return Err(DbError::NotFound {
                entity: "step".to_string(),
                id: id.to_string(),
            });
        }

        let query = format!("DELETE step:{}", id);
        self.client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        debug!("Successfully deleted step: {}", id);
        Ok(())
    }

    /// Get the initial step for a workflow (the step with order 0).
    ///
    /// # Arguments
    ///
    /// * `workflow_id` - The workflow Thing reference
    ///
    /// # Returns
    ///
    /// `Some(Step)` if an initial step exists, `None` otherwise.
    pub async fn get_initial_step(&self, workflow_id: &Thing) -> DbResult<Option<Step>> {
        debug!("Getting initial step for workflow: {}", workflow_id);
        let query = format!(
            "SELECT * FROM step WHERE workflow_id = {} AND order = 0 LIMIT 1",
            workflow_id
        );
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let step: Option<Step> = result.take(0)?;
        Ok(step)
    }

    /// Get the next steps for a given step (based on transitions_to).
    ///
    /// # Arguments
    ///
    /// * `step_id` - The current step's Thing reference
    ///
    /// # Returns
    ///
    /// A vector of steps that the current step can transition to.
    pub async fn get_transitions(&self, step_id: &Thing) -> DbResult<Vec<Step>> {
        debug!("Getting transitions for step: {}", step_id);

        // First get the step to find its transitions
        let step = self.get_by_thing(step_id).await?;
        let Some(step) = step else {
            return Ok(Vec::new());
        };

        if step.transitions_to.is_empty() {
            return Ok(Vec::new());
        }

        // Fetch all transition targets
        let mut steps = Vec::new();
        for target in &step.transitions_to {
            if let Some(target_step) = self.get_by_thing(target).await? {
                steps.push(target_step);
            }
        }

        Ok(steps)
    }

    /// Get all final steps for a workflow.
    ///
    /// # Arguments
    ///
    /// * `workflow_id` - The workflow Thing reference
    ///
    /// # Returns
    ///
    /// A vector of steps marked as final.
    pub async fn get_final_steps(&self, workflow_id: &Thing) -> DbResult<Vec<Step>> {
        debug!("Getting final steps for workflow: {}", workflow_id);
        let query = format!(
            "SELECT * FROM step WHERE workflow_id = {} AND is_final = true ORDER BY order ASC",
            workflow_id
        );
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let steps: Vec<Step> = result.take(0)?;
        debug!(
            "Found {} final steps for workflow {}",
            steps.len(),
            workflow_id
        );
        Ok(steps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AgentConfig;
    use crate::schema::init_schema;
    use surrealdb::engine::local::Mem;

    async fn setup_test_db() -> Surreal<Db> {
        let client = Surreal::new::<Mem>(()).await.unwrap();
        client.use_ns("vertebrae").use_db("test").await.unwrap();
        init_schema(&client).await.unwrap();

        // Create a test workflow
        client
            .query(r#"CREATE workflow:test SET name = "Test Workflow""#)
            .await
            .unwrap();

        client
    }

    #[tokio::test]
    async fn test_create_step() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));
        let step = Step::new("Review", workflow_id.clone())
            .with_order(0)
            .with_is_final(false);

        let created = repo.create(&step).await.unwrap();
        assert!(created.id.is_some());
        assert_eq!(created.name, "Review");
        assert_eq!(created.workflow_id, workflow_id);
        assert!(!created.is_final);
    }

    #[tokio::test]
    async fn test_create_step_with_id() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));
        let step = Step::new("Build", workflow_id.clone()).with_order(1);

        let created = repo.create_with_id("build_step", &step).await.unwrap();
        assert_eq!(created.id.unwrap().to_string(), "step:build_step");
        assert_eq!(created.name, "Build");
    }

    #[tokio::test]
    async fn test_get_step() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));
        let step = Step::new("Test Step", workflow_id).with_order(0);

        let created = repo.create_with_id("get_test", &step).await.unwrap();

        let fetched = repo.get("get_test").await.unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().name, created.name);
    }

    #[tokio::test]
    async fn test_get_nonexistent_step() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let fetched = repo.get("nonexistent").await.unwrap();
        assert!(fetched.is_none());
    }

    #[tokio::test]
    async fn test_exists() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));
        let step = Step::new("Exists Step", workflow_id).with_order(0);
        repo.create_with_id("exists_test", &step).await.unwrap();

        assert!(repo.exists("exists_test").await.unwrap());
        assert!(!repo.exists("nonexistent").await.unwrap());
    }

    #[tokio::test]
    async fn test_list_by_workflow() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));

        // Create multiple steps
        let step1 = Step::new("Step 1", workflow_id.clone()).with_order(0);
        let step2 = Step::new("Step 2", workflow_id.clone()).with_order(1);
        let step3 = Step::new("Step 3", workflow_id.clone()).with_order(2);

        repo.create(&step1).await.unwrap();
        repo.create(&step2).await.unwrap();
        repo.create(&step3).await.unwrap();

        let steps = repo.list_by_workflow(&workflow_id).await.unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].name, "Step 1");
        assert_eq!(steps[1].name, "Step 2");
        assert_eq!(steps[2].name, "Step 3");
    }

    #[tokio::test]
    async fn test_update_step() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));
        let step = Step::new("Original", workflow_id).with_order(0);
        repo.create_with_id("update_test", &step).await.unwrap();

        let updates = StepUpdate::new()
            .with_name("Updated")
            .with_is_final(true)
            .with_order(5);

        repo.update("update_test", &updates).await.unwrap();

        let updated = repo.get("update_test").await.unwrap().unwrap();
        assert_eq!(updated.name, "Updated");
        assert!(updated.is_final);
        assert_eq!(updated.order, 5);
    }

    #[tokio::test]
    async fn test_update_nonexistent_step() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let updates = StepUpdate::new().with_name("New Name");
        let result = repo.update("nonexistent", &updates).await;
        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_delete_step() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));
        let step = Step::new("To Delete", workflow_id).with_order(0);
        repo.create_with_id("delete_test", &step).await.unwrap();

        assert!(repo.exists("delete_test").await.unwrap());
        repo.delete("delete_test").await.unwrap();
        assert!(!repo.exists("delete_test").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_nonexistent_step() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let result = repo.delete("nonexistent").await;
        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_get_initial_step() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));

        // Create steps with different orders
        let step0 = Step::new("Initial", workflow_id.clone()).with_order(0);
        let step1 = Step::new("Second", workflow_id.clone()).with_order(1);

        repo.create(&step0).await.unwrap();
        repo.create(&step1).await.unwrap();

        let initial = repo.get_initial_step(&workflow_id).await.unwrap();
        assert!(initial.is_some());
        assert_eq!(initial.unwrap().name, "Initial");
    }

    #[tokio::test]
    async fn test_get_final_steps() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));

        // Create steps with different is_final values
        let step1 = Step::new("Not Final", workflow_id.clone())
            .with_order(0)
            .with_is_final(false);
        let step2 = Step::new("Final 1", workflow_id.clone())
            .with_order(1)
            .with_is_final(true);
        let step3 = Step::new("Final 2", workflow_id.clone())
            .with_order(2)
            .with_is_final(true);

        repo.create(&step1).await.unwrap();
        repo.create(&step2).await.unwrap();
        repo.create(&step3).await.unwrap();

        let final_steps = repo.get_final_steps(&workflow_id).await.unwrap();
        assert_eq!(final_steps.len(), 2);
        assert!(final_steps.iter().all(|s| s.is_final));
    }

    #[tokio::test]
    async fn test_step_with_agent_config() {
        let client = setup_test_db().await;
        let repo = StepRepository::new(&client);

        let workflow_id = Thing::from(("workflow", "test"));
        let agent_config = AgentConfig::new()
            .with_model("opus")
            .with_system_prompt("You are a code reviewer");

        let step = Step::new("Review", workflow_id)
            .with_agent_config(agent_config.clone())
            .with_order(0);

        let created = repo.create_with_id("config_test", &step).await.unwrap();
        assert_eq!(created.agent_config.model, agent_config.model);
        assert_eq!(
            created.agent_config.system_prompt,
            agent_config.system_prompt
        );
    }
}
