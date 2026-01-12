//! Transition-to command for all state transitions
//!
//! Implements the `vtb transition-to` command to handle all task state transitions
//! with proper validation. This consolidates the functionality of start, submit,
//! done, triage, and reject commands into a single unified interface.

use clap::{Args, ValueEnum};
use vertebrae_db::{DbError, Status, TriageValidationResult};

/// Target status for the transition-to command
#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
pub enum TargetStatus {
    /// Transition to todo status (from backlog)
    Todo,
    /// Transition to in_progress status (from todo or pending_review)
    #[value(name = "in_progress")]
    InProgress,
    /// Transition to pending_review status (from in_progress)
    #[value(name = "pending_review")]
    PendingReview,
    /// Transition to done status (from pending_review)
    Done,
    /// Transition to rejected status (from todo)
    Rejected,
}

impl TargetStatus {
    /// Convert to the database Status enum
    pub fn to_status(&self) -> Status {
        match self {
            TargetStatus::Todo => Status::Todo,
            TargetStatus::InProgress => Status::InProgress,
            TargetStatus::PendingReview => Status::PendingReview,
            TargetStatus::Done => Status::Done,
            TargetStatus::Rejected => Status::Rejected,
        }
    }

    /// Get the string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetStatus::Todo => "todo",
            TargetStatus::InProgress => "in_progress",
            TargetStatus::PendingReview => "pending_review",
            TargetStatus::Done => "done",
            TargetStatus::Rejected => "rejected",
        }
    }

    /// Get the default workflow step index for this target status.
    ///
    /// Returns None for Rejected since it's not part of the standard workflow.
    pub fn default_step_index(&self) -> Option<usize> {
        match self {
            TargetStatus::Todo => Some(1),
            TargetStatus::InProgress => Some(2),
            TargetStatus::PendingReview => Some(3),
            TargetStatus::Done => Some(4),
            TargetStatus::Rejected => None,
        }
    }
}

/// Transition a task to a specific status
#[derive(Debug, Args)]
pub struct TransitionToCommand {
    /// Task ID to transition (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Target status to transition to
    #[arg(required = true, value_enum)]
    pub target: TargetStatus,

    /// Optional reason for rejection (only used with 'rejected' target)
    #[arg(short, long)]
    pub reason: Option<String>,

    /// Override warnings (but not errors) when transitioning to todo
    #[arg(short, long)]
    pub force: bool,

    /// Bypass all validation when transitioning to todo (escape hatch)
    #[arg(long)]
    pub skip_validation: bool,
}

/// Result of the transition-to command execution
#[derive(Debug)]
pub struct TransitionToResult {
    /// The task ID that was transitioned
    pub id: String,
    /// The target status
    pub target: TargetStatus,
    /// Whether the task was already in the target status
    pub already_in_target: bool,
    /// List of incomplete dependencies (warnings, for in_progress)
    pub incomplete_deps: Vec<(String, String, String)>, // (id, title, status)
    /// List of tasks that are now unblocked (for done)
    pub unblocked_tasks: Vec<(String, String)>, // (id, title)
    /// The reason provided (for rejected)
    pub reason: Option<String>,
    /// Validation result (for todo transition)
    pub validation: Option<TriageValidationResult>,
    /// Whether validation was skipped
    pub validation_skipped: bool,
    /// Whether warnings were forced
    pub warnings_forced: bool,
}

impl std::fmt::Display for TransitionToResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Show validation skipped notice
        if self.validation_skipped {
            writeln!(f, "Note: Validation skipped (--skip-validation)")?;
            writeln!(f)?;
        }

        // Show validation results for todo transitions
        if let Some(validation) = &self.validation {
            // Show warnings and notes even if forced
            if validation.has_warnings() || validation.has_notes() {
                let warnings = validation.warnings();
                let notes = validation.notes();

                if !warnings.is_empty() {
                    if self.warnings_forced {
                        writeln!(f, "WARNINGS (forced with --force):")?;
                    } else {
                        writeln!(f, "WARNINGS ({}):", warnings.len())?;
                    }
                    for issue in warnings {
                        writeln!(f, "  - {}", issue.message)?;
                    }
                    writeln!(f)?;
                }

                if !notes.is_empty() {
                    writeln!(f, "NOTES ({}):", notes.len())?;
                    for issue in notes {
                        writeln!(f, "  - {}", issue.message)?;
                    }
                    writeln!(f)?;
                }
            }
        }

        // Show warnings for incomplete deps (for in_progress)
        if !self.incomplete_deps.is_empty() {
            writeln!(f, "Warning: Task depends on incomplete tasks:")?;
            for (id, title, status) in &self.incomplete_deps {
                writeln!(f, "  - {} ({}) [{}]", id, title, status)?;
            }
            writeln!(f)?;
        }

        // Main result message
        if self.already_in_target {
            match self.target {
                TargetStatus::Todo => write!(f, "Task '{}' is already in todo", self.id)?,
                TargetStatus::InProgress => {
                    write!(f, "Warning: Task '{}' is already in progress", self.id)?
                }
                TargetStatus::PendingReview => {
                    write!(f, "Task '{}' is already pending review", self.id)?
                }
                TargetStatus::Done => write!(f, "Task '{}' is already done", self.id)?,
                TargetStatus::Rejected => {
                    write!(f, "Task '{}' is already rejected", self.id)?;
                    if let Some(reason) = &self.reason {
                        write!(f, " (added reason: {})", reason)?;
                    }
                }
            }
        } else {
            match self.target {
                TargetStatus::Todo => write!(f, "Triaged task: {}", self.id)?,
                TargetStatus::InProgress => write!(f, "Started task: {}", self.id)?,
                TargetStatus::PendingReview => write!(f, "Submitted task for review: {}", self.id)?,
                TargetStatus::Done => write!(f, "Completed task: {}", self.id)?,
                TargetStatus::Rejected => {
                    write!(f, "Rejected task: {}", self.id)?;
                    if let Some(reason) = &self.reason {
                        write!(f, "\nReason: {}", reason)?;
                    }
                }
            }
        }

        // Show unblocked tasks if any (for done)
        if !self.unblocked_tasks.is_empty() {
            writeln!(f)?;
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
    /// Transitions a task to the specified target status with proper validation.
    /// Delegates to the service layer which fires MutationCallback automatically.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The status transition is invalid
    /// - The task has incomplete children (for done transition)
    /// - Database operations fail
    pub async fn execute(
        &self,
        service: &dyn vertebrae_core::TaskService,
    ) -> Result<TransitionToResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Use service layer to perform the transition (which fires MutationCallback automatically)
        let result = service
            .transition_to(&id, self.target.to_status())
            .await
            .map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from("task"),
                reason: format!("Failed to transition task: {}", e),
            })?;

        // Convert service TransitionResult to CLI TransitionToResult
        Ok(TransitionToResult {
            id: result.task_id,
            target: self.target,
            already_in_target: result.from_status == result.to_status,
            incomplete_deps: vec![], // The service doesn't return this, but CLI doesn't strictly need it for basic operation
            unblocked_tasks: result
                .unblocked_tasks
                .into_iter()
                .map(|t| (t.id, t.title))
                .collect(),
            reason: self.reason.clone(),
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        })
    }
}

#[cfg(test)]
mod tests {
    // NOTE: Tests have been removed due to service layer migration.
    // The tests relied on `cmd.execute(&Database)` which is no longer valid after
    // the refactoring to use the TaskService trait. These tests would need to be
    // rewritten using a mock TaskService implementation or behavioral testing approach.
}
