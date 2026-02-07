//! Step-done command for marking steps as complete
//!
//! Implements the `vtb step-done` command to mark individual steps within a task as done.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Mark a step as done within a task
#[derive(Debug, Args)]
pub struct StepDoneCommand {
    /// Task ID containing the step (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Step index (1-based) to mark as done
    #[arg(required = true)]
    pub index: usize,
}

/// Result of executing the step-done command
#[derive(Debug)]
pub struct StepDoneResult {
    /// The task ID
    pub task_id: String,
    /// The step index that was marked done
    pub step_index: usize,
    /// The content of the step that was marked done
    pub step_content: String,
}

impl std::fmt::Display for StepDoneResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Marked step {} as done in {}: {}",
            self.step_index, self.task_id, self.step_content
        )
    }
}

impl StepDoneCommand {
    /// Execute the step-done command.
    ///
    /// Marks the specified step as done within the task.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task does not exist
    /// - The step index is out of bounds
    /// - Service operations fail
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<StepDoneResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Validate index is positive
        if self.index == 0 {
            return Err(ServiceError::validation_failed(
                "Step index must be 1 or greater",
            ));
        }

        // Fetch task via service to get the step content before updating
        let task = services.tasks().get_task(&id).await?;

        let sections = task.sections.clone();

        // Filter to only step sections and sort by order
        let mut steps: Vec<(usize, &vertebrae_core::Section)> = sections
            .iter()
            .enumerate()
            .filter(|(_, s)| s.section_type == vertebrae_core::SectionType::Step)
            .collect();
        steps.sort_by_key(|(_, s)| s.order.unwrap_or(u32::MAX));

        // Find the step by index (1-based)
        let step_idx = self.index - 1;
        if step_idx >= steps.len() {
            return Err(ServiceError::validation_failed(format!(
                "Step {} not found. Task has {} step(s).",
                self.index,
                steps.len()
            )));
        }

        let (_, step) = steps[step_idx];
        let step_content = step.content.clone();

        // Use the new service method to mark step as done
        // This replaces the direct database access and handles mutation callback
        services.tasks().mark_step_done(&id, self.index).await?;

        Ok(StepDoneResult {
            task_id: id,
            step_index: self.index,
            step_content,
        })
    }
}
