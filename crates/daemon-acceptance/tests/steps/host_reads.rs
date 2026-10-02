//! Rhai host-read steps: execute scripts read live tasks (`vtb::tasks`) and
//! named artifacts (`vtb::artifacts`) through the daemon against a real
//! Sacrum, scoped to the execution's project.
//!
//! Fixtures live in the scenario's project, plus one task and its artifacts in
//! a second project that scripts must never see. Each fixture has a role;
//! `$ROLE` in a script or an expected result stands for its quoted ID.

use cucumber::gherkin::Step;
use cucumber::{given, then};
use serde_json::{Value, json};
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

use super::execute::{connect, create_execute_step, create_step, create_workflow};
use crate::DaemonWorld;

/// The marker in every other-project fixture; no script output may contain it.
const SECRET: &str = "Foreign secret";
const PLAN_BODY: &str = "  # Plan\n\n\tstep one  \n✓ done\r\n";
const DATA_BODY: &str = r#"{"max": 9223372036854775807, "min": -9223372036854775808,
  "exact": 9007199254740993, "none": null, "nested": [{"ok": true, "ratio": 0.5}, []]}"#;

fn id(world: &DaemonWorld, role: &str) -> String {
    world
        .fixture_ids
        .get(role)
        .unwrap_or_else(|| panic!("fixture {role} not created"))
        .clone()
}

/// Replace each `$ROLE` with its quoted ID. Longer roles go first so that
/// `$FOREIGN` never consumes the start of `$FOREIGN_PLAN`.
fn substitute(world: &DaemonWorld, text: &str) -> String {
    let mut roles: Vec<_> = world.fixture_ids.iter().collect();
    roles.sort_by_key(|(role, _)| std::cmp::Reverse(role.len()));
    let text = roles.into_iter().fold(text.to_owned(), |text, (role, id)| {
        text.replace(&format!("${role}"), &format!("\"{id}\""))
    });
    assert!(!text.contains('$'), "unresolved fixture in {text}");
    text
}

fn docstring(step: &Step) -> &str {
    step.docstring
        .as_deref()
        .expect("step needs a docstring")
        .trim()
}

/// Run `vtb` against `project` instead of the scenario's project.
async fn run_vtb_in(world: &mut DaemonWorld, project: &str, args: &[&str]) {
    let own = world
        .env
        .insert("VTB_PROJECT_ID".into(), project.to_owned())
        .expect("scenario project configured");
    world.run_vtb(args).await;
    world.env.insert("VTB_PROJECT_ID".into(), own);
}

async fn vtb_ok(world: &mut DaemonWorld, context: &str, args: &[&str]) {
    world.run_vtb(args).await;
    world.assert_vtb_ok(context);
}

async fn add_task(world: &mut DaemonWorld, project: &str, role: &str, args: &[&str]) -> String {
    run_vtb_in(world, project, &[&["add"], args].concat()).await;
    world.assert_vtb_ok(&format!("task add ({role})"));
    let task_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created task: ")
        .unwrap_or_else(|| panic!("unexpected task output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.created_task_ids.push(task_id.clone());
    world.fixture_ids.insert(role.into(), task_id.clone());
    task_id
}

async fn add_artifact(
    world: &mut DaemonWorld,
    project: &str,
    subject: (&str, &str),
    name: Option<&str>,
    body: &str,
) -> String {
    std::fs::create_dir_all(&world.capture_dir).expect("fixture body directory");
    let path = world
        .capture_dir
        .join(format!("artifact-{}.txt", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, body).expect("write artifact body");
    let path = path.display().to_string();
    let filename = format!("{}.txt", name.unwrap_or("unnamed"));
    let mut args = vec![
        "--json",
        "artifact",
        "add",
        &filename,
        "--body-file",
        &path,
        "--subject-type",
        subject.0,
        "--subject-id",
        subject.1,
    ];
    if let Some(name) = name {
        args.extend(["--logical-name", name]);
    }
    run_vtb_in(world, project, &args).await;
    world.assert_vtb_ok("artifact add");
    let created: Value = serde_json::from_str(&world.last_stdout).expect("artifact add JSON");
    created["artifact_id"]
        .as_str()
        .expect("artifact id")
        .to_owned()
}

/// Creation order matters: `find` and relationship listings are ordered by it.
#[given("a task hierarchy beside a task in another project")]
async fn task_hierarchy(world: &mut DaemonWorld) {
    let project = world.project_id.clone().expect("scenario project");
    world.fixture_ids.insert("PROJECT".into(), project.clone());
    let parent = add_task(
        world,
        &project,
        "PARENT",
        &["host-read-parent", "-l", "ticket"],
    )
    .await;
    let me = add_task(
        world,
        &project,
        "SELF",
        &[
            "host-read-self",
            "--parent",
            &parent,
            "-l",
            "task",
            "-p",
            "high",
            "-t",
            "host-read",
            "-d",
            "Reads its neighbours",
        ],
    )
    .await;
    vtb_ok(
        world,
        "section add",
        &["section", &me, "context", "Live host read"],
    )
    .await;
    vtb_ok(
        world,
        "code ref add",
        &["ref", &me, "src/lib.rs:L3-9", "--name", "roll_up"],
    )
    .await;
    let child_a = add_task(
        world,
        &project,
        "CHILD_A",
        &[
            "host-read-child-a",
            "--parent",
            &me,
            "-t",
            "host-read",
            "-p",
            "low",
        ],
    )
    .await;
    let child_b = add_task(
        world,
        &project,
        "CHILD_B",
        &["host-read-child-b", "--parent", &me],
    )
    .await;
    add_task(
        world,
        &project,
        "GRANDCHILD",
        &["host-read-grandchild", "--parent", &child_a],
    )
    .await;
    let archived = add_task(
        world,
        &project,
        "ARCHIVED",
        &["host-read-archived", "--parent", &me],
    )
    .await;
    vtb_ok(world, "archive", &["archive", &archived]).await;
    let blocker = add_task(world, &project, "BLOCKER", &["host-read-blocker"]).await;
    vtb_ok(world, "depend", &["depend", &child_b, "--on", &blocker]).await;
    add_task(
        world,
        &project,
        "DEPENDENT",
        &["host-read-dependent", "--depends-on", &me],
    )
    .await;

    // A second project, created like the scenario's own.
    let slug = format!("daemon-acc-foreign-{}", uuid::Uuid::new_v4());
    let foreign: vertebrae_sacrum_client::ProjectResponse = GraphqlClient::new(SacrumConfig::new(
        world.sacrum_url.clone(),
        world.sacrum_token.clone(),
        String::new(),
    ))
    .execute(
        vertebrae_sacrum_client::queries::projects::CREATE_PROJECT,
        json!({
            "name": slug, "slug": slug, "codexInstalled": true, "claudeInstalled": true
        }),
        "createProject",
    )
    .await
    .expect("create foreign project");
    world.created_project_ids.push(foreign.id.clone());
    world
        .fixture_ids
        .insert("FOREIGN_PROJECT".into(), foreign.id.clone());
    add_task(world, &foreign.id, "FOREIGN", &[SECRET]).await;
    world
        .fixture_ids
        .insert("MISSING".into(), uuid::Uuid::new_v4().to_string());
}

#[given("named artifacts on those tasks and on both projects")]
async fn named_artifacts(world: &mut DaemonWorld) {
    let project = id(world, "PROJECT");
    let me = id(world, "SELF");
    let plan = add_artifact(world, &project, ("task", &me), Some("plan"), PLAN_BODY).await;
    world.fixture_ids.insert("PLAN".into(), plan);
    for (name, body) in [
        ("data", DATA_BODY),
        ("null", "null"),
        ("broken", r#"{"a": [1,}"#),
        ("huge", r#"{"n": 100000000000000000000}"#),
    ] {
        add_artifact(world, &project, ("task", &me), Some(name), body).await;
    }
    add_artifact(world, &project, ("task", &me), None, "unnamed").await;
    let child = id(world, "CHILD_A");
    add_artifact(
        world,
        &project,
        ("task", &child),
        Some("result"),
        "child result",
    )
    .await;
    add_artifact(
        world,
        &project,
        ("project", &project),
        Some("shared"),
        "project shared",
    )
    .await;

    let foreign_project = id(world, "FOREIGN_PROJECT");
    let foreign = id(world, "FOREIGN");
    let foreign_plan = add_artifact(
        world,
        &foreign_project,
        ("task", &foreign),
        Some("plan"),
        SECRET,
    )
    .await;
    world
        .fixture_ids
        .insert("FOREIGN_PLAN".into(), foreign_plan);
    add_artifact(
        world,
        &foreign_project,
        ("project", &foreign_project),
        Some("shared"),
        SECRET,
    )
    .await;
}

/// More artifacts than Sacrum returns in one page.
#[given(expr = "a task with {int} named artifacts")]
async fn many_artifacts(world: &mut DaemonWorld, count: usize) {
    let project = id(world, "PROJECT");
    let many = add_task(world, &project, "MANY", &["host-read-many"]).await;
    for index in 0..count {
        let name = format!("item-{index:02}");
        add_artifact(world, &project, ("task", &many), Some(&name), "item").await;
    }
}

/// A Rhai execute step running the docstring script, then finish, with
/// `SELF` assigned and ready to start. Execute output must be an object, so
/// the script's value is returned under `result`.
#[given("a Rhai step running:")]
async fn rhai_step(world: &mut DaemonWorld, step: &Step) {
    let script = substitute(world, docstring(step));
    let script =
        format!("let host_read_result = {{\n{script}\n}};\n#{{ result: host_read_result }}");
    let workflow_id = create_workflow(world).await;
    std::fs::create_dir_all(&world.capture_dir).expect("fixture script directory");
    let path = world.capture_dir.join("host_reads.rhai");
    std::fs::write(&path, &script).expect("write host-read script");
    let flag = format!("@{}", path.display());
    let reads = create_execute_step(
        world,
        &workflow_id,
        "reads",
        0,
        &flag,
        json!({"type": "object"}),
    )
    .await;
    let finish = create_step(world, &workflow_id, "finish", "finish", 1, Value::Null).await;
    connect(world, &reads, &finish).await;
    world.step_id = Some(reads);

    let task_id = id(world, "SELF");
    vtb_ok(
        world,
        "workflow assign (host reads)",
        &["workflow", "assign", &task_id, &workflow_id],
    )
    .await;
    world.task_id = Some(task_id);
}

#[then("the script returns:")]
async fn script_returns(world: &mut DaemonWorld, step: &Step) {
    let expected = substitute(world, docstring(step));
    let expected: Value = serde_json::from_str(&expected)
        .unwrap_or_else(|error| panic!("expected result is not JSON ({error}): {expected}"));
    let execution = world
        .last_execution
        .as_ref()
        .expect("no execution observed");
    let output = execution.output.as_deref().expect("execute output");
    assert!(
        !output.contains(SECRET),
        "another project's data leaked: {output}"
    );
    let output: Value = serde_json::from_str(output).expect("execute output JSON");
    assert_eq!(output["result"], expected);
}

#[then(expr = "the execution failed with a {string} error from {string}")]
async fn failed_with(world: &mut DaemonWorld, kind: String, function: String) {
    let execution = world
        .last_execution
        .as_ref()
        .expect("no execution observed");
    let output = execution.output.as_deref().unwrap_or_default();
    assert!(
        output.contains(&kind) && output.contains(&function),
        "expected a {kind} error from {function}: {output}"
    );
}
