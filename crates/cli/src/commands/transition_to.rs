//! Transition-to command for workflow-based transitions
//!
//! Implements the `vtb transition-to` command to transition tasks between workflows
//! and steps. Validates transitions against the workflow_transitions edge table.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Transition a task to a workflow/step
#[derive(Debug, Args)]
pub struct TransitionToCommand {
    /// Task ID to transition (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Target workflow or workflow:step (e.g., 'implementation' or 'review:approved')
    #[arg(required = true)]
    pub target: String,

    /// Override warnings (but not errors) when transitioning
    #[arg(short, long)]
    pub force: bool,

    /// Bypass workflow transition validation (escape hatch)
    #[arg(long)]
    pub skip_validation: bool,
}

/// Parsed target representing either a workflow or workflow:step combination
#[derive(Debug, Clone)]
pub struct ParsedTarget {
    /// The target workflow name or ID
    pub workflow: String,
    /// Optional target step name within the workflow
    pub step: Option<String>,
}

impl ParsedTarget {
    /// Parse a target string into workflow and optional step.
    ///
    /// Formats:
    /// - "workflow" -> workflow only, use initial step
    /// - "workflow:step" -> specific step in workflow
    pub fn parse(target: &str) -> Self {
        if let Some((workflow, step)) = target.split_once(':') {
            Self {
                workflow: workflow.to_string(),
                step: Some(step.to_string()),
            }
        } else {
            Self {
                workflow: target.to_string(),
                step: None,
            }
        }
    }
}

/// Result of the transition-to command execution
#[derive(Debug)]
pub struct TransitionToResult {
    /// The task ID that was transitioned
    pub id: String,
    /// The target workflow
    pub target_workflow: String,
    /// The target step (if specified or determined)
    pub target_step: Option<String>,
    /// The previous workflow (if any)
    pub from_workflow: Option<String>,
    /// The previous step (if any)
    pub from_step: Option<String>,
    /// List of tasks that are now unblocked
    pub unblocked_tasks: Vec<(String, String)>, // (id, title)
    /// Whether validation was skipped
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
    /// Transitions a task to a workflow/step with proper validation against
    /// the workflow_transitions edge table.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - The target workflow does not exist
    /// - The transition is not allowed (no workflow_transitions edge)
    /// - Database operations fail
    #[allow(deprecated)]
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<TransitionToResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Parse target into workflow and optional step
        let parsed = ParsedTarget::parse(&self.target);

        // Get the task
        let task = services.tasks().get_task(&id).await?;

        // Get current workflow info
        let from_workflow = task.workflow_id.clone();
        let from_step = task.current_step_id.clone();

        // Get workflow service for workflow operations
        let workflow_service = services.workflows();

        // Resolve target workflow - validate it exists
        let _ = workflow_service.get_workflow(&parsed.workflow).await?;

        let target_workflow_id = parsed.workflow.clone();

        // Validate the transition if not skipped
        if !self.skip_validation
            && let Some(current_wf_id) = &from_workflow
        {
            // Check if transition is allowed
            let transitions = workflow_service
                .get_transitions_from_workflow(current_wf_id)
                .await?;
            let allowed = transitions
                .iter()
                .any(|t| t.to_workflow == target_workflow_id);

            if current_wf_id != &target_workflow_id && !allowed {
                return Err(ServiceError::InvalidInput(format!(
                    "Transition from workflow '{}' to '{}' is not allowed. \
                     Use --skip-validation to bypass this check.",
                    current_wf_id, target_workflow_id
                )));
            }

            // If staying within the same workflow, validate step transition
            if current_wf_id == &target_workflow_id
                && let Some(target_step_name) = &parsed.step
            {
                // Query steps for this workflow
                let steps = services
                    .steps()
                    .list_steps_for_workflow(current_wf_id.as_str())
                    .await?;

                // Invariant: task always has current_step_id
                let current_step_id = task.current_step_id.as_ref().ok_or_else(|| {
                    ServiceError::InvalidInput(format!(
                        "Task {} is missing current_step_id (invariant violation)",
                        id
                    ))
                })?;
                let current_step = steps
                    .iter()
                    .find(|s| s.id.as_ref() == Some(current_step_id));

                // Find target step
                let target_step = steps.iter().find(|s| s.name == *target_step_name);

                // Check if target step exists
                if target_step.is_none() {
                    return Err(ServiceError::InvalidInput(format!(
                        "Step '{}' not found in workflow '{}'",
                        target_step_name, target_workflow_id
                    )));
                }

                if let (Some(current), Some(target)) = (current_step, target_step) {
                    // Check if target is in current step's transitions_to
                    let target_id = target.id.as_ref();
                    let is_valid_transition = target_id.is_some()
                        && current
                            .transitions_to
                            .iter()
                            .any(|t| Some(t.as_str()) == target_id.map(|s| s.as_str()));

                    // Also allow transitioning to the same step
                    let is_same_step = current.name == target.name;

                    if !is_valid_transition && !is_same_step {
                        // Get valid transition names for the error message
                        let valid_transitions: Vec<String> = current
                            .transitions_to
                            .iter()
                            .filter_map(|t| steps.iter().find(|s| s.id.as_ref() == Some(t)))
                            .map(|s| s.name.clone())
                            .collect();

                        let hint = if valid_transitions.is_empty() {
                            "This step has no valid transitions (terminal state). Use 'vtb list' to see other tasks.".to_string()
                        } else {
                            format!(
                                "Valid transitions from '{}': {}",
                                current.name,
                                valid_transitions.join(", ")
                            )
                        };

                        return Err(ServiceError::InvalidInput(format!(
                            "Invalid step transition from '{}' to '{}'. {}",
                            current.name, target_step_name, hint
                        )));
                    }
                }
            }
        }

        // Determine target step
        let target_step_name = if let Some(step_name) = &parsed.step {
            Some(step_name.clone())
        } else {
            // Use initial step of the workflow - query the first step by order
            let steps = services
                .steps()
                .list_steps_for_workflow(&target_workflow_id)
                .await?;
            steps.first().map(|s| s.name.clone())
        };

        // Perform the transition - assign workflow and set step
        let _ = workflow_service
            .assign_workflow(&id, &target_workflow_id)
            .await?;

        // Set the step if specified
        if let Some(step_name) = &parsed.step {
            let steps = services
                .steps()
                .list_steps_for_workflow(&target_workflow_id)
                .await?;
            if let Some(step) = steps.iter().find(|s| s.name == *step_name)
                && let Some(step_id) = &step.id
            {
                services.tasks().set_current_step(&id, step_id).await?;
            }
        } else if let Some(ref step_name) = target_step_name {
            // If we have a target step from initial step resolution, find and set the step ID
            let steps = services
                .steps()
                .list_steps_for_workflow(&target_workflow_id)
                .await?;
            if let Some(step) = steps.iter().find(|s| &s.name == step_name)
                && let Some(step_id) = &step.id
            {
                services.tasks().set_current_step(&id, step_id).await?;
            }
        }

        // Get unblocked tasks (for done/terminal steps)
        let mut unblocked_tasks = vec![];
        if let Some(step_name) = &target_step_name {
            // Terminal steps: done, rejected
            if step_name == "done" || step_name == "rejected" {
                // Find tasks that depend on this task
                let dependents = services.tasks().get_dependents(&id).await?;

                for dependent_id in dependents {
                    // Check if this dependent has any remaining incomplete blockers
                    let blockers = services
                        .tasks()
                        .get_incomplete_blockers_with_details(&dependent_id)
                        .await?;

                    if blockers.is_empty() {
                        // This task is now unblocked
                        if let Ok(task) = services.tasks().get_task(&dependent_id).await {
                            unblocked_tasks.push((dependent_id, task.title));
                        }
                    }
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

    // ==================== ParsedTarget::parse tests ====================

    #[test]
    fn test_parse_target_workflow_only() {
        let target = ParsedTarget::parse("implementation");
        assert_eq!(target.workflow, "implementation");
        assert!(target.step.is_none());
    }

    #[test]
    fn test_parse_target_workflow_and_step() {
        let target = ParsedTarget::parse("review:approved");
        assert_eq!(target.workflow, "review");
        assert_eq!(target.step, Some("approved".to_string()));
    }

    #[test]
    fn test_parse_target_with_underscore() {
        let target = ParsedTarget::parse("in_progress:coding_done");
        assert_eq!(target.workflow, "in_progress");
        assert_eq!(target.step, Some("coding_done".to_string()));
    }

    #[test]
    fn test_parse_target_empty_string() {
        let target = ParsedTarget::parse("");
        assert_eq!(target.workflow, "");
        assert!(target.step.is_none());
    }

    #[test]
    fn test_parse_target_colon_only() {
        let target = ParsedTarget::parse(":");
        assert_eq!(target.workflow, "");
        assert_eq!(target.step, Some("".to_string()));
    }

    #[test]
    fn test_parse_target_multiple_colons() {
        // split_once only splits on first colon
        let target = ParsedTarget::parse("a:b:c");
        assert_eq!(target.workflow, "a");
        assert_eq!(target.step, Some("b:c".to_string()));
    }

    #[test]
    fn test_parse_target_clone() {
        let target = ParsedTarget::parse("review:approved");
        let cloned = target.clone();
        assert_eq!(target.workflow, cloned.workflow);
        assert_eq!(target.step, cloned.step);
    }

    #[test]
    fn test_parse_target_debug() {
        let target = ParsedTarget::parse("review:approved");
        let debug = format!("{:?}", target);
        assert!(debug.contains("ParsedTarget"));
        assert!(debug.contains("review"));
        assert!(debug.contains("approved"));
    }

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
            target: "review:approved".to_string(),
            force: true,
            skip_validation: false,
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("TransitionToCommand"));
        assert!(debug.contains("task1"));
        assert!(debug.contains("review:approved"));
    }

    #[test]
    fn test_transition_to_command_defaults() {
        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: "default".to_string(),
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
