//! Execution service trait and implementation
//!
//! Provides the main abstraction layer for step execution operations. The `ExecutionService` trait
//! defines the interface for all step execution management operations, including CRUD operations
//! for both step executions and session logs.

use crate::error::ServiceResult;
use crate::models::{SessionLog, StepExecution};
use async_trait::async_trait;
use std::sync::Arc;

/// Event representing an execution mutation for cache invalidation
#[derive(Debug, Clone)]
pub enum ExecutionMutationEvent {
    /// Step execution was created
    ExecutionCreated { id: String, task_id: String },
    /// Step execution was updated
    ExecutionUpdated { id: String, task_id: String },
    /// Session log was added
    LogAdded { id: String, execution_id: String },
}

/// Callback for execution mutation events - fires after each mutation completes
pub type ExecutionMutationCallback = Arc<dyn Fn(ExecutionMutationEvent) + Send + Sync>;

/// Service trait for step execution management operations
///
/// This trait defines the interface for all step execution-related business logic.
/// It abstracts over the database layer, allowing both CLI and GUI to
/// share the same operations while enabling easy testing through mocks.
///
/// # Object Safety
///
/// This trait is object-safe, enabling dynamic dispatch when needed.
#[async_trait]
pub trait ExecutionService: Send + Sync {
    /// Create a new step execution record
    ///
    /// # Arguments
    ///
    /// * `execution` - The step execution data to create
    ///
    /// # Returns
    ///
    /// The ID of the created execution.
    async fn create_execution(&self, execution: StepExecution) -> ServiceResult<String>;

    /// Get a step execution by ID
    ///
    /// ID lookups are case-insensitive.
    async fn get_execution(&self, id: &str) -> ServiceResult<Option<StepExecution>>;

    /// List all step executions for a task in chronological order
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task ID to list executions for
    ///
    /// # Returns
    ///
    /// A vector of step executions sorted by started_at ascending (oldest first).
    async fn list_executions_for_task(&self, task_id: &str) -> ServiceResult<Vec<StepExecution>>;

    /// Add a log entry to a step execution
    ///
    /// # Arguments
    ///
    /// * `log` - The session log data to create
    ///
    /// # Returns
    ///
    /// The ID of the created log.
    async fn add_log(&self, log: SessionLog) -> ServiceResult<String>;

    /// List all session logs for a step execution in chronological order
    ///
    /// # Arguments
    ///
    /// * `execution_id` - The execution ID to list logs for
    ///
    /// # Returns
    ///
    /// A vector of session logs sorted by created_at ascending (oldest first).
    async fn list_logs_for_execution(&self, execution_id: &str) -> ServiceResult<Vec<SessionLog>>;

    /// Get the most recent execution for a task
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task ID
    ///
    /// # Returns
    ///
    /// The most recent step execution for the task, or None if no executions exist.
    async fn get_latest_execution_for_task(
        &self,
        task_id: &str,
    ) -> ServiceResult<Option<StepExecution>>;

    /// Update an existing step execution
    ///
    /// # Arguments
    ///
    /// * `execution_id` - The execution ID to update
    /// * `output` - Optional output text to set
    /// * `transition_result` - Optional transition result to set
    ///
    /// # Returns
    ///
    /// Unit on success.
    async fn update_execution(
        &self,
        execution_id: &str,
        output: Option<String>,
        transition_result: Option<String>,
    ) -> ServiceResult<()>;

    /// Trigger a workflow step execution via the orchestrator (Sacrum).
    ///
    /// Sacrum creates a StepExecution record and broadcasts a `run_step` event
    /// to connected daemon clients on the project channel. The daemon picks up
    /// the event and executes the step.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task to run the step for
    /// * `workflow_id` - The workflow the step belongs to
    /// * `step_id` - The specific workflow step to execute
    ///
    /// # Returns
    ///
    /// The created StepExecution.
    async fn run_step(
        &self,
        task_id: &str,
        workflow_id: &str,
        step_id: &str,
    ) -> ServiceResult<StepExecution>;

}
