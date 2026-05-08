use clap::Args;
use vertebrae_core::{ServiceError, TaskRunSummary, VertebraeServices};

#[derive(Debug, Args)]
pub struct RunWorkflowCommand {
    /// Task ID to start a TaskRun for
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub task_id: String,
}

impl RunWorkflowCommand {
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let run = services.executions().run_workflow(&self.task_id).await?;

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
}
