//! Rhai artifact-write steps: execute scripts publish named artifacts with
//! `vtb::artifacts::put` and `put_json`, and the stored attachments are read
//! back through Sacrum to check bodies, filenames and provenance. The
//! progress sample comes from the execute agent docs.

use std::time::{Duration, Instant};

use cucumber::gherkin::Step;
use cucumber::{given, then, when};
use serde_json::{Value, json};
use vertebrae_core::ArtifactService;
use vertebrae_core::models::{Artifact, ListArtifactInput};
use vertebrae_sacrum_client::SacrumArtifactService;

use super::execute::{executions, fenced_block};
use super::host_reads::{SECRET, docstring, id, install_rhai_step, substitute};
use crate::DaemonWorld;

const DOC: &str =
    include_str!("../../../../docs/agent-context/workflows/steps/execute/host-artifact-writes.md");

/// The doc's first `rhai` block, run twice in one script so the second run
/// replaces what the first wrote.
#[given("the documented progress sample running twice on SELF")]
async fn documented_progress_twice(world: &mut DaemonWorld) {
    let sample = fenced_block(DOC, "host-artifact-writes.md", "rhai");
    let script = format!(
        "let first = {{\n{sample}\n}};\nlet second = {{\n{sample}\n}};\n#{{ first: first, second: second }}"
    );
    install_rhai_step(world, &script).await;
}

/// The fixtures stay well under one page.
async fn subject_artifacts(world: &DaemonWorld, role: &str) -> Vec<Artifact> {
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured");
    let service = SacrumArtifactService::new((**client).clone());
    let page = ListArtifactInput::new().with_limit(50);
    let artifacts = if role == "PROJECT" {
        service.list_artifacts(page).await
    } else {
        service.list_task_artifacts(&id(world, role), page).await
    };
    artifacts.unwrap_or_else(|error| panic!("list {role} artifacts: {error}"))
}

async fn named(world: &DaemonWorld, role: &str, name: &str) -> Artifact {
    let mut matching: Vec<_> = subject_artifacts(world, role)
        .await
        .into_iter()
        .filter(|artifact| artifact.logical_name.as_deref() == Some(name))
        .collect();
    assert_eq!(
        matching.len(),
        1,
        "{role} artifacts named {name}: {matching:?}"
    );
    matching.remove(0)
}

/// A step's retries are separate executions; wait for one that completes.
#[when("I wait for a retried attempt to complete")]
async fn retried_attempt(world: &mut DaemonWorld) {
    let deadline = Instant::now() + Duration::from_secs(60);
    let completed = loop {
        let rows = executions(world).await;
        if let Some(id) = rows
            .iter()
            .find(|row| row["status"] == "completed" && row["step_type"] == "execute")
            .and_then(|row| row["id"].as_str())
        {
            break id.to_owned();
        }
        assert!(Instant::now() < deadline, "no attempt completed: {rows:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let execution = world
        .poll_execution(&completed, &["completed"], Duration::from_secs(5))
        .await
        .expect("completed attempt");
    world.execution_id = Some(completed);
    world.last_execution = Some(execution);
}

#[then(expr = "the step failed {int} time(s) before it completed")]
async fn failed_before(world: &mut DaemonWorld, failures: usize) {
    let rows = executions(world).await;
    let statuses: Vec<_> = rows
        .iter()
        .filter(|row| row["step_type"] == "execute")
        .map(|row| row["status"].as_str().unwrap_or_default().to_owned())
        .collect();
    let mut expected = vec!["failed".to_owned(); failures];
    expected.push("completed".into());
    assert_eq!(statuses, expected, "{rows:?}");
}

/// The docstring is JSON: a `.json` artifact's value, or the exact text of
/// any other artifact as a JSON string. `$ROLE` stands for a fixture ID.
#[then(expr = "{word} has one artifact named {string} with filename {string} and body:")]
async fn one_artifact(
    world: &mut DaemonWorld,
    step: &Step,
    role: String,
    name: String,
    filename: String,
) {
    let expected: Value =
        serde_json::from_str(&substitute(world, docstring(step))).expect("expected body is JSON");
    let artifact = named(world, &role, &name).await;
    assert_eq!(artifact.filename, filename);
    if filename.ends_with(".json") {
        let body: Value = serde_json::from_str(&artifact.body).expect("stored JSON body");
        assert_eq!(body, expected);
    } else {
        assert_eq!(Value::String(artifact.body), expected);
    }
}

/// The provenance a script write records: the attachment's metadata names
/// the execution that wrote it, its TaskRun and its task.
#[then(expr = "{word}'s {string} artifact was written as {word} by the last execution")]
async fn written_by(world: &mut DaemonWorld, role: String, name: String, format: String) {
    let execution = world
        .last_execution
        .as_ref()
        .expect("no execution observed");
    let task_run_id = execution.task_run_id.clone().expect("execution TaskRun");
    let expected = json!({
        "version": 1, "content_kind": "artifact", "format": format, "origin": "rhai",
        "presentation": "raw",
        "extensions": {
            "execution_id": execution.id, "task_run_id": task_run_id, "task_id": id(world, "SELF")
        }
    });
    let artifact = named(world, &role, &name).await;
    let metadata = serde_json::to_value(artifact.metadata).expect("metadata JSON");
    assert_eq!(metadata, expected);
}

#[then("the task in the other project has only its own artifact")]
async fn foreign_untouched(world: &mut DaemonWorld) {
    let artifacts = subject_artifacts(world, "FOREIGN").await;
    let stored: Vec<_> = artifacts
        .iter()
        .map(|artifact| (artifact.logical_name.clone(), artifact.body.clone()))
        .collect();
    assert_eq!(stored, [(Some("plan".to_owned()), SECRET.to_owned())]);
}
