//! Rhai delete steps: execute scripts delete tasks with `vtb::tasks::delete`
//! and named artifacts with `vtb::artifacts::delete`, and the results are
//! checked through Sacrum. A second task with a run held open by a sleeping
//! mock provider stands in for running work. The scratch-children sample
//! comes from the execute agent docs.

use std::time::{Duration, Instant};

use cucumber::{given, then};

use vertebrae_core::ArtifactService;
use vertebrae_core::models::ListArtifactInput;
use vertebrae_core::service::TaskService;
use vertebrae_sacrum_client::{SacrumArtifactService, SacrumTaskService};

use super::execute::fenced_block;
use super::host_reads::{add_artifact, add_task, id, install_rhai_step, vtb_ok};
use crate::DaemonWorld;

const DOC: &str =
    include_str!("../../../../docs/agent-context/workflows/steps/execute/host-deletes.md");
const ACTIVE_RUN_TIMEOUT: Duration = Duration::from_secs(30);
/// Long enough to outlast the scenario; cleanup stops the daemon first.
const BUSY_SLEEP_MS: u64 = 120_000;

fn tasks(world: &DaemonWorld) -> SacrumTaskService {
    let client = world.graphql_client.as_ref().expect("scenario client");
    SacrumTaskService::new((**client).clone())
}

fn artifacts(world: &DaemonWorld) -> SacrumArtifactService {
    let client = world.graphql_client.as_ref().expect("scenario client");
    SacrumArtifactService::new((**client).clone())
}

async fn task_exists(world: &DaemonWorld, role: &str) -> bool {
    tasks(world)
        .task_exists(&id(world, role))
        .await
        .unwrap_or_else(|error| panic!("read {role}: {error}"))
}

async fn named_artifact_id(world: &DaemonWorld, role: &str, name: &str) -> Option<String> {
    artifacts(world)
        .list_task_artifacts(&id(world, role), ListArtifactInput::new().with_limit(50))
        .await
        .unwrap_or_else(|error| panic!("list {role} artifacts: {error}"))
        .into_iter()
        .find(|artifact| artifact.logical_name.as_deref() == Some(name))
        .map(|artifact| artifact.id)
}

#[given(expr = "{word}'s {string} artifact is recorded as {word}")]
async fn record_artifact(world: &mut DaemonWorld, role: String, name: String, as_role: String) {
    let artifact = named_artifact_id(world, &role, &name)
        .await
        .unwrap_or_else(|| panic!("{role} has no {name} artifact"));
    world.fixture_ids.insert(as_role, artifact);
}

#[then(expr = "the artifact {word} still has body {string}")]
async fn artifact_body(world: &mut DaemonWorld, role: String, body: String) {
    let artifact = artifacts(world)
        .get_artifact(&id(world, &role))
        .await
        .unwrap_or_else(|error| panic!("read artifact {role} by ID: {error}"));
    assert_eq!(artifact.body, body);
}

/// SCRATCH_A has notes and data, SCRATCH_B (archived) has notes; both are
/// tagged `scratch`. Their artifact IDs are kept to check the cleanup.
#[given("scratch children of SELF with named artifacts")]
async fn scratch_children(world: &mut DaemonWorld) {
    let project = id(world, "PROJECT");
    let me = id(world, "SELF");
    let mut scratch_artifacts = Vec::new();
    for (role, names) in [
        ("SCRATCH_A", &["notes", "data"][..]),
        ("SCRATCH_B", &["notes"]),
    ] {
        let task = add_task(
            world,
            &project,
            role,
            &["delete-scratch", "--parent", &me, "-t", "scratch"],
        )
        .await;
        for name in names {
            scratch_artifacts
                .push(add_artifact(world, &project, ("task", &task), Some(name), "scratch").await);
        }
    }
    vtb_ok(world, "archive", &["archive", &id(world, "SCRATCH_B")]).await;
    world
        .fixture_ids
        .insert("SCRATCH_ARTIFACTS".into(), scratch_artifacts.join(","));
}

/// The doc's first `rhai` block, run twice in one script.
#[given("the documented scratch-children sample running twice on SELF")]
async fn documented_cleanup_twice(world: &mut DaemonWorld) {
    let sample = fenced_block(DOC, "host-deletes.md", "rhai");
    let script = format!(
        "let first = {{\n{sample}\n}};\nlet second = {{\n{sample}\n}};\n#{{ first: first, second: second }}"
    );
    install_rhai_step(world, &script).await;
}

#[then("the scratch children and their artifacts are gone")]
async fn scratch_gone(world: &mut DaemonWorld) {
    for role in ["SCRATCH_A", "SCRATCH_B"] {
        assert!(!task_exists(world, role).await, "{role} still exists");
    }
    let artifact_ids = id(world, "SCRATCH_ARTIFACTS");
    for artifact_id in artifact_ids.split(',') {
        let read = artifacts(world).get_artifact(artifact_id).await;
        assert!(read.is_err(), "artifact {artifact_id} survived: {read:?}");
    }
}

#[then(expr = "{word} still has its {string} artifact")]
async fn still_has_artifact(world: &mut DaemonWorld, role: String, name: String) {
    assert!(
        named_artifact_id(world, &role, &name).await.is_some(),
        "{role} lost {name}"
    );
}

#[then("PARENT and SELF still exist")]
async fn parent_and_self_exist(world: &mut DaemonWorld) {
    for role in ["PARENT", "SELF"] {
        assert!(task_exists(world, role).await, "{role} was deleted");
    }
}

/// BUSY runs a one-step workflow whose mock provider sleeps, so its TaskRun
/// stays active while the scenario's script runs. Provider steps don't use
/// the execute slot, so the script still gets one.
#[given("BUSY, a child of BUSY_PARENT, with an active TaskRun")]
async fn busy_task(world: &mut DaemonWorld) {
    let project = id(world, "PROJECT");
    let parent = add_task(world, &project, "BUSY_PARENT", &["delete-busy-parent"]).await;
    let busy = add_task(
        world,
        &project,
        "BUSY",
        &["delete-busy", "--parent", &parent],
    )
    .await;

    let name = format!("daemon-acc-busy-{}", uuid::Uuid::new_v4().simple());
    vtb_ok(
        world,
        "workflow add (busy)",
        &["workflow", "add", &name, "--step", "run:claude-sonnet-4-6"],
    )
    .await;
    let workflow_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow output: {}", world.last_stdout))
        .trim()
        .to_owned();
    world.created_workflow_ids.push(workflow_id.clone());
    vtb_ok(
        world,
        "step add finish (busy)",
        &[
            "step",
            "add",
            "finish",
            "-w",
            &workflow_id,
            "--step-type",
            "finish",
            "--order",
            "1",
            "--harness",
            "claude",
        ],
    )
    .await;
    let steps = world
        .run_vtb_json(&["step", "list", &workflow_id])
        .await
        .expect("step list JSON");
    let step_id = |name: &str| {
        steps
            .as_array()
            .expect("step list")
            .iter()
            .find(|step| step["name"] == name)
            .and_then(|step| step["id"].as_str())
            .unwrap_or_else(|| panic!("no {name} step: {steps}"))
            .to_owned()
    };
    let (run, finish) = (step_id("run"), step_id("finish"));
    let prompt = world
        .mock_response("busy")
        .with_exit_code(0)
        .with_delay_ms(BUSY_SLEEP_MS)
        .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-busy"}"#)
        .build()
        .expect("busy mock envelope builds");
    vtb_ok(
        world,
        "step update (busy)",
        &[
            "step",
            "update",
            &run,
            "--harness",
            "claude",
            "--prompt",
            &prompt,
            "--transition-to",
            &finish,
        ],
    )
    .await;
    vtb_ok(
        world,
        "workflow assign (busy)",
        &["workflow", "assign", &busy, &workflow_id],
    )
    .await;
    vtb_ok(world, "start-taskrun (busy)", &["start-taskrun", &busy]).await;

    let deadline = Instant::now() + ACTIVE_RUN_TIMEOUT;
    loop {
        let task = tasks(world).get_task(&busy).await.expect("read BUSY");
        let active = task
            .run_controls
            .as_ref()
            .and_then(|controls| controls.active_run.as_ref());
        if active.is_some() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "BUSY never had an active run: {:?}",
            task.run_controls
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
