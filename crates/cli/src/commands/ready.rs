//! Ready command for showing highest-level actionable items
//!
//! Implements the `vtb ready` command to show entry points for work.
//! Shows highest-level unblocked items prioritized by hierarchy (epic > ticket > task).

use clap::Args;
use vertebrae_core::TaskSummary;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Show highest-level actionable items
#[derive(Debug, Args)]
pub struct ReadyCommand {}

/// Result of the ready command execution
#[derive(Debug)]
pub struct ReadyResult {
    /// Tasks that are ready to start (backlog status, unblocked, work not started on children)
    pub backlog_ready: Vec<TaskSummary>,
}

impl std::fmt::Display for ReadyResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.backlog_ready.is_empty() {
            return write!(f, "No actionable items found.");
        }

        writeln!(f, "Ready to start (backlog):")?;
        for task in &self.backlog_ready {
            writeln!(f, "  {}  {}  {}", task.id, task.level, task.title)?;
        }

        Ok(())
    }
}

impl ReadyCommand {
    /// Execute the ready command.
    ///
    /// Finds and returns actionable entry points:
    /// - Backlog items: ready to start work (unblocked, no work started on children)
    ///
    /// For items with hierarchies, only shows the highest-level entry point.
    /// An item is excluded if any of its children have work started
    /// (status in: in_progress, pending_review, done).
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if database operations fail.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<ReadyResult, ServiceError> {
        // Get ready items for backlog status (ready to start work)
        let backlog_ready = services.tasks().list_ready("backlog").await?;

        Ok(ReadyResult { backlog_ready })
    }
}
