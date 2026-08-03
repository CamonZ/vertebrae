//! Artifact command group for the `vtb artifact` CLI namespace.
//!
//! This module implements the `vtb artifact` command group.

use std::{
    fs,
    io::{self, Read, Write},
    path::PathBuf,
};

use clap::{Args, Subcommand};
use serde_json::{Value, json};
use uuid::Uuid;
use vertebrae_core::{
    Artifact, ArtifactLinkMetadata, CreateArtifactInput, GetArtifactByLogicalNameInput,
    ListArtifactInput, ServiceError, UpdateArtifactInput, VertebraeServices,
};

/// Artifact management commands.
#[derive(Debug, Subcommand)]
pub enum ArtifactCommand {
    /// Create a new artifact.
    Add(ArtifactAddCommand),
    /// List artifacts in the active project.
    List(ArtifactListCommand),
    /// Show an artifact by ID.
    Show(ArtifactShowCommand),
    /// Look up an artifact by its subject-local logical name.
    Lookup(ArtifactLookupCommand),
    /// Update an artifact by ID.
    Update(ArtifactUpdateCommand),
    /// Delete an artifact by ID.
    Delete(ArtifactDeleteCommand),
}

impl ArtifactCommand {
    /// Dispatch an artifact command to the shared artifact service boundary.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        match self {
            Self::Add(command) => command.execute(services).await,
            Self::List(command) => command.execute(services).await,
            Self::Show(command) => command.execute(services).await,
            Self::Lookup(command) => command.execute(services).await,
            Self::Update(command) => command.execute(services).await,
            Self::Delete(command) => command.execute(services).await,
        }
    }

    /// Dispatch an artifact command through the global JSON execution path.
    pub async fn execute_json(&self, services: &VertebraeServices) -> Result<Value, ServiceError> {
        match self {
            Self::Add(command) => command.execute_json(services).await,
            Self::List(command) => command.execute_json(services).await,
            Self::Show(command) => command.execute_json(services).await,
            Self::Lookup(command) => command.execute_json(services).await,
            Self::Update(command) => command.execute_json(services).await,
            Self::Delete(command) => command.execute_json(services).await,
        }
    }

    /// Normalize full artifact UUIDs before execution.
    pub async fn resolve_ids(&mut self, services: &VertebraeServices) -> Result<(), ServiceError> {
        match self {
            Self::Add(command) => {
                if let Some(subject_id) = &mut command.subject_id {
                    *subject_id = resolve_artifact_id(subject_id)?;
                }
            }
            Self::List(command) => {
                if let Some(task_id) = &mut command.task_id {
                    *task_id = super::resolve_id(task_id, services).await?;
                }
            }
            Self::Show(command) => command.id = resolve_artifact_id(&command.id)?,
            Self::Lookup(command) => command.subject_id = resolve_artifact_id(&command.subject_id)?,
            Self::Update(command) => {
                command.id = resolve_artifact_id(&command.id)?;
                if let Some(subject_id) = &mut command.subject_id {
                    *subject_id = resolve_artifact_id(subject_id)?;
                }
            }
            Self::Delete(command) => command.id = resolve_artifact_id(&command.id)?,
        }
        Ok(())
    }
}

const SUPPORTED_SUBJECT_TYPES: &[&str] = &[
    "project",
    "task",
    "task_section",
    "workflow",
    "task_run",
    "step_execution",
];

fn parse_subject_type(value: &str) -> Result<String, String> {
    let normalized = value.to_lowercase();
    if SUPPORTED_SUBJECT_TYPES.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(format!(
            "invalid subject type '{value}'. Valid values: {}",
            SUPPORTED_SUBJECT_TYPES.join(", ")
        ))
    }
}

fn validate_filename(filename: &str) -> Result<(), ServiceError> {
    if filename.trim().is_empty() {
        return Err(ServiceError::validation_failed(
            "artifact filename cannot be empty",
        ));
    }
    if filename.contains('\0') {
        return Err(ServiceError::validation_failed(
            "artifact filename cannot contain a NUL character",
        ));
    }
    Ok(())
}

fn validate_pagination(limit: Option<i32>, offset: Option<i32>) -> Result<(), ServiceError> {
    if limit.is_some_and(|value| value <= 0) {
        return Err(ServiceError::validation_failed(
            "artifact list limit must be greater than zero",
        ));
    }
    if offset.is_some_and(|value| value < 0) {
        return Err(ServiceError::validation_failed(
            "artifact list offset cannot be negative",
        ));
    }
    Ok(())
}

fn read_metadata(
    metadata: &Option<String>,
    metadata_file: &Option<PathBuf>,
) -> Result<Option<ArtifactLinkMetadata>, ServiceError> {
    let value = match (metadata, metadata_file) {
        (Some(_), Some(_)) => {
            return Err(ServiceError::validation_failed(
                "provide exactly one artifact metadata source: --metadata or --metadata-file",
            ));
        }
        (Some(value), None) => value.clone(),
        (None, Some(path)) => fs::read_to_string(path).map_err(|error| {
            ServiceError::validation_failed(format!(
                "failed to read artifact metadata file '{}': {error}",
                path.display()
            ))
        })?,
        (None, None) => return Ok(None),
    };

    serde_json::from_str(&value).map(Some).map_err(|error| {
        ServiceError::validation_failed(format!("invalid artifact metadata JSON: {error}"))
    })
}

fn format_artifact_list(artifacts: &[Artifact]) -> String {
    if artifacts.is_empty() {
        return "No artifacts found".to_string();
    }

    artifacts
        .iter()
        .map(|artifact| match &artifact.logical_name {
            Some(logical_name) => {
                format!("{}  {}  ({logical_name})", artifact.id, artifact.filename)
            }
            None => format!("{}  {}", artifact.id, artifact.filename),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_artifact(artifact: &Artifact) -> String {
    let mut output = format!(
        "Artifact: {}\nFilename: {}\nProject: {}\nBody:\n{}",
        artifact.id,
        artifact.filename,
        artifact
            .project_id
            .as_deref()
            .unwrap_or("<unknown (user-scoped)>"),
        artifact.body
    );
    if let Some(created_at) = artifact.created_at {
        output.push_str(&format!("\nCreated: {created_at}"));
    }
    if let Some(updated_at) = artifact.updated_at {
        output.push_str(&format!("\nUpdated: {updated_at}"));
    }
    if let Some(logical_name) = &artifact.logical_name {
        output.push_str(&format!("\nLogical name: {logical_name}"));
    }
    if let Some(metadata) = &artifact.metadata {
        let metadata = serde_json::to_string_pretty(metadata)
            .expect("artifact link metadata should always serialize");
        output.push_str(&format!("\nMetadata:\n{metadata}"));
    }
    output
}

fn artifact_operation(
    command: &'static str,
    status: &'static str,
    artifact: &Artifact,
) -> Result<Value, ServiceError> {
    let artifact_value = super::json_value(artifact)?;
    Ok(super::operation_result(
        command,
        status,
        json!({
            "artifact_id": artifact.id,
            "artifact": artifact_value,
        }),
    ))
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
    #[arg(long, conflicts_with = "body_file")]
    pub body: Option<String>,

    /// Read the artifact body from a file.
    #[arg(long, conflicts_with = "body")]
    pub body_file: Option<PathBuf>,

    /// Type of the direct attachment target.
    #[arg(long, value_parser = parse_subject_type)]
    pub subject_type: Option<String>,

    /// ID of the direct attachment target.
    #[arg(long, value_parser = crate::commands::parse_full_uuid("subject ID"))]
    pub subject_id: Option<String>,

    /// Stable logical name for the attachment within its subject.
    #[arg(long)]
    pub logical_name: Option<String>,

    /// Attachment provenance as a JSON object.
    #[arg(long, conflicts_with = "metadata_file")]
    pub metadata: Option<String>,

    /// Read attachment provenance JSON from a file.
    #[arg(long, conflicts_with = "metadata")]
    pub metadata_file: Option<PathBuf>,
}

impl ArtifactAddCommand {
    fn read_body(&self) -> Result<String, ServiceError> {
        match (&self.body, &self.body_file) {
            (Some(_), Some(_)) => Err(ServiceError::validation_failed(
                "provide exactly one artifact body source: --body, --body-file, or stdin",
            )),
            (Some(body), None) => Ok(body.clone()),
            (None, Some(path)) => fs::read_to_string(path).map_err(|error| {
                ServiceError::validation_failed(format!(
                    "failed to read artifact body file '{}': {error}",
                    path.display()
                ))
            }),
            (None, None) => {
                let mut body = String::new();
                std::io::stdin()
                    .read_to_string(&mut body)
                    .map_err(|error| {
                        ServiceError::validation_failed(format!(
                            "failed to read artifact body from stdin: {error}"
                        ))
                    })?;
                Ok(body)
            }
        }
    }

    fn create_input(&self) -> Result<CreateArtifactInput, ServiceError> {
        validate_filename(&self.filename)?;

        if self.subject_type.is_some() != self.subject_id.is_some() {
            return Err(ServiceError::validation_failed(
                "subject_type and subject_id must be provided together",
            ));
        }

        if let Some(subject_type) = &self.subject_type {
            parse_subject_type(subject_type).map_err(ServiceError::validation_failed)?;
        }

        let body = self.read_body()?;
        let metadata = read_metadata(&self.metadata, &self.metadata_file)?;
        let mut input = CreateArtifactInput::new(self.filename.clone(), body);
        if let (Some(subject_type), Some(subject_id)) = (&self.subject_type, &self.subject_id) {
            input = input.with_subject(subject_type.clone(), subject_id.clone());
        }
        if let Some(logical_name) = &self.logical_name {
            input = input.with_logical_name(logical_name.clone());
        }
        if let Some(metadata) = metadata {
            input = input.with_metadata(metadata);
        }
        input.validate().map_err(ServiceError::validation_failed)?;
        Ok(input)
    }

    async fn execute_result(&self, services: &VertebraeServices) -> Result<Artifact, ServiceError> {
        services
            .artifacts()
            .create_artifact(self.create_input()?)
            .await
    }

    async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let artifact = self.execute_result(services).await?;
        Ok(format!("Created artifact: {}", artifact.id))
    }

    async fn execute_json(&self, services: &VertebraeServices) -> Result<Value, ServiceError> {
        artifact_operation(
            "artifact add",
            "created",
            &self.execute_result(services).await?,
        )
    }
}

/// List artifacts in the active project.
#[derive(Debug, Args)]
pub struct ArtifactListCommand {
    /// Task ID whose directly attached artifacts should be listed.
    #[arg(long, value_parser = crate::commands::parse_uuid("task ID"))]
    pub task_id: Option<String>,

    /// Maximum number of artifacts to return.
    #[arg(long)]
    pub limit: Option<i32>,

    /// Number of artifacts to skip.
    #[arg(long)]
    pub offset: Option<i32>,
}

impl ArtifactListCommand {
    fn input(&self) -> Result<ListArtifactInput, ServiceError> {
        validate_pagination(self.limit, self.offset)?;
        let mut input = ListArtifactInput::new();
        if let Some(limit) = self.limit {
            input = input.with_limit(limit);
        }
        if let Some(offset) = self.offset {
            input = input.with_offset(offset);
        }
        Ok(input)
    }

    async fn execute_result(
        &self,
        services: &VertebraeServices,
    ) -> Result<Vec<Artifact>, ServiceError> {
        let input = self.input()?;
        match &self.task_id {
            Some(task_id) => {
                services
                    .artifacts()
                    .list_task_artifacts(task_id, input)
                    .await
            }
            None => services.artifacts().list_artifacts(input).await,
        }
    }

    async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        Ok(format_artifact_list(&self.execute_result(services).await?))
    }

    async fn execute_json(&self, services: &VertebraeServices) -> Result<Value, ServiceError> {
        super::json_value(self.execute_result(services).await?)
    }
}

/// Show an artifact by ID.
#[derive(Debug, Args)]
pub struct ArtifactShowCommand {
    /// Artifact ID.
    #[arg(required = true, value_parser = crate::commands::parse_full_uuid("artifact ID"))]
    pub id: String,
}

impl ArtifactShowCommand {
    async fn execute_result(&self, services: &VertebraeServices) -> Result<Artifact, ServiceError> {
        services.artifacts().get_artifact(&self.id).await
    }

    async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        Ok(format_artifact(&self.execute_result(services).await?))
    }

    async fn execute_json(&self, services: &VertebraeServices) -> Result<Value, ServiceError> {
        super::json_value(self.execute_result(services).await?)
    }
}

/// Look up an attachment by its logical name within a subject.
#[derive(Debug, Args)]
pub struct ArtifactLookupCommand {
    /// Stable logical name of the attachment.
    #[arg(required = true)]
    pub logical_name: String,

    /// Type of the attachment target.
    #[arg(long, value_parser = parse_subject_type)]
    pub subject_type: String,

    /// ID of the attachment target.
    #[arg(long, value_parser = crate::commands::parse_full_uuid("subject ID"))]
    pub subject_id: String,
}

impl ArtifactLookupCommand {
    fn input(&self) -> Result<GetArtifactByLogicalNameInput, ServiceError> {
        let input = GetArtifactByLogicalNameInput::new(
            self.subject_type.clone(),
            self.subject_id.clone(),
            self.logical_name.clone(),
        );
        input.validate().map_err(ServiceError::validation_failed)?;
        Ok(input)
    }

    async fn execute_result(&self, services: &VertebraeServices) -> Result<Artifact, ServiceError> {
        services
            .artifacts()
            .get_artifact_by_logical_name(self.input()?)
            .await
    }

    async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        Ok(format_artifact(&self.execute_result(services).await?))
    }

    async fn execute_json(&self, services: &VertebraeServices) -> Result<Value, ServiceError> {
        super::json_value(self.execute_result(services).await?)
    }
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
    #[arg(long, conflicts_with = "body_file")]
    pub body: Option<String>,

    /// Read the replacement artifact body from a file.
    #[arg(long, conflicts_with = "body")]
    pub body_file: Option<PathBuf>,

    /// Type of the replacement attachment target.
    #[arg(long, value_parser = parse_subject_type)]
    pub subject_type: Option<String>,

    /// ID of the replacement attachment target.
    #[arg(long, value_parser = crate::commands::parse_full_uuid("subject ID"))]
    pub subject_id: Option<String>,

    /// Updated stable logical name for the attachment.
    #[arg(long)]
    pub logical_name: Option<String>,

    /// Replacement attachment provenance as a JSON object.
    #[arg(long, conflicts_with = "metadata_file")]
    pub metadata: Option<String>,

    /// Read replacement attachment provenance JSON from a file.
    #[arg(long, conflicts_with = "metadata")]
    pub metadata_file: Option<PathBuf>,
}

impl ArtifactUpdateCommand {
    fn read_body(&self) -> Result<Option<String>, ServiceError> {
        match (&self.body, &self.body_file) {
            (Some(_), Some(_)) => Err(ServiceError::validation_failed(
                "provide exactly one artifact body update source: --body or --body-file",
            )),
            (Some(body), None) => Ok(Some(body.clone())),
            (None, Some(path)) => fs::read_to_string(path).map(Some).map_err(|error| {
                ServiceError::validation_failed(format!(
                    "failed to read artifact body file '{}': {error}",
                    path.display()
                ))
            }),
            (None, None) => Ok(None),
        }
    }

    fn update_input(&self) -> Result<UpdateArtifactInput, ServiceError> {
        if let Some(filename) = &self.filename {
            validate_filename(filename)?;
        }

        let body = self.read_body()?;
        if self.subject_type.is_some() != self.subject_id.is_some() {
            return Err(ServiceError::validation_failed(
                "subject_type and subject_id must be provided together",
            ));
        }
        if let Some(subject_type) = &self.subject_type {
            parse_subject_type(subject_type).map_err(ServiceError::validation_failed)?;
        }

        let metadata = read_metadata(&self.metadata, &self.metadata_file)?;
        if self.filename.is_none()
            && body.is_none()
            && self.subject_type.is_none()
            && self.logical_name.is_none()
            && metadata.is_none()
        {
            return Err(ServiceError::validation_failed(
                "artifact update requires a file, body, attachment, logical name, or metadata field",
            ));
        }

        let mut input = UpdateArtifactInput::new();
        if let Some(filename) = &self.filename {
            input = input.with_filename(filename.clone());
        }
        if let Some(body) = body {
            input = input.with_body(body);
        }
        if let (Some(subject_type), Some(subject_id)) = (&self.subject_type, &self.subject_id) {
            input = input.with_subject(subject_type.clone(), subject_id.clone());
        }
        if let Some(logical_name) = &self.logical_name {
            input = input.with_logical_name(logical_name.clone());
        }
        if let Some(metadata) = metadata {
            input = input.with_metadata(metadata);
        }
        input.validate().map_err(ServiceError::validation_failed)?;
        Ok(input)
    }

    async fn execute_result(&self, services: &VertebraeServices) -> Result<Artifact, ServiceError> {
        services
            .artifacts()
            .update_artifact(&self.id, self.update_input()?)
            .await
    }

    async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let artifact = self.execute_result(services).await?;
        Ok(format!("Updated artifact: {}", artifact.id))
    }

    async fn execute_json(&self, services: &VertebraeServices) -> Result<Value, ServiceError> {
        artifact_operation(
            "artifact update",
            "updated",
            &self.execute_result(services).await?,
        )
    }
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

impl ArtifactDeleteCommand {
    async fn execute_result(
        &self,
        services: &VertebraeServices,
    ) -> Result<Option<Artifact>, ServiceError> {
        let id = self.id.to_lowercase();
        if !self.force && !Self::confirm_delete(&id)? {
            return Ok(None);
        }

        services.artifacts().delete_artifact(&id).await.map(Some)
    }

    async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        match self.execute_result(services).await? {
            Some(artifact) => Ok(format!("Deleted artifact: {}", artifact.id)),
            None => Ok("Deletion cancelled".to_string()),
        }
    }

    async fn execute_json(&self, services: &VertebraeServices) -> Result<Value, ServiceError> {
        match self.execute_result(services).await? {
            Some(artifact) => artifact_operation("artifact delete", "deleted", &artifact),
            None => Ok(super::operation_result(
                "artifact delete",
                "cancelled",
                json!({
                    "artifact_id": self.id.to_lowercase(),
                    "deleted": false,
                }),
            )),
        }
    }

    fn confirm_delete(id: &str) -> Result<bool, ServiceError> {
        print!("Delete artifact '{}'? [y/N] ", id);
        io::stdout().flush().map_err(|error| {
            ServiceError::validation_failed(format!("failed to flush stdout: {error}"))
        })?;

        let mut input = String::new();
        io::stdin().read_line(&mut input).map_err(|error| {
            ServiceError::validation_failed(format!("failed to read confirmation: {error}"))
        })?;
        Ok(confirmation_accepted(&input))
    }
}

fn confirmation_accepted(input: &str) -> bool {
    matches!(input.trim().to_lowercase().as_str(), "y" | "yes")
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
            vec![
                "test",
                "lookup",
                "result",
                "--subject-type",
                "task",
                "--subject-id",
                ARTIFACT_ID,
            ],
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
    fn task_scoped_list_accepts_full_and_short_task_ids() {
        let parsed = TestCli::try_parse_from(["test", "list", "--task-id", ARTIFACT_ID])
            .expect("full task IDs should parse");
        let ArtifactCommand::List(command) = parsed.command else {
            panic!("expected artifact list command");
        };
        assert_eq!(command.task_id.as_deref(), Some(ARTIFACT_ID));

        let parsed = TestCli::try_parse_from(["test", "list", "--task-id", "A1B2C3D4"])
            .expect("short task IDs should parse");
        let ArtifactCommand::List(command) = parsed.command else {
            panic!("expected artifact list command");
        };
        assert_eq!(command.task_id.as_deref(), Some("a1b2c3d4"));

        assert!(TestCli::try_parse_from(["test", "list", "--task-id", "not-a-task-id"]).is_err());
    }

    #[test]
    fn parses_every_supported_attachment_target() {
        for subject_type in SUPPORTED_SUBJECT_TYPES {
            TestCli::try_parse_from([
                "test",
                "add",
                "notes.md",
                "--body",
                "hello",
                "--subject-type",
                subject_type,
                "--subject-id",
                ARTIFACT_ID,
            ])
            .unwrap_or_else(|error| panic!("{subject_type} should parse: {error}"));
        }
    }

    #[test]
    fn rejects_invalid_attachment_target_and_body_source_combinations() {
        assert!(
            TestCli::try_parse_from([
                "test",
                "add",
                "notes.md",
                "--body",
                "hello",
                "--subject-type",
                "workspace",
                "--subject-id",
                ARTIFACT_ID,
            ])
            .is_err()
        );

        assert!(
            TestCli::try_parse_from([
                "test",
                "add",
                "notes.md",
                "--body",
                "hello",
                "--metadata",
                "{}",
                "--metadata-file",
                "metadata.json",
            ])
            .is_err()
        );

        assert!(
            TestCli::try_parse_from([
                "test",
                "lookup",
                "result",
                "--subject-type",
                "workspace",
                "--subject-id",
                ARTIFACT_ID,
            ])
            .is_err()
        );

        assert!(
            TestCli::try_parse_from([
                "test",
                "add",
                "notes.md",
                "--body",
                "hello",
                "--body-file",
                "notes.txt",
            ])
            .is_err()
        );
    }

    #[test]
    fn validates_add_input_and_pagination() {
        let add = ArtifactAddCommand {
            filename: "notes.md".to_string(),
            body: Some("hello".to_string()),
            body_file: None,
            subject_type: Some("task".to_string()),
            subject_id: None,
            logical_name: None,
            metadata: None,
            metadata_file: None,
        };
        assert!(add.create_input().is_err());

        let empty_filename = ArtifactAddCommand {
            filename: "  ".to_string(),
            body: Some("hello".to_string()),
            body_file: None,
            subject_type: None,
            subject_id: None,
            logical_name: None,
            metadata: None,
            metadata_file: None,
        };
        assert!(empty_filename.create_input().is_err());

        assert!(
            ArtifactListCommand {
                task_id: None,
                limit: Some(0),
                offset: None,
            }
            .input()
            .is_err()
        );
        assert!(
            ArtifactListCommand {
                task_id: None,
                limit: None,
                offset: Some(-1),
            }
            .input()
            .is_err()
        );
    }

    #[test]
    fn reads_add_and_update_body_files_and_rejects_empty_update() {
        let path = std::env::temp_dir().join(format!(
            "vtb-artifact-body-{}-{}.txt",
            std::process::id(),
            ARTIFACT_ID.replace('-', "")
        ));
        std::fs::write(&path, "file body").expect("temporary body file should be writable");

        let add = ArtifactAddCommand {
            filename: "notes.md".to_string(),
            body: None,
            body_file: Some(path.clone()),
            subject_type: None,
            subject_id: None,
            logical_name: None,
            metadata: None,
            metadata_file: None,
        };
        assert_eq!(add.create_input().unwrap().body, "file body");

        let update = ArtifactUpdateCommand {
            id: ARTIFACT_ID.to_string(),
            filename: None,
            body: None,
            body_file: Some(path.clone()),
            subject_type: None,
            subject_id: None,
            logical_name: None,
            metadata: None,
            metadata_file: None,
        };
        assert_eq!(
            update.update_input().unwrap().body.as_deref(),
            Some("file body")
        );

        let empty_update = ArtifactUpdateCommand {
            id: ARTIFACT_ID.to_string(),
            filename: None,
            body: None,
            body_file: None,
            subject_type: None,
            subject_id: None,
            logical_name: None,
            metadata: None,
            metadata_file: None,
        };
        assert!(empty_update.update_input().is_err());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn builds_link_inputs_from_validated_metadata_and_paired_destinations() {
        let metadata = r#"{
            "version": 1,
            "content_kind": "result",
            "format": "markdown",
            "origin": "agent",
            "presentation": "rendered",
            "extensions": {"provider": "codex"}
        }"#;
        let add = ArtifactAddCommand {
            filename: "result.md".to_string(),
            body: Some("# Result".to_string()),
            body_file: None,
            subject_type: Some("task".to_string()),
            subject_id: Some(ARTIFACT_ID.to_string()),
            logical_name: Some("result".to_string()),
            metadata: Some(metadata.to_string()),
            metadata_file: None,
        };
        let input = add.create_input().expect("valid metadata should parse");
        assert_eq!(input.logical_name.as_deref(), Some("result"));
        assert_eq!(input.metadata.unwrap().extensions["provider"], "codex");

        let invalid_metadata = ArtifactAddCommand {
            metadata: Some("not-json".to_string()),
            ..add
        };
        assert!(invalid_metadata.create_input().is_err());

        let path = std::env::temp_dir().join(format!(
            "vtb-artifact-metadata-{}-{}.json",
            std::process::id(),
            ARTIFACT_ID.replace('-', "")
        ));
        std::fs::write(&path, metadata).expect("temporary metadata file should be writable");
        let from_file = ArtifactAddCommand {
            filename: "result.md".to_string(),
            body: Some("# Result".to_string()),
            body_file: None,
            subject_type: Some("task".to_string()),
            subject_id: Some(ARTIFACT_ID.to_string()),
            logical_name: Some("result".to_string()),
            metadata: None,
            metadata_file: Some(path.clone()),
        };
        assert_eq!(
            from_file.create_input().unwrap().metadata.unwrap().format,
            "markdown"
        );
        let _ = std::fs::remove_file(path);

        let update = ArtifactUpdateCommand {
            id: ARTIFACT_ID.to_string(),
            filename: None,
            body: None,
            body_file: None,
            subject_type: Some("workflow".to_string()),
            subject_id: Some(ARTIFACT_ID.to_string()),
            logical_name: Some("result".to_string()),
            metadata: Some(metadata.to_string()),
            metadata_file: None,
        };
        let input = update
            .update_input()
            .expect("link-only update should be valid");
        assert_eq!(input.subject_type.as_deref(), Some("workflow"));
        assert_eq!(input.logical_name.as_deref(), Some("result"));

        let incomplete_destination = ArtifactUpdateCommand {
            subject_id: None,
            ..update
        };
        assert!(incomplete_destination.update_input().is_err());
    }

    #[test]
    fn renders_artifact_details_for_humans() {
        let artifact = Artifact::new(ARTIFACT_ID, "project-id", "notes.md", "hello");
        let output = format_artifact(&artifact);

        assert!(output.contains("Artifact: a1b2c3d4-0000-4000-8000-000000000001"));
        assert!(output.contains("Filename: notes.md"));
        assert!(output.contains("Body:\nhello"));
    }

    #[test]
    fn delete_confirmation_defaults_to_no() {
        assert!(!confirmation_accepted(""));
        assert!(!confirmation_accepted("n"));
        assert!(confirmation_accepted("y"));
        assert!(confirmation_accepted(" YES\n"));
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
                Self::Add(_) | Self::List(_) | Self::Lookup(_) => {}
                Self::Show(command) => command.id = resolve_artifact_id(&command.id)?,
                Self::Update(command) => command.id = resolve_artifact_id(&command.id)?,
                Self::Delete(command) => command.id = resolve_artifact_id(&command.id)?,
            }
            Ok(())
        }
    }
}
