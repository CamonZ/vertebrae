//! Workflow service trait and implementation
//!
//! Provides the main abstraction layer for workflow operations. The `WorkflowService` trait
//! defines the interface for all workflow management operations, including CRUD operations,
//! task-workflow assignments, and workflow transitions.

use crate::error::ServiceResult;
use crate::models::Thing;
use crate::models::{Workflow, WorkflowTransition};
use async_trait::async_trait;
use std::sync::Arc;

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
    /// Current step ID
    pub current_step_id: Option<String>,
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
        workflow_id: &str,
        current_step_id: Option<&str>,
    ) -> ServiceResult<WorkflowInfo>;

    /// Migrate tasks to the default workflow
    ///
    /// Finds all tasks without a workflow assignment and assigns them to the
    /// default workflow, setting their current_step based on their current status.
    ///
    /// If `dry_run` is true, returns what would be migrated without making changes.
    async fn migrate_to_default_workflow(&self, dry_run: bool) -> ServiceResult<MigrationResult>;

    // =========================================================================
    // Workflow Transition Operations
    // =========================================================================

    /// Create a transition between two workflows
    ///
    /// # Arguments
    ///
    /// * `from_workflow_id` - The source workflow ID
    /// * `to_workflow_id` - The target workflow ID
    /// * `label` - Human-readable label for the transition
    /// * `target_step_id` - Optional step ID to start at in the target workflow
    ///
    /// # Returns
    ///
    /// The created `WorkflowTransition`.
    async fn create_workflow_transition(
        &self,
        from_workflow_id: &str,
        to_workflow_id: &str,
        label: &str,
        target_step_id: Option<&str>,
    ) -> ServiceResult<WorkflowTransition>;

    /// List all workflow transitions
    ///
    /// If `from_workflow_id` is provided, only returns transitions from that workflow.
    async fn list_workflow_transitions(
        &self,
        from_workflow_id: Option<&str>,
    ) -> ServiceResult<Vec<WorkflowTransition>>;

    /// Get transitions from a specific workflow
    async fn get_transitions_from_workflow(
        &self,
        workflow_id: &str,
    ) -> ServiceResult<Vec<WorkflowTransition>>;

    /// Get transitions to a specific workflow
    async fn get_transitions_to_workflow(
        &self,
        workflow_id: &str,
    ) -> ServiceResult<Vec<WorkflowTransition>>;

    /// Delete a transition between two workflows
    ///
    /// # Arguments
    ///
    /// * `from_workflow_id` - The source workflow ID
    /// * `to_workflow_id` - The target workflow ID
    async fn delete_workflow_transition(
        &self,
        from_workflow_id: &str,
        to_workflow_id: &str,
    ) -> ServiceResult<()>;

    /// Check if a transition exists between two workflows
    async fn workflow_transition_exists(
        &self,
        from_workflow_id: &str,
        to_workflow_id: &str,
    ) -> ServiceResult<bool>;

    // =========================================================================
    // Export Operations (Read-only, no mutation callbacks)
    // =========================================================================

    /// Export all workflows from the database for backup or import operations.
    ///
    /// Returns all workflows with their IDs. This is a read-only operation.
    ///
    /// # Returns
    ///
    /// A vector of (workflow_id, Workflow) tuples in deterministic order.
    async fn create_workflow_raw(&self, id: &str, workflow: &Workflow) -> ServiceResult<String>;
    async fn update_workflow_initial_step(&self, id: &str, step_id: &Thing) -> ServiceResult<()>;
    async fn export_all_workflows(&self) -> ServiceResult<Vec<(String, Workflow)>>;
}
