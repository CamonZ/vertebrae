//! Rhai task-write steps: execute scripts create, update and archive tasks
//! through `vtb::tasks`, and the documented plan-children sample creates one
//! child per plan key. The sample's plan, script and schema are read from
//! the execute agent docs, so the scenarios run exactly what agents are shown.

use cucumber::gherkin::Step;
use cucumber::{given, then, when};
use serde_json::{Value, json};

use super::execute::{
    connect, create_step, create_workflow, executions, fenced_block, wait_for_step,
};
use super::host_reads::{SECRET, add_artifact, add_task, id, run_vtb_in, vtb_ok};
use crate::DaemonWorld;

const DOC: &str =
    include_str!("../../../../docs/agent-context/workflows/steps/execute/host-writes.md");
const FIRST_RUN: &str = "create-children";
const SECOND_RUN: &str = "create-children-again";

fn fenced(language: &str) -> &'static str {
    fenced_block(DOC, "host-writes.md", language)
}

/// The documented plan: the doc's first `json` block.
fn documented_plan() -> Value {
    serde_json::from_str(fenced("json")).expect("documented plan is JSON")
}

/// The documented `--output-schema '<json>'` value.
fn documented_schema() -> Value {
    let flag = "--output-schema '";
    let start = DOC
        .find(flag)
        .expect("host-writes.md passes --output-schema")
        + flag.len();
    let end = DOC[start..]
        .find('\'')
        .expect("unterminated --output-schema");
    serde_json::from_str(&DOC[start..start + end]).expect("documented schema is JSON")
}

/// The last execution's output under the `result` key that wraps every
/// script in `a Rhai step running:`.
fn script_result(world: &DaemonWorld) -> Value {
    let output = world
        .last_execution
        .as_ref()
        .and_then(|execution| execution.output.as_deref())
        .expect("execute output");
    let output: Value = serde_json::from_str(output).expect("execute output JSON");
    output["result"].clone()
}

async fn shown(world: &mut DaemonWorld, project: Option<&str>, task_id: &str) -> Value {
    let args = ["--json", "show", task_id];
    match project {
        Some(project) => run_vtb_in(world, project, &args).await,
        None => world.run_vtb(&args).await,
    }
    world.assert_vtb_ok("show");
    serde_json::from_str(&world.last_stdout).expect("show JSON")
}

/// Name a task the script created, so later steps and expected results can
/// refer to it as `$ROLE`. The scenario deletes it afterwards.
#[when(expr = "the script's {word} is recorded as {word}")]
async fn record_created(world: &mut DaemonWorld, key: String, role: String) {
    let task_id = script_result(world)[&key]
        .as_str()
        .unwrap_or_else(|| panic!("script result has no {key}"))
        .to_owned();
    world.created_task_ids.push(task_id.clone());
    world.fixture_ids.insert(role, task_id);
}

#[then(expr = "{word} has never run")]
async fn never_run(world: &mut DaemonWorld, role: String) {
    let task_id = id(world, &role);
    let task = shown(world, None, &task_id).await;
    assert_eq!(task["run_history"], json!([]), "{role} has run: {task}");
    assert_eq!(task["run_controls"]["stoppable"], false, "{role}: {task}");
}

#[given("a workflow in the other project")]
async fn foreign_workflow(world: &mut DaemonWorld) {
    let project = id(world, "FOREIGN_PROJECT");
    let response: Value = world
        .graphql_client
        .as_ref()
        .expect("scenario client")
        .execute(
            vertebrae_sacrum_client::queries::workflows::CREATE_WORKFLOW,
            json!({
                "project_id": project,
                "name": format!("daemon-acc-foreign-{}", uuid::Uuid::new_v4().simple())
            }),
            "create_workflow",
        )
        .await
        .expect("create the other project's workflow");
    let workflow_id = response["id"].as_str().expect("workflow id").to_owned();
    world.created_workflow_ids.push(workflow_id.clone());
    world
        .fixture_ids
        .insert("FOREIGN_WORKFLOW".into(), workflow_id);
}

#[then("the task in the other project is unchanged")]
async fn foreign_unchanged(world: &mut DaemonWorld) {
    let project = id(world, "FOREIGN_PROJECT");
    let foreign = id(world, "FOREIGN");
    let task = shown(world, Some(&project), &foreign).await;
    assert_eq!(task["title"], SECRET, "{task}");
    assert_eq!(task["archived"], false, "{task}");
    assert_eq!(task["children"], json!([]), "{task}");
}

async fn plan_parent(world: &mut DaemonWorld, plan: &Value) {
    let project = world.project_id.clone().expect("scenario project");
    let parent = add_task(world, &project, "PARENT", &["plan-parent", "-l", "ticket"]).await;
    add_artifact(
        world,
        &project,
        ("task", &parent),
        Some("plan"),
        &plan.to_string(),
    )
    .await;
    world.task_id = Some(parent);
}

#[given("a parent with the documented plan")]
async fn documented_plan_parent(world: &mut DaemonWorld) {
    plan_parent(world, &documented_plan()).await;
}

/// The documented plan plus a last item whose title `create` refuses.
#[given(expr = "a parent with the documented plan and an item titled {string}")]
async fn failing_plan_parent(world: &mut DaemonWorld, title: String) {
    let mut plan = documented_plan();
    plan.as_array_mut()
        .expect("documented plan is an array")
        .push(json!({"key": "refused", "title": title}));
    plan_parent(world, &plan).await;
}

/// Each step is authored with the doc's flags; steps run in order, then finish.
async fn install_plan_steps(world: &mut DaemonWorld, names: &[&str]) {
    let workflow_id = create_workflow(world).await;
    std::fs::create_dir_all(&world.capture_dir).expect("fixture script directory");
    let path = world.capture_dir.join("plan-children.rhai");
    std::fs::write(&path, fenced("rhai")).expect("write the documented script");
    let script = format!("@{}", path.display());
    let schema = documented_schema().to_string();
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
                &schema,
                "--order",
                &order.to_string(),
            ])
            .await;
        world.assert_vtb_ok("step add (documented plan children)");
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
        "workflow assign (plan children)",
        &["workflow", "assign", &parent, &workflow_id],
    )
    .await;
}

#[given("the documented plan-children step on the parent")]
async fn documented_step(world: &mut DaemonWorld) {
    install_plan_steps(world, &[FIRST_RUN]).await;
}

/// A completed task cannot start another TaskRun, so a rerun is the same
/// documented step a second time within one run.
#[given("the documented plan-children step twice in a row on the parent")]
async fn documented_step_twice(world: &mut DaemonWorld) {
    install_plan_steps(world, &[FIRST_RUN, SECOND_RUN]).await;
}

#[when("I wait for the second plan run to complete")]
async fn second_plan_run(world: &mut DaemonWorld) {
    wait_for_step(world, SECOND_RUN).await;
}

/// Each row is a plan key and its child's title. The parent has exactly
/// these children, one per `plan:<key>` tag; each becomes fixture
/// `CHILD_<KEY>`.
#[then("the parent has exactly one child per plan key:")]
async fn one_child_per_key(world: &mut DaemonWorld, step: &Step) {
    let table = step.table.as_ref().expect("step needs a table");
    let rows: Vec<_> = table.rows.iter().skip(1).collect();
    let parent = id(world, "PARENT");
    let task = shown(world, None, &parent).await;
    let children = task["children"].as_array().expect("children").clone();
    assert_eq!(children.len(), rows.len(), "children: {children:?}");
    for row in rows {
        let tag = format!("plan:{}", row[0]);
        let tagged: Vec<_> = children
            .iter()
            .filter(|child| {
                child["tags"]
                    .as_array()
                    .is_some_and(|tags| tags.contains(&json!(tag)))
            })
            .collect();
        assert_eq!(tagged.len(), 1, "children tagged {tag}: {children:?}");
        assert_eq!(tagged[0]["title"], row[1].as_str());
        let child_id = tagged[0]["id"].as_str().expect("child id").to_owned();
        world
            .fixture_ids
            .insert(format!("CHILD_{}", row[0].to_uppercase()), child_id);
    }
}

#[then("the first run created them in plan order and the second found them")]
async fn created_then_found(world: &mut DaemonWorld) {
    let rows = executions(world).await;
    let output = |name: &str| -> Value {
        let row = rows
            .iter()
            .find(|row| row["step_name"] == name && row["status"] == "completed")
            .unwrap_or_else(|| panic!("no completed {name} execution: {rows:?}"));
        serde_json::from_str(row["output"].as_str().expect("plan output"))
            .expect("plan output JSON")
    };
    let children: Vec<_> = documented_plan()
        .as_array()
        .expect("documented plan is an array")
        .iter()
        .map(|item| {
            let key = item["key"].as_str().expect("plan key").to_uppercase();
            id(world, &format!("CHILD_{key}"))
        })
        .collect();
    assert_eq!(
        output(FIRST_RUN),
        json!({"created": children, "existing": []})
    );
    assert_eq!(
        output(SECOND_RUN),
        json!({"created": [], "existing": children})
    );
}

#[then(
    expr = "the plan step failed in at least {int} attempts with a {string} error from {string}"
)]
async fn failed_attempts(world: &mut DaemonWorld, attempts: usize, kind: String, function: String) {
    let rows = executions(world).await;
    assert!(rows.len() >= attempts, "attempts: {rows:?}");
    for row in &rows {
        assert_eq!(row["status"], "failed", "{row}");
        let output = row["output"].as_str().unwrap_or_default();
        assert!(
            output.contains(&kind) && output.contains(&function),
            "expected a {kind} error from {function}: {output}"
        );
    }
}
