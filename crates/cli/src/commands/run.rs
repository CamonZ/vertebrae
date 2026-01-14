use clap::Args;
use std::time::Duration;
use vertebrae_core::{ServiceError, TaskService};

#[derive(Debug, Args)]
pub struct RunCommand {
    /// Task ID to run workflow for
    task_id: String,
}

impl RunCommand {
    pub async fn execute(&self, service: &dyn TaskService) -> Result<(), ServiceError> {
        // Verify task exists and has workflow
        let task = service.get_task(&self.task_id).await?;

        if task.workflow_id.is_none() {
            return Err(ServiceError::ValidationFailed {
                message: format!("Task {} has no assigned workflow", self.task_id),
            });
        }

        // Send HTTP POST to GUI
        let url = "http://127.0.0.1:17273/api/run-workflow";
        let payload = serde_json::json!({ "task_id": self.task_id });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| ServiceError::ValidationFailed {
                message: format!("HTTP client error: {}", e),
            })?;

        let response = client.post(url).json(&payload).send().await.map_err(|_| {
            ServiceError::ValidationFailed {
                message: "Failed to connect to GUI on port 17273. Is the GUI running?".to_string(),
            }
        })?;

        if !response.status().is_success() {
            return Err(ServiceError::ValidationFailed {
                message: format!("GUI returned error: {}", response.status()),
            });
        }

        println!("✓ Workflow execution started for task {}", self.task_id);
        println!("  View progress in the GUI");

        Ok(())
    }
}
