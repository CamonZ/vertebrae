use clap::Args;
use vertebrae_core::{ServiceError, TaskRun, TaskRunSummary, VertebraeServices};

#[derive(Debug, Args)]
pub struct RunWorkflowCommand {
    /// Task ID to start a TaskRun for
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub task_id: String,

    /// Maximum number of concurrently executing step attempts for the root TaskRun
    #[arg(long, value_parser = parse_max_concurrency)]
    pub max_concurrency: Option<i32>,
}

fn parse_max_concurrency(value: &str) -> Result<i32, String> {
    let value = value
        .parse::<i32>()
        .map_err(|_| "max-concurrency must be a positive integer".to_string())?;
    if value <= 0 {
        return Err("max-concurrency must be greater than zero".to_string());
    }
    Ok(value)
}

impl RunWorkflowCommand {
    pub async fn execute_result(
        &self,
        services: &VertebraeServices,
    ) -> Result<TaskRun, ServiceError> {
        services
            .executions()
            .run_workflow(&self.task_id, self.max_concurrency)
            .await
    }

    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let run = self.execute_result(services).await?;
        Ok(format!(
            "Run: {}",
            crate::output::format_task_run_brief(&TaskRunSummary::from(&run))
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        run_workflow: RunWorkflowCommand,
    }

    #[test]
    fn test_run_workflow_command_parsing_basic() {
        let cli = TestCli::parse_from(["test", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert_eq!(
            cli.run_workflow.task_id,
            "a1b2c3d4-0000-4000-8000-000000000001"
        );
        assert_eq!(cli.run_workflow.max_concurrency, None);
    }

    #[test]
    fn test_run_workflow_command_rejects_invalid_id() {
        let result = TestCli::try_parse_from(["test", "not-a-uuid"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_run_workflow_command_accepts_short_id() {
        let cli = TestCli::parse_from(["test", "a1b2c3d4"]);
        assert_eq!(cli.run_workflow.task_id, "a1b2c3d4");
    }

    #[test]
    fn test_run_workflow_command_accepts_positive_max_concurrency() {
        let cli = TestCli::parse_from(["test", "a1b2c3d4", "--max-concurrency", "4"]);
        assert_eq!(cli.run_workflow.max_concurrency, Some(4));
    }

    #[test]
    fn test_run_workflow_command_rejects_zero_or_invalid_max_concurrency() {
        for value in ["0", "-1", "not-a-number"] {
            let result = TestCli::try_parse_from(["test", "a1b2c3d4", "--max-concurrency", value]);
            assert!(
                result.is_err(),
                "expected invalid value to be rejected: {value}"
            );
        }
    }
}
