//! Workflow repository for CRUD operations on workflows
//!
//! Provides a repository pattern implementation for workflow operations,
//! encapsulating SurrealDB queries and providing a clean API.

use crate::error::{DbError, DbResult};
use crate::models::{AgentConfig, Step, Workflow, WorkflowStep};
use crate::repository::StepRepository;

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

/// Result of a migration operation
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationResult {
    /// Number of tasks successfully migrated
    pub migrated: usize,
    /// Number of tasks skipped (e.g., Rejected status)
    pub skipped: usize,
    /// IDs of tasks that were skipped
    pub skipped_ids: Vec<String>,
}

impl MigrationResult {
    /// Check if any tasks were migrated
    pub fn has_migrations(&self) -> bool {
        self.migrated > 0
    }

    /// Check if any tasks were skipped
    pub fn has_skipped(&self) -> bool {
        self.skipped > 0
    }

    /// Total number of tasks processed
    pub fn total(&self) -> usize {
        self.migrated + self.skipped
    }
}

/// Result of migrating embedded workflow steps to first-class Step entities
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepMigrationResult {
    /// Number of workflows processed
    pub workflows_processed: usize,
    /// Total number of steps created
    pub steps_created: usize,
    /// Number of workflows skipped (no embedded steps)
    pub workflows_skipped: usize,
    /// Number of tasks updated with current_step_id
    pub tasks_updated: usize,
}

impl StepMigrationResult {
    /// Check if any steps were created
    pub fn has_migrations(&self) -> bool {
        self.steps_created > 0
    }

    /// Check if any workflows were processed
    pub fn has_processed(&self) -> bool {
        self.workflows_processed > 0
    }

    /// Total number of workflows encountered
    pub fn total_workflows(&self) -> usize {
        self.workflows_processed + self.workflows_skipped
    }
}

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
    /// Initial step reference (Some(thing) to set, None to leave unchanged)
    pub initial_step: Option<surrealdb::sql::Thing>,
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

    /// Set the initial_step (first-class Step reference)
    pub fn with_initial_step(mut self, step: surrealdb::sql::Thing) -> Self {
        self.initial_step = Some(step);
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
            || self.initial_step.is_some()
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

        if let Some(initial_step) = &updates.initial_step {
            debug!("Setting initial_step to: {:?}", initial_step);
            field_updates.push(format!("initial_step = {}", initial_step));
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
            .with_step(WorkflowStep::new(
                "backlog",
                AgentConfig::new().with_model("task-agent"),
                0,
            ))
            .with_step(WorkflowStep::new(
                "todo",
                AgentConfig::new().with_model("task-agent"),
                1,
            ))
            .with_step(WorkflowStep::new(
                "in_progress",
                AgentConfig::new().with_model("task-agent"),
                2,
            ))
            .with_step(WorkflowStep::new(
                "pending_review",
                AgentConfig::new().with_model("task-agent"),
                3,
            ))
            .with_step(WorkflowStep::new(
                "done",
                AgentConfig::new().with_model("task-agent"),
                4,
            ));

        self.create(DEFAULT_WORKFLOW_ID, &default_workflow).await?;

        debug!("Default workflow created successfully");
        Ok(true)
    }

    /// Perform a dry-run check to see what would be migrated without making changes.
    ///
    /// This method analyzes all tasks without a workflow assignment and determines
    /// how many would be migrated vs skipped, without actually performing the migration.
    ///
    /// Tasks with `Rejected` status are counted as skipped since that status is not
    /// part of the default workflow.
    ///
    /// # Returns
    ///
    /// A `MigrationResult` containing counts of tasks that would be migrated and skipped.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if database operations fail.
    pub async fn dry_run_migration(&self) -> DbResult<MigrationResult> {
        use crate::models::Status;

        debug!("Starting dry-run migration check");

        // Find all tasks without workflow_id
        #[derive(Debug, Deserialize)]
        struct TaskWithStatus {
            id: surrealdb::sql::Thing,
            status: Status,
        }

        let query = "SELECT id, status FROM task WHERE workflow_id IS NONE";
        let mut result = self
            .client
            .query(query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let tasks: Vec<TaskWithStatus> = result.take(0)?;

        debug!(
            "Found {} tasks without workflow assignment for dry-run check",
            tasks.len()
        );

        let mut would_migrate = 0;
        let mut would_skip = 0;
        let mut skipped_ids = Vec::new();

        for task in tasks {
            let task_id = task.id.id.to_raw();

            // Get the step index for this status
            if task.status.default_workflow_step().is_some() {
                trace!("Task {} would be migrated", task_id);
                would_migrate += 1;
            } else {
                // Status not in default workflow (e.g., Rejected)
                debug!(
                    "Task {} would be skipped (status {:?} not in default workflow)",
                    task_id, task.status
                );
                skipped_ids.push(task_id);
                would_skip += 1;
            }
        }

        debug!(
            "Dry-run check complete: {} would migrate, {} would skip",
            would_migrate, would_skip
        );

        Ok(MigrationResult {
            migrated: would_migrate,
            skipped: would_skip,
            skipped_ids,
        })
    }

    /// Migrate existing tasks to use the default workflow.
    ///
    /// Finds all tasks without a workflow assignment and assigns them to the
    /// default workflow, setting their current_step based on their current status.
    ///
    /// Tasks with `Rejected` status are skipped since that status is not part
    /// of the default workflow.
    ///
    /// This migration is idempotent - running it multiple times is safe as it
    /// only affects tasks without a workflow_id.
    ///
    /// # Returns
    ///
    /// A `MigrationResult` containing counts of migrated and skipped tasks.
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the default workflow doesn't exist.
    /// Returns `DbError::Query` if database operations fail.
    pub async fn migrate_to_default_workflow(&self) -> DbResult<MigrationResult> {
        use crate::models::Status;

        debug!("Starting migration to default workflow");

        // Ensure default workflow exists
        if !self.exists(DEFAULT_WORKFLOW_ID).await? {
            return Err(DbError::NotFound {
                entity: "workflow".to_string(),
                id: DEFAULT_WORKFLOW_ID.to_string(),
            });
        }

        let default_workflow_thing = surrealdb::sql::Thing::from(("workflow", DEFAULT_WORKFLOW_ID));

        // Find all tasks without workflow_id
        #[derive(Debug, Deserialize)]
        struct TaskWithStatus {
            id: surrealdb::sql::Thing,
            status: Status,
        }

        let query = "SELECT id, status FROM task WHERE workflow_id IS NONE";
        let mut result = self
            .client
            .query(query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let tasks: Vec<TaskWithStatus> = result.take(0)?;

        debug!("Found {} tasks without workflow assignment", tasks.len());

        let mut migrated = 0;
        let mut skipped = 0;
        let mut skipped_ids = Vec::new();

        for task in tasks {
            let task_id = task.id.id.to_raw();

            // Get the step index for this status
            match task.status.default_workflow_step() {
                Some(step) => {
                    // Update the task with workflow_id and current_step
                    let update_query = format!(
                        "UPDATE task:{} SET workflow_id = $workflow_id, current_step = {}, updated_at = time::now()",
                        task_id, step
                    );
                    self.client
                        .query(&update_query)
                        .bind(("workflow_id", default_workflow_thing.clone()))
                        .await
                        .map_err(|e| DbError::Query(Box::new(e)))?;

                    trace!("Migrated task {} to step {}", task_id, step);
                    migrated += 1;
                }
                None => {
                    // Status not in default workflow (e.g., Rejected)
                    debug!(
                        "Skipping task {} with status {:?} (not in default workflow)",
                        task_id, task.status
                    );
                    skipped_ids.push(task_id);
                    skipped += 1;
                }
            }
        }

        debug!(
            "Migration complete: {} migrated, {} skipped",
            migrated, skipped
        );

        Ok(MigrationResult {
            migrated,
            skipped,
            skipped_ids,
        })
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

    /// Migrate embedded workflow steps to first-class Step entities.
    ///
    /// This migration reads all workflows with embedded steps (the legacy `steps` field)
    /// and creates corresponding `Step` records in the step table. It also:
    /// - Sets up transitions between sequential steps
    /// - Marks the last step as final
    /// - Sets the workflow's `initial_step` to the first step created
    /// - Updates tasks that reference these workflows to use `current_step_id`
    ///
    /// This migration is idempotent - workflows that already have an `initial_step` set
    /// are skipped, as they've already been migrated.
    ///
    /// # Returns
    ///
    /// A `StepMigrationResult` containing counts of workflows processed and steps created.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if database operations fail.
    pub async fn migrate_embedded_steps_to_first_class(&self) -> DbResult<StepMigrationResult> {
        debug!("Starting migration of embedded steps to first-class Step entities");

        let step_repo = StepRepository::new(self.client);

        // Get workflow IDs with minimal fields needed for migration check
        #[derive(Debug, Deserialize)]
        struct WorkflowMigrationInfo {
            id: surrealdb::sql::Thing,
            steps: Vec<WorkflowStep>,
            initial_step: Option<surrealdb::sql::Thing>,
        }

        let mut result = self
            .client
            .query("SELECT id, steps, initial_step FROM workflow")
            .await?;
        let workflows: Vec<WorkflowMigrationInfo> = result.take(0)?;

        debug!("Found {} workflows to check for migration", workflows.len());

        let mut workflows_processed = 0;
        let mut steps_created = 0;
        let mut workflows_skipped = 0;
        let mut tasks_updated = 0;

        for wf in workflows {
            let workflow_id_str = wf.id.id.to_raw();

            // Skip if workflow already has initial_step set (already migrated)
            if wf.initial_step.is_some() {
                debug!(
                    "Skipping workflow {} - already has initial_step set",
                    workflow_id_str
                );
                workflows_skipped += 1;
                continue;
            }

            // Skip if workflow has no embedded steps
            if wf.steps.is_empty() {
                debug!(
                    "Skipping workflow {} - no embedded steps to migrate",
                    workflow_id_str
                );
                workflows_skipped += 1;
                continue;
            }

            debug!(
                "Migrating workflow {} with {} embedded steps",
                workflow_id_str,
                wf.steps.len()
            );

            // Create Step entities for each embedded step
            let mut created_step_ids: Vec<surrealdb::sql::Thing> = Vec::new();

            for (idx, embedded_step) in wf.steps.iter().enumerate() {
                let is_last = idx == wf.steps.len() - 1;

                // Create a unique step ID based on workflow ID and step name
                let step_id = format!(
                    "{}_{}",
                    workflow_id_str,
                    embedded_step.name.to_lowercase().replace(' ', "_")
                );

                let step = Step::new(embedded_step.name.clone(), wf.id.clone())
                    .with_agent_config(embedded_step.agent_config.clone())
                    .with_order(embedded_step.order as i32)
                    .with_is_final(is_last);

                match step_repo.create_with_id(&step_id, &step).await {
                    Ok(created_step) => {
                        if let Some(step_thing) = created_step.id {
                            created_step_ids.push(step_thing);
                            steps_created += 1;
                            trace!("Created step {} for workflow {}", step_id, workflow_id_str);
                        }
                    }
                    Err(e) => {
                        debug!(
                            "Failed to create step {} for workflow {}: {}",
                            step_id, workflow_id_str, e
                        );
                        // Continue with other steps even if one fails
                    }
                }
            }

            // Set up transitions between sequential steps
            if created_step_ids.len() > 1 {
                for i in 0..created_step_ids.len() - 1 {
                    let current_step_id = &created_step_ids[i];
                    let next_step_id = &created_step_ids[i + 1];

                    // Update current step to transition to next step
                    let update_query = format!(
                        "UPDATE {} SET transitions_to = [{}]",
                        current_step_id, next_step_id
                    );
                    if let Err(e) = self.client.query(&update_query).await {
                        debug!(
                            "Failed to set transition from {} to {}: {}",
                            current_step_id, next_step_id, e
                        );
                    }
                }
            }

            // Set the workflow's initial_step to the first created step
            if let Some(first_step_id) = created_step_ids.first() {
                let update_query = format!(
                    "UPDATE workflow:{} SET initial_step = {}, updated_at = time::now()",
                    workflow_id_str, first_step_id
                );
                if let Err(e) = self.client.query(&update_query).await {
                    debug!(
                        "Failed to set initial_step for workflow {}: {}",
                        workflow_id_str, e
                    );
                } else {
                    debug!(
                        "Set initial_step to {} for workflow {}",
                        first_step_id, workflow_id_str
                    );
                }
            }

            // Update tasks that reference this workflow to use current_step_id
            // Find tasks with this workflow_id and current_step set but no current_step_id
            #[derive(Debug, Deserialize)]
            struct TaskWithStep {
                id: surrealdb::sql::Thing,
                current_step: Option<usize>,
            }

            let tasks_query = format!(
                "SELECT id, current_step FROM task WHERE workflow_id = workflow:{} AND current_step IS NOT NONE AND current_step_id IS NONE",
                workflow_id_str
            );
            let mut task_result = self.client.query(&tasks_query).await?;
            let tasks: Vec<TaskWithStep> = task_result.take(0)?;

            for task in tasks {
                let task_id = task.id.id.to_raw();

                // Map current_step index to the corresponding step ID
                if let Some(step_idx) = task.current_step
                    && let Some(step_id) = created_step_ids.get(step_idx)
                {
                    let task_update = format!(
                        "UPDATE task:{} SET current_step_id = {}, updated_at = time::now()",
                        task_id, step_id
                    );
                    if let Err(e) = self.client.query(&task_update).await {
                        debug!(
                            "Failed to update task {} with current_step_id: {}",
                            task_id, e
                        );
                    } else {
                        tasks_updated += 1;
                        trace!(
                            "Updated task {} with current_step_id = {}",
                            task_id, step_id
                        );
                    }
                }
            }

            workflows_processed += 1;
        }

        debug!(
            "Step migration complete: {} workflows processed, {} steps created, {} tasks updated, {} workflows skipped",
            workflows_processed, steps_created, tasks_updated, workflows_skipped
        );

        Ok(StepMigrationResult {
            workflows_processed,
            steps_created,
            workflows_skipped,
            tasks_updated,
        })
    }

    /// Perform a dry-run check for step migration without making changes.
    ///
    /// This method analyzes all workflows and determines how many would be
    /// migrated and how many steps would be created, without actually
    /// performing the migration.
    ///
    /// # Returns
    ///
    /// A `StepMigrationResult` containing estimated counts.
    pub async fn dry_run_step_migration(&self) -> DbResult<StepMigrationResult> {
        debug!("Starting dry-run check for step migration");

        // Get workflow IDs with minimal fields needed for migration check
        #[derive(Debug, Deserialize)]
        struct WorkflowMigrationInfo {
            id: surrealdb::sql::Thing,
            steps: Vec<WorkflowStep>,
            initial_step: Option<surrealdb::sql::Thing>,
        }

        let mut result = self
            .client
            .query("SELECT id, steps, initial_step FROM workflow")
            .await?;
        let workflows: Vec<WorkflowMigrationInfo> = result.take(0)?;

        let mut workflows_processed = 0;
        let mut steps_created = 0;
        let mut workflows_skipped = 0;
        let mut tasks_updated = 0;

        for wf in workflows {
            let workflow_id_str = wf.id.id.to_raw();

            // Skip if workflow already has initial_step set
            if wf.initial_step.is_some() {
                workflows_skipped += 1;
                continue;
            }

            // Skip if workflow has no embedded steps
            if wf.steps.is_empty() {
                workflows_skipped += 1;
                continue;
            }

            // Count steps that would be created
            steps_created += wf.steps.len();
            workflows_processed += 1;

            // Count tasks that would be updated
            let tasks_query = format!(
                "SELECT count() FROM task WHERE workflow_id = workflow:{} AND current_step IS NOT NONE AND current_step_id IS NONE GROUP ALL",
                workflow_id_str
            );

            #[derive(Debug, Deserialize)]
            struct CountResult {
                count: usize,
            }

            let mut task_result = self.client.query(&tasks_query).await?;
            let count_results: Vec<CountResult> = task_result.take(0)?;
            if let Some(count_result) = count_results.first() {
                tasks_updated += count_result.count;
            }
        }

        debug!(
            "Dry-run complete: {} workflows would be processed, {} steps would be created, {} tasks would be updated, {} workflows skipped",
            workflows_processed, steps_created, tasks_updated, workflows_skipped
        );

        Ok(StepMigrationResult {
            workflows_processed,
            steps_created,
            workflows_skipped,
            tasks_updated,
        })
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
        Workflow::new(name).with_step(WorkflowStep::new(
            "default_step",
            AgentConfig::new().with_model("default_agent"),
            0,
        ))
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
            .with_step(WorkflowStep::new(
                "Step 1",
                AgentConfig::new().with_model("agent1"),
                0,
            ))
            .with_step(WorkflowStep::new(
                "Step 2",
                AgentConfig::new().with_model("agent2"),
                1,
            ))
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

        let workflow = Workflow::new("Steps Test").with_step(WorkflowStep::new(
            "Original Step",
            AgentConfig::new().with_model("agent1"),
            0,
        ));
        repo.create("upd4", &workflow).await.unwrap();

        let new_steps = vec![
            WorkflowStep::new("New Step 1", AgentConfig::new().with_model("new_agent1"), 0),
            WorkflowStep::new("New Step 2", AgentConfig::new().with_model("new_agent2"), 1),
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
        assert!(!retrieved.metadata.contains_key("old_key"));
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
            .with_step(WorkflowStep::new(
                "Step 1",
                AgentConfig::new().with_model("agent1"),
                0,
            ));
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
                WorkflowStep::new("Updated Step 1", AgentConfig::new().with_model("agent1"), 0),
                WorkflowStep::new("New Step 2", AgentConfig::new().with_model("agent2"), 1),
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
            .with_steps(vec![WorkflowStep::new(
                "Step",
                AgentConfig::new().with_model("agent"),
                0,
            )])
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
    async fn test_create_empty_embedded_steps_allowed() {
        // Empty embedded steps are allowed at the repository level since
        // first-class Step entities are now used. The service layer validates
        // that steps are provided during creation.
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = Workflow::new("Empty Steps");
        let result = repo.create("test1", &workflow).await;

        assert!(result.is_ok());
        assert!(repo.exists("test1").await.unwrap());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_create_duplicate_step_names_fails() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        let workflow = Workflow::new("Duplicate Steps")
            .with_step(WorkflowStep::new(
                "review",
                AgentConfig::new().with_model("agent1"),
                0,
            ))
            .with_step(WorkflowStep::new(
                "test",
                AgentConfig::new().with_model("agent2"),
                1,
            ))
            .with_step(WorkflowStep::new(
                "review",
                AgentConfig::new().with_model("agent3"),
                2,
            ));

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
            WorkflowStep::new("build", AgentConfig::new().with_model("agent1"), 0),
            WorkflowStep::new("deploy", AgentConfig::new().with_model("agent2"), 1),
            WorkflowStep::new("build", AgentConfig::new().with_model("agent3"), 2), // duplicate
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

    // ========================================
    // Migration tests
    // ========================================

    #[tokio::test]
    async fn test_migrate_no_tasks_without_workflow() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        // No tasks exist, migration should report 0 migrated
        let result = repo.migrate_to_default_workflow().await.unwrap();
        assert_eq!(result.migrated, 0);
        assert_eq!(result.skipped, 0);
        assert!(result.skipped_ids.is_empty());
        assert!(!result.has_migrations());
        assert!(!result.has_skipped());
        assert_eq!(result.total(), 0);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_tasks_with_various_statuses() {
        use crate::models::{Level, Status, Task};
        use crate::repository::TaskRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let task_repo = TaskRepository::new(db.client());

        // Create tasks with different statuses
        let task1 = Task::new("Backlog Task", Level::Task).with_status(Status::Backlog);
        let task2 = Task::new("Todo Task", Level::Task).with_status(Status::Todo);
        let task3 = Task::new("In Progress Task", Level::Task).with_status(Status::InProgress);
        let task4 =
            Task::new("Pending Review Task", Level::Task).with_status(Status::PendingReview);
        let task5 = Task::new("Done Task", Level::Task).with_status(Status::Done);

        task_repo.create("t1", &task1).await.unwrap();
        task_repo.create("t2", &task2).await.unwrap();
        task_repo.create("t3", &task3).await.unwrap();
        task_repo.create("t4", &task4).await.unwrap();
        task_repo.create("t5", &task5).await.unwrap();

        // Run migration
        let result = workflow_repo.migrate_to_default_workflow().await.unwrap();
        assert_eq!(result.migrated, 5);
        assert_eq!(result.skipped, 0);
        assert!(result.has_migrations());
        assert!(!result.has_skipped());

        // Verify each task has correct workflow_id and current_step
        let t1 = task_repo.get("t1").await.unwrap().unwrap();
        assert!(t1.workflow_id.is_some());
        assert_eq!(t1.current_step, Some(0)); // backlog

        let t2 = task_repo.get("t2").await.unwrap().unwrap();
        assert!(t2.workflow_id.is_some());
        assert_eq!(t2.current_step, Some(1)); // todo

        let t3 = task_repo.get("t3").await.unwrap().unwrap();
        assert!(t3.workflow_id.is_some());
        assert_eq!(t3.current_step, Some(2)); // in_progress

        let t4 = task_repo.get("t4").await.unwrap().unwrap();
        assert!(t4.workflow_id.is_some());
        assert_eq!(t4.current_step, Some(3)); // pending_review

        let t5 = task_repo.get("t5").await.unwrap().unwrap();
        assert!(t5.workflow_id.is_some());
        assert_eq!(t5.current_step, Some(4)); // done

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_skips_rejected_tasks() {
        use crate::models::{Level, Status, Task};
        use crate::repository::TaskRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let task_repo = TaskRepository::new(db.client());

        // Create a rejected task and a normal task
        let rejected_task = Task::new("Rejected Task", Level::Task).with_status(Status::Rejected);
        let normal_task = Task::new("Normal Task", Level::Task).with_status(Status::Todo);

        task_repo.create("rejected", &rejected_task).await.unwrap();
        task_repo.create("normal", &normal_task).await.unwrap();

        // Run migration
        let result = workflow_repo.migrate_to_default_workflow().await.unwrap();
        assert_eq!(result.migrated, 1);
        assert_eq!(result.skipped, 1);
        assert!(result.has_migrations());
        assert!(result.has_skipped());
        assert!(result.skipped_ids.contains(&"rejected".to_string()));

        // Verify rejected task still has no workflow
        let rejected = task_repo.get("rejected").await.unwrap().unwrap();
        assert!(rejected.workflow_id.is_none());
        assert!(rejected.current_step.is_none());

        // Verify normal task was migrated
        let normal = task_repo.get("normal").await.unwrap().unwrap();
        assert!(normal.workflow_id.is_some());
        assert_eq!(normal.current_step, Some(1));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_is_idempotent() {
        use crate::models::{Level, Status, Task};
        use crate::repository::TaskRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let task_repo = TaskRepository::new(db.client());

        // Create a task
        let task = Task::new("Test Task", Level::Task).with_status(Status::Todo);
        task_repo.create("test", &task).await.unwrap();

        // Run migration first time
        let result1 = workflow_repo.migrate_to_default_workflow().await.unwrap();
        assert_eq!(result1.migrated, 1);

        // Run migration second time - should find no tasks to migrate
        let result2 = workflow_repo.migrate_to_default_workflow().await.unwrap();
        assert_eq!(result2.migrated, 0);
        assert_eq!(result2.skipped, 0);

        // Verify task still has correct workflow
        let t = task_repo.get("test").await.unwrap().unwrap();
        assert!(t.workflow_id.is_some());
        assert_eq!(t.current_step, Some(1));

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_skips_already_assigned_tasks() {
        use crate::models::{Level, Status, Task};
        use crate::repository::TaskRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let task_repo = TaskRepository::new(db.client());

        // Create a task and assign it to the workflow manually
        let task = Task::new("Pre-assigned Task", Level::Task).with_status(Status::Todo);
        task_repo.create("assigned", &task).await.unwrap();

        let workflow_thing = surrealdb::sql::Thing::from(("workflow", DEFAULT_WORKFLOW_ID));
        task_repo
            .assign_workflow("assigned", &workflow_thing)
            .await
            .unwrap();

        // Create another task without workflow
        let task2 = Task::new("Unassigned Task", Level::Task).with_status(Status::InProgress);
        task_repo.create("unassigned", &task2).await.unwrap();

        // Run migration - should only migrate the unassigned task
        let result = workflow_repo.migrate_to_default_workflow().await.unwrap();
        assert_eq!(result.migrated, 1);
        assert_eq!(result.skipped, 0);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_dry_run_migration_no_tasks() {
        let (db, temp_dir) = setup_test_db().await;
        let repo = WorkflowRepository::new(db.client());

        // No tasks exist, dry run should report 0
        let result = repo.dry_run_migration().await.unwrap();
        assert_eq!(result.migrated, 0);
        assert_eq!(result.skipped, 0);
        assert!(result.skipped_ids.is_empty());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_dry_run_migration_mixed_tasks() {
        use crate::models::{Level, Status, Task};
        use crate::repository::TaskRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let task_repo = TaskRepository::new(db.client());

        // Create tasks with different statuses
        let task1 = Task::new("Backlog Task", Level::Task).with_status(Status::Backlog);
        let task2 = Task::new("Rejected Task", Level::Task).with_status(Status::Rejected);
        let task3 = Task::new("Todo Task", Level::Task).with_status(Status::Todo);

        task_repo.create("t1", &task1).await.unwrap();
        task_repo.create("t2", &task2).await.unwrap();
        task_repo.create("t3", &task3).await.unwrap();

        // Run dry-run
        let result = workflow_repo.dry_run_migration().await.unwrap();
        assert_eq!(result.migrated, 2);
        assert_eq!(result.skipped, 1);
        assert!(result.skipped_ids.contains(&"t2".to_string()));

        // Verify no tasks were actually migrated
        let t1 = task_repo.get("t1").await.unwrap().unwrap();
        assert!(t1.workflow_id.is_none());
        let t2 = task_repo.get("t2").await.unwrap().unwrap();
        assert!(t2.workflow_id.is_none());
        let t3 = task_repo.get("t3").await.unwrap().unwrap();
        assert!(t3.workflow_id.is_none());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_dry_run_migration_does_not_modify_tasks() {
        use crate::models::{Level, Status, Task};
        use crate::repository::TaskRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let task_repo = TaskRepository::new(db.client());

        // Create a task
        let task = Task::new("Test Task", Level::Task).with_status(Status::InProgress);
        task_repo.create("test", &task).await.unwrap();

        // Get original task state
        let original = task_repo.get("test").await.unwrap().unwrap();
        assert!(original.workflow_id.is_none());

        // Run dry-run multiple times
        let result1 = workflow_repo.dry_run_migration().await.unwrap();
        let result2 = workflow_repo.dry_run_migration().await.unwrap();

        // Both runs should return same results
        assert_eq!(result1.migrated, 1);
        assert_eq!(result2.migrated, 1);

        // Verify task state unchanged
        let after = task_repo.get("test").await.unwrap().unwrap();
        assert!(after.workflow_id.is_none());
        assert_eq!(after.status, original.status);

        cleanup(&temp_dir);
    }

    #[test]
    fn test_migration_result_helpers() {
        let result = MigrationResult {
            migrated: 5,
            skipped: 2,
            skipped_ids: vec!["a".to_string(), "b".to_string()],
        };

        assert!(result.has_migrations());
        assert!(result.has_skipped());
        assert_eq!(result.total(), 7);

        let empty_result = MigrationResult {
            migrated: 0,
            skipped: 0,
            skipped_ids: vec![],
        };

        assert!(!empty_result.has_migrations());
        assert!(!empty_result.has_skipped());
        assert_eq!(empty_result.total(), 0);
    }

    // ========================================
    // Step migration tests
    // ========================================

    #[test]
    fn test_step_migration_result_helpers() {
        let result = StepMigrationResult {
            workflows_processed: 2,
            steps_created: 6,
            workflows_skipped: 1,
            tasks_updated: 3,
        };

        assert!(result.has_migrations());
        assert!(result.has_processed());
        assert_eq!(result.total_workflows(), 3);

        let empty_result = StepMigrationResult {
            workflows_processed: 0,
            steps_created: 0,
            workflows_skipped: 0,
            tasks_updated: 0,
        };

        assert!(!empty_result.has_migrations());
        assert!(!empty_result.has_processed());
        assert_eq!(empty_result.total_workflows(), 0);
    }

    #[tokio::test]
    async fn test_migrate_embedded_steps_creates_steps() {
        use crate::repository::StepRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let step_repo = StepRepository::new(db.client());

        // Create a workflow with embedded steps
        let workflow = Workflow::new("Test Workflow")
            .with_step(WorkflowStep::new(
                "Review",
                AgentConfig::new().with_model("review-agent"),
                0,
            ))
            .with_step(WorkflowStep::new(
                "Build",
                AgentConfig::new().with_model("build-agent"),
                1,
            ))
            .with_step(WorkflowStep::new(
                "Deploy",
                AgentConfig::new().with_model("deploy-agent"),
                2,
            ));

        workflow_repo.create("test_wf", &workflow).await.unwrap();

        // Run migration
        let result = workflow_repo
            .migrate_embedded_steps_to_first_class()
            .await
            .unwrap();

        // We have default workflow (5 steps) + test_wf (3 steps)
        assert_eq!(result.workflows_processed, 2);
        assert_eq!(result.steps_created, 8);
        assert!(result.has_migrations());

        // Verify steps were created for test_wf
        let workflow_thing = surrealdb::sql::Thing::from(("workflow", "test_wf"));
        let steps = step_repo.list_by_workflow(&workflow_thing).await.unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].name, "Review");
        assert_eq!(steps[1].name, "Build");
        assert_eq!(steps[2].name, "Deploy");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_embedded_steps_sets_initial_step() {
        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());

        // Create a workflow with embedded steps
        let workflow = Workflow::new("Initial Step Test").with_step(WorkflowStep::new(
            "Start",
            AgentConfig::new().with_model("start-agent"),
            0,
        ));

        workflow_repo.create("init_test", &workflow).await.unwrap();

        // Run migration
        workflow_repo
            .migrate_embedded_steps_to_first_class()
            .await
            .unwrap();

        // Verify initial_step was set
        let migrated = workflow_repo.get("init_test").await.unwrap().unwrap();
        assert!(
            migrated.initial_step.is_some(),
            "initial_step should be set after migration"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_embedded_steps_sets_transitions() {
        use crate::repository::StepRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let step_repo = StepRepository::new(db.client());

        // Create a workflow with multiple steps
        let workflow = Workflow::new("Transition Test")
            .with_step(WorkflowStep::new(
                "Step1",
                AgentConfig::new().with_model("agent1"),
                0,
            ))
            .with_step(WorkflowStep::new(
                "Step2",
                AgentConfig::new().with_model("agent2"),
                1,
            ))
            .with_step(WorkflowStep::new(
                "Step3",
                AgentConfig::new().with_model("agent3"),
                2,
            ));

        workflow_repo.create("trans_test", &workflow).await.unwrap();

        // Run migration
        workflow_repo
            .migrate_embedded_steps_to_first_class()
            .await
            .unwrap();

        // Get the steps and verify transitions
        let workflow_thing = surrealdb::sql::Thing::from(("workflow", "trans_test"));
        let steps = step_repo.list_by_workflow(&workflow_thing).await.unwrap();

        // First step should have transition to second
        assert!(
            !steps[0].transitions_to.is_empty(),
            "First step should have transitions"
        );
        assert!(
            !steps[1].transitions_to.is_empty(),
            "Second step should have transitions"
        );
        // Last step should be final
        assert!(steps[2].is_final, "Last step should be marked as final");
        assert!(
            steps[2].transitions_to.is_empty(),
            "Final step should have no transitions"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_embedded_steps_is_idempotent() {
        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());

        // Create a workflow with embedded steps
        let workflow = Workflow::new("Idempotent Test").with_step(WorkflowStep::new(
            "Only",
            AgentConfig::new().with_model("agent"),
            0,
        ));

        workflow_repo.create("idemp_test", &workflow).await.unwrap();

        // Run migration first time
        let result1 = workflow_repo
            .migrate_embedded_steps_to_first_class()
            .await
            .unwrap();
        // default workflow (5 steps) + idemp_test (1 step)
        assert_eq!(result1.steps_created, 6);

        // Run migration second time - should skip already migrated workflows
        let result2 = workflow_repo
            .migrate_embedded_steps_to_first_class()
            .await
            .unwrap();
        assert_eq!(
            result2.steps_created, 0,
            "Second migration should not create steps"
        );
        assert_eq!(result2.workflows_skipped, 2);

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_embedded_steps_updates_tasks() {
        use crate::models::{Level, Status, Task};
        use crate::repository::TaskRepository;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let task_repo = TaskRepository::new(db.client());

        // Create a workflow with embedded steps
        let workflow = Workflow::new("Task Update Test")
            .with_step(WorkflowStep::new(
                "backlog",
                AgentConfig::new().with_model("agent1"),
                0,
            ))
            .with_step(WorkflowStep::new(
                "in_progress",
                AgentConfig::new().with_model("agent2"),
                1,
            ));

        workflow_repo.create("task_upd", &workflow).await.unwrap();

        // Create a task and assign it to the workflow at step 1
        // TaskRepository.create() doesn't save workflow_id, so we use assign_workflow()
        let task = Task::new("Task to Update", Level::Task).with_status(Status::InProgress);
        task_repo.create("task1", &task).await.unwrap();

        // Assign the task to the workflow
        let workflow_thing = surrealdb::sql::Thing::from(("workflow", "task_upd"));
        task_repo
            .assign_workflow("task1", &workflow_thing)
            .await
            .unwrap();
        // Set current_step to 1 (assign_workflow defaults to 0)
        task_repo.update_current_step("task1", 1).await.unwrap();

        // Run migration
        let result = workflow_repo
            .migrate_embedded_steps_to_first_class()
            .await
            .unwrap();
        assert_eq!(result.tasks_updated, 1);

        // Verify task has current_step_id set
        let updated_task = task_repo.get("task1").await.unwrap().unwrap();
        assert!(
            updated_task.current_step_id.is_some(),
            "Task should have current_step_id set after migration"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_dry_run_step_migration() {
        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());

        // Create a workflow with embedded steps
        let workflow = Workflow::new("Dry Run Test")
            .with_step(WorkflowStep::new(
                "Step1",
                AgentConfig::new().with_model("agent1"),
                0,
            ))
            .with_step(WorkflowStep::new(
                "Step2",
                AgentConfig::new().with_model("agent2"),
                1,
            ));

        workflow_repo.create("dry_run", &workflow).await.unwrap();

        // Run dry-run
        let result = workflow_repo.dry_run_step_migration().await.unwrap();

        // Should report default workflow (5 steps) + dry_run (2 steps)
        assert_eq!(result.workflows_processed, 2);
        assert_eq!(result.steps_created, 7);

        // Verify no steps were actually created for the dry_run workflow
        let workflow_thing = surrealdb::sql::Thing::from(("workflow", "dry_run"));
        let step_repo = StepRepository::new(db.client());
        let steps = step_repo.list_by_workflow(&workflow_thing).await.unwrap();
        assert!(
            steps.is_empty(),
            "Dry-run should not create any steps in the database"
        );

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_migrate_skips_workflows_with_initial_step_already_set() {
        use crate::repository::StepRepository;
        use surrealdb::sql::Thing;

        let (db, temp_dir) = setup_test_db().await;
        let workflow_repo = WorkflowRepository::new(db.client());
        let step_repo = StepRepository::new(db.client());

        // First migrate all existing workflows (default workflow)
        let first_result = workflow_repo
            .migrate_embedded_steps_to_first_class()
            .await
            .unwrap();
        assert_eq!(
            first_result.workflows_processed, 1,
            "Default workflow should be migrated"
        );

        // Create a workflow with embedded steps (required by validation)
        let workflow = Workflow::new("New Style Workflow").with_step(WorkflowStep::new(
            "placeholder",
            AgentConfig::new().with_model("agent"),
            0,
        ));
        workflow_repo.create("new_style", &workflow).await.unwrap();

        // Create a first-class step and set initial_step directly
        // (simulating a workflow created with the new first-class steps)
        let workflow_thing = Thing::from(("workflow", "new_style"));
        let step = Step::new("Real Step", workflow_thing);
        let created_step = step_repo.create_with_id("new_step", &step).await.unwrap();

        // Set initial_step on the workflow (making it look already migrated)
        db.client()
            .query(format!(
                "UPDATE workflow:new_style SET initial_step = {}",
                created_step.id.unwrap()
            ))
            .await
            .unwrap();

        // Run migration again
        let result = workflow_repo
            .migrate_embedded_steps_to_first_class()
            .await
            .unwrap();

        // Should skip all workflows:
        // - 1 default workflow (already migrated - has initial_step)
        // - 1 new_style workflow (has initial_step set)
        assert_eq!(result.workflows_processed, 0);
        assert_eq!(result.steps_created, 0);
        assert_eq!(result.workflows_skipped, 2);

        cleanup(&temp_dir);
    }
}
