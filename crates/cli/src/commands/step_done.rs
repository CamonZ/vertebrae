//! Step-done command for marking steps as complete
//!
//! Implements the `vtb step-done` command to mark individual steps within a task as done.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

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

    #[test]
    fn test_step_done_command_various_indices() {
        let indices = vec![1, 2, 5, 10, 100];
        for idx in indices {
            let cmd = StepDoneCommand {
                id: "task-123".to_string(),
                index: idx,
            };
            assert_eq!(cmd.index, idx);
        }
    }

    #[test]
    fn test_step_done_result_display_multiple_steps() {
        for step_num in 1..=5 {
            let result = StepDoneResult {
                task_id: "task-abc".to_string(),
                step_index: step_num,
                step_content: format!("Step {}", step_num),
            };
            let display = format!("{}", result);
            assert!(display.contains(&format!("Marked step {} as done", step_num)));
            assert!(display.contains("task-abc"));
        }
    }

    #[test]
    fn test_step_done_command_with_various_ids() {
        let ids = vec![
            "abc",
            "task-123",
            "UPPERCASE",
            "with-dashes-and-numbers-123",
        ];
        for id in ids {
            let cmd = StepDoneCommand {
                id: id.to_string(),
                index: 1,
            };
            assert_eq!(cmd.id, id);
        }
    }

    #[test]
    fn test_step_done_result_with_long_content() {
        let long_content = "This is a very long step description that spans multiple words and contains detailed instructions for completing this step".to_string();
        let result = StepDoneResult {
            task_id: "task-123".to_string(),
            step_index: 1,
            step_content: long_content.clone(),
        };
        let display = format!("{}", result);
        assert!(display.contains(&long_content));
    }

    #[test]
    fn test_step_done_result_with_special_characters() {
        let result = StepDoneResult {
            task_id: "task-123".to_string(),
            step_index: 1,
            step_content: "Step with special chars: !@#$%^&*()".to_string(),
        };
        let display = format!("{}", result);
        assert!(display.contains("!@#$%^&*()"));
    }

    // ==================== Async execute tests ====================

    async fn setup_services() -> VertebraeServices {
        let db = vertebrae_core::Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    async fn create_task_with_steps(services: &VertebraeServices, num_steps: usize) -> String {
        let options = vertebrae_core::CreateTaskOptions::new("Task with steps");
        let id = services.tasks().create_task(options).await.unwrap();

        for i in 0..num_steps {
            let section = vertebrae_core::Section {
                section_type: vertebrae_core::SectionType::Step,
                content: format!("Step {}", i + 1),
                order: Some(i as u32),
                done: None,
                done_at: None,
                refs: Vec::new(),
            };
            services.tasks().add_section(&id, section).await.unwrap();
        }

        id
    }

    #[tokio::test]
    async fn test_execute_step_done_success() {
        let services = setup_services().await;
        let id = create_task_with_steps(&services, 3).await;

        let cmd = StepDoneCommand {
            id: id.clone(),
            index: 1,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
        let step_result = result.unwrap();
        assert_eq!(step_result.task_id, id);
        assert_eq!(step_result.step_index, 1);
        assert_eq!(step_result.step_content, "Step 1");
    }

    #[tokio::test]
    async fn test_execute_step_done_second_step() {
        let services = setup_services().await;
        let id = create_task_with_steps(&services, 3).await;

        let cmd = StepDoneCommand {
            id: id.clone(),
            index: 2,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
        let step_result = result.unwrap();
        assert_eq!(step_result.step_index, 2);
        assert_eq!(step_result.step_content, "Step 2");
    }

    #[tokio::test]
    async fn test_execute_step_done_zero_index_fails() {
        let services = setup_services().await;
        let id = create_task_with_steps(&services, 3).await;

        let cmd = StepDoneCommand {
            id: id.clone(),
            index: 0,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
        let err = format!("{}", result.unwrap_err());
        assert!(err.contains("1 or greater"));
    }

    #[tokio::test]
    async fn test_execute_step_done_out_of_bounds() {
        let services = setup_services().await;
        let id = create_task_with_steps(&services, 2).await;

        let cmd = StepDoneCommand {
            id: id.clone(),
            index: 5,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
        let err = format!("{}", result.unwrap_err());
        assert!(err.contains("not found") || err.contains("2 step(s)"));
    }

    #[tokio::test]
    async fn test_execute_step_done_no_steps() {
        let services = setup_services().await;
        let options = vertebrae_core::CreateTaskOptions::new("No steps task");
        let id = services.tasks().create_task(options).await.unwrap();

        let cmd = StepDoneCommand {
            id: id.clone(),
            index: 1,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
        let err = format!("{}", result.unwrap_err());
        assert!(err.contains("0 step(s)") || err.contains("not found"));
    }

    #[tokio::test]
    async fn test_execute_step_done_nonexistent_task() {
        let services = setup_services().await;

        let cmd = StepDoneCommand {
            id: "nonexistent".to_string(),
            index: 1,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_execute_step_done_case_insensitive_id() {
        let services = setup_services().await;
        let id = create_task_with_steps(&services, 1).await;

        let cmd = StepDoneCommand {
            id: id.to_uppercase(),
            index: 1,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_execute_step_done_display() {
        let services = setup_services().await;
        let id = create_task_with_steps(&services, 1).await;

        let cmd = StepDoneCommand {
            id: id.clone(),
            index: 1,
        };
        let result = cmd.execute(&services).await.unwrap();
        let display = format!("{}", result);
        assert!(display.contains("Marked step 1 as done"));
        assert!(display.contains(&id));
    }
}
