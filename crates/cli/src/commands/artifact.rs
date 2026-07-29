//! Artifact command group for the `vtb artifact` CLI namespace.
//!
//! This module establishes the command-line shape and dispatch boundary for
//! artifact CRUD. The individual command implementations are intentionally
//! left for the follow-up artifact tasks.

use std::path::PathBuf;

use clap::{Args, Subcommand};
use serde_json::Value;
use uuid::Uuid;
use vertebrae_core::{ArtifactService, ServiceError, VertebraeServices};

/// Artifact management commands.
#[derive(Debug, Subcommand)]
pub enum ArtifactCommand {
    /// Create a new artifact.
    Add(ArtifactAddCommand),
    /// List artifacts in the active project.
    List(ArtifactListCommand),
    /// Show an artifact by ID.
    Show(ArtifactShowCommand),
    /// Update an artifact by ID.
    Update(ArtifactUpdateCommand),
    /// Delete an artifact by ID.
    Delete(ArtifactDeleteCommand),
}

impl ArtifactCommand {
    /// Dispatch an artifact command to the shared artifact service boundary.
    ///
    /// CRUD behavior is implemented by the follow-up artifact command tasks;
    /// this method keeps the top-level command dispatch contract in place.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let artifact_service = services.artifacts();
        match self {
            Self::Add(_) => scaffold_execute(artifact_service, "add").await,
            Self::List(_) => scaffold_execute(artifact_service, "list").await,
            Self::Show(_) => scaffold_execute(artifact_service, "show").await,
            Self::Update(_) => scaffold_execute(artifact_service, "update").await,
            Self::Delete(_) => scaffold_execute(artifact_service, "delete").await,
        }
    }

    /// Dispatch an artifact command through the global JSON execution path.
    pub async fn execute_json(&self, services: &VertebraeServices) -> Result<Value, ServiceError> {
        let artifact_service = services.artifacts();
        match self {
            Self::Add(_) => scaffold_execute_json(artifact_service, "add").await,
            Self::List(_) => scaffold_execute_json(artifact_service, "list").await,
            Self::Show(_) => scaffold_execute_json(artifact_service, "show").await,
            Self::Update(_) => scaffold_execute_json(artifact_service, "update").await,
            Self::Delete(_) => scaffold_execute_json(artifact_service, "delete").await,
        }
    }

    /// Normalize full artifact UUIDs before execution.
    pub async fn resolve_ids(&mut self, _services: &VertebraeServices) -> Result<(), ServiceError> {
        match self {
            Self::Add(_) | Self::List(_) => {}
            Self::Show(command) => command.id = resolve_artifact_id(&command.id)?,
            Self::Update(command) => command.id = resolve_artifact_id(&command.id)?,
            Self::Delete(command) => command.id = resolve_artifact_id(&command.id)?,
        }
        Ok(())
    }
}

async fn scaffold_execute(
    _service: &dyn ArtifactService,
    command: &'static str,
) -> Result<String, ServiceError> {
    Err(ServiceError::validation_failed(format!(
        "artifact {command} command is not implemented"
    )))
}

async fn scaffold_execute_json(
    _service: &dyn ArtifactService,
    command: &'static str,
) -> Result<Value, ServiceError> {
    Err(ServiceError::validation_failed(format!(
        "artifact {command} command is not implemented"
    )))
}

/// Normalize an artifact ID and provide a command-scoped error for manually
/// constructed commands that bypass Clap parsing.
fn resolve_artifact_id(id: &str) -> Result<String, ServiceError> {
    Uuid::parse_str(id).map(|uuid| uuid.to_string()).map_err(|_| {
        ServiceError::validation_failed(format!(
            "artifact ID '{id}' is not a valid UUID (expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
        ))
    })
}

/// Create a new artifact.
#[derive(Debug, Args)]
pub struct ArtifactAddCommand {
    /// Artifact filename.
    #[arg(required = true)]
    pub filename: String,

    /// Artifact body text.
    #[arg(long)]
    pub body: Option<String>,

    /// Read the artifact body from a file.
    #[arg(long)]
    pub body_file: Option<PathBuf>,

    /// Type of the direct attachment target.
    #[arg(long)]
    pub subject_type: Option<String>,

    /// ID of the direct attachment target.
    #[arg(long)]
    pub subject_id: Option<String>,
}

/// List artifacts in the active project.
#[derive(Debug, Args)]
pub struct ArtifactListCommand {
    /// Maximum number of artifacts to return.
    #[arg(long)]
    pub limit: Option<i32>,

    /// Number of artifacts to skip.
    #[arg(long)]
    pub offset: Option<i32>,
}

/// Show an artifact by ID.
#[derive(Debug, Args)]
pub struct ArtifactShowCommand {
    /// Artifact ID.
    #[arg(required = true, value_parser = crate::commands::parse_full_uuid("artifact ID"))]
    pub id: String,
}

/// Update an artifact by ID.
#[derive(Debug, Args)]
pub struct ArtifactUpdateCommand {
    /// Artifact ID.
    #[arg(required = true, value_parser = crate::commands::parse_full_uuid("artifact ID"))]
    pub id: String,

    /// Replacement artifact filename.
    #[arg(long)]
    pub filename: Option<String>,

    /// Replacement artifact body text.
    #[arg(long)]
    pub body: Option<String>,

    /// Read the replacement artifact body from a file.
    #[arg(long)]
    pub body_file: Option<PathBuf>,
}

/// Delete an artifact by ID.
#[derive(Debug, Args)]
pub struct ArtifactDeleteCommand {
    /// Artifact ID.
    #[arg(required = true, value_parser = crate::commands::parse_full_uuid("artifact ID"))]
    pub id: String,

    /// Skip the deletion confirmation prompt.
    #[arg(short, long)]
    pub force: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Debug, Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: ArtifactCommand,
    }

    const ARTIFACT_ID: &str = "a1b2c3d4-0000-4000-8000-000000000001";

    #[test]
    fn parses_all_artifact_subcommands() {
        let cases = [
            vec!["test", "add", "notes.md", "--body", "hello"],
            vec!["test", "list", "--limit", "10", "--offset", "2"],
            vec!["test", "show", ARTIFACT_ID],
            vec!["test", "update", ARTIFACT_ID, "--filename", "README.md"],
            vec!["test", "delete", ARTIFACT_ID, "--force"],
        ];

        for args in cases {
            TestCli::try_parse_from(args).expect("artifact subcommand should parse");
        }
    }

    #[test]
    fn artifact_ids_require_full_uuids() {
        let result = TestCli::try_parse_from(["test", "show", "a1b2c3d4"]);

        assert!(result.is_err(), "short artifact IDs should not parse");
    }

    #[test]
    fn normalizes_artifact_ids_for_dispatch() {
        let mut command = ArtifactCommand::Show(ArtifactShowCommand {
            id: ARTIFACT_ID.to_uppercase(),
        });

        // The resolver only normalizes UUIDs and does not call the backend.
        let runtime = tokio::runtime::Runtime::new().expect("runtime should start");
        runtime
            .block_on(command.resolve_ids_without_services())
            .expect("full artifact ID should resolve");

        match command {
            ArtifactCommand::Show(command) => assert_eq!(command.id, ARTIFACT_ID),
            _ => panic!("expected show command"),
        }
    }

    impl ArtifactCommand {
        async fn resolve_ids_without_services(&mut self) -> Result<(), ServiceError> {
            match self {
                Self::Add(_) | Self::List(_) => {}
                Self::Show(command) => command.id = resolve_artifact_id(&command.id)?,
                Self::Update(command) => command.id = resolve_artifact_id(&command.id)?,
                Self::Delete(command) => command.id = resolve_artifact_id(&command.id)?,
            }
            Ok(())
        }
    }
}
