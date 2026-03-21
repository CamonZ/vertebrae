//! Workflow service trait and implementation
//!
//! Provides the main abstraction layer for workflow operations. The `WorkflowService` trait
//! defines the interface for all workflow management operations, including CRUD operations,
//! task-workflow assignments, and workflow transitions.

use crate::error::ServiceResult;
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

/// Information about a workflow at a specific step
#[derive(Debug, Clone, serde::Serialize)]
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

    /// List all workflows with full details
    ///
    /// Returns complete Workflow objects instead of summaries.
    /// Useful when the caller needs all workflow fields without N+1 queries.
    async fn list_workflows_full(&self) -> ServiceResult<Vec<Workflow>>;

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
}
