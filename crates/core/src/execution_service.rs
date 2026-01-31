//! Execution service trait and implementation
//!
//! Provides the main abstraction layer for step execution operations. The `ExecutionService` trait
//! defines the interface for all step execution management operations, including CRUD operations
//! for both step executions and session logs.

use crate::error::{ServiceError, ServiceResult};
use crate::models::{SessionLog, StepExecution};
use async_trait::async_trait;
use std::sync::Arc;
use vertebrae_db::Database;

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
}

/// Default implementation of ExecutionService backed by Database
pub struct DefaultExecutionService {
    db: Database,
    /// Optional callback for mutations (cache invalidation, notifications, etc.)
    mutation_callback: Option<ExecutionMutationCallback>,
}

impl DefaultExecutionService {
    /// Create a new DefaultExecutionService that owns the database
    pub fn new(db: Database) -> Self {
        Self {
            db,
            mutation_callback: None,
        }
    }

    /// Create a new DefaultExecutionService with a mutation callback
    ///
    /// The callback fires after each mutation completes, enabling cache invalidation
    /// or other side effects in consumers (CLI, GUI, etc.).
    pub fn with_callback(db: Database, callback: ExecutionMutationCallback) -> Self {
        Self {
            db,
            mutation_callback: Some(callback),
        }
    }

    /// Set the mutation callback
    pub fn set_callback(&mut self, callback: ExecutionMutationCallback) {
        self.mutation_callback = Some(callback);
    }

    fn normalize_id(id: &str) -> String {
        id.to_lowercase()
    }
}

#[async_trait]
impl ExecutionService for DefaultExecutionService {
    async fn create_execution(&self, execution: StepExecution) -> ServiceResult<String> {
        let db_execution = execution.to_db();
        let id = self.db.executions().create_execution(&db_execution).await?;

        if let Some(callback) = &self.mutation_callback {
            let task_id = execution.task_id.clone();
            callback(ExecutionMutationEvent::ExecutionCreated {
                id: id.clone(),
                task_id,
            });
        }

        Ok(id)
    }

    async fn get_execution(&self, id: &str) -> ServiceResult<Option<StepExecution>> {
        let normalized_id = Self::normalize_id(id);
        let result = self.db.executions().get_execution(&normalized_id).await?;
        Ok(result.map(|db_exec| db_exec.into()))
    }

    async fn list_executions_for_task(&self, task_id: &str) -> ServiceResult<Vec<StepExecution>> {
        let normalized_id = Self::normalize_id(task_id);
        let results = self
            .db
            .executions()
            .list_executions_for_task(&normalized_id)
            .await?;
        Ok(results.into_iter().map(|db_exec| db_exec.into()).collect())
    }

    async fn add_log(&self, log: SessionLog) -> ServiceResult<String> {
        let db_log = log.to_db();
        let id = self.db.executions().add_log(&db_log).await?;

        if let Some(callback) = &self.mutation_callback {
            let execution_id = log.step_execution_id.clone();
            callback(ExecutionMutationEvent::LogAdded {
                id: id.clone(),
                execution_id,
            });
        }

        Ok(id)
    }

    async fn list_logs_for_execution(&self, execution_id: &str) -> ServiceResult<Vec<SessionLog>> {
        let normalized_id = Self::normalize_id(execution_id);
        let results = self
            .db
            .executions()
            .list_logs_for_execution(&normalized_id)
            .await?;
        Ok(results.into_iter().map(|db_log| db_log.into()).collect())
    }

    async fn get_latest_execution_for_task(
        &self,
        task_id: &str,
    ) -> ServiceResult<Option<StepExecution>> {
        let normalized_id = Self::normalize_id(task_id);
        let result = self
            .db
            .executions()
            .get_latest_execution_for_task(&normalized_id)
            .await?;
        Ok(result.map(|db_exec| db_exec.into()))
    }

    async fn update_execution(
        &self,
        execution_id: &str,
        output: Option<String>,
        transition_result: Option<String>,
    ) -> ServiceResult<()> {
        self.db
            .executions()
            .update_execution(execution_id, output, transition_result)
            .await
            .map_err(ServiceError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create an initialized execution service for testing
    async fn setup_test_service() -> DefaultExecutionService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        // Create prerequisites (task and workflow)
        db.client()
            .query(
                r#"
                CREATE task:test_task SET
                    title = "Test Task",
                    level = "task",
                    status = "backlog";

                CREATE workflow:test_workflow SET
                    name = "Test Workflow";
                "#,
            )
            .await
            .unwrap();

        DefaultExecutionService::new(db)
    }

    #[tokio::test]
    async fn test_create_execution() {
        let service = setup_test_service().await;

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        let id = service.create_execution(execution).await.unwrap();

        assert!(!id.is_empty());
    }

    #[tokio::test]
    async fn test_get_execution() {
        let service = setup_test_service().await;

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        let id = service.create_execution(execution).await.unwrap();

        let retrieved = service.get_execution(&id).await.unwrap();
        assert!(retrieved.is_some());
    }

    #[tokio::test]
    async fn test_get_execution_not_found() {
        let service = setup_test_service().await;

        let result = service.get_execution("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_list_executions_for_task() {
        let service = setup_test_service().await;

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        service.create_execution(execution).await.unwrap();

        let executions = service.list_executions_for_task("test_task").await.unwrap();
        assert_eq!(executions.len(), 1);
    }

    #[tokio::test]
    async fn test_list_executions_for_task_empty() {
        let service = setup_test_service().await;

        let executions = service.list_executions_for_task("test_task").await.unwrap();
        assert!(executions.is_empty());
    }

    #[tokio::test]
    async fn test_add_log() {
        let service = setup_test_service().await;

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        let exec_id = service.create_execution(execution).await.unwrap();

        let log = SessionLog::new(&exec_id, "Test log content");
        let log_id = service.add_log(log).await.unwrap();

        assert!(!log_id.is_empty());
    }

    #[tokio::test]
    async fn test_list_logs_for_execution() {
        let service = setup_test_service().await;

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        let exec_id = service.create_execution(execution).await.unwrap();

        let log = SessionLog::new(&exec_id, "Test log content");
        service.add_log(log).await.unwrap();

        let logs = service.list_logs_for_execution(&exec_id).await.unwrap();
        assert_eq!(logs.len(), 1);
    }

    #[tokio::test]
    async fn test_list_logs_for_execution_empty() {
        let service = setup_test_service().await;

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        let exec_id = service.create_execution(execution).await.unwrap();

        let logs = service.list_logs_for_execution(&exec_id).await.unwrap();
        assert!(logs.is_empty());
    }

    #[tokio::test]
    async fn test_get_latest_execution_for_task() {
        let service = setup_test_service().await;

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        service.create_execution(execution).await.unwrap();

        let execution2 = StepExecution::new("test_task", "test_workflow", "in_progress");
        let second_id = service.create_execution(execution2).await.unwrap();

        let latest = service
            .get_latest_execution_for_task("test_task")
            .await
            .unwrap();
        assert!(latest.is_some());
        assert_eq!(latest.unwrap().id, Some(second_id));
    }

    #[tokio::test]
    async fn test_get_latest_execution_for_task_none() {
        let service = setup_test_service().await;

        let latest = service
            .get_latest_execution_for_task("test_task")
            .await
            .unwrap();
        assert!(latest.is_none());
    }

    #[tokio::test]
    async fn test_mutation_callback_create_execution() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        db.client()
            .query(
                r#"
                CREATE task:test_task SET
                    title = "Test Task",
                    level = "task",
                    status = "backlog";

                CREATE workflow:test_workflow SET
                    name = "Test Workflow";
                "#,
            )
            .await
            .unwrap();

        let call_count = Arc::new(AtomicUsize::new(0));
        let call_count_clone = call_count.clone();

        let callback = Arc::new(move |_event: ExecutionMutationEvent| {
            call_count_clone.fetch_add(1, Ordering::SeqCst);
        });

        let service = DefaultExecutionService::with_callback(db, callback);

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        service.create_execution(execution).await.unwrap();

        assert_eq!(call_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_mutation_callback_add_log() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        db.client()
            .query(
                r#"
                CREATE task:test_task SET
                    title = "Test Task",
                    level = "task",
                    status = "backlog";

                CREATE workflow:test_workflow SET
                    name = "Test Workflow";
                "#,
            )
            .await
            .unwrap();

        let call_count = Arc::new(AtomicUsize::new(0));
        let call_count_clone = call_count.clone();

        let callback = Arc::new(move |_event: ExecutionMutationEvent| {
            call_count_clone.fetch_add(1, Ordering::SeqCst);
        });

        let service = DefaultExecutionService::with_callback(db, callback);

        let execution = StepExecution::new("test_task", "test_workflow", "backlog");
        let exec_id = service.create_execution(execution).await.unwrap();

        let log = SessionLog::new(&exec_id, "Test log content");
        service.add_log(log).await.unwrap();

        assert_eq!(call_count.load(Ordering::SeqCst), 2);
    }
}
