//! Execution service trait and implementation
//!
//! Provides the main abstraction layer for step execution operations. The `ExecutionService` trait
//! defines the interface for all step execution management operations, including CRUD operations
//! for both step executions and session logs.

use crate::error::ServiceResult;
use crate::models::{ExecutionStatus, SessionLog, StepExecution, TaskRun, TaskRunTrace};
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

/// Parameters for updating execution status with optional metrics.
///
/// Used by [`ExecutionService::update_execution_status`] to report
/// status transitions along with optional output and usage data.
#[derive(Debug, Clone)]
pub struct UpdateExecutionStatusParams {
    /// The new execution status (required).
    pub status: ExecutionStatus,
    /// Optional output text.
    pub output: Option<String>,
    /// Optional input token count.
    pub input_tokens: Option<i64>,
    /// Optional output token count.
    pub output_tokens: Option<i64>,
    /// Optional cost in USD (as decimal string for precision).
    pub cost: Option<String>,
    /// Optional duration in milliseconds.
    pub duration_ms: Option<i64>,
    /// Optional resolved model name (e.g., `claude-sonnet-4-5`, `gpt-5`).
    pub model: Option<String>,
    /// Optional resolved provider (e.g., `anthropic`, `openai`).
    pub model_provider: Option<String>,
}

/// Target used when requesting a durable TaskRun stop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopRunTarget {
    /// Stop the active run for this task, if any.
    TaskId(String),
    /// Stop this explicit TaskRun.
    TaskRunId(String),
}

impl UpdateExecutionStatusParams {
    /// Create params with just a status.
    pub fn new(status: ExecutionStatus) -> Self {
        Self {
            status,
            output: None,
            input_tokens: None,
            output_tokens: None,
            cost: None,
            duration_ms: None,
            model: None,
            model_provider: None,
        }
    }

    /// Set the output text.
    pub fn with_output(mut self, output: impl Into<String>) -> Self {
        self.output = Some(output.into());
        self
    }

    /// Set the input token count.
    pub fn with_input_tokens(mut self, tokens: i64) -> Self {
        self.input_tokens = Some(tokens);
        self
    }

    /// Set the output token count.
    pub fn with_output_tokens(mut self, tokens: i64) -> Self {
        self.output_tokens = Some(tokens);
        self
    }

    /// Set the cost in USD (as decimal string for precision).
    pub fn with_cost(mut self, cost: impl Into<String>) -> Self {
        self.cost = Some(cost.into());
        self
    }

    /// Set the duration in milliseconds.
    pub fn with_duration_ms(mut self, duration_ms: i64) -> Self {
        self.duration_ms = Some(duration_ms);
        self
    }

    /// Set the resolved model name. Blank/whitespace input is treated as unset.
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = non_blank(model.into());
        self
    }

    /// Set the resolved model provider (e.g., `anthropic`, `openai`).
    /// Blank/whitespace input is treated as unset.
    pub fn with_model_provider(mut self, provider: impl Into<String>) -> Self {
        self.model_provider = non_blank(provider.into());
        self
    }
}

fn non_blank(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

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
    /// * `step_id` - The specific workflow step to execute
    ///
    /// # Returns
    ///
    /// The created StepExecution.
    async fn run_step(&self, task_id: &str, step_id: &str) -> ServiceResult<StepExecution>;

    /// Update execution status and optional fields in one call
    ///
    /// Used by the daemon to report status transitions (pending -> running -> completed/failed)
    /// along with optional output, cost, duration, and token usage data.
    ///
    /// # Arguments
    ///
    /// * `execution_id` - The execution ID to update
    /// * `params` - Status and optional metrics to update
    async fn update_execution_status(
        &self,
        execution_id: &str,
        params: UpdateExecutionStatusParams,
    ) -> ServiceResult<()>;

    /// Orchestrate a task through its entire workflow via the backend.
    ///
    /// Calls the `orchestrate_task` mutation on Sacrum, which drives the task
    /// through all workflow steps using the TaskOrchestrator FSM (auto-advance,
    /// eval prompts, workflow chaining).
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task to orchestrate
    ///
    /// # Errors
    ///
    /// Returns an error if the task has no workflow assigned, is already completed,
    /// or if orchestration is already running.
    async fn orchestrate_task(&self, task_id: &str) -> ServiceResult<()>;

    /// Stop the running TaskOrchestrator for a task.
    ///
    /// Calls the `stop_orchestrator` mutation on Sacrum, which terminates the
    /// orchestrator FSM and cancels any in-flight step execution. The mutation
    /// is idempotent: calling it for a task with no running orchestrator is a
    /// no-op and returns successfully.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task whose orchestrator should be stopped
    async fn stop_orchestrator(&self, task_id: &str) -> ServiceResult<()>;

    /// Get the active TaskRun for a task, if any.
    async fn active_run(&self, task_id: &str) -> ServiceResult<Option<TaskRun>>;

    /// List TaskRuns for a task in backend-defined order.
    async fn task_runs(&self, task_id: &str) -> ServiceResult<Vec<TaskRun>>;

    /// Get one TaskRun by full TaskRun ID.
    async fn task_run(&self, task_run_id: &str) -> ServiceResult<Option<TaskRun>>;

    /// Get a TaskRun trace tree rooted at the provided run ID.
    async fn task_run_trace(&self, root_task_run_id: &str) -> ServiceResult<TaskRunTrace>;

    /// Start or schedule a durable workflow run for a task.
    async fn run_workflow(&self, task_id: &str) -> ServiceResult<TaskRun>;

    /// Stop a durable TaskRun by explicit run ID or by task ID fallback.
    async fn stop_run(&self, target: StopRunTarget) -> ServiceResult<Option<TaskRun>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_params_has_all_none_optional_fields() {
        let params = UpdateExecutionStatusParams::new(ExecutionStatus::InProgress);
        assert_eq!(params.status, ExecutionStatus::InProgress);
        assert!(params.output.is_none());
        assert!(params.input_tokens.is_none());
        assert!(params.output_tokens.is_none());
        assert!(params.cost.is_none());
        assert!(params.duration_ms.is_none());
        assert!(params.model.is_none());
        assert!(params.model_provider.is_none());
    }

    #[test]
    fn with_output_sets_output_field() {
        let params =
            UpdateExecutionStatusParams::new(ExecutionStatus::Completed).with_output("some output");
        assert_eq!(params.output.as_deref(), Some("some output"));
    }

    #[test]
    fn with_input_tokens_sets_field() {
        let params =
            UpdateExecutionStatusParams::new(ExecutionStatus::Completed).with_input_tokens(1500);
        assert_eq!(params.input_tokens, Some(1500));
    }

    #[test]
    fn with_output_tokens_sets_field() {
        let params =
            UpdateExecutionStatusParams::new(ExecutionStatus::Completed).with_output_tokens(800);
        assert_eq!(params.output_tokens, Some(800));
    }

    #[test]
    fn with_cost_sets_field() {
        let params =
            UpdateExecutionStatusParams::new(ExecutionStatus::Completed).with_cost("0.003");
        assert_eq!(params.cost.as_deref(), Some("0.003"));
    }

    #[test]
    fn with_duration_ms_sets_field() {
        let params =
            UpdateExecutionStatusParams::new(ExecutionStatus::Completed).with_duration_ms(5432);
        assert_eq!(params.duration_ms, Some(5432));
    }

    #[test]
    fn chaining_all_builders() {
        let params = UpdateExecutionStatusParams::new(ExecutionStatus::Completed)
            .with_output("done")
            .with_input_tokens(2000)
            .with_output_tokens(1000)
            .with_cost("0.05")
            .with_duration_ms(10000)
            .with_model("claude-sonnet-4-5")
            .with_model_provider("anthropic");

        assert_eq!(params.status, ExecutionStatus::Completed);
        assert_eq!(params.output.as_deref(), Some("done"));
        assert_eq!(params.input_tokens, Some(2000));
        assert_eq!(params.output_tokens, Some(1000));
        assert_eq!(params.cost.as_deref(), Some("0.05"));
        assert_eq!(params.duration_ms, Some(10000));
        assert_eq!(params.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(params.model_provider.as_deref(), Some("anthropic"));
    }

    #[test]
    fn with_model_treats_blank_as_unset() {
        let params = UpdateExecutionStatusParams::new(ExecutionStatus::InProgress)
            .with_model("   ")
            .with_model_provider("");
        assert!(params.model.is_none());
        assert!(params.model_provider.is_none());
    }
}
