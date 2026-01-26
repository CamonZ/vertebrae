//! Step-done command for marking steps as complete
//!
//! Implements the `vtb step-done` command to mark individual steps within a task as done.

use clap::Args;
use vertebrae_core::ServiceError;

/// Mark a step as done within a task
#[derive(Debug, Args)]
pub struct StepDoneCommand {
    /// Task ID containing the step (case-insensitive)
    #[arg(required = true)]
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
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task does not exist
    /// - The step index is out of bounds
    /// - Service operations fail
    pub async fn execute(
        &self,
        service: &dyn vertebrae_core::TaskService,
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
        let task = service.get_task(&id).await?;

        let sections = task.sections.clone();

        // Filter to only step sections and sort by order
        let mut steps: Vec<(usize, &vertebrae_db::Section)> = sections
            .iter()
            .enumerate()
            .filter(|(_, s)| s.section_type == vertebrae_db::SectionType::Step)
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
        service.mark_step_done(&id, self.index).await?;

        Ok(StepDoneResult {
            task_id: id,
            step_index: self.index,
            step_content,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_step_done_result_display() {
        let result = StepDoneResult {
            task_id: "abc123".to_string(),
            step_index: 1,
            step_content: "First step".to_string(),
        };

        let display = format!("{}", result);
        assert!(display.contains("Marked step 1 as done"));
        assert!(display.contains("abc123"));
        assert!(display.contains("First step"));
    }

    #[test]
    fn test_step_done_command_debug() {
        let cmd = StepDoneCommand {
            id: "abc123".to_string(),
            index: 1,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("StepDoneCommand"));
        assert!(debug_str.contains("abc123"));
    }

    #[test]
    fn test_step_done_result_debug() {
        let result = StepDoneResult {
            task_id: "abc123".to_string(),
            step_index: 1,
            step_content: "Test step".to_string(),
        };
        let debug_str = format!("{:?}", result);
        assert!(debug_str.contains("StepDoneResult"));
        assert!(debug_str.contains("abc123"));
    }
}
