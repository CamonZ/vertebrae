//! Transition-to command for workflow-based transitions
//!
//! Implements the `vtb transition-to` command to transition tasks between
//! workflow steps. Validates transitions against the step transitions graph.

use clap::Args;
use serde::Serialize;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Transition a task to a specific workflow step
///
/// The task argument accepts a full task UUID or 8-character short ID,
/// case-insensitive. The target can be a full step UUID, an 8-character step
/// short ID, or a step name (e.g., 'backlog', 'in_progress', 'done'). When a
/// name is given, it is resolved by looking up the task's current workflow
/// steps.
#[derive(Debug, Args)]
pub struct TransitionToCommand {
    /// Task ID to transition (full UUID or 8-character short ID)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Target step: name, full UUID, or 8-character short ID
    #[arg(required = true)]
    pub target: String,

    /// Override warnings (but not errors) when transitioning
    #[arg(short, long)]
    pub force: bool,

    /// Bypass workflow transition validation (escape hatch)
    #[arg(long)]
    pub skip_validation: bool,
}

/// Result of the transition-to command execution
#[derive(Debug, Serialize)]
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
    /// Transitions a task to a target step within the same workflow. Use
    /// `vtb workflow assign` to move a task to a different workflow.
    /// Transitions are validated against the step's transitions_to graph unless
    /// `--skip-validation` is supplied.
    #[allow(deprecated)]
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<TransitionToResult, ServiceError> {
        let id = self.id.to_lowercase();
        let target_input = self.target.clone();

        // Get the task
        let task = services.tasks().get_task(&id).await?;

        // Get current workflow info
        let from_workflow = task.workflow_id.clone();
        let from_step = task.current_step_id.clone();

        // Resolve target: full UUID, 8-char short ID, or step name
        let is_full_uuid = uuid::Uuid::parse_str(&target_input).is_ok();
        let is_short = crate::commands::is_short_id(&target_input);
        let target_step = if is_full_uuid || is_short {
            // Resolve via step service for short IDs (scoped to the task's
            // workflow when present, otherwise project-wide). Full UUIDs are
            // looked up directly.
            let target_step_id = if is_full_uuid {
                target_input.to_lowercase()
            } else {
                crate::commands::resolve_step_id(&target_input, from_workflow.as_deref(), services)
                    .await?
            };
            services
                .steps()
                .get_step(&target_step_id)
                .await?
                .ok_or_else(|| {
                    ServiceError::InvalidInput(format!(
                        "Step '{}' not found. Use 'vtb step list <workflow-id>' to see available steps.",
                        target_step_id
                    ))
                })?
        } else {
            // Treat as step name — resolve via the task's workflow
            let wf_id = from_workflow.as_ref().ok_or_else(|| {
                ServiceError::InvalidInput(format!(
                    "Task '{}' is not assigned to any workflow. \
                     Use 'vtb workflow assign' first.",
                    id
                ))
            })?;

            let steps = services.steps().list_steps_for_workflow(wf_id).await?;

            match steps.iter().find(|s| s.name == target_input) {
                Some(step) => step.clone(),
                None => {
                    // Check if the name exists in another workflow
                    let all_steps = services.steps().list_all_steps().await?;
                    if let Some(other) = all_steps.iter().find(|s| s.name == target_input) {
                        return Err(ServiceError::InvalidInput(format!(
                            "Target step belongs to workflow '{}' but task is in workflow '{}'. \
                             Use 'vtb workflow assign' to change workflows first.",
                            other.workflow_id, wf_id
                        )));
                    }
                    return Err(ServiceError::InvalidInput(format!(
                        "Step name '{}' not found in workflow. \
                         Use 'vtb step list {}' to see available steps.",
                        target_input, wf_id
                    )));
                }
            }
        };

        let target_step_id = target_step
            .id
            .clone()
            .expect("resolved step must have an ID");
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

        // Skip the backend call if already on the target step (no-op)
        let is_same_step = from_step.as_ref() == Some(&target_step_id);
        if !is_same_step {
            if self.skip_validation {
                services
                    .tasks()
                    .advance_to_step(&id, &target_step_id)
                    .await?;
            } else {
                services
                    .tasks()
                    .set_current_step(&id, &target_step_id)
                    .await?;
            }
        }

        // Resolve names for display
        let target_step_name = Some(target_step.name.clone());
        let workflow = services
            .workflows()
            .get_workflow(&target_workflow_id)
            .await?;
        let target_workflow_name = workflow.name;

        let from_workflow_name = from_workflow.as_ref().map(|_| target_workflow_name.clone());
        let from_step_name = if let Some(step_id) = &from_step {
            services.steps().get_step(step_id).await?.map(|s| s.name)
        } else {
            None
        };

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
            target_workflow: target_workflow_name,
            target_step: target_step_name,
            from_workflow: from_workflow_name,
            from_step: from_step_name,
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
