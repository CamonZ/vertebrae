//! ValidationGate repository for CRUD operations on validation gates
//!
//! Provides a repository pattern implementation for validation gate operations,
//! encapsulating SurrealDB queries and providing a clean API.

use crate::error::{DbError, DbResult};
use crate::models::{ValidationGate, ValidationGateType, ValidationMechanism};
use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;
use surrealdb::sql::Thing;
use tracing::{debug, trace};

/// Repository for validation gate CRUD operations
///
/// Encapsulates database queries for validation gates, providing a clean API
/// that hides the underlying SurrealDB implementation details.
pub struct ValidationGateRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Update structure for partial validation gate updates
#[derive(Debug, Default)]
pub struct ValidationGateUpdate {
    /// New name (if Some)
    pub name: Option<String>,
    /// New description (if Some)
    pub description: Option<String>,
    /// New mechanism (if Some)
    pub mechanism: Option<ValidationMechanism>,
    /// New child_gates list (if Some, replaces entire list)
    pub child_gates: Option<Vec<Thing>>,
    /// New pass_threshold (if Some)
    pub pass_threshold: Option<f64>,
    /// New command (if Some)
    pub command: Option<String>,
    /// New timeout_seconds (if Some)
    pub timeout_seconds: Option<u32>,
    /// New agent_config (if Some)
    pub agent_config: Option<serde_json::Value>,
    /// New classification_prompt (if Some)
    pub classification_prompt: Option<String>,
}

impl ValidationGateUpdate {
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
        self.description = Some(description.into());
        self
    }

    /// Set a new mechanism
    pub fn with_mechanism(mut self, mechanism: ValidationMechanism) -> Self {
        self.mechanism = Some(mechanism);
        self
    }

    /// Set new child gates
    pub fn with_child_gates(mut self, child_gates: Vec<Thing>) -> Self {
        self.child_gates = Some(child_gates);
        self
    }

    /// Set a new pass threshold
    pub fn with_pass_threshold(mut self, threshold: f64) -> Self {
        self.pass_threshold = Some(threshold);
        self
    }

    /// Set a new command
    pub fn with_command(mut self, command: impl Into<String>) -> Self {
        self.command = Some(command.into());
        self
    }

    /// Set new timeout in seconds
    pub fn with_timeout_seconds(mut self, seconds: u32) -> Self {
        self.timeout_seconds = Some(seconds);
        self
    }

    /// Set a new agent config
    pub fn with_agent_config(mut self, config: serde_json::Value) -> Self {
        self.agent_config = Some(config);
        self
    }

    /// Set a new classification prompt
    pub fn with_classification_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.classification_prompt = Some(prompt.into());
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.name.is_some()
            || self.description.is_some()
            || self.mechanism.is_some()
            || self.child_gates.is_some()
            || self.pass_threshold.is_some()
            || self.command.is_some()
            || self.timeout_seconds.is_some()
            || self.agent_config.is_some()
            || self.classification_prompt.is_some()
    }
}

/// Minimal row for checking gate existence
#[derive(Debug, Deserialize)]
struct IdOnly {
    #[allow(dead_code)]
    id: Thing,
}

impl<'a> ValidationGateRepository<'a> {
    /// Create a new ValidationGateRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Create a new validation gate.
    ///
    /// # Arguments
    ///
    /// * `gate` - The validation gate data to create
    ///
    /// # Returns
    ///
    /// The created validation gate with its assigned ID.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    /// Returns `DbError::ValidationError` if gate validation fails.
    pub async fn create(&self, gate: &ValidationGate) -> DbResult<ValidationGate> {
        debug!("Creating validation gate: {}", gate.name);
        trace!("Gate data: {:?}", gate);

        // Validate the gate configuration
        gate.validate()
            .map_err(|e| DbError::ValidationError { message: e })?;

        let child_gates_str = format_child_gates(&gate.child_gates);

        let mut set_clauses = vec![
            "name = $name".to_string(),
            format!("gate_type = \"{}\"", gate.gate_type.as_str()),
        ];

        if let Some(desc) = &gate.description {
            set_clauses.push(format!("description = \"{}\"", desc.replace('\"', "\\\"")));
        }

        if let Some(mech) = &gate.mechanism {
            set_clauses.push(format!("mechanism = \"{}\"", mech.as_str()));
        }

        if !gate.child_gates.is_empty() {
            set_clauses.push(format!("child_gates = [{}]", child_gates_str));
        }

        if let Some(threshold) = gate.pass_threshold {
            set_clauses.push(format!("pass_threshold = {}", threshold));
        }

        if let Some(cmd) = &gate.command {
            set_clauses.push(format!("command = \"{}\"", cmd.replace('\"', "\\\"")));
        }

        if let Some(timeout) = gate.timeout_seconds {
            set_clauses.push(format!("timeout_seconds = {}", timeout));
        }

        if let Some(config) = &gate.agent_config {
            let json = serde_json::to_string(config).map_err(|e| DbError::ValidationError {
                message: format!("Failed to serialize agent_config: {}", e),
            })?;
            set_clauses.push(format!("agent_config = {}", json));
        }

        if let Some(prompt) = &gate.classification_prompt {
            set_clauses.push(format!(
                "classification_prompt = \"{}\"",
                prompt.replace('\"', "\\\"")
            ));
        }

        let query = format!("CREATE validation_gate SET {}", set_clauses.join(", "));

        let mut result = self
            .client
            .query(&query)
            .bind(("name", gate.name.clone()))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        let created: Option<ValidationGate> = result.take(0)?;
        created.ok_or_else(|| DbError::ValidationError {
            message: "Failed to create validation gate".to_string(),
        })
    }

    /// Create a validation gate with a specific ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The unique gate ID
    /// * `gate` - The validation gate data to create
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create_with_id(
        &self,
        id: &str,
        gate: &ValidationGate,
    ) -> DbResult<ValidationGate> {
        debug!("Creating validation gate with id {}: {}", id, gate.name);
        trace!("Gate data: {:?}", gate);

        // Validate the gate configuration
        gate.validate()
            .map_err(|e| DbError::ValidationError { message: e })?;

        let child_gates_str = format_child_gates(&gate.child_gates);

        let mut set_clauses = vec![
            "name = $name".to_string(),
            format!("gate_type = \"{}\"", gate.gate_type.as_str()),
        ];

        if let Some(desc) = &gate.description {
            set_clauses.push(format!("description = \"{}\"", desc.replace('\"', "\\\"")));
        }

        if let Some(mech) = &gate.mechanism {
            set_clauses.push(format!("mechanism = \"{}\"", mech.as_str()));
        }

        if !gate.child_gates.is_empty() {
            set_clauses.push(format!("child_gates = [{}]", child_gates_str));
        }

        if let Some(threshold) = gate.pass_threshold {
            set_clauses.push(format!("pass_threshold = {}", threshold));
        }

        if let Some(cmd) = &gate.command {
            set_clauses.push(format!("command = \"{}\"", cmd.replace('\"', "\\\"")));
        }

        if let Some(timeout) = gate.timeout_seconds {
            set_clauses.push(format!("timeout_seconds = {}", timeout));
        }

        if let Some(config) = &gate.agent_config {
            let json = serde_json::to_string(config).map_err(|e| DbError::ValidationError {
                message: format!("Failed to serialize agent_config: {}", e),
            })?;
            set_clauses.push(format!("agent_config = {}", json));
        }

        if let Some(prompt) = &gate.classification_prompt {
            set_clauses.push(format!(
                "classification_prompt = \"{}\"",
                prompt.replace('\"', "\\\"")
            ));
        }

        let query = format!(
            "CREATE validation_gate:{} SET {}",
            id,
            set_clauses.join(", ")
        );

        let mut result = self
            .client
            .query(&query)
            .bind(("name", gate.name.clone()))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        let created: Option<ValidationGate> = result.take(0)?;
        created.ok_or_else(|| DbError::ValidationError {
            message: format!("Failed to create validation gate with id {}", id),
        })
    }

    /// Get a validation gate by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The gate ID to fetch
    ///
    /// # Returns
    ///
    /// `Some(ValidationGate)` if found, `None` otherwise.
    pub async fn get(&self, id: &str) -> DbResult<Option<ValidationGate>> {
        debug!("Fetching validation gate: {}", id);
        let query = format!("SELECT * FROM validation_gate:{}", id);
        let mut result = self.client.query(&query).await.map_err(|e| {
            debug!("Failed to fetch validation gate: {}: {}", id, e);
            DbError::Query(Box::new(e))
        })?;
        let gate: Option<ValidationGate> = result.take(0)?;
        if gate.is_some() {
            debug!("Successfully fetched validation gate: {}", id);
        } else {
            debug!("Validation gate not found: {}", id);
        }
        Ok(gate)
    }

    /// Get a validation gate by Thing reference.
    ///
    /// # Arguments
    ///
    /// * `thing` - The gate Thing reference
    ///
    /// # Returns
    ///
    /// `Some(ValidationGate)` if found, `None` otherwise.
    pub async fn get_by_thing(&self, thing: &Thing) -> DbResult<Option<ValidationGate>> {
        debug!("Fetching validation gate by thing: {}", thing);
        let query = format!("SELECT * FROM {}", thing);
        let mut result = self.client.query(&query).await.map_err(|e| {
            debug!("Failed to fetch validation gate: {}: {}", thing, e);
            DbError::Query(Box::new(e))
        })?;
        let gate: Option<ValidationGate> = result.take(0)?;
        Ok(gate)
    }

    /// Check if a validation gate with the given ID exists.
    ///
    /// # Arguments
    ///
    /// * `id` - The gate ID to check
    ///
    /// # Returns
    ///
    /// `true` if the gate exists, `false` otherwise.
    pub async fn exists(&self, id: &str) -> DbResult<bool> {
        let query = format!("SELECT id FROM validation_gate:{}", id);
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let gate: Option<IdOnly> = result.take(0)?;
        Ok(gate.is_some())
    }

    /// List all validation gates.
    ///
    /// # Returns
    ///
    /// A vector of all validation gates in the database.
    pub async fn list(&self) -> DbResult<Vec<ValidationGate>> {
        debug!("Listing all validation gates");
        let mut result = self
            .client
            .query("SELECT * FROM validation_gate ORDER BY name ASC")
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let gates: Vec<ValidationGate> = result.take(0)?;
        debug!("Found {} validation gates", gates.len());
        Ok(gates)
    }

    /// List validation gates by type.
    ///
    /// # Arguments
    ///
    /// * `gate_type` - The type of gates to list
    ///
    /// # Returns
    ///
    /// A vector of validation gates of the specified type.
    pub async fn list_by_type(
        &self,
        gate_type: ValidationGateType,
    ) -> DbResult<Vec<ValidationGate>> {
        debug!("Listing validation gates of type: {}", gate_type);
        let query = format!(
            "SELECT * FROM validation_gate WHERE gate_type = \"{}\" ORDER BY name ASC",
            gate_type.as_str()
        );
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let gates: Vec<ValidationGate> = result.take(0)?;
        debug!(
            "Found {} validation gates of type {}",
            gates.len(),
            gate_type
        );
        Ok(gates)
    }

    /// Update a validation gate.
    ///
    /// # Arguments
    ///
    /// * `id` - The gate ID to update
    /// * `updates` - The updates to apply
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the gate doesn't exist.
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update(&self, id: &str, updates: &ValidationGateUpdate) -> DbResult<()> {
        debug!("Updating validation gate: {}", id);
        trace!("Updates: {:?}", updates);

        if !updates.has_updates() {
            debug!("No updates specified for validation gate: {}", id);
            return Ok(());
        }

        // Check if gate exists
        if !self.exists(id).await? {
            return Err(DbError::NotFound {
                entity: "validation_gate".to_string(),
                id: id.to_string(),
            });
        }

        let mut set_clauses = Vec::new();

        if let Some(name) = &updates.name {
            set_clauses.push(format!("name = \"{}\"", name.replace('\"', "\\\"")));
        }

        if let Some(desc) = &updates.description {
            set_clauses.push(format!("description = \"{}\"", desc.replace('\"', "\\\"")));
        }

        if let Some(mech) = &updates.mechanism {
            set_clauses.push(format!("mechanism = \"{}\"", mech.as_str()));
        }

        if let Some(child_gates) = &updates.child_gates {
            let refs = format_child_gates(child_gates);
            set_clauses.push(format!("child_gates = [{}]", refs));
        }

        if let Some(threshold) = updates.pass_threshold {
            set_clauses.push(format!("pass_threshold = {}", threshold));
        }

        if let Some(cmd) = &updates.command {
            set_clauses.push(format!("command = \"{}\"", cmd.replace('\"', "\\\"")));
        }

        if let Some(timeout) = updates.timeout_seconds {
            set_clauses.push(format!("timeout_seconds = {}", timeout));
        }

        if let Some(config) = &updates.agent_config {
            let json = serde_json::to_string(config).map_err(|e| DbError::ValidationError {
                message: format!("Failed to serialize agent_config: {}", e),
            })?;
            set_clauses.push(format!("agent_config = {}", json));
        }

        if let Some(prompt) = &updates.classification_prompt {
            set_clauses.push(format!(
                "classification_prompt = \"{}\"",
                prompt.replace('\"', "\\\"")
            ));
        }

        set_clauses.push("updated_at = time::now()".to_string());

        let query = format!(
            "UPDATE validation_gate:{} SET {}",
            id,
            set_clauses.join(", ")
        );

        self.client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        debug!("Successfully updated validation gate: {}", id);
        Ok(())
    }

    /// Delete a validation gate.
    ///
    /// # Arguments
    ///
    /// * `id` - The gate ID to delete
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the gate doesn't exist.
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete(&self, id: &str) -> DbResult<()> {
        debug!("Deleting validation gate: {}", id);

        // Check if gate exists
        if !self.exists(id).await? {
            return Err(DbError::NotFound {
                entity: "validation_gate".to_string(),
                id: id.to_string(),
            });
        }

        let query = format!("DELETE validation_gate:{}", id);
        self.client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        debug!("Successfully deleted validation gate: {}", id);
        Ok(())
    }

    /// Get all child gates for a composite gate.
    ///
    /// # Arguments
    ///
    /// * `gate_id` - The parent gate's Thing reference
    ///
    /// # Returns
    ///
    /// A vector of child validation gates.
    pub async fn get_child_gates(&self, gate_id: &Thing) -> DbResult<Vec<ValidationGate>> {
        debug!("Getting child gates for: {}", gate_id);

        // First get the parent gate
        let parent = self.get_by_thing(gate_id).await?;
        let Some(parent) = parent else {
            return Ok(Vec::new());
        };

        if parent.child_gates.is_empty() {
            return Ok(Vec::new());
        }

        // Fetch all child gates
        let mut gates = Vec::new();
        for child_ref in &parent.child_gates {
            if let Some(child) = self.get_by_thing(child_ref).await? {
                gates.push(child);
            }
        }

        debug!("Found {} child gates for {}", gates.len(), gate_id);
        Ok(gates)
    }
}

/// Format child gates as SurrealDB record references
fn format_child_gates(child_gates: &[Thing]) -> String {
    child_gates
        .iter()
        .map(|t| format!("{}:{}", t.tb, t.id.to_raw()))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AgentConfig;
    use crate::schema::init_schema;
    use surrealdb::engine::local::Mem;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Surreal<Db> {
        let client = Surreal::new::<Mem>(()).await.unwrap();
        client.use_ns("vertebrae").use_db("test").await.unwrap();
        init_schema(&client).await.unwrap();
        client
    }

    #[tokio::test]
    async fn test_create_command_execution_gate() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let gate = ValidationGate::command_execution("Test Runner", "cargo test");
        let created = repo.create(&gate).await.unwrap();

        assert!(created.id.is_some());
        assert_eq!(created.name, "Test Runner");
        assert_eq!(created.gate_type, ValidationGateType::CommandExecution);
        assert_eq!(created.command, Some("cargo test".to_string()));
    }

    #[tokio::test]
    async fn test_create_manual_approval_gate() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let gate = ValidationGate::manual_approval("Code Review")
            .with_description("Requires human approval");
        let created = repo.create(&gate).await.unwrap();

        assert!(created.id.is_some());
        assert_eq!(created.name, "Code Review");
        assert_eq!(created.gate_type, ValidationGateType::ManualApproval);
        assert_eq!(
            created.description,
            Some("Requires human approval".to_string())
        );
    }

    #[tokio::test]
    async fn test_create_agent_classification_gate() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let config = AgentConfig::new().with_model("sonnet");
        let gate = ValidationGate::agent_classification(
            "Quality Check",
            "Is this code production ready?",
            config,
        );
        let created = repo.create(&gate).await.unwrap();

        assert!(created.id.is_some());
        assert_eq!(created.name, "Quality Check");
        assert_eq!(created.gate_type, ValidationGateType::AgentClassification);
        assert!(created.classification_prompt.is_some());
    }

    #[tokio::test]
    async fn test_create_composite_gate() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        // Create child gates first
        let child1 = repo
            .create(&ValidationGate::manual_approval("Child 1"))
            .await
            .unwrap();
        let child2 = repo
            .create(&ValidationGate::command_execution("Child 2", "echo ok"))
            .await
            .unwrap();

        // Create composite gate
        let gate = ValidationGate::composite("Combined", ValidationMechanism::AllMustPass)
            .with_child_gate(child1.id.unwrap())
            .with_child_gate(child2.id.unwrap());
        let created = repo.create(&gate).await.unwrap();

        assert!(created.id.is_some());
        assert_eq!(created.name, "Combined");
        assert_eq!(created.gate_type, ValidationGateType::Composite);
        assert_eq!(created.mechanism, Some(ValidationMechanism::AllMustPass));
        assert_eq!(created.child_gates.len(), 2);
    }

    #[tokio::test]
    async fn test_create_with_id() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let gate = ValidationGate::manual_approval("Custom ID Gate");
        let created = repo.create_with_id("custom_gate", &gate).await.unwrap();

        assert!(created.id.is_some());
        let id = created.id.as_ref().unwrap();
        assert_eq!(id.id.to_raw(), "custom_gate");
    }

    #[tokio::test]
    async fn test_get() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let gate = ValidationGate::manual_approval("Get Test");
        let created = repo.create_with_id("get_test", &gate).await.unwrap();

        let fetched = repo.get("get_test").await.unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().name, created.name);
    }

    #[tokio::test]
    async fn test_get_not_found() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let result = repo.get("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_exists() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let gate = ValidationGate::manual_approval("Exists Test");
        repo.create_with_id("exists_test", &gate).await.unwrap();

        assert!(repo.exists("exists_test").await.unwrap());
        assert!(!repo.exists("not_exists").await.unwrap());
    }

    #[tokio::test]
    async fn test_list() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        repo.create(&ValidationGate::manual_approval("Gate A"))
            .await
            .unwrap();
        repo.create(&ValidationGate::manual_approval("Gate B"))
            .await
            .unwrap();
        repo.create(&ValidationGate::command_execution("Gate C", "test"))
            .await
            .unwrap();

        let gates = repo.list().await.unwrap();
        assert_eq!(gates.len(), 3);
    }

    #[tokio::test]
    async fn test_list_by_type() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        repo.create(&ValidationGate::manual_approval("Manual 1"))
            .await
            .unwrap();
        repo.create(&ValidationGate::manual_approval("Manual 2"))
            .await
            .unwrap();
        repo.create(&ValidationGate::command_execution("Cmd 1", "test"))
            .await
            .unwrap();

        let manual_gates = repo
            .list_by_type(ValidationGateType::ManualApproval)
            .await
            .unwrap();
        assert_eq!(manual_gates.len(), 2);

        let cmd_gates = repo
            .list_by_type(ValidationGateType::CommandExecution)
            .await
            .unwrap();
        assert_eq!(cmd_gates.len(), 1);
    }

    #[tokio::test]
    async fn test_update() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let gate = ValidationGate::command_execution("Original", "old_cmd");
        repo.create_with_id("update_test", &gate).await.unwrap();

        let update = ValidationGateUpdate::new()
            .with_name("Updated")
            .with_command("new_cmd")
            .with_timeout_seconds(120);
        repo.update("update_test", &update).await.unwrap();

        let fetched = repo.get("update_test").await.unwrap().unwrap();
        assert_eq!(fetched.name, "Updated");
        assert_eq!(fetched.command, Some("new_cmd".to_string()));
        assert_eq!(fetched.timeout_seconds, Some(120));
    }

    #[tokio::test]
    async fn test_update_not_found() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let update = ValidationGateUpdate::new().with_name("New Name");
        let result = repo.update("nonexistent", &update).await;

        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_delete() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let gate = ValidationGate::manual_approval("Delete Test");
        repo.create_with_id("delete_test", &gate).await.unwrap();

        assert!(repo.exists("delete_test").await.unwrap());

        repo.delete("delete_test").await.unwrap();

        assert!(!repo.exists("delete_test").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_not_found() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        let result = repo.delete("nonexistent").await;
        assert!(matches!(result, Err(DbError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_get_child_gates() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        // Create child gates
        let child1 = repo
            .create_with_id("child1", &ValidationGate::manual_approval("Child 1"))
            .await
            .unwrap();
        let child2 = repo
            .create_with_id(
                "child2",
                &ValidationGate::command_execution("Child 2", "test"),
            )
            .await
            .unwrap();

        // Create parent composite gate
        let parent = ValidationGate::composite("Parent", ValidationMechanism::AllMustPass)
            .with_child_gate(child1.id.clone().unwrap())
            .with_child_gate(child2.id.clone().unwrap());
        let created = repo.create_with_id("parent", &parent).await.unwrap();

        // Get child gates
        let children = repo.get_child_gates(&created.id.unwrap()).await.unwrap();
        assert_eq!(children.len(), 2);
    }

    #[tokio::test]
    async fn test_validation_fails_for_invalid_gate() {
        let client = setup_test_db().await;
        let repo = ValidationGateRepository::new(&client);

        // Try to create a CommandExecution gate without a command
        let gate = ValidationGate::new("Invalid", ValidationGateType::CommandExecution);
        let result = repo.create(&gate).await;

        assert!(matches!(result, Err(DbError::ValidationError { .. })));
    }
}
