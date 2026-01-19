//! Step execution repository for CRUD operations on step executions and session logs
//!
//! Provides a repository pattern implementation for tracking workflow step executions
//! and their associated session logs.

use crate::error::{DbError, DbResult};
use crate::models::{ExecutionStatus, SessionLog, StepExecution};

use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;
use surrealdb::sql::Thing;
use tracing::{debug, trace};

/// Repository for step execution CRUD operations
///
/// Encapsulates database queries for step executions and session logs,
/// providing a clean API that hides the underlying SurrealDB implementation details.
pub struct StepExecutionRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Minimal row for returning execution ID
#[derive(Debug, Deserialize)]
struct IdOnly {
    id: Thing,
}

impl<'a> StepExecutionRepository<'a> {
    /// Create a new StepExecutionRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Create a new step execution record.
    ///
    /// # Arguments
    ///
    /// * `execution` - The step execution data to create
    ///
    /// # Returns
    ///
    /// The ID of the created execution as a string.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create_execution(&self, execution: &StepExecution) -> DbResult<String> {
        debug!(
            "Creating step execution for task: {:?}, step: {}",
            execution.task_id, execution.step_name
        );
        trace!("Execution data: {:?}", execution);

        let started_at = execution.started_at.to_rfc3339();
        let completed_at_str = match &execution.completed_at {
            Some(dt) => format!("d\"{}\"", dt.to_rfc3339()),
            None => "NONE".to_string(),
        };

        let step_name = execution.step_name.clone();
        let status = execution.status.as_str().to_string();

        // Build token_usage object if present
        let token_usage_str = match &execution.token_usage {
            Some(usage) => {
                let cache_read = match usage.cache_read_input_tokens {
                    Some(v) => v.to_string(),
                    None => "NONE".to_string(),
                };
                let cache_creation = match usage.cache_creation_input_tokens {
                    Some(v) => v.to_string(),
                    None => "NONE".to_string(),
                };
                format!(
                    "{{ input_tokens: {}, output_tokens: {}, cache_read_input_tokens: {}, cache_creation_input_tokens: {} }}",
                    usage.input_tokens, usage.output_tokens, cache_read, cache_creation
                )
            }
            None => "NONE".to_string(),
        };

        let cost_usd_str = match execution.cost_usd {
            Some(v) => v.to_string(),
            None => "NONE".to_string(),
        };

        let duration_ms_str = match execution.duration_ms {
            Some(v) => v.to_string(),
            None => "NONE".to_string(),
        };

        let query = format!(
            r#"CREATE step_execution SET
                task_id = {},
                workflow_id = {},
                step_name = $step_name,
                started_at = d"{}",
                completed_at = {},
                status = $status,
                context = $context,
                prompt = $prompt,
                output = $output,
                transition_result = $transition_result,
                model_used = $model_used,
                session_id = $session_id,
                token_usage = {},
                cost_usd = {},
                duration_ms = {}"#,
            execution.task_id,
            execution.workflow_id,
            started_at,
            completed_at_str,
            token_usage_str,
            cost_usd_str,
            duration_ms_str
        );

        let mut result = self
            .client
            .query(&query)
            .bind(("step_name", step_name))
            .bind(("status", status))
            .bind(("context", execution.context.clone()))
            .bind(("prompt", execution.prompt.clone()))
            .bind(("output", execution.output.clone()))
            .bind(("transition_result", execution.transition_result.clone()))
            .bind(("model_used", execution.model_used.clone()))
            .bind(("session_id", execution.session_id.clone()))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        let created: Option<IdOnly> = result.take(0)?;
        let id = created.ok_or_else(|| DbError::ValidationError {
            message: "No ID returned from create operation".to_string(),
        })?;

        let id_str = id.id.id.to_raw();
        debug!("Created step execution with ID: {}", id_str);
        Ok(id_str)
    }

    /// Add a log entry to a step execution.
    ///
    /// # Arguments
    ///
    /// * `log` - The session log data to create
    ///
    /// # Returns
    ///
    /// The ID of the created log as a string.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn add_log(&self, log: &SessionLog) -> DbResult<String> {
        debug!(
            "Adding session log for execution: {:?}",
            log.step_execution_id
        );
        trace!("Log content length: {} chars", log.content.len());

        let created_at = log.created_at.to_rfc3339();
        let content = log.content.clone();

        let query = format!(
            r#"CREATE session_log SET
                step_execution_id = {},
                content = $content,
                created_at = d"{}""#,
            log.step_execution_id, created_at
        );

        let mut result = self
            .client
            .query(&query)
            .bind(("content", content))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        let created: Option<IdOnly> = result.take(0)?;
        let id = created.ok_or_else(|| DbError::ValidationError {
            message: "No ID returned from create operation".to_string(),
        })?;

        let id_str = id.id.id.to_raw();
        debug!("Created session log with ID: {}", id_str);
        Ok(id_str)
    }

    /// Get a step execution by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The execution ID to fetch
    ///
    /// # Returns
    ///
    /// `Some(StepExecution)` if found, `None` otherwise.
    pub async fn get_execution(&self, id: &str) -> DbResult<Option<StepExecution>> {
        debug!("Fetching step execution: {}", id);
        let query = format!("SELECT * FROM step_execution:{}", id);
        let mut result = self.client.query(&query).await.map_err(|e| {
            debug!("Failed to fetch execution: {}: {}", id, e);
            DbError::Query(Box::new(e))
        })?;
        let execution: Option<StepExecution> = result.take(0)?;
        if execution.is_some() {
            debug!("Successfully fetched execution: {}", id);
        } else {
            debug!("Execution not found: {}", id);
        }
        Ok(execution)
    }

    /// List all step executions for a task in chronological order.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task ID to list executions for (without the "task:" prefix)
    ///
    /// # Returns
    ///
    /// A vector of step executions sorted by started_at ascending (oldest first).
    pub async fn list_executions_for_task(&self, task_id: &str) -> DbResult<Vec<StepExecution>> {
        debug!("Listing executions for task: {}", task_id);
        let query = format!(
            "SELECT * FROM step_execution WHERE task_id = task:{} ORDER BY started_at ASC",
            task_id
        );
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let executions: Vec<StepExecution> = result.take(0)?;
        debug!("Found {} executions for task {}", executions.len(), task_id);
        Ok(executions)
    }

    /// List all session logs for a step execution in chronological order.
    ///
    /// # Arguments
    ///
    /// * `execution_id` - The execution ID to list logs for (without the "step_execution:" prefix)
    ///
    /// # Returns
    ///
    /// A vector of session logs sorted by created_at ascending (oldest first).
    pub async fn list_logs_for_execution(&self, execution_id: &str) -> DbResult<Vec<SessionLog>> {
        debug!("Listing logs for execution: {}", execution_id);
        let query = format!(
            "SELECT * FROM session_log WHERE step_execution_id = step_execution:{} ORDER BY created_at ASC",
            execution_id
        );
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let logs: Vec<SessionLog> = result.take(0)?;
        debug!("Found {} logs for execution {}", logs.len(), execution_id);
        Ok(logs)
    }

    /// Update the status of a step execution.
    ///
    /// # Arguments
    ///
    /// * `id` - The execution ID to update
    /// * `status` - The new status
    /// * `completed_at` - Optional completion timestamp
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the execution doesn't exist.
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_status(
        &self,
        id: &str,
        status: ExecutionStatus,
        completed_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> DbResult<()> {
        debug!("Updating execution {} status to: {}", id, status);

        let completed_str = match completed_at {
            Some(dt) => format!("d\"{}\"", dt.to_rfc3339()),
            None => "NONE".to_string(),
        };

        let query = format!(
            r#"UPDATE step_execution:{} SET
                status = $status,
                completed_at = {}"#,
            id, completed_str
        );

        self.client
            .query(&query)
            .bind(("status", status.as_str()))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        Ok(())
    }

    /// Update an execution's output and/or transition result.
    ///
    /// # Arguments
    ///
    /// * `id` - The execution ID to update
    /// * `output` - Optional output text to set
    /// * `transition_result` - Optional transition result to set
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_execution(
        &self,
        id: &str,
        output: Option<String>,
        transition_result: Option<String>,
    ) -> DbResult<()> {
        debug!(
            "Updating execution {} with output={:?}, transition_result={:?}",
            id,
            output.as_ref().map(|s| s.len()),
            transition_result.as_ref()
        );

        let mut field_updates = Vec::new();

        if output.is_some() {
            field_updates.push("output = $output".to_string());
        }

        if transition_result.is_some() {
            field_updates.push("transition_result = $transition_result".to_string());
        }

        if field_updates.is_empty() {
            debug!("No updates to apply for execution {}", id);
            return Ok(());
        }

        let query = format!(
            "UPDATE step_execution:{} SET {}",
            id,
            field_updates.join(", ")
        );

        self.client
            .query(&query)
            .bind(("output", output))
            .bind(("transition_result", transition_result))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        debug!("Updated execution {}", id);
        Ok(())
    }

    /// Get the most recent execution for a task.
    ///
    /// # Arguments
    ///
    /// * `task_id` - The task ID (without the "task:" prefix)
    ///
    /// # Returns
    ///
    /// The most recent step execution for the task, or `None` if no executions exist.
    pub async fn get_latest_execution_for_task(
        &self,
        task_id: &str,
    ) -> DbResult<Option<StepExecution>> {
        debug!("Getting latest execution for task: {}", task_id);
        let query = format!(
            "SELECT * FROM step_execution WHERE task_id = task:{} ORDER BY started_at DESC LIMIT 1",
            task_id
        );
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let execution: Option<StepExecution> = result.take(0)?;
        Ok(execution)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::init_schema;
    use chrono::Utc;
    use surrealdb::engine::local::Mem;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Surreal<Db> {
        let client = Surreal::new::<Mem>(()).await.unwrap();
        client.use_ns("vertebrae").use_db("test").await.unwrap();
        init_schema(&client).await.unwrap();
        client
    }

    /// Helper to create prerequisite task and workflow
    async fn create_prerequisites(client: &Surreal<Db>, suffix: &str) {
        client
            .query(format!(
                r#"
                CREATE task:{suffix} SET
                    title = "Test Task",
                    level = "task",
                    status = "backlog";

                CREATE workflow:{suffix} SET
                    name = "Test Workflow";
                "#
            ))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_create_execution_returns_valid_id() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "create_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "create_test")),
            Thing::from(("workflow", "create_test")),
            "backlog",
        );

        let id = repo.create_execution(&execution).await.unwrap();
        assert!(!id.is_empty(), "ID should not be empty");
    }

    #[tokio::test]
    async fn test_get_execution() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "get_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "get_test")),
            Thing::from(("workflow", "get_test")),
            "in_progress",
        );

        let id = repo.create_execution(&execution).await.unwrap();
        let retrieved = repo.get_execution(&id).await.unwrap();

        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.step_name, "in_progress");
        assert_eq!(retrieved.status, ExecutionStatus::InProgress);
    }

    #[tokio::test]
    async fn test_get_execution_not_found() {
        let client = setup_test_db().await;
        let repo = StepExecutionRepository::new(&client);

        let result = repo.get_execution("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_list_executions_for_task_chronological() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "list_test").await;

        let repo = StepExecutionRepository::new(&client);

        // Create executions with different timestamps
        let base_time = Utc::now();
        for (i, step) in ["backlog", "in_progress", "pending_review"]
            .iter()
            .enumerate()
        {
            let execution = StepExecution::new(
                Thing::from(("task", "list_test")),
                Thing::from(("workflow", "list_test")),
                *step,
            )
            .with_started_at(base_time + chrono::Duration::seconds(i as i64));
            repo.create_execution(&execution).await.unwrap();
        }

        let executions = repo.list_executions_for_task("list_test").await.unwrap();
        assert_eq!(executions.len(), 3);

        // Verify chronological order
        assert_eq!(executions[0].step_name, "backlog");
        assert_eq!(executions[1].step_name, "in_progress");
        assert_eq!(executions[2].step_name, "pending_review");
    }

    #[tokio::test]
    async fn test_list_executions_for_task_empty() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "empty_test").await;

        let repo = StepExecutionRepository::new(&client);
        let executions = repo.list_executions_for_task("empty_test").await.unwrap();
        assert!(executions.is_empty());
    }

    #[tokio::test]
    async fn test_add_log() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "log_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "log_test")),
            Thing::from(("workflow", "log_test")),
            "step",
        );
        let exec_id = repo.create_execution(&execution).await.unwrap();

        let log = SessionLog::new(
            Thing::from(("step_execution", exec_id.as_str())),
            "Test log content",
        );
        let log_id = repo.add_log(&log).await.unwrap();

        assert!(!log_id.is_empty());
    }

    #[tokio::test]
    async fn test_list_logs_for_execution() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "logs_list_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "logs_list_test")),
            Thing::from(("workflow", "logs_list_test")),
            "step",
        );
        let exec_id = repo.create_execution(&execution).await.unwrap();

        // Add multiple logs
        let base_time = Utc::now();
        for i in 0..3 {
            let log = SessionLog::new(
                Thing::from(("step_execution", exec_id.as_str())),
                format!("Log entry {}", i),
            )
            .with_created_at(base_time + chrono::Duration::seconds(i));
            repo.add_log(&log).await.unwrap();
        }

        let logs = repo.list_logs_for_execution(&exec_id).await.unwrap();
        assert_eq!(logs.len(), 3);

        // Verify chronological order
        assert!(logs[0].content.contains("0"));
        assert!(logs[1].content.contains("1"));
        assert!(logs[2].content.contains("2"));
    }

    #[tokio::test]
    async fn test_update_status() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "update_status_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "update_status_test")),
            Thing::from(("workflow", "update_status_test")),
            "step",
        );
        let id = repo.create_execution(&execution).await.unwrap();

        // Verify initial status
        let initial = repo.get_execution(&id).await.unwrap().unwrap();
        assert_eq!(initial.status, ExecutionStatus::InProgress);
        assert!(initial.completed_at.is_none());

        // Update to completed
        let completed_time = Utc::now();
        repo.update_status(&id, ExecutionStatus::Completed, Some(completed_time))
            .await
            .unwrap();

        let updated = repo.get_execution(&id).await.unwrap().unwrap();
        assert_eq!(updated.status, ExecutionStatus::Completed);
        assert!(updated.completed_at.is_some());
    }

    #[tokio::test]
    async fn test_get_latest_execution_for_task() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "latest_test").await;

        let repo = StepExecutionRepository::new(&client);

        // Create multiple executions
        let base_time = Utc::now();
        for (i, step) in ["first", "second", "latest"].iter().enumerate() {
            let execution = StepExecution::new(
                Thing::from(("task", "latest_test")),
                Thing::from(("workflow", "latest_test")),
                *step,
            )
            .with_started_at(base_time + chrono::Duration::seconds(i as i64));
            repo.create_execution(&execution).await.unwrap();
        }

        let latest = repo
            .get_latest_execution_for_task("latest_test")
            .await
            .unwrap();
        assert!(latest.is_some());
        assert_eq!(latest.unwrap().step_name, "latest");
    }

    #[tokio::test]
    async fn test_get_latest_execution_for_task_none() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "no_exec_test").await;

        let repo = StepExecutionRepository::new(&client);
        let latest = repo
            .get_latest_execution_for_task("no_exec_test")
            .await
            .unwrap();
        assert!(latest.is_none());
    }

    #[tokio::test]
    async fn test_create_execution_with_turn_data() {
        use crate::models::TokenUsage;

        let client = setup_test_db().await;
        create_prerequisites(&client, "turn_data_test").await;

        let repo = StepExecutionRepository::new(&client);
        let token_usage = TokenUsage::new(1000, 500)
            .with_cache_read(200)
            .with_cache_creation(100);

        let execution = StepExecution::new(
            Thing::from(("task", "turn_data_test")),
            Thing::from(("workflow", "turn_data_test")),
            "execute",
        )
        .with_prompt(r#"{"task": "implement feature"}"#)
        .with_output("Feature implemented successfully")
        .with_model_used("claude-sonnet-4-20250514")
        .with_session_id("session_abc123")
        .with_token_usage(token_usage)
        .with_cost_usd(0.0125)
        .with_duration_ms(45000);

        let id = repo.create_execution(&execution).await.unwrap();
        let retrieved = repo.get_execution(&id).await.unwrap().unwrap();

        assert_eq!(
            retrieved.prompt,
            Some(r#"{"task": "implement feature"}"#.to_string())
        );
        assert_eq!(
            retrieved.output,
            Some("Feature implemented successfully".to_string())
        );
        assert_eq!(
            retrieved.model_used,
            Some("claude-sonnet-4-20250514".to_string())
        );
        assert_eq!(retrieved.session_id, Some("session_abc123".to_string()));

        let usage = retrieved.token_usage.unwrap();
        assert_eq!(usage.input_tokens, 1000);
        assert_eq!(usage.output_tokens, 500);
        assert_eq!(usage.cache_read_input_tokens, Some(200));
        assert_eq!(usage.cache_creation_input_tokens, Some(100));

        assert_eq!(retrieved.cost_usd, Some(0.0125));
        assert_eq!(retrieved.duration_ms, Some(45000));
    }

    #[tokio::test]
    async fn test_create_execution_without_turn_data() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "no_turn_data_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "no_turn_data_test")),
            Thing::from(("workflow", "no_turn_data_test")),
            "backlog",
        );

        let id = repo.create_execution(&execution).await.unwrap();
        let retrieved = repo.get_execution(&id).await.unwrap().unwrap();

        assert!(retrieved.prompt.is_none());
        assert!(retrieved.output.is_none());
        assert!(retrieved.model_used.is_none());
        assert!(retrieved.session_id.is_none());
        assert!(retrieved.token_usage.is_none());
        assert!(retrieved.cost_usd.is_none());
        assert!(retrieved.duration_ms.is_none());
    }

    #[tokio::test]
    async fn test_create_execution_with_partial_token_usage() {
        use crate::models::TokenUsage;

        let client = setup_test_db().await;
        create_prerequisites(&client, "partial_usage_test").await;

        let repo = StepExecutionRepository::new(&client);
        // Token usage without cache fields
        let token_usage = TokenUsage::new(500, 250);

        let execution = StepExecution::new(
            Thing::from(("task", "partial_usage_test")),
            Thing::from(("workflow", "partial_usage_test")),
            "step",
        )
        .with_token_usage(token_usage);

        let id = repo.create_execution(&execution).await.unwrap();
        let retrieved = repo.get_execution(&id).await.unwrap().unwrap();

        let usage = retrieved.token_usage.unwrap();
        assert_eq!(usage.input_tokens, 500);
        assert_eq!(usage.output_tokens, 250);
        assert!(usage.cache_read_input_tokens.is_none());
        assert!(usage.cache_creation_input_tokens.is_none());
    }

    #[tokio::test]
    async fn test_create_execution_with_context_and_transition() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "ctx_trans_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "ctx_trans_test")),
            Thing::from(("workflow", "ctx_trans_test")),
            "execute",
        )
        .with_context(r#"{"task_id": "test", "description": "Test task"}"#)
        .with_prompt(r#"{"instruction": "implement feature"}"#)
        .with_transition_result("advance");

        let id = repo.create_execution(&execution).await.unwrap();
        let retrieved = repo.get_execution(&id).await.unwrap().unwrap();

        assert_eq!(
            retrieved.context,
            Some(r#"{"task_id": "test", "description": "Test task"}"#.to_string())
        );
        assert_eq!(
            retrieved.prompt,
            Some(r#"{"instruction": "implement feature"}"#.to_string())
        );
        assert_eq!(retrieved.transition_result, Some("advance".to_string()));
    }

    #[tokio::test]
    async fn test_update_execution_output() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "update_output_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "update_output_test")),
            Thing::from(("workflow", "update_output_test")),
            "step",
        );

        let id = repo.create_execution(&execution).await.unwrap();

        // Update with output only
        repo.update_execution(&id, Some("Task completed successfully".to_string()), None)
            .await
            .unwrap();

        let retrieved = repo.get_execution(&id).await.unwrap().unwrap();
        assert_eq!(
            retrieved.output,
            Some("Task completed successfully".to_string())
        );
        assert!(retrieved.transition_result.is_none());
    }

    #[tokio::test]
    async fn test_update_execution_transition_result() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "update_trans_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "update_trans_test")),
            Thing::from(("workflow", "update_trans_test")),
            "step",
        );

        let id = repo.create_execution(&execution).await.unwrap();

        // Update with transition result only
        repo.update_execution(&id, None, Some("advance".to_string()))
            .await
            .unwrap();

        let retrieved = repo.get_execution(&id).await.unwrap().unwrap();
        assert!(retrieved.output.is_none());
        assert_eq!(retrieved.transition_result, Some("advance".to_string()));
    }

    #[tokio::test]
    async fn test_update_execution_both_fields() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "update_both_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "update_both_test")),
            Thing::from(("workflow", "update_both_test")),
            "step",
        );

        let id = repo.create_execution(&execution).await.unwrap();

        // Update with both fields
        repo.update_execution(
            &id,
            Some("Feature implemented".to_string()),
            Some("reject".to_string()),
        )
        .await
        .unwrap();

        let retrieved = repo.get_execution(&id).await.unwrap().unwrap();
        assert_eq!(retrieved.output, Some("Feature implemented".to_string()));
        assert_eq!(retrieved.transition_result, Some("reject".to_string()));
    }

    #[tokio::test]
    async fn test_update_execution_no_changes() {
        let client = setup_test_db().await;
        create_prerequisites(&client, "update_none_test").await;

        let repo = StepExecutionRepository::new(&client);
        let execution = StepExecution::new(
            Thing::from(("task", "update_none_test")),
            Thing::from(("workflow", "update_none_test")),
            "step",
        )
        .with_output("original output");

        let id = repo.create_execution(&execution).await.unwrap();

        // Update with no changes
        repo.update_execution(&id, None, None).await.unwrap();

        // Verify original data is unchanged
        let retrieved = repo.get_execution(&id).await.unwrap().unwrap();
        assert_eq!(retrieved.output, Some("original output".to_string()));
    }
}
