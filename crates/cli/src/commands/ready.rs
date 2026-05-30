//! Ready command for showing actionable items
//!
//! Implements the `vtb ready` command to show entry points for work.
//! Shows unblocked items returned by the backend ready query.

use clap::Args;
use serde::Serialize;
use vertebrae_core::Task;
use vertebrae_core::{ServiceError, VertebraeServices};

/// Show actionable items
#[derive(Debug, Args)]
pub struct ReadyCommand {}

/// Result of the ready command execution
#[derive(Debug, Serialize)]
pub struct ReadyResult {
    /// Tasks that are ready to start.
    pub backlog_ready: Vec<Task>,
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
    /// Finds and returns actionable items from the backend ready query.
    /// The CLI filters archived items from that result.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if database operations fail.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<ReadyResult, ServiceError> {
        let mut backlog_ready = services.tasks().list_ready().await?;

        // Filter out archived tasks
        backlog_ready.retain(|t| !t.archived);

        Ok(ReadyResult { backlog_ready })
    }
}
