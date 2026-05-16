use clap::Args;
use vertebrae_core::StepExecution;
use vertebrae_core::{ServiceError, VertebraeServices};

#[derive(Debug, Args)]
pub struct RunCommand {
    /// Task ID to run the workflow for
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub task_id: String,
}

impl RunCommand {
    pub async fn execute_result(
        &self,
        services: &VertebraeServices,
    ) -> Result<StepExecution, ServiceError> {
        let task = services.tasks().get_task(&self.task_id).await?;

        let _workflow_id = task.workflow_id.as_deref().ok_or_else(|| {
            ServiceError::validation_failed(format!(
                "Task {} has no assigned workflow",
                self.task_id
            ))
        })?;

        let step_id = task.current_step_id.as_deref().ok_or_else(|| {
            ServiceError::validation_failed(format!(
                "Task {} has no current step. Assign a workflow first.",
                self.task_id
            ))
        })?;

        services
            .executions()
            .run_step(&self.task_id, step_id)
            .await
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("no_daemon_connected") || msg.contains("no daemon") {
                    ServiceError::validation_failed(
                        "No daemon is connected to handle step execution. \
                         Start the daemon with `vtb-daemon` and try again.",
                    )
                } else {
                    e
                }
            })
    }

    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let execution = self.execute_result(services).await?;

        let id = execution.id.as_deref().unwrap_or("unknown");
        let short_id = if id.len() > 8 { &id[..8] } else { id };

        Ok(format!(
            "Execution {} started (step: {}, status: {})",
            short_id, execution.step_name, execution.status
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_command_parsing_basic() {
        use clap::Parser;

        #[derive(Parser)]
        struct TestCli {
            #[command(flatten)]
            run: RunCommand,
        }

        let cli = TestCli::parse_from(["test", "a1b2c3d4-0000-4000-8000-000000000001"]);
        assert_eq!(cli.run.task_id, "a1b2c3d4-0000-4000-8000-000000000001");
    }
}
