use cucumber::{then, when};

use crate::SmokeWorld;

fn remember_created_artifact(world: &mut SmokeWorld, alias: Option<&str>) {
    if world.last_exit_code != 0 {
        return;
    }

    let artifact_id = world.extract_artifact_id_from_output().unwrap_or_else(|| {
        panic!(
            "artifact creation succeeded but returned no artifact ID.\nstdout: '{}'\nstderr: '{}'",
            world.last_stdout, world.last_stderr
        )
    });
    world.track_artifact(artifact_id.clone());
    world
        .stored_ids
        .insert("artifact_id".to_string(), artifact_id.clone());
    if let Some(alias) = alias {
        world.stored_ids.insert(alias.to_string(), artifact_id);
    }
}

fn resolve_artifact_ref(world: &SmokeWorld, artifact_ref: &str) -> String {
    world.resolve_vars(artifact_ref)
}

fn last_json(world: &SmokeWorld, context: &str) -> serde_json::Value {
    serde_json::from_str(&world.last_stdout).unwrap_or_else(|error| {
        panic!(
            "failed to parse {context} JSON: {error}\nstdout: '{}'\nstderr: '{}'",
            world.last_stdout, world.last_stderr
        )
    })
}

#[when(expr = "I add artifact {string} with body {string}")]
async fn add_artifact(world: &mut SmokeWorld, filename: String, body: String) {
    world
        .run_vtb(&["artifact", "add", &filename, "--body", &body])
        .await;
    remember_created_artifact(world, None);
}

#[when(expr = "I add artifact {string} with body {string} as {string}")]
async fn add_artifact_as(world: &mut SmokeWorld, filename: String, body: String, alias: String) {
    world
        .run_vtb(&["artifact", "add", &filename, "--body", &body])
        .await;
    remember_created_artifact(world, Some(&alias));
}

#[when(expr = "I add artifact {string} with body {string} attached to {string} {string}")]
async fn add_artifact_attached_to(
    world: &mut SmokeWorld,
    filename: String,
    body: String,
    subject_type: String,
    subject_ref: String,
) {
    let subject_id = resolve_artifact_ref(world, &subject_ref);
    world
        .run_vtb(&[
            "artifact",
            "add",
            &filename,
            "--body",
            &body,
            "--subject-type",
            &subject_type,
            "--subject-id",
            &subject_id,
        ])
        .await;
    remember_created_artifact(world, None);
}

#[when(expr = "I list artifacts with --limit {int}")]
async fn list_artifacts_with_limit(world: &mut SmokeWorld, limit: i32) {
    let limit = limit.to_string();
    world
        .run_vtb(&["artifact", "list", "--limit", &limit])
        .await;
}

#[when("I list artifacts with an invalid token")]
async fn list_artifacts_with_invalid_token(world: &mut SmokeWorld) {
    world
        .run_vtb_in(
            std::path::Path::new("."),
            &[("VTB_TOKEN", Some("invalid-acceptance-token"))],
            &["artifact", "list"],
        )
        .await;
}

#[when("I list artifacts as JSON")]
async fn list_artifacts_as_json(world: &mut SmokeWorld) {
    world.run_vtb(&["--json", "artifact", "list"]).await;
}

#[when(expr = "I show artifact {string} as JSON")]
async fn show_artifact_as_json(world: &mut SmokeWorld, artifact_ref: String) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    world
        .run_vtb(&["--json", "artifact", "show", &artifact_id])
        .await;
}

#[when(expr = "I update artifact {string} with filename {string} and body {string}")]
async fn update_artifact(
    world: &mut SmokeWorld,
    artifact_ref: String,
    filename: String,
    body: String,
) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    world
        .run_vtb(&[
            "artifact",
            "update",
            &artifact_id,
            "--filename",
            &filename,
            "--body",
            &body,
        ])
        .await;
}

#[when(expr = "I update artifact {string} without changes")]
async fn update_artifact_without_changes(world: &mut SmokeWorld, artifact_ref: String) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    world.run_vtb(&["artifact", "update", &artifact_id]).await;
}

#[when(expr = "I delete artifact {string} with --force")]
async fn delete_artifact(world: &mut SmokeWorld, artifact_ref: String) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    world
        .run_vtb(&["artifact", "delete", &artifact_id, "--force"])
        .await;
}

#[then(expr = "the artifact list should include {string} with filename {string} and body {string}")]
async fn artifact_list_should_include(
    world: &mut SmokeWorld,
    artifact_ref: String,
    expected_filename: String,
    expected_body: String,
) {
    assert_eq!(
        world.last_exit_code, 0,
        "artifact list failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    let artifacts = last_json(world, "artifact list");
    let artifact = artifacts
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == artifact_id))
        .unwrap_or_else(|| {
            panic!(
                "artifact '{}' was not present in the list.\nJSON: {}",
                artifact_id, artifacts
            )
        });

    assert_eq!(
        artifact["filename"], expected_filename,
        "listed artifact filename mismatch: {}",
        artifact
    );
    assert_eq!(
        artifact["body"], expected_body,
        "listed artifact body mismatch: {}",
        artifact
    );
}

#[then("every listed artifact should belong to the active project")]
async fn every_listed_artifact_belongs_to_active_project(world: &mut SmokeWorld) {
    let project_id = world
        .env
        .get("VTB_PROJECT_ID")
        .expect("configured client did not set VTB_PROJECT_ID");
    let artifacts = last_json(world, "artifact list");
    let artifacts = artifacts
        .as_array()
        .expect("artifact list JSON should be an array");

    assert!(
        !artifacts.is_empty(),
        "artifact list should contain the artifact created for this project"
    );
    for artifact in artifacts {
        assert_eq!(
            artifact["project_id"].as_str(),
            Some(project_id.as_str()),
            "artifact was returned outside the active project: {}",
            artifact
        );
    }
}

#[then(expr = "the artifact JSON should have filename {string} and body {string}")]
async fn artifact_json_should_have_content(
    world: &mut SmokeWorld,
    expected_filename: String,
    expected_body: String,
) {
    assert_eq!(
        world.last_exit_code, 0,
        "artifact show failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let artifact = last_json(world, "artifact show");
    assert_eq!(
        artifact["filename"], expected_filename,
        "artifact filename mismatch: {}",
        artifact
    );
    assert_eq!(
        artifact["body"], expected_body,
        "artifact body mismatch: {}",
        artifact
    );
}

#[then("the artifact JSON project_id should match the active project")]
async fn artifact_json_project_should_match_active_project(world: &mut SmokeWorld) {
    let project_id = world
        .env
        .get("VTB_PROJECT_ID")
        .expect("configured client did not set VTB_PROJECT_ID");
    let artifact = last_json(world, "artifact show");
    assert_eq!(
        artifact["project_id"].as_str(),
        Some(project_id.as_str()),
        "artifact project mismatch: {}",
        artifact
    );
}
