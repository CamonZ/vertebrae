//! The documented child-outcome rollup. The sample script and schema are read
//! from the execute agent docs, so the scenarios run exactly what agents are
//! shown: an execute step on a parent reads each direct child's `outcome`
//! artifact, and output persistence stores the summary on the parent.

use std::time::{Duration, Instant};

use cucumber::gherkin::Step;
use cucumber::{given, then, when};
use serde_json::{Value, json};

use super::assertions::task_artifacts;
use super::execute::{connect, create_step, create_workflow, executions};
use super::host_reads::{add_artifact, add_task, id, vtb_ok};
use crate::DaemonWorld;

const DOC: &str =
    include_str!("../../../../docs/agent-context/workflows/steps/execute/host-reads.md");
const SUMMARY: &str = "children-summary";
const FIRST_RUN: &str = "summarize";
const SECOND_RUN: &str = "summarize-again";
const SECOND_RUN_TIMEOUT: Duration = Duration::from_secs(30);

/// The body of the doc's first fenced block in `language`.
fn fenced(language: &str) -> &'static str {
    let open = format!("```{language}\n");
    let start = DOC
        .find(&open)
        .unwrap_or_else(|| panic!("host-reads.md has no {language} block"))
        + open.len();
    let end = DOC[start..]
        .find("```")
        .unwrap_or_else(|| panic!("unterminated {language} block in host-reads.md"));
    &DOC[start..start + end]
}

fn title(role: &str) -> String {
    format!("rollup-{}", role.to_lowercase())
}

fn rows(step: &Step) -> Vec<(String, String)> {
    let table = step.table.as_ref().expect("step needs a table");
    table
        .rows
        .iter()
        .skip(1)
        .map(|row| (row[0].clone(), row[1].clone()))
        .collect()
}

async fn add_child(world: &mut DaemonWorld, role: &str, parent: &str, outcome: Option<&str>) {
    let project = world.project_id.clone().expect("scenario project");
    let child = add_task(world, &project, role, &[&title(role), "--parent", parent]).await;
    if let Some(body) = outcome {
        add_artifact(world, &project, ("task", &child), Some("outcome"), body).await;
    }
}

#[given("a parent whose children report outcomes:")]
async fn parent_with_children(world: &mut DaemonWorld, step: &Step) {
    let project = world.project_id.clone().expect("scenario project");
    let parent = add_task(
        world,
        &project,
        "PARENT",
        &["rollup-parent", "-l", "ticket"],
    )
    .await;
    for (role, outcome) in rows(step) {
        let outcome = (outcome != "-").then_some(outcome.as_str());
        add_child(world, &role, &parent, outcome).await;
    }
    world.task_id = Some(parent);
}

/// Only direct children are summarized; a grandchild's outcome never appears.
#[given(expr = "{word} has a child with its own outcome")]
async fn grandchild(world: &mut DaemonWorld, role: String) {
    let parent = id(world, &role);
    add_child(
        world,
        "GRANDCHILD",
        &parent,
        Some(r#"{"status": "passed"}"#),
    )
    .await;
}

#[given("a child of the parent whose outcome is malformed JSON")]
async fn malformed_child(world: &mut DaemonWorld) {
    let parent = id(world, "PARENT");
    add_child(world, "BROKEN", &parent, Some(r#"{"status": "#)).await;
}

/// Each summary step is authored with the doc's flags: script file, schema
/// and persistence options. Steps run in order, then finish.
async fn install_summary_steps(world: &mut DaemonWorld, names: &[&str]) {
    let workflow_id = create_workflow(world).await;
    std::fs::create_dir_all(&world.capture_dir).expect("fixture script directory");
    let path = world.capture_dir.join("children-summary.rhai");
    std::fs::write(&path, fenced("rhai")).expect("write the documented script");
    let script = format!("@{}", path.display());
    let schema: Value = serde_json::from_str(fenced("json")).expect("documented schema is JSON");
    let persistence = json!({"artifact": {"logical_name": SUMMARY}});
    let mut steps = Vec::new();
    for (order, name) in names.iter().enumerate() {
        let response = world
            .run_vtb_json(&[
                "step",
                "add",
                name,
                "--workflow",
                &workflow_id,
                "--step-type",
                "execute",
                "--script",
                &script,
                "--output-schema",
                &schema.to_string(),
                "--persistence-options",
                &persistence.to_string(),
                "--order",
                &order.to_string(),
            ])
            .await;
        world.assert_vtb_ok("step add (documented children summary)");
        let step_id = response.expect("step add JSON")["step_id"]
            .as_str()
            .expect("step id")
            .to_owned();
        steps.push(step_id);
    }
    let finish_order = i32::try_from(names.len()).expect("step order");
    let finish = create_step(
        world,
        &workflow_id,
        "finish",
        "finish",
        finish_order,
        Value::Null,
    )
    .await;
    steps.push(finish);
    for pair in steps.windows(2) {
        connect(world, &pair[0], &pair[1]).await;
    }
    world.step_id = Some(steps[0].clone());

    let parent = id(world, "PARENT");
    vtb_ok(
        world,
        "workflow assign (children summary)",
        &["workflow", "assign", &parent, &workflow_id],
    )
    .await;
}

#[given("the documented children-summary step on the parent")]
async fn documented_step(world: &mut DaemonWorld) {
    install_summary_steps(world, &[FIRST_RUN]).await;
}

/// A completed task cannot start another TaskRun, so a rerun is the same
/// documented step a second time within one run.
#[given("the documented children-summary step twice in a row on the parent")]
async fn documented_step_twice(world: &mut DaemonWorld) {
    install_summary_steps(world, &[FIRST_RUN, SECOND_RUN]).await;
}

#[when("I wait for the second summary to complete")]
async fn second_summary(world: &mut DaemonWorld) {
    let deadline = Instant::now() + SECOND_RUN_TIMEOUT;
    let execution_id = loop {
        let rows = executions(world).await;
        if let Some(id) = rows
            .iter()
            .find(|row| row["step_name"] == SECOND_RUN)
            .and_then(|row| row["id"].as_str())
        {
            break id.to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "the second summary never started: {rows:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let execution = world
        .poll_execution(&execution_id, &["completed"], SECOND_RUN_TIMEOUT)
        .await
        .expect("the second summary completes");
    world.execution_id = Some(execution_id);
    world.last_execution = Some(execution);
}

#[then("both summary runs returned the same summary")]
async fn same_summary(world: &mut DaemonWorld) {
    let rows = executions(world).await;
    let output = |name: &str| -> Value {
        let row = rows
            .iter()
            .find(|row| row["step_name"] == name && row["status"] == "completed")
            .unwrap_or_else(|| panic!("no completed {name} execution: {rows:?}"));
        serde_json::from_str(row["output"].as_str().expect("summary output"))
            .expect("summary output JSON")
    };
    assert_eq!(output(FIRST_RUN), output(SECOND_RUN));
}

/// Each row is a child role and its outcome JSON, or `missing`. The expected
/// summary orders both lists by child ID, as the sample script does.
#[then("the children summary, in ID order, is:")]
async fn summary_is(world: &mut DaemonWorld, step: &Step) {
    let mut reported = Vec::new();
    let mut missing = Vec::new();
    for (role, outcome) in rows(step) {
        let child_id = id(world, &role);
        let mut entry = json!({"id": child_id, "title": title(&role)});
        if outcome == "missing" {
            missing.push((child_id, entry));
        } else {
            entry["outcome"] = serde_json::from_str(&outcome).expect("outcome cell is JSON");
            reported.push((child_id, entry));
        }
    }
    let ordered = |mut entries: Vec<(String, Value)>| {
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
            .into_iter()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>()
    };
    let expected = json!({"reported": ordered(reported), "missing": ordered(missing)});

    let execution = world
        .last_execution
        .as_ref()
        .expect("no execution observed");
    let output = execution.output.as_deref().expect("summary output");
    let output: Value = serde_json::from_str(output).expect("summary output JSON");
    assert_eq!(output, expected);
}

#[then("the parent's children-summary artifact holds the same summary")]
async fn artifact_holds_summary(world: &mut DaemonWorld) {
    let artifacts = task_artifacts(world).await;
    let stored: Vec<_> = artifacts
        .iter()
        .filter(|artifact| artifact.logical_name.as_deref() == Some(SUMMARY))
        .collect();
    assert_eq!(stored.len(), 1, "children-summary artifacts: {stored:?}");
    assert_eq!(stored[0].filename, format!("{SUMMARY}.json"));
    let body: Value = serde_json::from_str(&stored[0].body).expect("summary artifact JSON");
    let output = world
        .last_execution
        .as_ref()
        .and_then(|execution| execution.output.as_deref())
        .expect("summary output");
    let output: Value = serde_json::from_str(output).expect("summary output JSON");
    assert_eq!(body, output);
}
