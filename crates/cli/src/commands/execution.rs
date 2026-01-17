//! Execution commands for viewing workflow execution history
//!
//! Implements the `vtb execution` subcommand group for viewing step executions
//! and their associated session logs.

use clap::{Args, Subcommand};
use surrealdb::sql::Thing;
use vertebrae_core::{ServiceError, TaskService};
use vertebrae_db::{ExecutionStatus, SessionLog};

/// Execution management commands
#[derive(Debug, Subcommand)]
pub enum ExecutionCommand {
    /// List all executions for a task
    List(ExecutionListCommand),
    /// Show details of a specific execution
    Show(ExecutionShowCommand),
    /// Add a log entry to an execution
    Log(ExecutionLogCommand),
}

impl ExecutionCommand {
    /// Execute the execution subcommand.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        match self {
            ExecutionCommand::List(cmd) => cmd.execute(service).await,
            ExecutionCommand::Show(cmd) => cmd.execute(service).await,
            ExecutionCommand::Log(cmd) => cmd.execute(service).await,
        }
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
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task is not found
    /// - Database operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        // Normalize task ID to lowercase for case-insensitive lookup
        let task_id = self.task_id.to_lowercase();

        // Verify the task exists
        let task_exists = service.task_exists(&task_id).await?;
        if !task_exists {
            return Err(ServiceError::task_not_found(&self.task_id));
        }

        // Get executions for the task
        let db = service.database();
        let executions = db.executions().list_executions_for_task(&task_id).await?;

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
                .map(|t| t.id.to_raw())
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
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The execution is not found
    /// - Database operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        // Try to get the execution
        let db = service.database();
        let execution = db
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
            .map(|t| t.id.to_raw())
            .unwrap_or_else(|| "?".to_string());

        let task_id = execution.task_id.id.to_raw();
        let workflow_id = execution.workflow_id.id.to_raw();

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

        // Get session logs for this execution
        let logs = db.executions().list_logs_for_execution(&exec_id).await?;

        if !logs.is_empty() {
            output.push('\n');
            output.push_str("Session Logs\n");
            output.push_str(&"-".repeat(40));
            output.push('\n');

            for (i, log) in logs.iter().enumerate() {
                let created = log.created_at.format("%Y-%m-%d %H:%M:%S");
                let log_id = log
                    .id
                    .as_ref()
                    .map(|t| t.id.to_raw())
                    .unwrap_or_else(|| "?".to_string());
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
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The execution is not found
    /// - Database operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        // Verify the execution exists
        let db = service.database();
        let execution = db
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
            .map(|t| t.id.to_raw())
            .unwrap_or_else(|| self.execution_id.clone());
        let step_execution_thing = Thing::from(("step_execution", exec_id.as_str()));
        let log = SessionLog::new(step_execution_thing, &self.content);
        let log_id = db.executions().add_log(&log).await?;

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
}
