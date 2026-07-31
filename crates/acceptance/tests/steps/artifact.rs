use cucumber::{given, then, when};
use tokio_postgres::NoTls;
use uuid::Uuid;

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

fn artifact_ids(value: &serde_json::Value) -> Vec<&str> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("expected an artifact array, got {value}"))
        .iter()
        .filter_map(|artifact| artifact.get("id").and_then(serde_json::Value::as_str))
        .collect()
}

async fn assert_subject_has_artifact(
    world: &SmokeWorld,
    subject_type: &str,
    subject_id: &str,
    artifact_id: &str,
) {
    let project_id = world
        .stored_ids
        .get("project_id")
        .expect("configured project ID is required");
    let database_url = std::env::var("SACRUM_DATABASE_URL")
        .expect("SACRUM_DATABASE_URL must be set for destination-link assertions");
    let project_id = Uuid::parse_str(project_id).expect("project ID should be a UUID");
    let artifact_id = Uuid::parse_str(artifact_id).expect("artifact ID should be a UUID");
    let subject_id = Uuid::parse_str(subject_id).expect("subject ID should be a UUID");
    let subject_type = subject_type.to_string();
    let (client, connection) = tokio_postgres::connect(&database_url, NoTls)
        .await
        .expect("failed to connect to the Sacrum acceptance database");
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("Sacrum acceptance database connection failed: {error}");
        }
    });
    let link = client
        .query_opt(
            "SELECT 1 FROM artifact_links \
             WHERE project_id = $1 AND artifact_id = $2 \
             AND subject_type = $3 AND subject_id = $4",
            &[&project_id, &artifact_id, &subject_type, &subject_id],
        )
        .await
        .unwrap_or_else(|error| panic!("failed to query {subject_type} artifact link: {error}"));
    assert!(
        link.is_some(),
        "artifact {artifact_id} was not attached to {subject_type} {subject_id}"
    );
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

#[when(expr = "I add artifact {string} from a body file containing {string}")]
async fn add_artifact_from_file(world: &mut SmokeWorld, filename: String, body: String) {
    let path = world.write_temp_file(&body);
    let path = path.to_string_lossy().into_owned();
    world
        .run_vtb(&["artifact", "add", &filename, "--body-file", &path])
        .await;
    remember_created_artifact(world, None);
}

#[when(expr = "I add artifact {string} from stdin containing {string}")]
async fn add_artifact_from_stdin(world: &mut SmokeWorld, filename: String, body: String) {
    world
        .run_vtb_with_stdin(&["artifact", "add", &filename], &body)
        .await;
    remember_created_artifact(world, None);
}

#[when(expr = "I add artifact {string} with body {string} as JSON")]
async fn add_artifact_as_json(world: &mut SmokeWorld, filename: String, body: String) {
    world
        .run_vtb(&["--json", "artifact", "add", &filename, "--body", &body])
        .await;
    remember_created_artifact(world, None);
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

#[when(expr = "I list artifacts with --limit {int} and --offset {int}")]
async fn list_artifacts_with_limit_and_offset(world: &mut SmokeWorld, limit: i32, offset: i32) {
    let limit = limit.to_string();
    let offset = offset.to_string();
    world
        .run_vtb(&[
            "--json", "artifact", "list", "--limit", &limit, "--offset", &offset,
        ])
        .await;
}

#[when("I list artifacts for humans")]
async fn list_artifacts_for_humans(world: &mut SmokeWorld) {
    world.run_vtb(&["artifact", "list"]).await;
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

#[when(expr = "I show artifact {string} for humans")]
async fn show_artifact_for_humans(world: &mut SmokeWorld, artifact_ref: String) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    world.run_vtb(&["artifact", "show", &artifact_id]).await;
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

#[when(expr = "I update artifact {string} with body file containing {string}")]
async fn update_artifact_from_file(world: &mut SmokeWorld, artifact_ref: String, body: String) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    let path = world.write_temp_file(&body);
    let path = path.to_string_lossy().into_owned();
    world
        .run_vtb(&["artifact", "update", &artifact_id, "--body-file", &path])
        .await;
}

#[when(
    expr = "I update artifact {string} with filename {string} and body file containing {string}"
)]
async fn update_artifact_from_file_with_filename(
    world: &mut SmokeWorld,
    artifact_ref: String,
    filename: String,
    body: String,
) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    let path = world.write_temp_file(&body);
    let path = path.to_string_lossy().into_owned();
    world
        .run_vtb(&[
            "artifact",
            "update",
            &artifact_id,
            "--filename",
            &filename,
            "--body-file",
            &path,
        ])
        .await;
}

#[when(expr = "I update artifact {string} with body {string} as JSON")]
async fn update_artifact_as_json(world: &mut SmokeWorld, artifact_ref: String, body: String) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    world
        .run_vtb(&[
            "--json",
            "artifact",
            "update",
            &artifact_id,
            "--body",
            &body,
        ])
        .await;
}

#[when(expr = "I update artifact {string} with filename {string} and body {string} as JSON")]
async fn update_artifact_with_filename_as_json(
    world: &mut SmokeWorld,
    artifact_ref: String,
    filename: String,
    body: String,
) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    world
        .run_vtb(&[
            "--json",
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

#[when(expr = "I delete artifact {string} with --force as JSON")]
async fn delete_artifact_as_json(world: &mut SmokeWorld, artifact_ref: String) {
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    world
        .run_vtb(&["--json", "artifact", "delete", &artifact_id, "--force"])
        .await;
}

#[when(expr = "I run artifact command {string} with an invalid token")]
async fn run_artifact_command_with_invalid_token(world: &mut SmokeWorld, args: String) {
    let args = args.split_whitespace().collect::<Vec<_>>();
    world
        .run_vtb_in(
            std::path::Path::new("."),
            &[("VTB_TOKEN", Some("invalid-acceptance-token"))],
            &args,
        )
        .await;
}

#[given("I create an artifact task section fixture")]
async fn create_artifact_task_section_fixture(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task fixture").clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("configured Sacrum client is required");
    let section: serde_json::Value = client
        .execute(
            r#"mutation ArtifactFixtureSection($task_id: Uuid4!) {
                createSection(
                    taskId: $task_id,
                    sectionType: "testing_criterion",
                    content: "Artifact attachment section"
                ) { id }
            }"#,
            serde_json::json!({"task_id": task_id}),
            "createSection",
        )
        .await
        .expect("failed to create task section fixture");
    let section_id = section
        .get("id")
        .and_then(serde_json::Value::as_str)
        .expect("createSection did not return a section ID");
    world
        .stored_ids
        .insert("section_id".to_string(), section_id.to_string());
}

#[when("I create an artifact step execution")]
async fn create_artifact_step_execution(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task fixture").clone();
    let step_id = world
        .stored_ids
        .get("step:execute")
        .expect("workflow fixture did not create the execute step")
        .clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("configured Sacrum client is required");
    let execution: serde_json::Value = client
        .execute(
            r#"mutation ArtifactFixtureRunStep($task_id: Uuid4!, $step_id: Uuid4!) {
                runStep(taskId: $task_id, stepId: $step_id) { id }
            }"#,
            serde_json::json!({"task_id": task_id, "step_id": step_id}),
            "runStep",
        )
        .await
        .expect("failed to create step execution fixture");
    let execution_id = execution
        .get("id")
        .and_then(serde_json::Value::as_str)
        .expect("runStep did not return an execution ID");
    world
        .stored_ids
        .insert("step_execution_id".to_string(), execution_id.to_string());
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

#[then(expr = "artifact {string} should be attached to {string} {string}")]
async fn artifact_should_be_attached_to(
    world: &mut SmokeWorld,
    artifact_ref: String,
    subject_type: String,
    subject_ref: String,
) {
    assert_eq!(
        world.last_exit_code, 0,
        "artifact creation failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let artifact_id = resolve_artifact_ref(world, &artifact_ref);
    let subject_id = resolve_artifact_ref(world, &subject_ref);
    assert_subject_has_artifact(world, &subject_type, &subject_id, &artifact_id).await;
}

#[then(expr = "the human artifact list should say {string}")]
async fn human_artifact_list_should_say(world: &mut SmokeWorld, expected: String) {
    assert_eq!(
        world.last_exit_code, 0,
        "artifact list failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    assert_eq!(world.last_stdout.trim(), expected);
}

#[then(expr = "the artifact JSON list should contain {int} entries")]
async fn artifact_json_list_should_contain(world: &mut SmokeWorld, expected: usize) {
    assert_eq!(
        world.last_exit_code, 0,
        "artifact list failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    assert_eq!(
        artifact_ids(&last_json(world, "artifact list")).len(),
        expected
    );
}

#[then(expr = "the artifact list should not contain filename {string}")]
async fn artifact_list_should_not_contain_filename(world: &mut SmokeWorld, filename: String) {
    assert_eq!(
        world.last_exit_code, 0,
        "artifact list failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let artifacts = last_json(world, "artifact list");
    assert!(
        !artifacts
            .as_array()
            .expect("artifact list should be an array")
            .iter()
            .any(|artifact| artifact["filename"] == filename)
    );
}

#[then(expr = "the artifact JSON status should be {string}")]
async fn artifact_json_status_should_be(world: &mut SmokeWorld, expected: String) {
    assert_eq!(
        world.last_exit_code, 0,
        "artifact JSON command failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    assert_eq!(last_json(world, "artifact operation")["status"], expected);
}
