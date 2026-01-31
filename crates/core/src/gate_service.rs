//! Gate service trait and implementation
//!
//! Provides the abstraction layer for validation gate operations. The `GateService` trait
//! defines the interface for all gate management operations, enabling both CLI and GUI
//! to share the same business logic.

use crate::error::{ServiceError, ServiceResult};
use crate::models::{ValidationGate, ValidationGateUpdate};
use async_trait::async_trait;
use vertebrae_db::{Database, Thing};

/// Service trait for validation gate operations
///
/// Provides a clean interface for managing validation gates, abstracting away
/// the underlying database implementation details.
#[async_trait]
pub trait GateService: Send + Sync {
    /// Create a new validation gate.
    ///
    /// # Arguments
    ///
    /// * `gate` - The validation gate to create
    ///
    /// # Returns
    ///
    /// The ID of the created gate
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the gate creation fails
    async fn create_gate(&self, gate: &ValidationGate) -> ServiceResult<String>;

    /// Create a validation gate with a specific ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The unique gate ID (will be lowercased)
    /// * `gate` - The validation gate to create
    ///
    /// # Returns
    ///
    /// The ID of the created gate
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the gate creation fails
    async fn create_gate_with_id(&self, id: &str, gate: &ValidationGate) -> ServiceResult<String>;

    /// Get a validation gate by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The gate ID (will be lowercased for lookup)
    ///
    /// # Returns
    ///
    /// The gate if found, or `None`
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the database query fails
    async fn get_gate(&self, id: &str) -> ServiceResult<Option<ValidationGate>>;

    /// Check if a gate exists.
    ///
    /// # Arguments
    ///
    /// * `id` - The gate ID (will be lowercased for lookup)
    ///
    /// # Returns
    ///
    /// `true` if the gate exists, `false` otherwise
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the database query fails
    async fn gate_exists(&self, id: &str) -> ServiceResult<bool>;

    /// List all validation gates.
    ///
    /// # Returns
    ///
    /// A vector of all validation gates in the database
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the database query fails
    async fn list_gates(&self) -> ServiceResult<Vec<ValidationGate>>;

    /// List validation gates by type.
    ///
    /// # Arguments
    ///
    /// * `gate_type` - The type of gates to list
    ///
    /// # Returns
    ///
    /// A vector of validation gates of the specified type
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the database query fails
    async fn list_gates_by_type(
        &self,
        gate_type: vertebrae_db::ValidationGateType,
    ) -> ServiceResult<Vec<ValidationGate>>;

    /// Update a validation gate.
    ///
    /// # Arguments
    ///
    /// * `id` - The gate ID (will be lowercased)
    /// * `updates` - The updates to apply
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the update fails
    async fn update_gate(&self, id: &str, updates: &ValidationGateUpdate) -> ServiceResult<()>;

    /// Delete a validation gate.
    ///
    /// # Arguments
    ///
    /// * `id` - The gate ID (will be lowercased)
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the deletion fails
    async fn delete_gate(&self, id: &str) -> ServiceResult<()>;

    /// Get all child gates for a composite gate.
    ///
    /// # Arguments
    ///
    /// * `gate_id` - The parent gate's ID
    ///
    /// # Returns
    ///
    /// A vector of child validation gates
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the query fails
    async fn get_child_gates(&self, gate_id: &str) -> ServiceResult<Vec<ValidationGate>>;
}

/// Default implementation of GateService backed by the database
pub struct DefaultGateService {
    db: Database,
}

impl DefaultGateService {
    /// Create a new DefaultGateService with the given database
    pub fn new(db: Database) -> Self {
        Self { db }
    }
}

#[async_trait]
impl GateService for DefaultGateService {
    async fn create_gate(&self, gate: &ValidationGate) -> ServiceResult<String> {
        let repo = self.db.validation_gates();
        let db_gate = gate.to_db();
        let created = repo.create(&db_gate).await?;

        created
            .id
            .map(|thing| thing.id.to_raw())
            .ok_or_else(|| ServiceError::ValidationFailed {
                message: "Gate created but no ID returned".to_string(),
            })
    }

    async fn create_gate_with_id(&self, id: &str, gate: &ValidationGate) -> ServiceResult<String> {
        let repo = self.db.validation_gates();
        let id_lower = id.to_lowercase();
        let db_gate = gate.to_db();

        let created = repo.create_with_id(&id_lower, &db_gate).await?;

        created
            .id
            .map(|thing| thing.id.to_raw())
            .ok_or_else(|| ServiceError::ValidationFailed {
                message: "Gate created but no ID returned".to_string(),
            })
    }

    async fn get_gate(&self, id: &str) -> ServiceResult<Option<ValidationGate>> {
        let repo = self.db.validation_gates();
        let id_lower = id.to_lowercase();

        let result = repo.get(&id_lower).await?;
        Ok(result.map(|db_gate| db_gate.into()))
    }

    async fn gate_exists(&self, id: &str) -> ServiceResult<bool> {
        let repo = self.db.validation_gates();
        let id_lower = id.to_lowercase();

        repo.exists(&id_lower).await.map_err(ServiceError::from)
    }

    async fn list_gates(&self) -> ServiceResult<Vec<ValidationGate>> {
        let repo = self.db.validation_gates();

        let results = repo.list().await?;
        Ok(results.into_iter().map(|db_gate| db_gate.into()).collect())
    }

    async fn list_gates_by_type(
        &self,
        gate_type: vertebrae_db::ValidationGateType,
    ) -> ServiceResult<Vec<ValidationGate>> {
        let repo = self.db.validation_gates();

        let results = repo.list_by_type(gate_type).await?;
        Ok(results.into_iter().map(|db_gate| db_gate.into()).collect())
    }

    async fn update_gate(&self, id: &str, updates: &ValidationGateUpdate) -> ServiceResult<()> {
        let repo = self.db.validation_gates();
        let id_lower = id.to_lowercase();
        let db_update = updates.to_db();

        repo.update(&id_lower, &db_update)
            .await
            .map_err(ServiceError::from)
    }

    async fn delete_gate(&self, id: &str) -> ServiceResult<()> {
        let repo = self.db.validation_gates();
        let id_lower = id.to_lowercase();

        repo.delete(&id_lower).await.map_err(ServiceError::from)
    }

    async fn get_child_gates(&self, gate_id: &str) -> ServiceResult<Vec<ValidationGate>> {
        let repo = self.db.validation_gates();

        // Parse the gate_id as a Thing reference
        let thing = Thing::from(("validation_gate", gate_id.to_lowercase().as_str()));

        let results = repo.get_child_gates(&thing).await?;
        Ok(results.into_iter().map(|db_gate| db_gate.into()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_db::ValidationGateType;

    async fn setup_service() -> DefaultGateService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultGateService::new(db)
    }

    #[tokio::test]
    async fn test_create_gate() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Test Gate");
        let id = service.create_gate(&gate).await.unwrap();

        assert!(!id.is_empty());
    }

    #[tokio::test]
    async fn test_create_gate_with_id() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Custom ID Gate");
        let id = service
            .create_gate_with_id("custom_gate", &gate)
            .await
            .unwrap();

        assert_eq!(id, "custom_gate");
    }

    #[tokio::test]
    async fn test_create_gate_with_id_lowercases() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Uppercase ID Gate");
        let id = service
            .create_gate_with_id("CUSTOM_GATE", &gate)
            .await
            .unwrap();

        assert_eq!(id, "custom_gate");
    }

    #[tokio::test]
    async fn test_get_gate() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Get Test");
        let created_id = service
            .create_gate_with_id("get_test", &gate)
            .await
            .unwrap();

        let fetched = service.get_gate(&created_id).await.unwrap();

        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().name, "Get Test");
    }

    #[tokio::test]
    async fn test_get_gate_not_found() {
        let service = setup_service().await;

        let result = service.get_gate("nonexistent").await.unwrap();

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_get_gate_lowercases() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Lowercase Test");
        service
            .create_gate_with_id("lowercase_test", &gate)
            .await
            .unwrap();

        let fetched = service.get_gate("LOWERCASE_TEST").await.unwrap();

        assert!(fetched.is_some());
    }

    #[tokio::test]
    async fn test_gate_exists() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Exists Test");
        service
            .create_gate_with_id("exists_test", &gate)
            .await
            .unwrap();

        assert!(service.gate_exists("exists_test").await.unwrap());
        assert!(!service.gate_exists("not_exists").await.unwrap());
    }

    #[tokio::test]
    async fn test_gate_exists_lowercases() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Exists Lowercase Test");
        service
            .create_gate_with_id("exists_lower", &gate)
            .await
            .unwrap();

        assert!(service.gate_exists("EXISTS_LOWER").await.unwrap());
    }

    #[tokio::test]
    async fn test_list_gates() {
        let service = setup_service().await;

        service
            .create_gate(&ValidationGate::manual_approval("Gate A"))
            .await
            .unwrap();
        service
            .create_gate(&ValidationGate::manual_approval("Gate B"))
            .await
            .unwrap();
        service
            .create_gate(&ValidationGate::command_execution("Gate C", "test"))
            .await
            .unwrap();

        let gates = service.list_gates().await.unwrap();

        assert_eq!(gates.len(), 3);
    }

    #[tokio::test]
    async fn test_list_gates_by_type() {
        let service = setup_service().await;

        service
            .create_gate(&ValidationGate::manual_approval("Manual 1"))
            .await
            .unwrap();
        service
            .create_gate(&ValidationGate::manual_approval("Manual 2"))
            .await
            .unwrap();
        service
            .create_gate(&ValidationGate::command_execution("Cmd 1", "test"))
            .await
            .unwrap();

        let manual_gates = service
            .list_gates_by_type(ValidationGateType::ManualApproval)
            .await
            .unwrap();
        assert_eq!(manual_gates.len(), 2);

        let cmd_gates = service
            .list_gates_by_type(ValidationGateType::CommandExecution)
            .await
            .unwrap();
        assert_eq!(cmd_gates.len(), 1);
    }

    #[tokio::test]
    async fn test_update_gate() {
        let service = setup_service().await;

        let gate = ValidationGate::command_execution("Original", "old_cmd");
        service
            .create_gate_with_id("update_test", &gate)
            .await
            .unwrap();

        let update = ValidationGateUpdate::new()
            .with_name("Updated")
            .with_command("new_cmd")
            .with_timeout_seconds(120);
        service.update_gate("update_test", &update).await.unwrap();

        let fetched = service.get_gate("update_test").await.unwrap().unwrap();
        assert_eq!(fetched.name, "Updated");
        assert_eq!(fetched.command, Some("new_cmd".to_string()));
        assert_eq!(fetched.timeout_seconds, Some(120));
    }

    #[tokio::test]
    async fn test_update_gate_lowercases() {
        let service = setup_service().await;

        let gate = ValidationGate::command_execution("Original", "old_cmd");
        service
            .create_gate_with_id("update_lower", &gate)
            .await
            .unwrap();

        let update = ValidationGateUpdate::new().with_name("Updated");
        service.update_gate("UPDATE_LOWER", &update).await.unwrap();

        let fetched = service.get_gate("update_lower").await.unwrap().unwrap();
        assert_eq!(fetched.name, "Updated");
    }

    #[tokio::test]
    async fn test_delete_gate() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Delete Test");
        service
            .create_gate_with_id("delete_test", &gate)
            .await
            .unwrap();

        assert!(service.gate_exists("delete_test").await.unwrap());

        service.delete_gate("delete_test").await.unwrap();

        assert!(!service.gate_exists("delete_test").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_gate_lowercases() {
        let service = setup_service().await;

        let gate = ValidationGate::manual_approval("Delete Lowercase Test");
        service
            .create_gate_with_id("delete_lower", &gate)
            .await
            .unwrap();

        service.delete_gate("DELETE_LOWER").await.unwrap();

        assert!(!service.gate_exists("delete_lower").await.unwrap());
    }

    #[tokio::test]
    async fn test_get_child_gates() {
        let service = setup_service().await;

        // Create child gates
        let child1_id = service
            .create_gate_with_id("child1", &ValidationGate::manual_approval("Child 1"))
            .await
            .unwrap();
        let child2_id = service
            .create_gate_with_id(
                "child2",
                &ValidationGate::command_execution("Child 2", "test"),
            )
            .await
            .unwrap();

        // Get the gates to get their Thing references
        let child1 = service.get_gate(&child1_id).await.unwrap().unwrap();
        let child2 = service.get_gate(&child2_id).await.unwrap().unwrap();

        // Create parent composite gate
        let parent =
            ValidationGate::composite("Parent", vertebrae_db::ValidationMechanism::AllMustPass)
                .with_child_gate(child1.id.unwrap())
                .with_child_gate(child2.id.unwrap());
        let parent_id = service
            .create_gate_with_id("parent", &parent)
            .await
            .unwrap();

        // Get child gates
        let children = service.get_child_gates(&parent_id).await.unwrap();
        assert_eq!(children.len(), 2);
    }
}
