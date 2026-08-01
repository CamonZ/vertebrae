//! Integration coverage for the `vtb artifact` command group.

use super::mock::mock_services;
use clap::Parser;
use vertebrae_cli::CliArgs;
use vertebrae_cli::commands::artifact::{
    ArtifactAddCommand, ArtifactCommand, ArtifactDeleteCommand, ArtifactListCommand,
    ArtifactLookupCommand, ArtifactShowCommand, ArtifactUpdateCommand,
};
use vertebrae_cli::commands::{Command, CommandResult};
use vertebrae_core::{
    ArtifactLinkMetadata, CreateArtifactInput, GetArtifactByLogicalNameInput, UpdateArtifactInput,
};

const ARTIFACT_ID: &str = "a1b2c3d4-0000-4000-8000-000000000001";

fn add_command(filename: &str, body: &str) -> ArtifactCommand {
    ArtifactCommand::Add(ArtifactAddCommand {
        filename: filename.to_string(),
        body: Some(body.to_string()),
        body_file: None,
        subject_type: None,
        subject_id: None,
        logical_name: None,
        metadata: None,
        metadata_file: None,
    })
}

#[test]
fn global_json_parser_covers_artifact_link_flags_and_conflicts() {
    let metadata = r#"{"version":1,"content_kind":"result","format":"markdown","origin":"agent","presentation":"rendered","extensions":{}}"#;
    let parsed = CliArgs::try_parse_from([
        "vtb",
        "--json",
        "artifact",
        "add",
        "result.md",
        "--body",
        "# Result",
        "--subject-type",
        "task",
        "--subject-id",
        ARTIFACT_ID,
        "--logical-name",
        "result",
        "--metadata",
        metadata,
    ])
    .expect("global JSON artifact add should parse");
    assert!(parsed.json);
    let Some(Command::Artifact(ArtifactCommand::Add(command))) = parsed.command else {
        panic!("expected artifact add command");
    };
    assert_eq!(command.logical_name.as_deref(), Some("result"));
    assert_eq!(command.metadata.as_deref(), Some(metadata));

    let parsed = CliArgs::try_parse_from([
        "vtb",
        "--json",
        "artifact",
        "update",
        ARTIFACT_ID,
        "--subject-type",
        "workflow",
        "--subject-id",
        ARTIFACT_ID,
        "--logical-name",
        "summary",
        "--metadata-file",
        "metadata.json",
    ])
    .expect("global JSON artifact update should parse");
    let Some(Command::Artifact(ArtifactCommand::Update(command))) = parsed.command else {
        panic!("expected artifact update command");
    };
    assert_eq!(command.logical_name.as_deref(), Some("summary"));
    assert_eq!(
        command
            .metadata_file
            .as_deref()
            .and_then(|path| path.to_str()),
        Some("metadata.json")
    );

    assert!(
        CliArgs::try_parse_from([
            "vtb",
            "--json",
            "artifact",
            "update",
            ARTIFACT_ID,
            "--metadata",
            metadata,
            "--metadata-file",
            "metadata.json",
        ])
        .is_err()
    );
}

async fn add_artifact(
    services: &vertebrae_core::VertebraeServices,
    filename: &str,
    body: &str,
) -> String {
    let output = add_command(filename, body).execute(services).await.unwrap();
    output
        .strip_prefix("Created artifact: ")
        .expect("add output should contain the artifact ID")
        .to_string()
}

#[tokio::test]
async fn add_list_and_json_output_use_the_active_project_scope() {
    let services = mock_services();
    let artifact_id = add_artifact(&services, "notes.md", "hello").await;

    let list = ArtifactCommand::List(ArtifactListCommand {
        limit: None,
        offset: None,
    })
    .execute(&services)
    .await
    .unwrap();
    assert!(list.contains(&artifact_id));
    assert!(list.contains("notes.md"));

    let result = Command::Artifact(ArtifactCommand::List(ArtifactListCommand {
        limit: None,
        offset: None,
    }))
    .execute_json(&services)
    .await
    .unwrap();
    let CommandResult::Json(json) = result else {
        panic!("artifact list --json should return JSON output");
    };
    let artifacts = json.as_array().expect("artifact list should be an array");
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["id"], artifact_id);
    assert_eq!(artifacts[0]["project_id"], "mock-project");
}

#[tokio::test]
async fn mock_artifact_service_preserves_subject_link_context() {
    let services = mock_services();
    let metadata = ArtifactLinkMetadata::new("result", "markdown", "agent", "rendered")
        .with_extension("provider", serde_json::json!("codex"));
    let artifact = services
        .artifacts()
        .create_artifact(
            CreateArtifactInput::new("result.md", "# Result")
                .with_subject("task", ARTIFACT_ID)
                .with_logical_name("result")
                .with_metadata(metadata.clone()),
        )
        .await
        .unwrap();

    let found = services
        .artifacts()
        .get_artifact_by_logical_name(GetArtifactByLogicalNameInput::new(
            "task",
            ARTIFACT_ID,
            "result",
        ))
        .await
        .unwrap();
    assert_eq!(found.id, artifact.id);
    assert_eq!(found.metadata, Some(metadata.clone()));

    let updated = services
        .artifacts()
        .update_artifact(
            &artifact.id,
            UpdateArtifactInput::new()
                .with_metadata(metadata.with_extension("display", serde_json::json!("summary"))),
        )
        .await
        .unwrap();
    assert_eq!(
        updated.metadata.unwrap().extensions["display"],
        serde_json::json!("summary")
    );
}

#[tokio::test]
async fn cli_commands_create_lookup_and_reattach_logical_artifacts() {
    let services = mock_services();
    let metadata = r#"{
        "version": 1,
        "content_kind": "result",
        "format": "markdown",
        "origin": "agent",
        "presentation": "rendered",
        "extensions": {"provider": "codex"}
    }"#;
    let created = ArtifactCommand::Add(ArtifactAddCommand {
        filename: "result.md".to_string(),
        body: Some("# Result".to_string()),
        body_file: None,
        subject_type: Some("task".to_string()),
        subject_id: Some(ARTIFACT_ID.to_string()),
        logical_name: Some("result".to_string()),
        metadata: Some(metadata.to_string()),
        metadata_file: None,
    })
    .execute_json(&services)
    .await
    .unwrap();
    let artifact_id = created["artifact_id"].as_str().unwrap().to_string();
    assert_eq!(created["artifact"]["logical_name"], "result");
    assert_eq!(
        created["artifact"]["metadata"]["extensions"]["provider"],
        "codex"
    );

    assert!(
        ArtifactCommand::Add(ArtifactAddCommand {
            filename: "duplicate.md".to_string(),
            body: Some("duplicate".to_string()),
            body_file: None,
            subject_type: Some("task".to_string()),
            subject_id: Some(ARTIFACT_ID.to_string()),
            logical_name: Some("result".to_string()),
            metadata: None,
            metadata_file: None,
        })
        .execute(&services)
        .await
        .is_err()
    );

    let lookup = ArtifactCommand::Lookup(ArtifactLookupCommand {
        logical_name: "result".to_string(),
        subject_type: "task".to_string(),
        subject_id: ARTIFACT_ID.to_string(),
    });
    let output = lookup.execute(&services).await.unwrap();
    assert!(output.contains("Logical name: result"));
    assert!(output.contains("Metadata:"));

    let updated = ArtifactCommand::Update(ArtifactUpdateCommand {
        id: artifact_id,
        filename: None,
        body: None,
        body_file: None,
        subject_type: Some("workflow".to_string()),
        subject_id: Some(ARTIFACT_ID.to_string()),
        logical_name: Some("summary".to_string()),
        metadata: None,
        metadata_file: None,
    })
    .execute_json(&services)
    .await
    .unwrap();
    assert_eq!(updated["artifact"]["logical_name"], "summary");

    assert!(
        ArtifactCommand::Lookup(ArtifactLookupCommand {
            logical_name: "result".to_string(),
            subject_type: "task".to_string(),
            subject_id: ARTIFACT_ID.to_string(),
        })
        .execute(&services)
        .await
        .is_err()
    );

    let found = ArtifactCommand::Lookup(ArtifactLookupCommand {
        logical_name: "summary".to_string(),
        subject_type: "workflow".to_string(),
        subject_id: ARTIFACT_ID.to_string(),
    })
    .execute_json(&services)
    .await
    .unwrap();
    assert_eq!(found["logical_name"], "summary");
}

#[tokio::test]
async fn add_supports_body_files_and_rejects_invalid_body_source_combinations() {
    let services = mock_services();
    let path =
        std::env::temp_dir().join(format!("vtb-cli-artifact-{}-body.txt", std::process::id()));
    std::fs::write(&path, "body from file").expect("temporary body file should be writable");

    let command = ArtifactCommand::Add(ArtifactAddCommand {
        filename: "file.md".to_string(),
        body: None,
        body_file: Some(path.clone()),
        subject_type: Some("project".to_string()),
        subject_id: Some(ARTIFACT_ID.to_string()),
        logical_name: None,
        metadata: None,
        metadata_file: None,
    });
    let output = command.execute(&services).await.unwrap();
    let artifact_id = output.strip_prefix("Created artifact: ").unwrap();
    let shown = ArtifactCommand::Show(ArtifactShowCommand {
        id: artifact_id.to_string(),
    })
    .execute(&services)
    .await
    .unwrap();
    assert!(shown.contains("body from file"));

    let parse_error = CliArgs::try_parse_from([
        "vtb",
        "artifact",
        "add",
        "notes.md",
        "--body",
        "inline",
        "--body-file",
        "notes.txt",
    ]);
    assert!(parse_error.is_err());

    let missing_target = ArtifactCommand::Add(ArtifactAddCommand {
        filename: "invalid.md".to_string(),
        body: Some("body".to_string()),
        body_file: None,
        subject_type: Some("task".to_string()),
        subject_id: None,
        logical_name: None,
        metadata: None,
        metadata_file: None,
    });
    assert!(missing_target.execute(&services).await.is_err());

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn show_and_update_preserve_partial_update_semantics() {
    let services = mock_services();
    let artifact_id = add_artifact(&services, "notes.md", "before").await;

    let shown = ArtifactCommand::Show(ArtifactShowCommand {
        id: artifact_id.clone(),
    })
    .execute(&services)
    .await
    .unwrap();
    assert!(shown.contains("Filename: notes.md"));
    assert!(shown.contains("Body:\nbefore"));

    let updated = ArtifactCommand::Update(ArtifactUpdateCommand {
        id: artifact_id.clone(),
        filename: None,
        body: Some("after".to_string()),
        body_file: None,
        subject_type: None,
        subject_id: None,
        logical_name: None,
        metadata: None,
        metadata_file: None,
    })
    .execute(&services)
    .await
    .unwrap();
    assert!(updated.contains(&artifact_id));

    let json = ArtifactCommand::Update(ArtifactUpdateCommand {
        id: artifact_id.clone(),
        filename: Some("renamed.md".to_string()),
        body: None,
        body_file: None,
        subject_type: None,
        subject_id: None,
        logical_name: None,
        metadata: None,
        metadata_file: None,
    })
    .execute_json(&services)
    .await
    .unwrap();
    assert_eq!(json["command"], "artifact update");
    assert_eq!(json["status"], "updated");
    assert_eq!(json["artifact"]["body"], "after");

    let shown = ArtifactCommand::Show(ArtifactShowCommand { id: artifact_id })
        .execute(&services)
        .await
        .unwrap();
    assert!(shown.contains("Filename: renamed.md"));
    assert!(shown.contains("Body:\nafter"));

    let empty_update = ArtifactCommand::Update(ArtifactUpdateCommand {
        id: ARTIFACT_ID.to_string(),
        filename: None,
        body: None,
        body_file: None,
        subject_type: None,
        subject_id: None,
        logical_name: None,
        metadata: None,
        metadata_file: None,
    });
    let error = empty_update.execute(&services).await.unwrap_err();
    assert!(error.to_string().contains(
        "artifact update requires a file, body, attachment, logical name, or metadata field"
    ));
}

#[tokio::test]
async fn list_pagination_and_delete_force_and_errors_are_enforced() {
    let services = mock_services();
    let first_id = add_artifact(&services, "first.md", "one").await;
    let second_id = add_artifact(&services, "second.md", "two").await;

    let page = ArtifactCommand::List(ArtifactListCommand {
        limit: Some(1),
        offset: Some(1),
    })
    .execute(&services)
    .await
    .unwrap();
    assert!(!page.contains(&first_id));
    assert!(page.contains(&second_id));

    let result = Command::Artifact(ArtifactCommand::Delete(ArtifactDeleteCommand {
        id: first_id.clone(),
        force: true,
    }))
    .execute_json(&services)
    .await
    .unwrap();
    let CommandResult::Json(json) = result else {
        panic!("artifact delete --json should return JSON output");
    };
    assert_eq!(json["command"], "artifact delete");
    assert_eq!(json["status"], "deleted");
    assert_eq!(json["artifact_id"], first_id);

    let missing = ArtifactCommand::Delete(ArtifactDeleteCommand {
        id: first_id,
        force: true,
    });
    assert!(missing.execute(&services).await.is_err());

    let parsed = CliArgs::try_parse_from(["vtb", "artifact", "delete", ARTIFACT_ID, "--force"])
        .expect("artifact delete --force should parse");
    let Some(Command::Artifact(ArtifactCommand::Delete(command))) = parsed.command else {
        panic!("expected artifact delete command");
    };
    assert!(command.force);
}
