use std::io::Write;

use cucumber::{given, then, when};
use tokio::time::{Duration, Instant, sleep};
use vertebrae_core::{ExecutionService, HumanInputConfig, StepConfig, StepService};
use vertebrae_sacrum_client::{SacrumExecutionService, SacrumStepService};

use crate::SmokeWorld;

const APPROVAL_SCHEMA: &str = r#"{"type":"object","required":["approved","reason"],"properties":{"approved":{"type":"boolean"},"reason":{"type":"string"}}}"#;

fn approval_schema() -> serde_json::Value {
    serde_json::from_str(APPROVAL_SCHEMA).expect("approval schema is valid JSON")
}

fn step_id(world: &SmokeWorld, name: &str) -> String {
    world
        .stored_ids
        .get(&format!("step:{name}"))
        .unwrap_or_else(|| panic!("no step '{name}' stored"))
        .clone()
}

fn client(world: &SmokeWorld) -> vertebrae_sacrum_client::GraphqlClient {
    world
        .graphql_client
        .as_ref()
        .expect("configured Sacrum client is required")
        .clone()
}

/// Write `contents` to a scenario-owned temp file and return its `@path`.
fn at_path(world: &mut SmokeWorld, contents: &str) -> String {
    let mut file = tempfile::NamedTempFile::new().expect("failed to create temp file");
    file.write_all(contents.as_bytes())
        .expect("failed to write temp file");
    let path = format!("@{}", file.path().display());
    world.temp_files.push(file);
    path
}

/// Read a step's config back from Sacrum through the client's GraphQL
/// fragments, so the assertion covers the real schema round trip.
async fn stored_human_input_config(world: &SmokeWorld, name: &str) -> HumanInputConfig {
    let step = SacrumStepService::new(client(world))
        .get_step(&step_id(world, name))
        .await
        .expect("failed to read step from Sacrum")
        .unwrap_or_else(|| panic!("step '{name}' not found in Sacrum"));
    match step.config {
        Some(StepConfig::HumanInput(config)) => config,
        other => panic!("expected a human_input config on '{name}', got {other:?}"),
    }
}

#[when(
    expr = "I add a human_input step {string} with role {string} and question from a file containing {string}, artifact {string}, and the approval output schema"
)]
async fn add_configured_gate(
    world: &mut SmokeWorld,
    name: String,
    role: String,
    question: String,
    artifact: String,
) {
    let workflow_id = world.workflow_id.clone().expect("no workflow ID stored");
    let question = at_path(world, &question);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &workflow_id,
            "--harness",
            "claude",
            "--step-type",
            "human_input",
            "--role",
            &role,
            "--question",
            &question,
            "--artifact",
            &artifact,
            "--output-schema",
            APPROVAL_SCHEMA,
        ])
        .await;
    if world.last_exit_code == 0 {
        let id = world
            .last_stdout
            .trim()
            .strip_prefix("Created step: ")
            .unwrap_or_else(|| panic!("unexpected step add output: {}", world.last_stdout))
            .trim()
            .to_string();
        world.stored_ids.insert(format!("step:{name}"), id);
    }
}

#[given(
    expr = "the human_input step {string} is configured with role {string} and question {string}, artifact {string}, and the approval output schema"
)]
#[when(
    expr = "I configure the human_input step {string} with role {string} and question {string}, artifact {string}, and the approval output schema"
)]
async fn configure_gate(
    world: &mut SmokeWorld,
    name: String,
    role: String,
    question: String,
    artifact: String,
) {
    let id = step_id(world, &name);
    world
        .run_vtb(&[
            "step",
            "update",
            &id,
            "--role",
            &role,
            "--question",
            &question,
            "--artifact",
            &artifact,
            "--output-schema",
            APPROVAL_SCHEMA,
        ])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to configure human_input step '{name}': {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[when(expr = "I clear the human_input role, question and artifact of step {string}")]
async fn clear_gate_role_question_and_artifact(world: &mut SmokeWorld, name: String) {
    let id = step_id(world, &name);
    world
        .run_vtb(&[
            "step",
            "update",
            &id,
            "--clear-role",
            "--clear-question",
            "--clear-artifact",
        ])
        .await;
}

#[then(
    expr = "Sacrum should store the human_input step {string} with role {string} and question {string}, artifact {string}, and the approval output schema"
)]
async fn sacrum_stores_gate_config(
    world: &mut SmokeWorld,
    name: String,
    role: String,
    question: String,
    artifact: String,
) {
    assert_eq!(
        stored_human_input_config(world, &name).await,
        HumanInputConfig {
            version: 2,
            role: Some(role),
            question: Some(question),
            artifact: Some(artifact),
            output_schema: Some(approval_schema()),
        }
    );
}

#[then(
    expr = "Sacrum should store the human_input step {string} with only the approval output schema"
)]
async fn sacrum_stores_cleared_gate_config(world: &mut SmokeWorld, name: String) {
    assert_eq!(
        stored_human_input_config(world, &name).await,
        HumanInputConfig {
            version: 2,
            role: None,
            question: None,
            artifact: None,
            output_schema: Some(approval_schema()),
        }
    );
}

#[then(expr = "the step show JSON config should have {word} {string}")]
async fn step_show_json_config_field(world: &mut SmokeWorld, field: String, expected: String) {
    let json: serde_json::Value = serde_json::from_str(&world.last_stdout).unwrap_or_else(|e| {
        panic!(
            "step show output is not JSON: {e}\nstdout: '{}'",
            world.last_stdout
        )
    });
    assert_eq!(
        json["config"][&field], expected,
        "config: {}",
        json["config"]
    );
    assert_eq!(json["config"]["output_schema"], approval_schema());
}

/// Wait until the run is parked on the gate and store that execution's ID as
/// `step_execution_id`.
#[when(expr = "the TaskRun {string} is waiting at the human_input gate")]
async fn wait_for_parked_gate(world: &mut SmokeWorld, task_run_ref: String) {
    let task_run_id = world.resolve_vars(&format!("<{task_run_ref}>"));
    let client = client(world);
    let deadline = Instant::now() + Duration::from_secs(30);
    let execution_id = loop {
        let run: serde_json::Value = client
            .execute(
                r#"query HumanInputGateRun($id: Uuid4!) {
                    taskRun(id: $id) { status latestStepExecutionId }
                }"#,
                serde_json::json!({"id": &task_run_id}),
                "taskRun",
            )
            .await
            .expect("failed to read TaskRun");
        if run["status"] == "waiting"
            && let Some(id) = run["latestStepExecutionId"].as_str()
        {
            break id.to_string();
        }
        assert!(
            Instant::now() < deadline,
            "TaskRun {task_run_id} did not park at the gate within 30 seconds: {run}"
        );
        sleep(Duration::from_millis(100)).await;
    };
    world
        .stored_ids
        .insert("step_execution_id".to_string(), execution_id);
}

#[then(
    expr = "the waiting execution should carry role {string}, question {string} and artifact {string}"
)]
async fn waiting_execution_carries_rendered_config(
    world: &mut SmokeWorld,
    role: String,
    question: String,
    artifact: String,
) {
    let execution_id = world.resolve_vars("<step_execution_id>");
    let execution = SacrumExecutionService::new(client(world))
        .get_execution(&execution_id)
        .await
        .expect("failed to read the waiting execution")
        .expect("waiting execution not found");
    assert_eq!(
        execution.config,
        Some(StepConfig::HumanInput(HumanInputConfig {
            version: 2,
            role: Some(role),
            question: Some(question),
            artifact: Some(artifact),
            output_schema: Some(approval_schema()),
        }))
    );
}

#[when(expr = "I attach {string} as {string} to the waiting execution")]
async fn attach_to_waiting_execution(world: &mut SmokeWorld, body: String, logical_name: String) {
    let execution_id = world.resolve_vars("<step_execution_id>");
    world
        .run_vtb(&[
            "artifact",
            "add",
            "response.json",
            "--body",
            &body,
            "--subject-type",
            "step_execution",
            "--subject-id",
            &execution_id,
            "--logical-name",
            &logical_name,
        ])
        .await;
    if world.last_exit_code == 0
        && let Some(id) = world.extract_artifact_id_from_output()
    {
        world.track_artifact(id);
    }
}

#[then(expr = "the TaskRun {string} should reach status {string}")]
async fn task_run_reaches_status(world: &mut SmokeWorld, task_run_ref: String, expected: String) {
    let task_run_id = world.resolve_vars(&format!("<{task_run_ref}>"));
    let client = client(world);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let run: serde_json::Value = client
            .execute(
                r#"query HumanInputGateRunStatus($id: Uuid4!) {
                    taskRun(id: $id) { status }
                }"#,
                serde_json::json!({"id": &task_run_id}),
                "taskRun",
            )
            .await
            .expect("failed to read TaskRun");
        if run["status"] == expected.as_str() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "TaskRun {task_run_id} did not reach {expected} within 30 seconds: {run}"
        );
        sleep(Duration::from_millis(100)).await;
    }
}
