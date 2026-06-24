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
    /// Display order for sorting workflows (lower values appear first)
    pub order: i32,
    /// Whether this is the default workflow for new tasks
    pub is_default: bool,
    /// Whether this is a terminal workflow (cannot transition out)
    pub is_final: bool,
    /// Optional kanban column for board placement
    pub kanban_column: Option<String>,
}

impl CreateWorkflowOptions {
    /// Create new options with a name and steps
    pub fn new(name: impl Into<String>, steps: Vec<WorkflowStepInput>) -> Self {
        Self {
            name: name.into(),
            description: None,
            steps,
            order: 0,
            is_default: false,
            is_final: false,
            kanban_column: None,
        }
    }

    /// Set the description
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Set the display order
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = order;
        self
    }

    /// Set whether this is the default workflow
    pub fn with_is_default(mut self, is_default: bool) -> Self {
        self.is_default = is_default;
        self
    }

    /// Set whether this is a terminal (final) workflow
    pub fn with_is_final(mut self, is_final: bool) -> Self {
        self.is_final = is_final;
        self
    }

    /// Set the kanban column
    pub fn with_kanban_column(mut self, kanban_column: impl Into<String>) -> Self {
        self.kanban_column = Some(kanban_column.into());
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
    /// Display order for sorting workflows (Some(i32) to set, None leaves unchanged)
    pub order: Option<i32>,
    /// Whether this is the default workflow (Some(bool) to set, None leaves unchanged)
    pub is_default: Option<bool>,
    /// Whether this is a terminal workflow (Some(bool) to set, None leaves unchanged)
    pub is_final: Option<bool>,
    /// Kanban column (Some(Some(x)) to set, Some(None) to clear, None leaves unchanged)
    pub kanban_column: Option<Option<String>>,
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

    /// Set the display order
    pub fn with_order(mut self, order: i32) -> Self {
        self.order = Some(order);
        self
    }

    /// Set whether this is the default workflow
    pub fn with_is_default(mut self, is_default: bool) -> Self {
        self.is_default = Some(is_default);
        self
    }

    /// Set whether this is a terminal (final) workflow
    pub fn with_is_final(mut self, is_final: bool) -> Self {
        self.is_final = Some(is_final);
        self
    }

    /// Set the kanban column
    pub fn with_kanban_column(mut self, kanban_column: impl Into<String>) -> Self {
        self.kanban_column = Some(Some(kanban_column.into()));
        self
    }

    /// Clear the kanban column
    pub fn clear_kanban_column(mut self) -> Self {
        self.kanban_column = Some(None);
        self
    }

    /// Check if any updates are specified
    pub fn has_updates(&self) -> bool {
        self.name.is_some()
            || self.description.is_some()
            || self.order.is_some()
            || self.is_default.is_some()
            || self.is_final.is_some()
            || self.kanban_column.is_some()
    }
}

/// Summary of a workflow
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkflowSummary {
    /// Workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Number of steps in the workflow
    pub step_count: usize,
    /// Whether this is the default workflow for new tasks
    pub is_default: bool,
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

    /// Resolve a short ID prefix (first 8 hex characters of UUID) to a full workflow ID.
    ///
    /// Returns the full UUID string if exactly one workflow matches the prefix.
    async fn resolve_short_id(&self, prefix: &str) -> ServiceResult<String>;

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

    /// List all workflow transitions and workflow names from one workflow fetch.
    ///
    /// If `from_workflow_id` is provided, only returns transitions from that workflow.
    async fn list_workflow_transitions_with_names(
        &self,
        from_workflow_id: Option<&str>,
    ) -> ServiceResult<(
        Vec<WorkflowTransition>,
        std::collections::HashMap<String, String>,
    )>;

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

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== CreateWorkflowOptions tests ====================

    #[test]
    fn create_workflow_options_defaults_kanban_to_none() {
        let opts = CreateWorkflowOptions::new("test", vec![]);
        assert!(opts.kanban_column.is_none());
    }

    #[test]
    fn create_workflow_options_defaults_is_default_to_false() {
        let opts = CreateWorkflowOptions::new("test", vec![]);
        assert!(!opts.is_default);
    }

    #[test]
    fn create_workflow_options_with_kanban_column() {
        let opts = CreateWorkflowOptions::new("test", vec![]).with_kanban_column("In Progress");
        assert_eq!(opts.kanban_column, Some("In Progress".to_string()));
    }

    #[test]
    fn create_workflow_options_with_is_default() {
        let opts = CreateWorkflowOptions::new("test", vec![]).with_is_default(true);
        assert!(opts.is_default);
    }

    #[test]
    fn create_workflow_options_builder_chain() {
        let opts = CreateWorkflowOptions::new("test", vec![])
            .with_description("desc")
            .with_order(5)
            .with_is_default(true)
            .with_kanban_column("Review");
        assert_eq!(opts.name, "test");
        assert_eq!(opts.description, Some("desc".to_string()));
        assert_eq!(opts.order, 5);
        assert!(opts.is_default);
        assert_eq!(opts.kanban_column, Some("Review".to_string()));
    }

    // ==================== UpdateWorkflowOptions tests ====================

    #[test]
    fn update_workflow_options_with_kanban_column() {
        let opts = UpdateWorkflowOptions::new().with_kanban_column("In Progress");
        assert_eq!(opts.kanban_column, Some(Some("In Progress".to_string())));
        assert!(opts.has_updates());
    }

    #[test]
    fn update_workflow_options_clear_kanban_column() {
        let opts = UpdateWorkflowOptions::new().clear_kanban_column();
        assert_eq!(opts.kanban_column, Some(None));
        assert!(opts.has_updates());
    }

    #[test]
    fn update_workflow_options_with_is_default() {
        let opts = UpdateWorkflowOptions::new().with_is_default(true);
        assert_eq!(opts.is_default, Some(true));
        assert!(opts.has_updates());
    }

    #[test]
    fn update_workflow_options_defaults() {
        let opts = UpdateWorkflowOptions::new();
        assert!(opts.kanban_column.is_none());
        assert!(opts.is_default.is_none());
        assert!(!opts.has_updates());
    }
}
