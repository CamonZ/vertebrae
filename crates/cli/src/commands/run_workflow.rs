use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

#[derive(Debug, Args)]
pub struct RunWorkflowCommand {
    /// Task ID to orchestrate through its entire workflow
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub task_id: String,
}

impl RunWorkflowCommand {
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let task = services.tasks().get_task(&self.task_id).await?;

        if task.workflow_id.is_none() {
            return Err(ServiceError::validation_failed(format!(
                "Task {} has no assigned workflow",
                self.task_id
            )));
        }

        services
            .executions()
            .orchestrate_task(&self.task_id)
            .await?;

        let short_id = if self.task_id.len() > 8 {
            &self.task_id[..8]
        } else {
            &self.task_id
        };

        Ok(format!(
            "Workflow orchestration started for task {}",
            short_id
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
