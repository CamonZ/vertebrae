//! Workflow service trait and implementation
//!
//! Provides the main abstraction layer for workflow operations. The `WorkflowService` trait
//! defines the interface for all workflow management operations, including CRUD operations,
//! task-workflow assignments, and workflow transitions.

use crate::error::{ServiceError, ServiceResult};
use async_trait::async_trait;
use std::sync::Arc;
use vertebrae_db::{Database, Thing, Workflow};

/// Event representing a workflow mutation for cache invalidation
#[derive(Debug, Clone)]
pub enum WorkflowMutationEvent {
    /// Workflow was created
    WorkflowCreated { id: String },
    /// Workflow was updated
    WorkflowUpdated { id: String },
    /// Workflow was deleted
    WorkflowDeleted { id: String },
    /// Task was assigned to a workflow
    TaskAssignedToWorkflow {
        task_id: String,
        workflow_id: String,
    },
    /// Task was unassigned from a workflow
    TaskUnassignedFromWorkflow { task_id: String },
    /// Task advanced to next step in workflow
    TaskStepAdvanced {
        task_id: String,
        workflow_id: String,
        from_step: usize,
        to_step: usize,
    },
    /// Task retreated to previous step in workflow
    TaskStepRetreated {
        task_id: String,
        workflow_id: String,
        from_step: usize,
        to_step: usize,
    },
    /// Task was rejected in workflow
    TaskRejected {
        task_id: String,
        from_workflow_id: String,
        to_workflow_id: Option<String>,
    },
}

/// Callback for workflow mutation events - fires after each mutation completes
pub type WorkflowMutationCallback = Arc<dyn Fn(WorkflowMutationEvent) + Send + Sync>;

/// Options for creating a new workflow
#[derive(Debug, Clone)]
pub struct CreateWorkflowOptions {
    /// Workflow name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Workflow steps
    pub steps: Vec<WorkflowStepInput>,
    /// Whether to automatically advance to the next step on successful completion
    pub auto_advance: bool,
    /// Display order for sorting workflows (lower values appear first)
    pub order: i32,
}

impl CreateWorkflowOptions {
    /// Create new options with a name and steps
    pub fn new(name: impl Into<String>, steps: Vec<WorkflowStepInput>) -> Self {
        Self {
            name: name.into(),
            description: None,
            steps,
            auto_advance: false,
            order: 0,
        }
    }

    /// Set the description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Set the auto_advance setting
    pub fn with_auto_advance(mut self, auto_advance: bool) -> Self {
        self.auto_advance = auto_advance;
        self
    }

    /// Set the display order
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = order;
        self
    }
}

/// A step definition for workflow creation
#[derive(Debug, Clone)]
pub struct WorkflowStepInput {
    /// Step name
    pub name: String,
    /// Model to use for this step
    pub model: String,
}

impl WorkflowStepInput {
    /// Create a new step input
    pub fn new(name: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            model: model.into(),
        }
    }
}

/// Options for updating a workflow
#[derive(Debug, Default, Clone)]
pub struct UpdateWorkflowOptions {
    /// New name (if Some)
    pub name: Option<String>,
    /// New description (Some(Some(x)) to set, Some(None) to clear, None leaves unchanged)
    pub description: Option<Option<String>>,
    /// Auto advance setting (Some(bool) to set, None leaves unchanged)
    pub auto_advance: Option<bool>,
    /// Display order for sorting workflows (Some(i32) to set, None leaves unchanged)
    pub order: Option<i32>,
}

impl UpdateWorkflowOptions {
    /// Create new empty update options
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

    /// Set the auto_advance setting
    pub fn with_auto_advance(mut self, auto_advance: bool) -> Self {
        self.auto_advance = Some(auto_advance);
        self
    }

    /// Set the display order
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = Some(order);
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.name.is_some()
            || self.description.is_some()
            || self.auto_advance.is_some()
            || self.order.is_some()
    }
}

/// Summary of a workflow
#[derive(Debug, Clone)]
pub struct WorkflowSummary {
    /// Workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Number of steps in the workflow
    pub step_count: usize,
}

/// Result of assigning a workflow to a task
#[derive(Debug, Clone)]
pub struct AssignResult {
    /// The task ID
    pub task_id: String,
    /// The workflow ID assigned
    pub workflow_id: String,
    /// The name of the first step
    pub first_step_name: String,
}

/// Result of advancing a step in a workflow
#[derive(Debug, Clone)]
pub struct StepTransitionResult {
    /// The task ID
    pub task_id: String,
    /// The workflow ID
    pub workflow_id: String,
    /// The previous step index
    pub from_step: usize,
    /// The new step index
    pub to_step: usize,
    /// The name of the new step
    pub step_name: String,
    /// Total number of steps in the workflow
    pub total_steps: usize,
    /// Execution ID if an execution was created
    pub execution_id: Option<String>,
    /// If workflow chaining occurred, the new workflow ID
    pub chained_to_workflow: Option<String>,
}

/// Result of rejecting a task in a workflow
#[derive(Debug, Clone)]
pub struct RejectResult {
    /// The task ID
    pub task_id: String,
    /// The workflow ID it was in
    pub from_workflow_id: String,
    /// If workflow chaining occurred, the new workflow ID
    pub chained_to_workflow: Option<String>,
    /// The name of the first step of the new workflow (if chained)
    pub first_step_name: Option<String>,
    /// Execution ID if an execution was created
    pub execution_id: Option<String>,
}

/// Information about a workflow at a specific step
#[derive(Debug, Clone)]
pub struct WorkflowInfo {
    /// Workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Name of the current step
    pub current_step_name: String,
    /// Current step index
    pub current_step_index: usize,
    /// Total number of steps
    pub total_steps: usize,
    /// Name of the previous step (if any)
    pub prev_step_name: Option<String>,
    /// Name of the next step (if any)
    pub next_step_name: Option<String>,
}

/// Result of a migration operation
#[derive(Debug, Clone)]
pub struct MigrationResult {
    /// Number of tasks successfully migrated
    pub migrated: usize,
    /// Number of tasks skipped
    pub skipped: usize,
    /// IDs of skipped tasks
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

/// Service trait for workflow management operations
///
/// This trait defines the interface for all workflow-related business logic.
/// It abstracts over the database layer, allowing both CLI and GUI to
/// share the same operations while enabling easy testing through mocks.
///
/// # Object Safety
///
/// This trait is object-safe, enabling dynamic dispatch when needed.
#[async_trait]
pub trait WorkflowService: Send + Sync {
    // =========================================================================
    // Database Access (DEPRECATED - DO NOT USE)
    // =========================================================================

    /// Get a reference to the underlying database
    ///
    /// **DEPRECATED**: This method is a bypass that avoids the service layer.
    /// It should NOT be used and will be removed.
    ///
    /// Using this method prevents:
    /// - Mutations from being captured by WorkflowMutationCallback
    /// - Notifications being triggered for GUI cache invalidation
    /// - Proper transaction handling and atomicity
    ///
    /// All code must be refactored to use proper service methods instead.
    #[deprecated(
        since = "0.1.0",
        note = "this database bypass will be removed; use service methods instead"
    )]
    fn database(&self) -> &Database;

    // =========================================================================
    // Workflow CRUD Operations
    // =========================================================================

    /// Create a new workflow
    ///
    /// Generates a unique ID for the workflow and creates it with the provided options.
    ///
    /// Returns the ID of the created workflow.
    async fn create_workflow(&self, options: CreateWorkflowOptions) -> ServiceResult<String>;

    /// Get a workflow by ID
    ///
    /// ID lookups are case-insensitive.
    async fn get_workflow(&self, id: &str) -> ServiceResult<Workflow>;

    /// List all workflows
    async fn list_workflows(&self) -> ServiceResult<Vec<WorkflowSummary>>;

    /// Update a workflow
    ///
    /// Only updates fields specified in the options.
    async fn update_workflow(&self, id: &str, options: UpdateWorkflowOptions) -> ServiceResult<()>;

    /// Delete a workflow
    async fn delete_workflow(&self, id: &str) -> ServiceResult<()>;

    /// Check if a workflow exists
    async fn workflow_exists(&self, id: &str) -> ServiceResult<bool>;

    // =========================================================================
    // Task-Workflow Operations
    // =========================================================================

    /// Assign a workflow to a task
    ///
    /// Sets the task's workflow to the specified workflow and initializes
    /// the current step to 0 (first step).
    async fn assign_workflow(
        &self,
        task_id: &str,
        workflow_id: &str,
    ) -> ServiceResult<AssignResult>;

    /// Remove workflow assignment from a task
    ///
    /// Clears both workflow_id and current_step fields.
    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()>;

    /// Advance a task to the next step in its workflow
    ///
    /// Returns an error if the task is already on the last step.
    async fn advance_step(&self, task_id: &str) -> ServiceResult<StepTransitionResult>;

    /// Move a task back to the previous step in its workflow
    ///
    /// If already on the first step, returns an error.
    async fn retreat_step(&self, task_id: &str) -> ServiceResult<StepTransitionResult>;

    /// Reject a task in its current workflow
    ///
    /// Unassigns the workflow from the task.
    async fn reject_task(&self, task_id: &str) -> ServiceResult<RejectResult>;

    // =========================================================================
    // Query Operations
    // =========================================================================

    /// Get workflow information for a task at its current step
    ///
    /// Returns information about the workflow including step details.
    /// Handles deleted workflows by returning placeholder information.
    async fn get_workflow_info(
        &self,
        workflow_id: &Thing,
        current_step: usize,
    ) -> ServiceResult<WorkflowInfo>;

    /// Migrate tasks to the default workflow
    ///
    /// Finds all tasks without a workflow assignment and assigns them to the
    /// default workflow, setting their current_step based on their current status.
    ///
    /// If `dry_run` is true, returns what would be migrated without making changes.
    async fn migrate_to_default_workflow(&self, dry_run: bool) -> ServiceResult<MigrationResult>;
}

/// Default implementation of WorkflowService backed by Database
pub struct DefaultWorkflowService {
    db: Database,
    /// Optional callback for mutations (cache invalidation, notifications, etc.)
    mutation_callback: Option<WorkflowMutationCallback>,
}

impl DefaultWorkflowService {
    /// Create a new DefaultWorkflowService that owns the database
    pub fn new(db: Database) -> Self {
        Self {
            db,
            mutation_callback: None,
        }
    }

    /// Create a new DefaultWorkflowService with a mutation callback
    ///
    /// The callback fires after each mutation completes, enabling cache invalidation
    /// or other side effects in consumers (CLI, GUI, etc.).
    pub fn with_callback(db: Database, callback: WorkflowMutationCallback) -> Self {
        Self {
            db,
            mutation_callback: Some(callback),
        }
    }

    /// Fire the mutation callback if registered
    fn on_mutation(&self, event: WorkflowMutationEvent) {
        if let Some(callback) = &self.mutation_callback {
            callback(event);
        }
    }

    /// Get a reference to the underlying database
    pub fn database(&self) -> &Database {
        &self.db
    }

    /// Generate a unique workflow ID from a name
    async fn generate_unique_id(&self, name: &str) -> ServiceResult<String> {
        let db = &self.db;
        crate::id_generator::generate_unique_id(name, "workflow", |id| async move {
            db.workflows().exists(&id).await.map_err(ServiceError::from)
        })
        .await
    }

    /// Get ordered step names for a workflow.
    ///
    /// Fetches first-class Step entities from the database.
    async fn get_workflow_steps(&self, workflow: &Workflow) -> ServiceResult<Vec<String>> {
        if let Some(ref workflow_thing) = workflow.id {
            let steps = self.db.steps().list_by_workflow(workflow_thing).await?;
            return Ok(steps.iter().map(|s| s.name.clone()).collect());
        }

        Ok(Vec::new())
    }
}

#[async_trait]
impl WorkflowService for DefaultWorkflowService {
    fn database(&self) -> &Database {
        &self.db
    }

    async fn create_workflow(&self, options: CreateWorkflowOptions) -> ServiceResult<String> {
        // Validate name
        if options.name.trim().is_empty() {
            return Err(ServiceError::validation_failed(
                "Workflow name cannot be empty",
            ));
        }

        // Validate steps
        if options.steps.is_empty() {
            return Err(ServiceError::validation_failed(
                "Workflow must have at least one step",
            ));
        }

        // Check for unique step names
        let mut seen_names = std::collections::HashSet::new();
        for step in &options.steps {
            if !seen_names.insert(&step.name) {
                return Err(ServiceError::validation_failed(format!(
                    "Duplicate step name '{}' in workflow",
                    step.name
                )));
            }
        }

        // Generate unique ID
        let id = self.generate_unique_id(&options.name).await?;

        // Build workflow (without embedded steps - we'll use first-class Step entities)
        let mut workflow = Workflow::new(&options.name)
            .with_auto_advance(options.auto_advance)
            .with_order(options.order);

        if let Some(desc) = options.description {
            workflow = workflow.with_description(desc);
        }

        // Create workflow in database first (needed for step references)
        self.db.workflows().create(&id, &workflow).await?;

        // Create first-class Step entities
        let workflow_thing = vertebrae_db::Thing::from(("workflow", id.as_str()));
        let mut step_ids: Vec<vertebrae_db::Thing> = Vec::new();
        let total_steps = options.steps.len();

        for (order, step_input) in options.steps.iter().enumerate() {
            let agent_config = vertebrae_db::AgentConfig::new().with_model(&step_input.model);
            let is_final = order == total_steps - 1;

            let step = vertebrae_db::Step::new(&step_input.name, workflow_thing.clone())
                .with_agent_config(agent_config)
                .with_order(order as i32)
                .with_is_final(is_final);

            // Generate step ID based on workflow and step name
            let step_id = format!(
                "{}_{}",
                id,
                step_input.name.to_lowercase().replace(' ', "_")
            );
            let created_step = self.db.steps().create_with_id(&step_id, &step).await?;

            if let Some(thing) = created_step.id {
                step_ids.push(thing);
            }
        }

        // Set up linear transitions between steps
        for i in 0..step_ids.len().saturating_sub(1) {
            let current_id = step_ids[i].id.to_raw();
            let next_step = step_ids[i + 1].clone();

            let update = vertebrae_db::StepUpdate::new().with_transitions_to(vec![next_step]);
            self.db.steps().update(&current_id, &update).await?;
        }

        // Set the workflow's initial_step to the first step
        if let Some(first_step) = step_ids.first() {
            let workflow_update =
                vertebrae_db::WorkflowUpdate::new().with_initial_step(first_step.clone());
            self.db.workflows().update(&id, &workflow_update).await?;
        }

        // Fire mutation callback
        self.on_mutation(WorkflowMutationEvent::WorkflowCreated { id: id.clone() });

        Ok(id)
    }

    async fn get_workflow(&self, id: &str) -> ServiceResult<Workflow> {
        let id = id.to_lowercase();
        self.db
            .workflows()
            .get(&id)
            .await?
            .ok_or_else(|| ServiceError::workflow_not_found(&id))
    }

    async fn list_workflows(&self) -> ServiceResult<Vec<WorkflowSummary>> {
        let workflows = self.db.workflows().list().await?;

        let mut summaries = Vec::with_capacity(workflows.len());
        for w in workflows {
            let id =
                w.id.as_ref()
                    .map(|thing| thing.id.to_raw())
                    .unwrap_or_default();

            // Get step count from first-class Step entities
            let step_count = if let Some(ref workflow_thing) = w.id {
                let steps = self.db.steps().list_by_workflow(workflow_thing).await?;
                steps.len()
            } else {
                0
            };

            summaries.push(WorkflowSummary {
                id,
                name: w.name,
                description: w.description,
                step_count,
            });
        }

        Ok(summaries)
    }

    async fn update_workflow(&self, id: &str, options: UpdateWorkflowOptions) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify workflow exists
        if !self.db.workflows().exists(&id).await? {
            return Err(ServiceError::workflow_not_found(&id));
        }

        if !options.has_updates() {
            return Ok(());
        }

        // Validate name if provided
        if let Some(name) = &options.name
            && name.trim().is_empty()
        {
            return Err(ServiceError::validation_failed(
                "Workflow name cannot be empty",
            ));
        }

        // Build database update
        let mut update = vertebrae_db::WorkflowUpdate::new();

        if let Some(name) = &options.name {
            update = update.with_name(name);
        }

        match &options.description {
            Some(Some(desc)) => {
                update = update.with_description(desc);
            }
            Some(None) => {
                update = update.clear_description();
            }
            None => {}
        }

        if let Some(auto_advance) = options.auto_advance {
            update = update.with_auto_advance(auto_advance);
        }

        if let Some(order) = options.order {
            update = update.with_order(order);
        }

        self.db.workflows().update(&id, &update).await?;

        // Fire mutation callback
        self.on_mutation(WorkflowMutationEvent::WorkflowUpdated { id: id.clone() });

        Ok(())
    }

    async fn delete_workflow(&self, id: &str) -> ServiceResult<()> {
        let id = id.to_lowercase();

        // Verify workflow exists
        if !self.db.workflows().exists(&id).await? {
            return Err(ServiceError::workflow_not_found(&id));
        }

        self.db.workflows().delete(&id).await?;

        // Fire mutation callback
        self.on_mutation(WorkflowMutationEvent::WorkflowDeleted { id: id.clone() });

        Ok(())
    }

    async fn workflow_exists(&self, id: &str) -> ServiceResult<bool> {
        let id = id.to_lowercase();
        Ok(self.db.workflows().exists(&id).await?)
    }

    async fn assign_workflow(
        &self,
        task_id: &str,
        workflow_id: &str,
    ) -> ServiceResult<AssignResult> {
        let task_id = task_id.to_lowercase();
        let workflow_id = workflow_id.to_lowercase();

        // Verify task exists
        if !self.db.tasks().exists(&task_id).await? {
            return Err(ServiceError::task_not_found(&task_id));
        }

        // Verify workflow exists
        let workflow = self
            .db
            .workflows()
            .get(&workflow_id)
            .await?
            .ok_or_else(|| ServiceError::workflow_not_found(&workflow_id))?;

        // Get the first step
        let step_names = self.get_workflow_steps(&workflow).await?;
        if step_names.is_empty() {
            return Err(ServiceError::validation_failed("Workflow has no steps"));
        }
        let first_step_name = step_names[0].clone();

        // Assign workflow to task
        let workflow_thing = Thing::from(("workflow", workflow_id.as_str()));
        self.db
            .tasks()
            .assign_workflow(&task_id, &workflow_thing)
            .await?;

        // Set current step to 0
        self.db.tasks().update_current_step(&task_id, 0).await?;

        // Fire mutation callback
        self.on_mutation(WorkflowMutationEvent::TaskAssignedToWorkflow {
            task_id: task_id.clone(),
            workflow_id: workflow_id.clone(),
        });

        Ok(AssignResult {
            task_id,
            workflow_id,
            first_step_name,
        })
    }

    async fn unassign_workflow(&self, task_id: &str) -> ServiceResult<()> {
        let task_id = task_id.to_lowercase();

        // Verify task exists
        if !self.db.tasks().exists(&task_id).await? {
            return Err(ServiceError::task_not_found(&task_id));
        }

        self.db.tasks().unassign_workflow(&task_id).await?;

        // Fire mutation callback
        self.on_mutation(WorkflowMutationEvent::TaskUnassignedFromWorkflow {
            task_id: task_id.clone(),
        });

        Ok(())
    }

    async fn advance_step(&self, task_id: &str) -> ServiceResult<StepTransitionResult> {
        let task_id = task_id.to_lowercase();

        // Get task
        let task = self
            .db
            .tasks()
            .get(&task_id)
            .await?
            .ok_or_else(|| ServiceError::task_not_found(&task_id))?;

        // Verify task has a workflow
        let workflow_thing = task.workflow_id.clone().ok_or_else(|| {
            ServiceError::validation_failed("Task does not have a workflow assigned")
        })?;

        let current_step = task.current_step.ok_or_else(|| {
            ServiceError::validation_failed("Task does not have a current step set")
        })?;

        let workflow_id = workflow_thing.id.to_raw();

        // Get workflow
        let workflow = self
            .db
            .workflows()
            .get(&workflow_id)
            .await?
            .ok_or_else(|| ServiceError::workflow_not_found(&workflow_id))?;

        let step_names = self.get_workflow_steps(&workflow).await?;
        let total_steps = step_names.len();
        let from_step = current_step as usize;

        // Check if we're at the last step
        if from_step >= total_steps - 1 {
            return Err(ServiceError::validation_failed(
                "Task is already at the last step of the workflow",
            ));
        }

        let to_step = from_step + 1;
        let step_name = step_names[to_step].clone();

        // Update task step
        self.db
            .tasks()
            .update_current_step(&task_id, to_step)
            .await?;

        // Fire mutation callback
        self.on_mutation(WorkflowMutationEvent::TaskStepAdvanced {
            task_id: task_id.clone(),
            workflow_id: workflow_id.clone(),
            from_step,
            to_step,
        });

        Ok(StepTransitionResult {
            task_id,
            workflow_id,
            from_step,
            to_step,
            step_name,
            total_steps,
            execution_id: None,
            chained_to_workflow: None,
        })
    }

    async fn retreat_step(&self, task_id: &str) -> ServiceResult<StepTransitionResult> {
        let task_id = task_id.to_lowercase();

        // Get task
        let task = self
            .db
            .tasks()
            .get(&task_id)
            .await?
            .ok_or_else(|| ServiceError::task_not_found(&task_id))?;

        // Verify task has a workflow
        let workflow_thing = task.workflow_id.clone().ok_or_else(|| {
            ServiceError::validation_failed("Task does not have a workflow assigned")
        })?;

        let current_step = task.current_step.ok_or_else(|| {
            ServiceError::validation_failed("Task does not have a current step set")
        })?;

        let workflow_id = workflow_thing.id.to_raw();

        // Get workflow
        let workflow = self
            .db
            .workflows()
            .get(&workflow_id)
            .await?
            .ok_or_else(|| ServiceError::workflow_not_found(&workflow_id))?;

        let step_names = self.get_workflow_steps(&workflow).await?;
        let total_steps = step_names.len();
        let from_step = current_step as usize;

        // Check if we're at the first step
        if from_step == 0 {
            return Err(ServiceError::validation_failed(
                "Task is already at the first step of the workflow",
            ));
        }

        let to_step = from_step - 1;
        let step_name = step_names[to_step].clone();

        // Update task step
        self.db
            .tasks()
            .update_current_step(&task_id, to_step)
            .await?;

        // Fire mutation callback
        self.on_mutation(WorkflowMutationEvent::TaskStepRetreated {
            task_id: task_id.clone(),
            workflow_id: workflow_id.clone(),
            from_step,
            to_step,
        });

        Ok(StepTransitionResult {
            task_id,
            workflow_id,
            from_step,
            to_step,
            step_name,
            total_steps,
            execution_id: None,
            chained_to_workflow: None,
        })
    }

    async fn reject_task(&self, task_id: &str) -> ServiceResult<RejectResult> {
        let task_id = task_id.to_lowercase();

        // Get task
        let task = self
            .db
            .tasks()
            .get(&task_id)
            .await?
            .ok_or_else(|| ServiceError::task_not_found(&task_id))?;

        // Verify task has a workflow
        let workflow_thing = task.workflow_id.clone().ok_or_else(|| {
            ServiceError::validation_failed("Task does not have a workflow assigned")
        })?;

        let from_workflow_id = workflow_thing.id.to_raw();

        // Verify workflow exists
        if !self.db.workflows().exists(&from_workflow_id).await? {
            return Err(ServiceError::workflow_not_found(&from_workflow_id));
        }

        // Unassign workflow from task
        self.db.tasks().unassign_workflow(&task_id).await?;

        // Fire mutation callback
        self.on_mutation(WorkflowMutationEvent::TaskRejected {
            task_id: task_id.clone(),
            from_workflow_id: from_workflow_id.clone(),
            to_workflow_id: None,
        });

        Ok(RejectResult {
            task_id,
            from_workflow_id,
            chained_to_workflow: None,
            first_step_name: None,
            execution_id: None,
        })
    }

    async fn get_workflow_info(
        &self,
        workflow_id: &Thing,
        current_step: usize,
    ) -> ServiceResult<WorkflowInfo> {
        let id = workflow_id.id.to_raw();

        // Try to get the workflow
        let workflow = match self.db.workflows().get(&id).await? {
            Some(w) => w,
            None => {
                // Workflow was deleted, return placeholder
                return Ok(WorkflowInfo {
                    id,
                    name: "Deleted Workflow".to_string(),
                    current_step_name: "Unknown".to_string(),
                    current_step_index: current_step,
                    total_steps: 0,
                    prev_step_name: None,
                    next_step_name: None,
                });
            }
        };

        let step_names = self.get_workflow_steps(&workflow).await?;
        let total_steps = step_names.len();

        if step_names.is_empty() {
            return Ok(WorkflowInfo {
                id,
                name: workflow.name,
                current_step_name: "Unknown".to_string(),
                current_step_index: current_step,
                total_steps: 0,
                prev_step_name: None,
                next_step_name: None,
            });
        }

        let step_idx = current_step.min(step_names.len() - 1);
        let current_step_name = step_names[step_idx].clone();

        let prev_step_name = if step_idx > 0 {
            Some(step_names[step_idx - 1].clone())
        } else {
            None
        };

        let next_step_name = if step_idx < step_names.len() - 1 {
            Some(step_names[step_idx + 1].clone())
        } else {
            None
        };

        Ok(WorkflowInfo {
            id,
            name: workflow.name,
            current_step_name,
            current_step_index: current_step,
            total_steps,
            prev_step_name,
            next_step_name,
        })
    }

    async fn migrate_to_default_workflow(&self, dry_run: bool) -> ServiceResult<MigrationResult> {
        let db_result = if dry_run {
            self.db.workflows().dry_run_migration().await?
        } else {
            self.db.workflows().migrate_to_default_workflow().await?
        };

        // Convert from db MigrationResult to service MigrationResult
        Ok(MigrationResult {
            migrated: db_result.migrated,
            skipped: db_result.skipped,
            skipped_ids: db_result.skipped_ids,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create an initialized workflow service for testing
    async fn setup_test_service() -> DefaultWorkflowService {
        let db = vertebrae_db::Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultWorkflowService::new(db)
    }

    #[tokio::test]
    async fn test_create_workflow_simple() {
        let service = setup_test_service().await;

        let steps = vec![
            WorkflowStepInput::new("review", "reviewer"),
            WorkflowStepInput::new("merge", "merger"),
        ];

        let id = service
            .create_workflow(CreateWorkflowOptions::new("Test Workflow", steps))
            .await
            .unwrap();

        assert!(service.workflow_exists(&id).await.unwrap());

        let workflow = service.get_workflow(&id).await.unwrap();
        assert_eq!(workflow.name, "Test Workflow");

        // Verify initial_step is set
        assert!(
            workflow.initial_step.is_some(),
            "initial_step should be set"
        );

        // Verify Step entities exist by querying the database
        #[allow(deprecated)]
        let db = service.database();
        let workflow_thing = Thing::from(("workflow", id.as_str()));
        let steps = db.steps().list_by_workflow(&workflow_thing).await.unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].name, "review");
        assert_eq!(steps[1].name, "merge");
    }

    #[tokio::test]
    async fn test_create_workflow_with_description() {
        let service = setup_test_service().await;

        let steps = vec![WorkflowStepInput::new("step1", "agent1")];

        let options =
            CreateWorkflowOptions::new("My Workflow", steps).with_description("A test workflow");

        let id = service.create_workflow(options).await.unwrap();

        let workflow = service.get_workflow(&id).await.unwrap();
        assert_eq!(workflow.description, Some("A test workflow".to_string()));
    }

    #[tokio::test]
    async fn test_create_workflow_empty_name_fails() {
        let service = setup_test_service().await;

        let steps = vec![WorkflowStepInput::new("step1", "agent1")];

        let result = service
            .create_workflow(CreateWorkflowOptions::new("   ", steps))
            .await;

        assert!(matches!(result, Err(ServiceError::ValidationFailed { .. })));
    }

    #[tokio::test]
    async fn test_create_workflow_no_steps_fails() {
        let service = setup_test_service().await;

        let result = service
            .create_workflow(CreateWorkflowOptions::new("No Steps", vec![]))
            .await;

        assert!(matches!(result, Err(ServiceError::ValidationFailed { .. })));
    }

    #[tokio::test]
    async fn test_create_workflow_duplicate_step_names_fails() {
        let service = setup_test_service().await;

        let steps = vec![
            WorkflowStepInput::new("review", "agent1"),
            WorkflowStepInput::new("review", "agent2"),
        ];

        let result = service
            .create_workflow(CreateWorkflowOptions::new("Dup Steps", steps))
            .await;

        assert!(matches!(result, Err(ServiceError::ValidationFailed { .. })));
    }

    #[tokio::test]
    async fn test_list_workflows() {
        let service = setup_test_service().await;

        // Create two workflows
        let steps1 = vec![WorkflowStepInput::new("s1", "a1")];
        let steps2 = vec![
            WorkflowStepInput::new("s1", "a1"),
            WorkflowStepInput::new("s2", "a2"),
        ];

        service
            .create_workflow(CreateWorkflowOptions::new("WF1", steps1))
            .await
            .unwrap();
        service
            .create_workflow(CreateWorkflowOptions::new("WF2", steps2))
            .await
            .unwrap();

        let workflows = service.list_workflows().await.unwrap();

        // Should include default workflow + 2 created
        assert_eq!(workflows.len(), 3);
        assert!(workflows.iter().any(|w| w.name == "WF1"));
        assert!(workflows.iter().any(|w| w.name == "WF2"));
    }

    #[tokio::test]
    async fn test_update_workflow_name() {
        let service = setup_test_service().await;

        let steps = vec![WorkflowStepInput::new("s1", "a1")];
        let id = service
            .create_workflow(CreateWorkflowOptions::new("Original", steps))
            .await
            .unwrap();

        service
            .update_workflow(&id, UpdateWorkflowOptions::new().with_name("Updated"))
            .await
            .unwrap();

        let workflow = service.get_workflow(&id).await.unwrap();
        assert_eq!(workflow.name, "Updated");
    }

    #[tokio::test]
    async fn test_delete_workflow() {
        let service = setup_test_service().await;

        let steps = vec![WorkflowStepInput::new("s1", "a1")];
        let id = service
            .create_workflow(CreateWorkflowOptions::new("To Delete", steps))
            .await
            .unwrap();

        assert!(service.workflow_exists(&id).await.unwrap());

        service.delete_workflow(&id).await.unwrap();

        assert!(!service.workflow_exists(&id).await.unwrap());
    }

    #[tokio::test]
    async fn test_workflow_case_insensitive_lookup() {
        let service = setup_test_service().await;

        let steps = vec![WorkflowStepInput::new("s1", "a1")];
        let id = service
            .create_workflow(CreateWorkflowOptions::new("CaseSensitive", steps))
            .await
            .unwrap();

        // Should work with uppercase
        let upper_id = id.to_uppercase();
        assert!(service.workflow_exists(&upper_id).await.unwrap());

        let workflow = service.get_workflow(&upper_id).await.unwrap();
        assert_eq!(workflow.name, "CaseSensitive");
    }

    #[tokio::test]
    async fn test_migrate_to_default_workflow_dry_run() {
        let service = setup_test_service().await;

        let result = service.migrate_to_default_workflow(true).await.unwrap();

        // Should be 0 since database is empty
        assert_eq!(result.migrated, 0);
        assert_eq!(result.skipped, 0);
    }
}
