//! Reject-step command for workflow step lifecycle management
//!
//! Implements the `vtb reject-step` command to reject a workflow step with optional feedback.

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Reject a workflow step with optional feedback
#[derive(Debug, Args)]
pub struct RejectStepCommand {
    /// Task ID to reject the step for (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// Target step ID to transition to (e.g., previous step for revision)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("target step ID"))]
    pub target_step_id: String,

    /// Optional feedback about why the step was rejected
    #[arg(short, long)]
    pub feedback: Option<String>,
}

/// Result of executing the reject-step command
#[derive(Debug)]
pub struct RejectStepResult {
    /// The task ID
    pub task_id: String,
    /// The target step ID that was transitioned to
    pub target_step_id: String,
    /// Optional feedback provided
    pub feedback: Option<String>,
}

impl std::fmt::Display for RejectStepResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Rejected step for task '{}' and transitioned to step '{}'",
            self.task_id, self.target_step_id
        )?;
        if let Some(feedback) = &self.feedback {
            write!(f, ". Feedback: {}", feedback)?;
        }
        Ok(())
    }
}

impl RejectStepCommand {
    /// Execute the reject-step command.
    ///
    /// Rejects the current workflow step for the task and transitions to a target step,
    /// optionally including feedback about the rejection.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task does not exist
    /// - The target step does not exist
    /// - The service operation fails
    pub async fn execute(
        &self,
        services: &VertebraeServices,
    ) -> Result<RejectStepResult, ServiceError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();
        let target_step_id = self.target_step_id.to_lowercase();

        // Verify task exists
        let _ = services.tasks().get_task(&id).await?;

        // Reject the step with optional feedback
        let feedback_ref = self.feedback.as_deref();
        services
            .tasks()
            .reject_step(&id, &target_step_id, feedback_ref)
            .await?;

        Ok(RejectStepResult {
            task_id: id,
            target_step_id,
            feedback: self.feedback.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reject_step_command_debug() {
        let cmd = RejectStepCommand {
            id: "task-123".to_string(),
            target_step_id: "step-456".to_string(),
            feedback: Some("Needs revision".to_string()),
        };
        let debug = format!("{:?}", cmd);
        assert!(debug.contains("RejectStepCommand"));
        assert!(debug.contains("task-123"));
        assert!(debug.contains("step-456"));
    }

    #[test]
    fn test_reject_step_command_without_feedback() {
        let cmd = RejectStepCommand {
            id: "task-123".to_string(),
            target_step_id: "step-456".to_string(),
            feedback: None,
        };
        assert!(cmd.feedback.is_none());
    }

    #[test]
    fn test_reject_step_result_debug() {
        let result = RejectStepResult {
            task_id: "task-123".to_string(),
            target_step_id: "step-456".to_string(),
            feedback: Some("Needs revision".to_string()),
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("RejectStepResult"));
        assert!(debug.contains("task-123"));
        assert!(debug.contains("step-456"));
    }

    #[test]
    fn test_reject_step_result_display_with_feedback() {
        let result = RejectStepResult {
            task_id: "task-abc".to_string(),
            target_step_id: "step-def".to_string(),
            feedback: Some("Please fix the issues".to_string()),
        };
        let output = format!("{}", result);
        assert!(output.contains("Rejected step for task 'task-abc'"));
        assert!(output.contains("transitioned to step 'step-def'"));
        assert!(output.contains("Feedback: Please fix the issues"));
    }

    #[test]
    fn test_reject_step_result_display_without_feedback() {
        let result = RejectStepResult {
            task_id: "task-xyz".to_string(),
            target_step_id: "step-uvw".to_string(),
            feedback: None,
        };
        let output = format!("{}", result);
        assert!(output.contains("Rejected step for task 'task-xyz'"));
        assert!(output.contains("transitioned to step 'step-uvw'"));
        assert!(!output.contains("Feedback:"));
    }
}
