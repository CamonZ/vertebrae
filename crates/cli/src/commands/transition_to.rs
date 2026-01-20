//! Transition-to command for workflow-based transitions
//!
//! Implements the `vtb transition-to` command to transition tasks between workflows
//! and steps. Validates transitions against the workflow_transitions edge table.

use clap::Args;
use vertebrae_core::{ServiceError, TaskService};

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
    /// * `service` - Reference to the task service
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
        service: &dyn TaskService,
    ) -> Result<TransitionToResult, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Parse target into workflow and optional step
        let parsed = ParsedTarget::parse(&self.target);

        // Get the task
        let task = service.get_task(&id).await?;

        // Get current workflow info
        let from_workflow = task.workflow_id.as_ref().map(|t| t.id.to_raw());
        let from_step = task.current_step_id.as_ref().map(|t| t.id.to_raw());

        // Get the database to validate the transition
        let db = service.database();

        // Resolve target workflow - try by ID first, then by name
        let workflow = db.workflows().get(&parsed.workflow).await?.or_else(|| None); // TODO: Add lookup by name

        let target_workflow_id = if workflow.is_some() {
            parsed.workflow.clone()
        } else {
            // Try to find workflow by name
            // For now, assume the target is the ID
            return Err(ServiceError::InvalidInput(format!(
                "Workflow '{}' not found",
                parsed.workflow
            )));
        };

        // Validate the transition if not skipped
        if !self.skip_validation
            && let Some(current_wf_id) = &from_workflow
        {
            // Check if transition is allowed
            let allowed = db
                .workflow_transitions()
                .exists(current_wf_id, &target_workflow_id)
                .await?;

            if !allowed && current_wf_id != &target_workflow_id {
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
                let workflow_thing =
                    surrealdb::sql::Thing::from(("workflow", target_workflow_id.as_str()));
                let steps = db.steps().list_by_workflow(&workflow_thing).await?;

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

                if let (Some(current), Some(target)) = (current_step, target_step) {
                    // Check if target is in current step's transitions_to
                    let target_id = target.id.as_ref();
                    let is_valid_transition = target_id.is_some()
                        && current.transitions_to.iter().any(|t| Some(t) == target_id);

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
            // Find step by name in target workflow
            let workflow_thing =
                surrealdb::sql::Thing::from(("workflow", target_workflow_id.as_str()));
            let steps = db.steps().list_by_workflow(&workflow_thing).await?;
            let step = steps.iter().find(|s| s.name == *step_name);
            if step.is_none() {
                return Err(ServiceError::InvalidInput(format!(
                    "Step '{}' not found in workflow '{}'",
                    step_name, target_workflow_id
                )));
            }
            Some(step_name.clone())
        } else {
            // Use initial step of the workflow
            let workflow = db.workflows().get(&target_workflow_id).await?;
            if let Some(wf) = workflow {
                if let Some(initial_step) = &wf.initial_step {
                    let step = db.steps().get(&initial_step.id.to_raw()).await?;
                    step.map(|s| s.name)
                } else {
                    None
                }
            } else {
                None
            }
        };

        // Perform the transition - assign workflow and set step
        let workflow_thing = surrealdb::sql::Thing::from(("workflow", target_workflow_id.as_str()));
        service.assign_workflow(&id, &workflow_thing).await?;

        // Set the step if specified
        if let Some(step_name) = &parsed.step {
            let workflow_thing_for_steps =
                surrealdb::sql::Thing::from(("workflow", target_workflow_id.as_str()));
            let steps = db
                .steps()
                .list_by_workflow(&workflow_thing_for_steps)
                .await?;
            if let Some(step) = steps.iter().find(|s| s.name == *step_name) {
                // Update current_step_id (reference to step record)
                if let Some(ref step_id) = step.id {
                    db.tasks().update_current_step_id(&id, step_id).await?;
                }
            }
        } else if let Some(ref step_name) = target_step_name {
            // If we have a target step from initial step resolution, find and set the step ID
            let workflow_thing_for_steps =
                surrealdb::sql::Thing::from(("workflow", target_workflow_id.as_str()));
            let steps = db
                .steps()
                .list_by_workflow(&workflow_thing_for_steps)
                .await?;
            if let Some(step) = steps.iter().find(|s| &s.name == step_name)
                && let Some(ref step_id) = step.id
            {
                db.tasks().update_current_step_id(&id, step_id).await?;
            }
        }

        // Get unblocked tasks (for done/terminal steps)
        // Check if the target step is terminal and compute newly unblocked tasks
        let mut unblocked_tasks = vec![];
        if let Some(step_name) = &target_step_name {
            // Terminal steps: done, rejected
            if step_name == "done" || step_name == "rejected" {
                // Find tasks that depend on this task
                let dependents = db.relationships().get_dependents(&id).await?;

                for dependent_id in dependents {
                    // Check if this dependent has any remaining incomplete blockers
                    let blockers = db.graph().get_blockers(&dependent_id, Some(1)).await?;
                    let has_incomplete_blockers = blockers.iter().any(|blocker| {
                        // A blocker is incomplete if its status is not done/rejected
                        blocker.status.as_str() != "done" && blocker.status.as_str() != "rejected"
                    });

                    if !has_incomplete_blockers {
                        // This task is now unblocked
                        if let Ok(Some(task)) = db.tasks().get(&dependent_id).await {
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
}
