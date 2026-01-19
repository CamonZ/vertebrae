//! StatusSchema repository for CRUD operations on status schemas
//!
//! Provides a repository pattern implementation for status schema operations,
//! encapsulating SurrealDB queries and providing a clean API.

use crate::error::{DbError, DbResult};
use crate::models::{StatusDefinition, StatusProgression, StatusSchema};
use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;
use tracing::debug;

/// The ID of the default status schema.
///
/// This schema is automatically created during database initialization
/// and provides the standard status flow for tasks.
pub const DEFAULT_STATUS_SCHEMA_ID: &str = "default";

/// Repository for status schema CRUD operations
///
/// Encapsulates database queries for status schemas, providing a clean API
/// that hides the underlying SurrealDB implementation details.
pub struct StatusSchemaRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Update structure for partial status schema updates
#[derive(Debug, Default)]
pub struct StatusSchemaUpdate {
    /// New name (if Some)
    pub name: Option<String>,
    /// New description (if Some, None clears it, absent leaves unchanged)
    pub description: Option<Option<String>>,
    /// Whether this is the default schema
    pub is_default: Option<bool>,
    /// Status definitions to set (replaces entire statuses array)
    pub statuses: Option<Vec<StatusDefinition>>,
    /// Progression rules to set (replaces entire progressions array)
    pub progressions: Option<Vec<StatusProgression>>,
}

impl StatusSchemaUpdate {
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

    /// Set whether this is the default schema
    pub fn with_is_default(mut self, is_default: bool) -> Self {
        self.is_default = Some(is_default);
        self
    }

    /// Set status definitions
    pub fn with_statuses(mut self, statuses: Vec<StatusDefinition>) -> Self {
        self.statuses = Some(statuses);
        self
    }

    /// Set progression rules
    pub fn with_progressions(mut self, progressions: Vec<StatusProgression>) -> Self {
        self.progressions = Some(progressions);
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.name.is_some()
            || self.description.is_some()
            || self.is_default.is_some()
            || self.statuses.is_some()
            || self.progressions.is_some()
    }
}

/// Minimal row for checking schema existence
#[derive(Debug, Deserialize)]
struct IdOnly {
    #[allow(dead_code)]
    id: surrealdb::sql::Thing,
}

impl<'a> StatusSchemaRepository<'a> {
    /// Create a new StatusSchemaRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Check if a status schema with the given ID exists.
    ///
    /// # Arguments
    ///
    /// * `id` - The schema ID to check
    ///
    /// # Returns
    ///
    /// `Ok(true)` if the schema exists, `Ok(false)` otherwise.
    pub async fn exists(&self, id: &str) -> DbResult<bool> {
        let query = format!("SELECT id FROM status_schema:{}", id);
        let mut result = self.client.query(&query).await?;
        let row: Option<IdOnly> = result.take(0)?;
        Ok(row.is_some())
    }

    /// Create a new status schema in the database.
    ///
    /// # Arguments
    ///
    /// * `schema` - The status schema to create
    ///
    /// # Returns
    ///
    /// The created status schema with its assigned ID.
    ///
    /// # Errors
    ///
    /// Returns `DbError::ValidationError` if the schema fails validation.
    pub async fn create(&self, schema: StatusSchema) -> DbResult<StatusSchema> {
        // Validate the schema before inserting
        schema.validate().map_err(|msg| DbError::ValidationError {
            message: format!("Invalid status schema: {}", msg),
        })?;

        debug!("Creating status schema '{}'", schema.name);

        let statuses_json = serde_json::to_string(&schema.statuses)?;
        let progressions_json = serde_json::to_string(&schema.progressions)?;

        let query = format!(
            r#"CREATE status_schema SET
                name = "{}",
                description = {},
                is_default = {},
                statuses = {},
                progressions = {},
                created_at = time::now(),
                updated_at = time::now()
            "#,
            schema.name,
            match &schema.description {
                Some(desc) => format!(r#""{}""#, desc.replace('"', "\\\"")),
                None => "NONE".to_string(),
            },
            schema.is_default,
            statuses_json,
            progressions_json,
        );

        let mut result = self.client.query(&query).await?;
        let created: Option<StatusSchema> = result.take(0)?;

        created.ok_or_else(|| DbError::NotFound {
            entity: "status_schema".to_string(),
            id: schema.name.clone(),
        })
    }

    /// Create a new status schema with a specific ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The ID to use for the new schema
    /// * `schema` - The status schema to create
    ///
    /// # Returns
    ///
    /// The created status schema.
    pub async fn create_with_id(&self, id: &str, schema: StatusSchema) -> DbResult<StatusSchema> {
        // Validate the schema before inserting
        schema.validate().map_err(|msg| DbError::ValidationError {
            message: format!("Invalid status schema: {}", msg),
        })?;

        debug!("Creating status schema '{}' with ID '{}'", schema.name, id);

        let statuses_json = serde_json::to_string(&schema.statuses)?;
        let progressions_json = serde_json::to_string(&schema.progressions)?;

        let query = format!(
            r#"CREATE status_schema:{} SET
                name = "{}",
                description = {},
                is_default = {},
                statuses = {},
                progressions = {},
                created_at = time::now(),
                updated_at = time::now()
            "#,
            id,
            schema.name,
            match &schema.description {
                Some(desc) => format!(r#""{}""#, desc.replace('"', "\\\"")),
                None => "NONE".to_string(),
            },
            schema.is_default,
            statuses_json,
            progressions_json,
        );

        let mut result = self.client.query(&query).await?;
        let created: Option<StatusSchema> = result.take(0)?;

        created.ok_or_else(|| DbError::NotFound {
            entity: "status_schema".to_string(),
            id: id.to_string(),
        })
    }

    /// Get a status schema by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The schema ID to retrieve
    ///
    /// # Returns
    ///
    /// The status schema if found, or `None` if not found.
    pub async fn get(&self, id: &str) -> DbResult<Option<StatusSchema>> {
        let query = format!("SELECT * FROM status_schema:{}", id);
        let mut result = self.client.query(&query).await?;
        let schema: Option<StatusSchema> = result.take(0)?;
        Ok(schema)
    }

    /// Get the default status schema.
    ///
    /// # Returns
    ///
    /// The default status schema, or `None` if no default is set.
    pub async fn get_default(&self) -> DbResult<Option<StatusSchema>> {
        let query = "SELECT * FROM status_schema WHERE is_default = true LIMIT 1";
        let mut result = self.client.query(query).await?;
        let schema: Option<StatusSchema> = result.take(0)?;
        Ok(schema)
    }

    /// List all status schemas.
    ///
    /// # Returns
    ///
    /// A vector of all status schemas, ordered by name.
    pub async fn list(&self) -> DbResult<Vec<StatusSchema>> {
        let query = "SELECT * FROM status_schema ORDER BY name";
        let mut result = self.client.query(query).await?;
        let schemas: Vec<StatusSchema> = result.take(0)?;
        Ok(schemas)
    }

    /// Update a status schema.
    ///
    /// # Arguments
    ///
    /// * `id` - The schema ID to update
    /// * `update` - The fields to update
    ///
    /// # Returns
    ///
    /// The updated status schema.
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the schema doesn't exist.
    /// Returns `DbError::ValidationError` if the update results in an invalid schema.
    pub async fn update(&self, id: &str, update: StatusSchemaUpdate) -> DbResult<StatusSchema> {
        if !update.has_updates() {
            // No updates specified, just return the current schema
            return self.get(id).await?.ok_or_else(|| DbError::NotFound {
                entity: "status_schema".to_string(),
                id: id.to_string(),
            });
        }

        debug!("Updating status schema '{}'", id);

        // Build the SET clauses
        let mut set_clauses = Vec::new();

        if let Some(name) = &update.name {
            set_clauses.push(format!(r#"name = "{}""#, name.replace('"', "\\\"")));
        }

        if let Some(description) = &update.description {
            match description {
                Some(desc) => {
                    set_clauses.push(format!(r#"description = "{}""#, desc.replace('"', "\\\"")));
                }
                None => set_clauses.push("description = NONE".to_string()),
            }
        }

        if let Some(is_default) = update.is_default {
            set_clauses.push(format!("is_default = {}", is_default));
        }

        if let Some(statuses) = &update.statuses {
            let json = serde_json::to_string(statuses)?;
            set_clauses.push(format!("statuses = {}", json));
        }

        if let Some(progressions) = &update.progressions {
            let json = serde_json::to_string(progressions)?;
            set_clauses.push(format!("progressions = {}", json));
        }

        set_clauses.push("updated_at = time::now()".to_string());

        let query = format!("UPDATE status_schema:{} SET {}", id, set_clauses.join(", "));

        let mut result = self.client.query(&query).await?;
        let updated: Option<StatusSchema> = result.take(0)?;

        let schema = updated.ok_or_else(|| DbError::NotFound {
            entity: "status_schema".to_string(),
            id: id.to_string(),
        })?;

        // Validate the updated schema
        schema.validate().map_err(|msg| DbError::ValidationError {
            message: format!("Updated schema is invalid: {}", msg),
        })?;

        Ok(schema)
    }

    /// Delete a status schema.
    ///
    /// # Arguments
    ///
    /// * `id` - The schema ID to delete
    ///
    /// # Returns
    ///
    /// `Ok(true)` if the schema was deleted, `Ok(false)` if it didn't exist.
    pub async fn delete(&self, id: &str) -> DbResult<bool> {
        debug!("Deleting status schema '{}'", id);

        let query = format!("DELETE status_schema:{}", id);
        self.client.query(&query).await?;

        // Check if it was actually deleted
        Ok(!self.exists(id).await?)
    }

    /// Create the default status schema if it doesn't exist.
    ///
    /// Uses `StatusSchema::default_schema()` to create the standard schema
    /// with the ID "default".
    ///
    /// # Returns
    ///
    /// `Ok(true)` if the schema was created, `Ok(false)` if it already existed.
    pub async fn create_default_schema(&self) -> DbResult<bool> {
        if self.exists(DEFAULT_STATUS_SCHEMA_ID).await? {
            debug!("Default status schema already exists");
            return Ok(false);
        }

        debug!("Creating default status schema");
        let schema = StatusSchema::default_schema();
        self.create_with_id(DEFAULT_STATUS_SCHEMA_ID, schema)
            .await?;
        Ok(true)
    }

    /// Check if a status name is valid according to the default schema.
    ///
    /// # Arguments
    ///
    /// * `status_name` - The status name to validate
    ///
    /// # Returns
    ///
    /// `Ok(true)` if the status is valid, `Ok(false)` otherwise.
    pub async fn is_valid_status(&self, status_name: &str) -> DbResult<bool> {
        let schema = self.get_default().await?;
        match schema {
            Some(s) => Ok(s.get_status(status_name).is_some()),
            None => Ok(false),
        }
    }

    /// Check if a status transition is valid according to the default schema.
    ///
    /// # Arguments
    ///
    /// * `from_status` - The current status
    /// * `to_status` - The target status
    ///
    /// # Returns
    ///
    /// `Ok(true)` if the transition is valid, `Ok(false)` otherwise.
    pub async fn is_valid_transition(&self, from_status: &str, to_status: &str) -> DbResult<bool> {
        let schema = self.get_default().await?;
        match schema {
            Some(s) => Ok(s.can_transition(from_status, to_status)),
            None => Ok(false),
        }
    }

    /// Get the list of valid transitions from a status.
    ///
    /// # Arguments
    ///
    /// * `status_name` - The current status
    ///
    /// # Returns
    ///
    /// A vector of valid target status names.
    pub async fn get_valid_transitions(&self, status_name: &str) -> DbResult<Vec<String>> {
        let schema = self.get_default().await?;
        match schema {
            Some(s) => Ok(s
                .valid_transitions_from(status_name)
                .into_iter()
                .map(String::from)
                .collect()),
            None => Ok(Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use surrealdb::engine::local::Mem;

    /// Helper to create an in-memory test database with schema initialized
    async fn setup_test_db() -> Surreal<Db> {
        let client = Surreal::new::<Mem>(()).await.unwrap();
        client.use_ns("vertebrae").use_db("test").await.unwrap();
        crate::schema::init_schema(&client).await.unwrap();
        client
    }

    #[tokio::test]
    async fn test_create_status_schema() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        let schema = StatusSchema::new("test")
            .with_description("Test schema")
            .with_status(StatusDefinition::new("open"))
            .with_status(StatusDefinition::new("closed"))
            .with_progression(StatusProgression::new("open", "closed"));

        let created = repo.create(schema).await.unwrap();
        assert_eq!(created.name, "test");
        assert_eq!(created.description, Some("Test schema".to_string()));
        assert_eq!(created.statuses.len(), 2);
        assert_eq!(created.progressions.len(), 1);
        assert!(created.id.is_some());
    }

    #[tokio::test]
    async fn test_create_with_id() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        let schema = StatusSchema::new("custom").with_is_default(false);
        let created = repo.create_with_id("custom", schema).await.unwrap();

        assert!(created.id.is_some());
        let id = created.id.unwrap();
        assert_eq!(id.id.to_raw(), "custom");
    }

    #[tokio::test]
    async fn test_get_status_schema() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        let schema = StatusSchema::new("get_test");
        repo.create_with_id("get_test", schema).await.unwrap();

        let retrieved = repo.get("get_test").await.unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().name, "get_test");
    }

    #[tokio::test]
    async fn test_get_nonexistent() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        let retrieved = repo.get("nonexistent").await.unwrap();
        assert!(retrieved.is_none());
    }

    #[tokio::test]
    async fn test_exists() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        assert!(!repo.exists("exists_test").await.unwrap());

        let schema = StatusSchema::new("exists_test");
        repo.create_with_id("exists_test", schema).await.unwrap();

        assert!(repo.exists("exists_test").await.unwrap());
    }

    #[tokio::test]
    async fn test_get_default() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        // Initially no default
        let default = repo.get_default().await.unwrap();
        assert!(default.is_none());

        // Create a default schema
        let schema = StatusSchema::new("default_test").with_is_default(true);
        repo.create_with_id("default_test", schema).await.unwrap();

        let default = repo.get_default().await.unwrap();
        assert!(default.is_some());
        assert_eq!(default.unwrap().name, "default_test");
    }

    #[tokio::test]
    async fn test_list() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        // Initially empty
        let schemas = repo.list().await.unwrap();
        assert!(schemas.is_empty());

        // Create some schemas
        repo.create_with_id("zebra", StatusSchema::new("zebra"))
            .await
            .unwrap();
        repo.create_with_id("alpha", StatusSchema::new("alpha"))
            .await
            .unwrap();
        repo.create_with_id("beta", StatusSchema::new("beta"))
            .await
            .unwrap();

        let schemas = repo.list().await.unwrap();
        assert_eq!(schemas.len(), 3);
        // Should be ordered by name
        assert_eq!(schemas[0].name, "alpha");
        assert_eq!(schemas[1].name, "beta");
        assert_eq!(schemas[2].name, "zebra");
    }

    #[tokio::test]
    async fn test_update() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        let schema = StatusSchema::new("update_test")
            .with_status(StatusDefinition::new("a"))
            .with_status(StatusDefinition::new("b"))
            .with_progression(StatusProgression::new("a", "b"));
        repo.create_with_id("update_test", schema).await.unwrap();

        let update = StatusSchemaUpdate::new()
            .with_name("updated_name")
            .with_description("Updated description")
            .with_is_default(true);

        let updated = repo.update("update_test", update).await.unwrap();
        assert_eq!(updated.name, "updated_name");
        assert_eq!(updated.description, Some("Updated description".to_string()));
        assert!(updated.is_default);
    }

    #[tokio::test]
    async fn test_update_statuses() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        let schema = StatusSchema::new("update_statuses_test")
            .with_status(StatusDefinition::new("a"))
            .with_progression(StatusProgression::new("a", "a")); // self-transition
        repo.create_with_id("update_statuses_test", schema)
            .await
            .unwrap();

        let update = StatusSchemaUpdate::new()
            .with_statuses(vec![
                StatusDefinition::new("x"),
                StatusDefinition::new("y"),
                StatusDefinition::new("z"),
            ])
            .with_progressions(vec![
                StatusProgression::new("x", "y"),
                StatusProgression::new("y", "z"),
            ]);

        let updated = repo.update("update_statuses_test", update).await.unwrap();
        assert_eq!(updated.statuses.len(), 3);
        assert_eq!(updated.progressions.len(), 2);
    }

    #[tokio::test]
    async fn test_delete() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        let schema = StatusSchema::new("delete_test");
        repo.create_with_id("delete_test", schema).await.unwrap();
        assert!(repo.exists("delete_test").await.unwrap());

        let deleted = repo.delete("delete_test").await.unwrap();
        assert!(deleted);
        assert!(!repo.exists("delete_test").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_nonexistent() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        // Deleting nonexistent returns true (it doesn't exist anymore)
        let deleted = repo.delete("nonexistent").await.unwrap();
        assert!(deleted);
    }

    #[tokio::test]
    async fn test_create_default_schema() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        // First call creates
        let created = repo.create_default_schema().await.unwrap();
        assert!(created);

        // Second call skips
        let created = repo.create_default_schema().await.unwrap();
        assert!(!created);

        // Verify the schema exists and has expected properties
        let schema = repo.get(DEFAULT_STATUS_SCHEMA_ID).await.unwrap().unwrap();
        assert_eq!(schema.name, "default");
        assert!(schema.is_default);
        assert!(!schema.statuses.is_empty());
        // Should have backlog, todo, in_progress, pending_review, done, rejected
        let names: Vec<&str> = schema.statuses.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"backlog"));
        assert!(names.contains(&"todo"));
        assert!(names.contains(&"in_progress"));
        assert!(names.contains(&"pending_review"));
        assert!(names.contains(&"done"));
        assert!(names.contains(&"rejected"));
    }

    #[tokio::test]
    async fn test_is_valid_status() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        // No default schema yet
        assert!(!repo.is_valid_status("backlog").await.unwrap());

        // Create default schema
        repo.create_default_schema().await.unwrap();

        // Now statuses should be valid
        assert!(repo.is_valid_status("backlog").await.unwrap());
        assert!(repo.is_valid_status("in_progress").await.unwrap());
        assert!(repo.is_valid_status("done").await.unwrap());

        // Invalid status
        assert!(!repo.is_valid_status("invalid").await.unwrap());
        // todo is included for backward compatibility
        assert!(repo.is_valid_status("todo").await.unwrap());
    }

    #[tokio::test]
    async fn test_is_valid_transition() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);
        repo.create_default_schema().await.unwrap();

        // Valid transitions
        assert!(
            repo.is_valid_transition("backlog", "in_progress")
                .await
                .unwrap()
        );
        assert!(
            repo.is_valid_transition("in_progress", "pending_review")
                .await
                .unwrap()
        );
        assert!(
            repo.is_valid_transition("pending_review", "done")
                .await
                .unwrap()
        );

        // Same status is always valid
        assert!(
            repo.is_valid_transition("backlog", "backlog")
                .await
                .unwrap()
        );

        // Invalid transitions
        assert!(!repo.is_valid_transition("backlog", "done").await.unwrap());
        assert!(!repo.is_valid_transition("done", "backlog").await.unwrap());
    }

    #[tokio::test]
    async fn test_get_valid_transitions() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);
        repo.create_default_schema().await.unwrap();

        let transitions = repo.get_valid_transitions("backlog").await.unwrap();
        assert!(transitions.contains(&"in_progress".to_string()));
        assert!(transitions.contains(&"rejected".to_string()));

        let transitions = repo.get_valid_transitions("done").await.unwrap();
        assert!(transitions.is_empty()); // Terminal status

        let transitions = repo.get_valid_transitions("invalid").await.unwrap();
        assert!(transitions.is_empty());
    }

    #[tokio::test]
    async fn test_create_invalid_schema_fails() {
        let client = setup_test_db().await;
        let repo = StatusSchemaRepository::new(&client);

        // Schema with progression referencing unknown status
        let schema = StatusSchema::new("invalid")
            .with_status(StatusDefinition::new("a"))
            .with_progression(StatusProgression::new("a", "unknown"));

        let result = repo.create(schema).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert!(message.contains("unknown status"));
            }
            _ => panic!("Expected ValidationError"),
        }
    }
}
