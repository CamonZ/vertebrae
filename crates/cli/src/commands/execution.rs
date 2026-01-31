//! Execution commands for managing workflow execution history
//!
//! Implements the `vtb execution` subcommand group for creating, viewing,
//! and updating step executions and their associated session logs.

use clap::{Args, Subcommand};
use vertebrae_core::{ExecutionStatus, SessionLog, StepExecution};
use vertebrae_core::{ServiceError, VertebraeServices};

/// Execution management commands
#[derive(Debug, Subcommand)]
pub enum ExecutionCommand {
    /// Create a new execution for a task
    Create(ExecutionCreateCommand),
    /// List all executions for a task
    List(ExecutionListCommand),
    /// Show details of a specific execution
    Show(ExecutionShowCommand),
    /// Update an existing execution
    Update(ExecutionUpdateCommand),
    /// Add a log entry to an execution
    Log(ExecutionLogCommand),
}

impl ExecutionCommand {
    /// Execute the execution subcommand.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        match self {
            ExecutionCommand::Create(cmd) => cmd.execute(services).await,
            ExecutionCommand::List(cmd) => cmd.execute(services).await,
            ExecutionCommand::Show(cmd) => cmd.execute(services).await,
            ExecutionCommand::Update(cmd) => cmd.execute(services).await,
            ExecutionCommand::Log(cmd) => cmd.execute(services).await,
        }
    }
}

/// Create a new step execution for a task
#[derive(Debug, Args)]
pub struct ExecutionCreateCommand {
    /// Task ID (short or full) to create execution for
    #[arg(required = true)]
    pub task_id: String,

    /// JSON context data about the task (must be valid JSON)
    #[arg(long)]
    pub context: Option<String>,

    /// JSON prompt for the execution (must be valid JSON)
    #[arg(long)]
    pub prompt: Option<String>,
}

impl ExecutionCreateCommand {
    /// Execute the create execution command.
    ///
    /// Creates a new StepExecution for the task's current workflow and step.
    /// The task must have a workflow assigned.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task is not found
    /// - The task has no workflow assigned
    /// - The context or prompt is not valid JSON
    /// - Database operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        // Normalize task ID to lowercase for case-insensitive lookup
        let task_id = self.task_id.to_lowercase();

        // Get the task to verify it exists and has a workflow
        let task = services.tasks().get_task(&task_id).await?;

        // Verify task has a workflow assigned
        let workflow_id = task.workflow_id.as_ref().ok_or_else(|| {
            ServiceError::validation_failed(format!(
                "task '{}' has no workflow assigned",
                &task_id[..6.min(task_id.len())]
            ))
        })?;

        // Get the current step name from task's current_step_id
        let step_id = task.current_step_id.as_ref().ok_or_else(|| {
            ServiceError::validation_failed(format!(
                "task '{}' has no current_step_id (invariant violation)",
                &task_id[..6.min(task_id.len())]
            ))
        })?;
        let step = services
            .steps()
            .get_step(step_id.as_str())
            .await?
            .ok_or_else(|| {
                ServiceError::validation_failed(format!("step '{}' not found", step_id))
            })?;
        let step_name = step.name;

        // Validate context JSON if provided
        if let Some(ref context) = self.context {
            serde_json::from_str::<serde_json::Value>(context).map_err(|e| {
                ServiceError::validation_failed(format!("invalid context JSON: {}", e))
            })?;
        }

        // Validate prompt JSON if provided
        if let Some(ref prompt) = self.prompt {
            serde_json::from_str::<serde_json::Value>(prompt).map_err(|e| {
                ServiceError::validation_failed(format!("invalid prompt JSON: {}", e))
            })?;
        }

        // Create the step execution
        let mut execution = StepExecution::new(task_id.clone(), workflow_id.clone(), &step_name);

        if let Some(ref context) = self.context {
            execution = execution.with_context(context);
        }

        if let Some(ref prompt) = self.prompt {
            execution = execution.with_prompt(prompt);
        }

        // Save to database
        let exec_id = services.executions().create_execution(execution).await?;

        Ok(exec_id)
    }
}

/// Update an existing execution
#[derive(Debug, Args)]
pub struct ExecutionUpdateCommand {
    /// Execution ID to update
    #[arg(required = true)]
    pub execution_id: String,

    /// Output text from the execution
    #[arg(long)]
    pub output: Option<String>,

    /// Transition result (e.g., "advance", "reject", "retry")
    #[arg(long)]
    pub transition_result: Option<String>,
}

impl ExecutionUpdateCommand {
    /// Execute the update execution command.
    ///
    /// Updates an existing execution's output and/or transition result.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The execution is not found
    /// - Database operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        // Verify the execution exists
        let _execution = services
            .executions()
            .get_execution(&self.execution_id)
            .await?
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "execution '{}' not found",
                    self.execution_id
                ))
            })?;

        // Update the execution
        services
            .executions()
            .update_execution(
                &self.execution_id,
                self.output.clone(),
                self.transition_result.clone(),
            )
            .await?;

        let short_id = &self.execution_id[..6.min(self.execution_id.len())];
        Ok(format!("Updated execution {}", short_id))
    }
}

/// List all executions for a task
#[derive(Debug, Args)]
pub struct ExecutionListCommand {
    /// Task ID (short or full) to list executions for
    #[arg(required = true)]
    pub task_id: String,
}

impl ExecutionListCommand {
    /// Execute the list executions command.
    ///
    /// Lists all step executions for the specified task in chronological order.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task is not found
    /// - Database operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        // Normalize task ID to lowercase for case-insensitive lookup
        let task_id = self.task_id.to_lowercase();

        // Verify the task exists
        let task_exists = services.tasks().task_exists(&task_id).await?;
        if !task_exists {
            return Err(ServiceError::task_not_found(&self.task_id));
        }

        // Get executions for the task
        let executions = services
            .executions()
            .list_executions_for_task(&task_id)
            .await?;

        if executions.is_empty() {
            return Ok(format!("No executions found for task {}", &task_id[..6]));
        }

        let mut output = format!(
            "Executions for task {} ({} total)\n",
            &task_id[..6],
            executions.len()
        );
        output.push_str(&"=".repeat(60));
        output.push('\n');

        for execution in &executions {
            let exec_id = execution
                .id
                .as_ref()
                .cloned()
                .unwrap_or_else(|| "?".to_string());
            let short_id = if exec_id.len() > 6 {
                &exec_id[..6]
            } else {
                &exec_id
            };

            let status_str = match execution.status {
                ExecutionStatus::InProgress => "IN_PROGRESS",
                ExecutionStatus::Completed => "COMPLETED",
                ExecutionStatus::Failed => "FAILED",
            };

            let started = execution.started_at.format("%Y-%m-%d %H:%M:%S");
            let completed = execution
                .completed_at
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| "-".to_string());

            output.push_str(&format!(
                "{} | {} | {:12} | {} -> {}\n",
                short_id, execution.step_name, status_str, started, completed
            ));
        }

        Ok(output)
    }
}

/// Show details of a specific execution
#[derive(Debug, Args)]
pub struct ExecutionShowCommand {
    /// Execution ID (short or full) to show details for
    #[arg(required = true)]
    pub execution_id: String,
}

impl ExecutionShowCommand {
    /// Execute the show execution command.
    ///
    /// Displays full details of a specific execution including session logs.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The execution is not found
    /// - Database operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        // Try to get the execution
        let execution = services
            .executions()
            .get_execution(&self.execution_id)
            .await?
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "execution '{}' not found",
                    self.execution_id
                ))
            })?;

        let exec_id = execution
            .id
            .as_ref()
            .cloned()
            .unwrap_or_else(|| "?".to_string());

        let task_id = execution.task_id.clone();
        let workflow_id = execution.workflow_id.clone();

        let status_str = match execution.status {
            ExecutionStatus::InProgress => "IN_PROGRESS",
            ExecutionStatus::Completed => "COMPLETED",
            ExecutionStatus::Failed => "FAILED",
        };

        let started = execution.started_at.format("%Y-%m-%d %H:%M:%S UTC");
        let completed = execution
            .completed_at
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
            .unwrap_or_else(|| "-".to_string());

        let duration = execution.duration().map_or_else(
            || "-".to_string(),
            |d| {
                let secs = d.num_seconds();
                if secs < 60 {
                    format!("{}s", secs)
                } else if secs < 3600 {
                    format!("{}m {}s", secs / 60, secs % 60)
                } else {
                    format!("{}h {}m {}s", secs / 3600, (secs % 3600) / 60, secs % 60)
                }
            },
        );

        let mut output = format!("Execution: {}\n", exec_id);
        output.push_str(&"=".repeat(60));
        output.push('\n');
        output.push('\n');
        output.push_str("Metadata\n");
        output.push_str(&"-".repeat(40));
        output.push('\n');
        output.push_str(&format!(
            "Task:       {}\n",
            &task_id[..6.min(task_id.len())]
        ));
        output.push_str(&format!(
            "Workflow:   {}\n",
            &workflow_id[..6.min(workflow_id.len())]
        ));
        output.push_str(&format!("Step:       {}\n", execution.step_name));
        output.push_str(&format!("Status:     {}\n", status_str));
        output.push_str(&format!("Started:    {}\n", started));
        output.push_str(&format!("Completed:  {}\n", completed));
        output.push_str(&format!("Duration:   {}\n", duration));
        if let Some(ref result) = execution.transition_result {
            output.push_str(&format!("Transition: {}\n", result));
        }

        // Display context if present
        if let Some(ref context) = execution.context {
            output.push('\n');
            output.push_str("Context\n");
            output.push_str(&"-".repeat(40));
            output.push('\n');
            output.push_str(context);
            if !context.ends_with('\n') {
                output.push('\n');
            }
        }

        // Display prompt if present
        if let Some(ref prompt) = execution.prompt {
            output.push('\n');
            output.push_str("Prompt\n");
            output.push_str(&"-".repeat(40));
            output.push('\n');
            output.push_str(prompt);
            if !prompt.ends_with('\n') {
                output.push('\n');
            }
        }

        // Display output if present
        if let Some(ref exec_output) = execution.output {
            output.push('\n');
            output.push_str("Output\n");
            output.push_str(&"-".repeat(40));
            output.push('\n');
            output.push_str(exec_output);
            if !exec_output.ends_with('\n') {
                output.push('\n');
            }
        }

        // Get session logs for this execution
        let logs = services
            .executions()
            .list_logs_for_execution(&exec_id)
            .await?;

        if !logs.is_empty() {
            output.push('\n');
            output.push_str("Session Logs\n");
            output.push_str(&"-".repeat(40));
            output.push('\n');

            for (i, log) in logs.iter().enumerate() {
                let created = log.created_at.format("%Y-%m-%d %H:%M:%S");
                let log_id = log.id.as_ref().cloned().unwrap_or_else(|| "?".to_string());
                output.push_str(&format!("\n[{}] Log {} ({})\n", i + 1, created, log_id));
                output.push_str(&"-".repeat(20));
                output.push('\n');
                output.push_str(&log.content);
                if !log.content.ends_with('\n') {
                    output.push('\n');
                }
            }
        }

        Ok(output)
    }
}

/// Add a log entry to an execution
#[derive(Debug, Args)]
pub struct ExecutionLogCommand {
    /// Execution ID to add the log to
    #[arg(required = true)]
    pub execution_id: String,

    /// Log content (can be multiline text from stdin or shell)
    #[arg(required = true)]
    pub content: String,
}

impl ExecutionLogCommand {
    /// Execute the log command.
    ///
    /// Adds a log entry to the specified execution.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The execution is not found
    /// - Database operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        // Verify the execution exists
        let execution = services
            .executions()
            .get_execution(&self.execution_id)
            .await?
            .ok_or_else(|| {
                ServiceError::validation_failed(format!(
                    "execution '{}' not found",
                    self.execution_id
                ))
            })?;

        // Create the session log
        let exec_id = execution
            .id
            .as_ref()
            .cloned()
            .unwrap_or_else(|| self.execution_id.clone());
        let log = SessionLog::new(exec_id, &self.content);
        let log_id = services.executions().add_log(log).await?;

        let content_preview = if self.content.len() > 50 {
            format!("{}...", &self.content[..50])
        } else {
            self.content.clone()
        };

        Ok(format!(
            "Added log {} to execution {}: \"{}\"",
            &log_id[..6.min(log_id.len())],
            &self.execution_id[..6.min(self.execution_id.len())],
            content_preview.replace('\n', " ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Test struct to parse commands
    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: ExecutionCommand,
    }

    #[test]
    fn test_execution_list_parses() {
        let cli = TestCli::try_parse_from(["test", "list", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::List(cmd) => {
                assert_eq!(cmd.task_id, "abc123");
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_execution_list_requires_task_id() {
        let result = TestCli::try_parse_from(["test", "list"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_show_parses() {
        let cli = TestCli::try_parse_from(["test", "show", "exec123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Show(cmd) => {
                assert_eq!(cmd.execution_id, "exec123");
            }
            _ => panic!("Expected Show command"),
        }
    }

    #[test]
    fn test_execution_show_requires_execution_id() {
        let result = TestCli::try_parse_from(["test", "show"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_list_debug() {
        let cli = TestCli::try_parse_from(["test", "list", "task123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("List") && debug_str.contains("task123"),
            "Debug output should contain List variant and task_id field value"
        );
    }

    #[test]
    fn test_execution_show_debug() {
        let cli = TestCli::try_parse_from(["test", "show", "exec123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Show") && debug_str.contains("exec123"),
            "Debug output should contain Show variant and execution_id field value"
        );
    }

    #[test]
    fn test_execution_log_parses() {
        let cli = TestCli::try_parse_from(["test", "log", "exec123", "Test log content"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Log(cmd) => {
                assert_eq!(cmd.execution_id, "exec123");
                assert_eq!(cmd.content, "Test log content");
            }
            _ => panic!("Expected Log command"),
        }
    }

    #[test]
    fn test_execution_log_requires_execution_id() {
        let result = TestCli::try_parse_from(["test", "log"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_log_requires_content() {
        let result = TestCli::try_parse_from(["test", "log", "exec123"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_log_debug() {
        let cli = TestCli::try_parse_from(["test", "log", "exec123", "content"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Log") && debug_str.contains("exec123"),
            "Debug output should contain Log variant and execution_id field value"
        );
    }

    #[test]
    fn test_execution_create_parses() {
        let cli = TestCli::try_parse_from(["test", "create", "task123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Create(cmd) => {
                assert_eq!(cmd.task_id, "task123");
                assert!(cmd.context.is_none());
                assert!(cmd.prompt.is_none());
            }
            _ => panic!("Expected Create command"),
        }
    }

    #[test]
    fn test_execution_create_with_context() {
        let cli = TestCli::try_parse_from([
            "test",
            "create",
            "task123",
            "--context",
            r#"{"task": "test"}"#,
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Create(cmd) => {
                assert_eq!(cmd.task_id, "task123");
                assert_eq!(cmd.context, Some(r#"{"task": "test"}"#.to_string()));
            }
            _ => panic!("Expected Create command"),
        }
    }

    #[test]
    fn test_execution_create_with_prompt() {
        let cli = TestCli::try_parse_from([
            "test",
            "create",
            "task123",
            "--prompt",
            r#"{"instruction": "do something"}"#,
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Create(cmd) => {
                assert_eq!(cmd.task_id, "task123");
                assert_eq!(
                    cmd.prompt,
                    Some(r#"{"instruction": "do something"}"#.to_string())
                );
            }
            _ => panic!("Expected Create command"),
        }
    }

    #[test]
    fn test_execution_create_with_both_flags() {
        let cli = TestCli::try_parse_from([
            "test",
            "create",
            "task123",
            "--context",
            r#"{"task": "test"}"#,
            "--prompt",
            r#"{"instruction": "do something"}"#,
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Create(cmd) => {
                assert_eq!(cmd.task_id, "task123");
                assert!(cmd.context.is_some());
                assert!(cmd.prompt.is_some());
            }
            _ => panic!("Expected Create command"),
        }
    }

    #[test]
    fn test_execution_create_requires_task_id() {
        let result = TestCli::try_parse_from(["test", "create"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_create_debug() {
        let cli = TestCli::try_parse_from(["test", "create", "task123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Create") && debug_str.contains("task123"),
            "Debug output should contain Create variant and task_id field value"
        );
    }

    #[test]
    fn test_execution_update_parses() {
        let cli = TestCli::try_parse_from(["test", "update", "exec123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Update(cmd) => {
                assert_eq!(cmd.execution_id, "exec123");
                assert!(cmd.output.is_none());
                assert!(cmd.transition_result.is_none());
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_execution_update_with_output() {
        let cli =
            TestCli::try_parse_from(["test", "update", "exec123", "--output", "Task completed"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Update(cmd) => {
                assert_eq!(cmd.execution_id, "exec123");
                assert_eq!(cmd.output, Some("Task completed".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_execution_update_with_transition_result() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "exec123",
            "--transition-result",
            "advance",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Update(cmd) => {
                assert_eq!(cmd.execution_id, "exec123");
                assert_eq!(cmd.transition_result, Some("advance".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_execution_update_with_all_flags() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "exec123",
            "--output",
            "Task completed",
            "--transition-result",
            "advance",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            ExecutionCommand::Update(cmd) => {
                assert_eq!(cmd.execution_id, "exec123");
                assert_eq!(cmd.output, Some("Task completed".to_string()));
                assert_eq!(cmd.transition_result, Some("advance".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_execution_update_requires_execution_id() {
        let result = TestCli::try_parse_from(["test", "update"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_update_debug() {
        let cli = TestCli::try_parse_from(["test", "update", "exec123"]).unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Update") && debug_str.contains("exec123"),
            "Debug output should contain Update variant and execution_id field value"
        );
    }

    // ========================================
    // Async execution tests
    // ========================================

    use vertebrae_core::{
        CreateTaskOptions, Database, Level, SessionLog, StepExecution, VertebraeServices,
    };

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> VertebraeServices {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    /// Helper to create a task with a workflow assigned
    async fn create_task_with_workflow(services: &VertebraeServices, id: &str, title: &str) {
        let options = CreateTaskOptions::new(title)
            .with_id(id)
            .with_level(Level::Task)
            .with_status("in_progress");
        services.tasks().create_task(options).await.unwrap();
    }

    #[tokio::test]
    async fn test_execution_create_succeeds() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let cmd = ExecutionCreateCommand {
            task_id: "task01".to_string(),
            context: None,
            prompt: None,
        };

        let result = cmd.execute(&services).await;
        assert!(
            result.is_ok(),
            "Create execution failed: {:?}",
            result.err()
        );

        let exec_id = result.unwrap();
        assert!(!exec_id.is_empty(), "Execution ID should not be empty");
    }

    #[tokio::test]
    async fn test_execution_create_with_context_and_prompt() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let cmd = ExecutionCreateCommand {
            task_id: "task01".to_string(),
            context: Some(r#"{"key": "value"}"#.to_string()),
            prompt: Some(r#"{"instruction": "do something"}"#.to_string()),
        };

        let result = cmd.execute(&services).await;
        assert!(
            result.is_ok(),
            "Create with context/prompt failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_execution_create_invalid_context_json() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let cmd = ExecutionCreateCommand {
            task_id: "task01".to_string(),
            context: Some("not valid json".to_string()),
            prompt: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err(), "Should fail with invalid JSON context");
        let err_msg = format!("{}", result.err().unwrap());
        assert!(
            err_msg.contains("invalid context JSON"),
            "Error should mention invalid context JSON, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_execution_create_invalid_prompt_json() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let cmd = ExecutionCreateCommand {
            task_id: "task01".to_string(),
            context: None,
            prompt: Some("{bad json".to_string()),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err(), "Should fail with invalid JSON prompt");
        let err_msg = format!("{}", result.err().unwrap());
        assert!(
            err_msg.contains("invalid prompt JSON"),
            "Error should mention invalid prompt JSON, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_execution_create_nonexistent_task() {
        let services = setup_test_service().await;

        let cmd = ExecutionCreateCommand {
            task_id: "nonexistent".to_string(),
            context: None,
            prompt: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err(), "Should fail for nonexistent task");
    }

    #[tokio::test]
    async fn test_execution_create_case_insensitive() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "abc123", "Test Task").await;

        let cmd = ExecutionCreateCommand {
            task_id: "ABC123".to_string(),
            context: None,
            prompt: None,
        };

        let result = cmd.execute(&services).await;
        assert!(
            result.is_ok(),
            "Case-insensitive create failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_execution_list_with_executions() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        // Create an execution directly
        let task = services.tasks().get_task("task01").await.unwrap();
        let workflow_id = task.workflow_id.as_ref().unwrap();
        let execution = StepExecution::new("task01", workflow_id.clone(), "in_progress");
        services
            .executions()
            .create_execution(execution)
            .await
            .unwrap();

        let cmd = ExecutionListCommand {
            task_id: "task01".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "List executions failed: {:?}", result.err());

        let output = result.unwrap();
        assert!(
            output.contains("Executions for task task01"),
            "Output should contain header, got: {}",
            output
        );
        assert!(
            output.contains("1 total"),
            "Should show total count, got: {}",
            output
        );
        assert!(
            output.contains("IN_PROGRESS"),
            "Should show status, got: {}",
            output
        );
    }

    #[tokio::test]
    async fn test_execution_list_empty() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let cmd = ExecutionListCommand {
            task_id: "task01".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
        assert!(result.unwrap().contains("No executions found"));
    }

    #[tokio::test]
    async fn test_execution_list_nonexistent_task() {
        let services = setup_test_service().await;

        let cmd = ExecutionListCommand {
            task_id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err(), "Should fail for nonexistent task");
    }

    #[tokio::test]
    async fn test_execution_show_details() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let task = services.tasks().get_task("task01").await.unwrap();
        let workflow_id = task.workflow_id.as_ref().unwrap();
        let execution = StepExecution::new("task01", workflow_id.clone(), "in_progress")
            .with_context(r#"{"key": "value"}"#);
        let exec_id = services
            .executions()
            .create_execution(execution)
            .await
            .unwrap();

        let cmd = ExecutionShowCommand {
            execution_id: exec_id.clone(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Show execution failed: {:?}", result.err());

        let output = result.unwrap();
        assert!(
            output.contains("Execution:"),
            "Should contain execution header"
        );
        assert!(
            output.contains("Metadata"),
            "Should contain metadata section"
        );
        assert!(output.contains("IN_PROGRESS"), "Should show status");
        assert!(output.contains("Context"), "Should show context section");
    }

    #[tokio::test]
    async fn test_execution_show_nonexistent() {
        let services = setup_test_service().await;

        let cmd = ExecutionShowCommand {
            execution_id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err(), "Should fail for nonexistent execution");
        let err_msg = format!("{}", result.err().unwrap());
        assert!(
            err_msg.contains("not found"),
            "Error should mention not found, got: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_execution_update_succeeds() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let task = services.tasks().get_task("task01").await.unwrap();
        let workflow_id = task.workflow_id.as_ref().unwrap();
        let execution = StepExecution::new("task01", workflow_id.clone(), "in_progress");
        let exec_id = services
            .executions()
            .create_execution(execution)
            .await
            .unwrap();

        let cmd = ExecutionUpdateCommand {
            execution_id: exec_id.clone(),
            output: Some("Task completed successfully".to_string()),
            transition_result: Some("advance".to_string()),
        };

        let result = cmd.execute(&services).await;
        assert!(
            result.is_ok(),
            "Update execution failed: {:?}",
            result.err()
        );
        let msg = result.unwrap();
        assert!(
            msg.contains("Updated execution"),
            "Should confirm update, got: {}",
            msg
        );
    }

    #[tokio::test]
    async fn test_execution_update_nonexistent() {
        let services = setup_test_service().await;

        let cmd = ExecutionUpdateCommand {
            execution_id: "nonexistent".to_string(),
            output: Some("output".to_string()),
            transition_result: None,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err(), "Should fail for nonexistent execution");
    }

    #[tokio::test]
    async fn test_execution_log_succeeds() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let task = services.tasks().get_task("task01").await.unwrap();
        let workflow_id = task.workflow_id.as_ref().unwrap();
        let execution = StepExecution::new("task01", workflow_id.clone(), "in_progress");
        let exec_id = services
            .executions()
            .create_execution(execution)
            .await
            .unwrap();

        let cmd = ExecutionLogCommand {
            execution_id: exec_id.clone(),
            content: "This is a log entry".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Add log failed: {:?}", result.err());

        let msg = result.unwrap();
        assert!(
            msg.contains("Added log"),
            "Should confirm log addition, got: {}",
            msg
        );
        assert!(
            msg.contains("This is a log entry"),
            "Should contain content preview, got: {}",
            msg
        );
    }

    #[tokio::test]
    async fn test_execution_log_long_content_truncated() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let task = services.tasks().get_task("task01").await.unwrap();
        let workflow_id = task.workflow_id.as_ref().unwrap();
        let execution = StepExecution::new("task01", workflow_id.clone(), "in_progress");
        let exec_id = services
            .executions()
            .create_execution(execution)
            .await
            .unwrap();

        let long_content = "x".repeat(100);
        let cmd = ExecutionLogCommand {
            execution_id: exec_id.clone(),
            content: long_content,
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok());

        let msg = result.unwrap();
        assert!(
            msg.contains("..."),
            "Long content should be truncated with '...', got: {}",
            msg
        );
    }

    #[tokio::test]
    async fn test_execution_log_nonexistent_execution() {
        let services = setup_test_service().await;

        let cmd = ExecutionLogCommand {
            execution_id: "nonexistent".to_string(),
            content: "some log".to_string(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_err(), "Should fail for nonexistent execution");
    }

    #[tokio::test]
    async fn test_execution_show_with_logs() {
        let services = setup_test_service().await;
        create_task_with_workflow(&services, "task01", "Test Task").await;

        let task = services.tasks().get_task("task01").await.unwrap();
        let workflow_id = task.workflow_id.as_ref().unwrap();
        let execution = StepExecution::new("task01", workflow_id.clone(), "in_progress");
        let exec_id = services
            .executions()
            .create_execution(execution)
            .await
            .unwrap();

        // Add a log entry
        let log = SessionLog::new(exec_id.clone(), "First log entry");
        services.executions().add_log(log).await.unwrap();

        let cmd = ExecutionShowCommand {
            execution_id: exec_id.clone(),
        };

        let result = cmd.execute(&services).await;
        assert!(result.is_ok(), "Show with logs failed: {:?}", result.err());

        let output = result.unwrap();
        assert!(
            output.contains("Session Logs"),
            "Should contain session logs section, got: {}",
            output
        );
        assert!(
            output.contains("First log entry"),
            "Should contain log content, got: {}",
            output
        );
    }
}
