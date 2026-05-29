//! Archive command for setting the archived flag on tasks
//!
//! Implements the `vtb archive` and `vtb unarchive` commands.

use clap::Args;
use vertebrae_core::{ServiceError, UpdateTaskOptions, VertebraeServices};

/// Archive a task (set archived=true).
#[derive(Debug, Args)]
pub struct ArchiveCommand {
    /// Task ID to archive (full UUID or 8-character short ID, case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,
}

impl ArchiveCommand {
    /// Execute the archive command.
    ///
    /// Sets archived=true on the specified task.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the task does not exist or service operations fail.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let id = self.id.to_lowercase();
        let options = UpdateTaskOptions::new().with_archived(true);
        services.tasks().update_task(&id, options).await?;
        Ok(format!("Task {} archived", id))
    }
}

/// Unarchive a task (set archived=false).
#[derive(Debug, Args)]
pub struct UnarchiveCommand {
    /// Task ID to unarchive (full UUID or 8-character short ID, case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,
}

impl UnarchiveCommand {
    /// Execute the unarchive command.
    ///
    /// Sets archived=false on the specified task.
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the task does not exist or service operations fail.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let id = self.id.to_lowercase();
        let options = UpdateTaskOptions::new().with_archived(false);
        services.tasks().update_task(&id, options).await?;
        Ok(format!("Task {} unarchived", id))
    }
}
