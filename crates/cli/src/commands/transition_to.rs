//! Transition-to command for workflow-based transitions
//!
//! Implements the `vtb transition-to` command to transition tasks between
//! workflow steps. Validates transitions against the step transitions graph.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Transition a task to a specific workflow step
///
/// Both arguments are UUIDs. The target step must belong to the same workflow
/// the task is currently assigned to, and must be a valid transition from the
/// task's current step (unless --skip-validation is used).
#[derive(Debug, Args)]
pub struct TransitionToCommand {
    /// Task UUID to transition
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Target step UUID to transition the task to
    #[arg(required = true, value_parser = crate::commands::parse_uuid("step ID"))]
    pub target: String,

    /// Override warnings (but not errors) when transitioning
    #[arg(short, long)]
    pub force: bool,

    /// Bypass workflow transition validation (escape hatch)
    #[arg(long)]
    pub skip_validation: bool,
}

/// Result of the transition-to command execution
#[derive(Debug)]
pub struct TransitionToResult {
    pub id: String,
    pub target_workflow: String,
    pub target_step: Option<String>,
    pub from_workflow: Option<String>,
    pub from_step: Option<String>,
    pub unblocked_tasks: Vec<(String, String)>,
    pub validation_skipped: bool,
}

impl std::fmt::Display for TransitionToResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Show validation skipped notice
        if self.validation_skipped {
            writeln!(
                f,
                "Note: Workflow transition validation skipped (--skip-validation)"
            )?;
            writeln!(f)?;
        }

        // Main result message
        let step_info = self
            .target_step
            .as_ref()
            .map(|s| format!(":{}", s))
            .unwrap_or_default();

        if let Some(from_wf) = &self.from_workflow {
            let from_step = self
                .from_step
                .as_ref()
                .map(|s| format!(":{}", s))
                .unwrap_or_default();
            writeln!(
                f,
                "Transitioned task '{}' from {}{} to {}{}",
                self.id, from_wf, from_step, self.target_workflow, step_info
            )?;
        } else {
            writeln!(
                f,
                "Assigned task '{}' to workflow {}{}",
                self.id, self.target_workflow, step_info
            )?;
        }

        // Show unblocked tasks if any
        if !self.unblocked_tasks.is_empty() {
            writeln!(f)?;
            writeln!(f, "Unblocked tasks:")?;
            for (id, title) in &self.unblocked_tasks {
                writeln!(f, "  - {} ({})", id, title)?;
            }
        }

        Ok(())
    }
}

impl TransitionToCommand {
    /// Execute the transition-to command.
    ///
    /// Transitions a task to a target step within the same workflow,
    /// validating the transition against the step's transitions_to graph.
    #[allow(deprecated)]
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<TransitionToResult, ServiceError> {
        let id = self.id.to_lowercase();
        let target_step_id = self.target.to_lowercase();

        // Get the task
        let task = services.tasks().get_task(&id).await?;

        // Get current workflow info
        let from_workflow = task.workflow_id.clone();
        let from_step = task.current_step_id.clone();

        // Resolve target step - validate it exists
        let target_step = services
            .steps()
            .get_step(&target_step_id)
            .await?
            .ok_or_else(|| {
                ServiceError::InvalidInput(format!(
                    "Step '{}' not found. Use 'vtb step list <workflow-id>' to see available steps.",
                    target_step_id
                ))
            })?;

        let target_workflow_id = target_step.workflow_id.clone();

        // Validate the task is assigned to the same workflow
        if let Some(current_wf_id) = &from_workflow {
            if current_wf_id != &target_workflow_id {
                return Err(ServiceError::InvalidInput(format!(
                    "Target step belongs to workflow '{}' but task is in workflow '{}'. \
                     Use 'vtb workflow assign' to change workflows first.",
                    target_workflow_id, current_wf_id
                )));
            }
        } else {
            return Err(ServiceError::InvalidInput(format!(
                "Task '{}' is not assigned to any workflow. \
                 Use 'vtb workflow assign' first.",
                id
            )));
        }

        // Validate the transition if not skipped
        if !self.skip_validation
            && let Some(current_step_id) = &from_step
        {
            let current_step = services
                .steps()
                .get_step(current_step_id)
                .await?
                .ok_or_else(|| {
                    ServiceError::InvalidInput(format!(
                        "Task's current step '{}' not found (invariant violation)",
                        current_step_id
                    ))
                })?;

            let is_valid_transition = current_step
                .transitions_to
                .iter()
                .any(|t| t == &target_step_id);

            let is_same_step = current_step_id == &target_step_id;

            if !is_valid_transition && !is_same_step {
                // Get valid transition names for the error message
                let steps = services
                    .steps()
                    .list_steps_for_workflow(&target_workflow_id)
                    .await?;
                let valid_transitions: Vec<String> = current_step
                    .transitions_to
                    .iter()
                    .filter_map(|t| steps.iter().find(|s| s.id.as_ref() == Some(t)))
                    .map(|s| format!("{} ({})", s.name, s.id.as_deref().unwrap_or("?")))
                    .collect();

                let hint = if valid_transitions.is_empty() {
                    "This step has no valid transitions (terminal state).".to_string()
                } else {
                    format!(
                        "Valid transitions from '{}': {}",
                        current_step.name,
                        valid_transitions.join(", ")
                    )
                };

                return Err(ServiceError::InvalidInput(format!(
                    "Invalid step transition from '{}' to '{}'. {}",
                    current_step.name, target_step.name, hint
                )));
            }
        }

        // Perform the transition
        services
            .tasks()
            .set_current_step(&id, &target_step_id)
            .await?;

        // Resolve target step name for display
        let target_step_name = Some(target_step.name.clone());

        // Get unblocked tasks (for done/terminal steps)
        let mut unblocked_tasks = vec![];
        if target_step.is_final {
            let dependents = services.tasks().get_dependents(&id).await?;

            for dependent_id in dependents {
                let blockers = services
                    .tasks()
                    .get_incomplete_blockers_with_details(&dependent_id)
                    .await?;

                if blockers.is_empty()
                    && let Ok(task) = services.tasks().get_task(&dependent_id).await
                {
                    unblocked_tasks.push((dependent_id, task.title));
                }
            }
        }

        Ok(TransitionToResult {
            id,
            target_workflow: target_workflow_id,
            target_step: target_step_name,
            from_workflow,
            from_step,
            unblocked_tasks,
            validation_skipped: self.skip_validation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== TransitionToResult Display tests ====================

    #[test]
    fn test_display_transition_with_from_workflow_and_step() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target_workflow: "review".to_string(),
            target_step: Some("pending".to_string()),
            from_workflow: Some("implementation".to_string()),
            from_step: Some("coding".to_string()),
            unblocked_tasks: vec![],
            validation_skipped: false,
        };
        let output = format!("{}", result);
        assert!(
            output
                .contains("Transitioned task 'task1' from implementation:coding to review:pending")
        );
        assert!(!output.contains("validation skipped"));
        assert!(!output.contains("Unblocked"));
    }

    #[test]
    fn test_display_transition_with_from_workflow_no_step() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target_workflow: "review".to_string(),
            target_step: None,
            from_workflow: Some("implementation".to_string()),
            from_step: None,
            unblocked_tasks: vec![],
            validation_skipped: false,
        };
        let output = format!("{}", result);
        assert!(output.contains("Transitioned task 'task1' from implementation to review"));
    }

    #[test]
    fn test_display_transition_no_from_workflow() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target_workflow: "implementation".to_string(),
            target_step: Some("backlog".to_string()),
            from_workflow: None,
            from_step: None,
            unblocked_tasks: vec![],
            validation_skipped: false,
        };
        let output = format!("{}", result);
        assert!(output.contains("Assigned task 'task1' to workflow implementation:backlog"));
    }

    #[test]
    fn test_display_transition_no_from_no_step() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target_workflow: "default".to_string(),
            target_step: None,
            from_workflow: None,
            from_step: None,
            unblocked_tasks: vec![],
            validation_skipped: false,
        };
        let output = format!("{}", result);
        assert!(output.contains("Assigned task 'task1' to workflow default"));
    }

    #[test]
    fn test_display_transition_with_validation_skipped() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target_workflow: "review".to_string(),
            target_step: None,
            from_workflow: None,
            from_step: None,
            unblocked_tasks: vec![],
            validation_skipped: true,
        };
        let output = format!("{}", result);
        assert!(output.contains("validation skipped"));
        assert!(output.contains("--skip-validation"));
    }

    #[test]
    fn test_display_transition_with_unblocked_tasks() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target_workflow: "default".to_string(),
            target_step: Some("done".to_string()),
            from_workflow: Some("default".to_string()),
            from_step: Some("in_progress".to_string()),
            unblocked_tasks: vec![
                ("task2".to_string(), "Build feature X".to_string()),
                ("task3".to_string(), "Write tests".to_string()),
            ],
            validation_skipped: false,
        };
        let output = format!("{}", result);
        assert!(output.contains("Unblocked tasks:"));
        assert!(output.contains("task2"));
        assert!(output.contains("Build feature X"));
        assert!(output.contains("task3"));
        assert!(output.contains("Write tests"));
    }

    #[test]
    fn test_display_transition_all_features() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target_workflow: "done".to_string(),
            target_step: Some("completed".to_string()),
            from_workflow: Some("review".to_string()),
            from_step: Some("approved".to_string()),
            unblocked_tasks: vec![("task2".to_string(), "Next task".to_string())],
            validation_skipped: true,
        };
        let output = format!("{}", result);
        assert!(output.contains("validation skipped"));
        assert!(output.contains("Transitioned task 'task1'"));
        assert!(output.contains("from review:approved to done:completed"));
        assert!(output.contains("Unblocked tasks:"));
        assert!(output.contains("task2"));
    }

    // ==================== TransitionToCommand struct tests ====================

    #[test]
    fn test_transition_to_command_debug() {
        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: "step-uuid-123".to_string(),
            force: true,
            skip_validation: false,
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("TransitionToCommand"));
        assert!(debug.contains("task1"));
        assert!(debug.contains("step-uuid-123"));
    }

    #[test]
    fn test_transition_to_command_defaults() {
        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: "step-uuid-456".to_string(),
            force: false,
            skip_validation: false,
        };
        assert!(!cmd.force);
        assert!(!cmd.skip_validation);
    }

    // ==================== TransitionToResult debug ====================

    #[test]
    fn test_transition_to_result_debug() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target_workflow: "review".to_string(),
            target_step: Some("pending".to_string()),
            from_workflow: None,
            from_step: None,
            unblocked_tasks: vec![],
            validation_skipped: false,
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("TransitionToResult"));
        assert!(debug.contains("task1"));
        assert!(debug.contains("review"));
    }
}
