use clap::Args;
use vertebrae_core::{ServiceError, StopRunTarget, TaskRunSummary, VertebraeServices};

#[derive(Debug, Args)]
pub struct StopCommand {
    /// Task ID whose active TaskRun should be stopped
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub task_id: String,
}

impl StopCommand {
    pub async fn execute_result(
        &self,
        services: &VertebraeServices,
    ) -> Result<Option<vertebrae_core::TaskRun>, ServiceError> {
        services
            .executions()
            .stop_run(StopRunTarget::TaskId(self.task_id.clone()))
            .await
    }

    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let stopped_run = self.execute_result(services).await?;
        Ok(match stopped_run {
            Some(run) => format!(
                "Stopped run: {}",
                crate::output::format_task_run_brief(&TaskRunSummary::from(&run))
            ),
            None => format!("No active run for task {}", self.task_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        stop: StopCommand,
    }

    #[test]
    fn test_stop_command_parsing_basic() {
        let cli = TestCli::parse_from(["test", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert_eq!(cli.stop.task_id, "a1b2c3d4-0000-4000-8000-000000000001");
    }

    #[test]
    fn test_stop_command_rejects_invalid_id() {
        let result = TestCli::try_parse_from(["test", "not-a-uuid"]);
        assert!(result.is_err());
    }
}
