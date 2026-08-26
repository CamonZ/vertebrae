use cucumber::{given, when};

use crate::GuiWorld;

fn artifact_fixture(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "markdown" => (
            "# Artifact Markdown Heading\n\nRendered **markdown** body.",
            r#"{"version":1,"content_kind":"document","format":"markdown","origin":"acceptance","presentation":"rendered","extensions":{}}"#,
        ),
        "json" => (
            r#"{"fixture":"Artifact JSON Value","count":2}"#,
            r#"{"version":1,"content_kind":"document","format":"json","origin":"acceptance","presentation":"rendered","extensions":{}}"#,
        ),
        "conversation" => (
            concat!(
                r#"{"version":1,"event_id":"turn","stream_id":"artifact","timestamp":"2026-08-02T00:00:00Z","type":"turn_input","data":{"provenance":"human","content":"Artifact conversation question"}}"#,
                "\n",
                r#"{"version":1,"event_id":"answer","stream_id":"artifact","timestamp":"2026-08-02T00:00:01Z","type":"text","data":{"text":"Artifact conversation answer"}}"#,
            ),
            r#"{"version":1,"content_kind":"conversation","format":"jsonl","origin":"acceptance","presentation":"raw","extensions":{}}"#,
        ),
        "malformed-json" => (
            "{not valid json}",
            r#"{"version":1,"content_kind":"document","format":"json","origin":"acceptance","presentation":"rendered","extensions":{}}"#,
        ),
        "unknown" => (
            "Unknown artifact raw payload",
            r#"{"version":1,"content_kind":"document","format":"yaml","origin":"acceptance","presentation":"rendered","extensions":{}}"#,
        ),
        other => panic!("unsupported artifact fixture kind '{other}'"),
    }
}

async fn create_artifact(
    world: &mut GuiWorld,
    filename: &str,
    kind: &str,
    task_id: Option<&str>,
    logical_name: Option<&str>,
) {
    let (body, metadata) = artifact_fixture(kind);
    let mut args = vec![
        "artifact",
        "add",
        filename,
        "--body",
        body,
        "--metadata",
        metadata,
    ];
    if let Some(task_id) = task_id {
        args.extend(["--subject-type", "task", "--subject-id", task_id]);
    }
    if let Some(logical_name) = logical_name {
        args.extend(["--logical-name", logical_name]);
    }
    world.run_vtb(&args).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb artifact add failed:\nstdout: {}\nstderr: {}",
        world.last_stdout, world.last_stderr
    );
    let id = world.extract_artifact_id_from_output().unwrap_or_else(|| {
        panic!(
            "failed to extract artifact ID from vtb artifact add output: {}",
            world.last_stdout
        )
    });
    world.track_artifact(id);
}

#[when(expr = "I create project artifact {string} of kind {string} via the CLI")]
async fn create_project_artifact_via_cli(world: &mut GuiWorld, filename: String, kind: String) {
    create_artifact(world, &filename, &kind, None, None).await;
}

#[when(
    expr = "I create project artifact {string} with logical name {string} of kind {string} via the CLI"
)]
async fn create_project_artifact_with_logical_name_via_cli(
    world: &mut GuiWorld,
    filename: String,
    logical_name: String,
    kind: String,
) {
    create_artifact(world, &filename, &kind, None, Some(&logical_name)).await;
}

#[when(expr = "I create a task artifact {string} of kind {string} via the CLI")]
async fn create_task_artifact_via_cli(world: &mut GuiWorld, filename: String, kind: String) {
    let task_id = world
        .task_id
        .as_deref()
        .expect("no task ID stored")
        .to_owned();
    create_artifact(world, &filename, &kind, Some(&task_id), None).await;
}

#[when("I delete the current artifact via the CLI")]
async fn delete_current_artifact_via_cli(world: &mut GuiWorld) {
    let artifact_id = world
        .artifact_id
        .as_deref()
        .expect("no artifact ID stored")
        .to_owned();
    world
        .run_vtb(&["artifact", "delete", &artifact_id, "--force"])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb artifact delete failed:\nstdout: {}\nstderr: {}",
        world.last_stdout, world.last_stderr
    );
    world.artifact_id = None;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build and run `vtb workflow add` from a Gherkin data table.
///
/// Recognised keys: `name`, `kanban_column`, `factory_name`, `description`.
async fn do_create_workflow(world: &mut GuiWorld, step: &cucumber::gherkin::Step) {
    let table = step
        .table
        .as_ref()
        .expect("expected a data table for workflow creation");

    let mut name = String::new();
    let mut extra: Vec<String> = Vec::new();

    for row in &table.rows {
        let key = row[0].trim();
        let value = row[1].trim();
        match key {
            "name" => name = value.to_string(),
            "kanban_column" => {
                extra.push("--kanban-column".to_string());
                extra.push(value.to_string());
            }
            "factory_name" => {
                extra.push("--factory-name".to_string());
                extra.push(value.to_string());
            }
            "description" => {
                extra.push("--description".to_string());
                extra.push(value.to_string());
            }
            other => panic!("unsupported table key in create workflow: '{}'", other),
        }
    }

    assert!(!name.is_empty(), "workflow table must include a 'name' row");

    let mut args: Vec<String> = vec!["workflow".to_string(), "add".to_string(), name.clone()];
    args.extend(extra);

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;

    assert_eq!(
        world.last_exit_code, 0,
        "vtb workflow add failed:\nstdout: {}\nstderr: {}",
        world.last_stdout, world.last_stderr
    );

    if let Some(id) = world.extract_workflow_id_from_output() {
        world.track_workflow(id, Some(name));
    } else {
        panic!(
            "failed to extract workflow ID from vtb output: {}",
            world.last_stdout
        );
    }
}

/// Build and run `vtb add` from a Gherkin data table.
///
/// Recognised keys: `title`, `level`, `description`, `workflow` (looked up
/// by name from previously created workflows in this scenario).
async fn do_create_task(world: &mut GuiWorld, step: &cucumber::gherkin::Step) {
    let table = step
        .table
        .as_ref()
        .expect("expected a data table for task creation");

    let mut title = String::new();
    let mut extra: Vec<String> = Vec::new();

    for row in &table.rows {
        let key = row[0].trim();
        let value = row[1].trim();
        match key {
            "title" => title = value.to_string(),
            "level" => {
                extra.push("--level".to_string());
                extra.push(value.to_string());
            }
            "description" => {
                extra.push("--description".to_string());
                extra.push(value.to_string());
            }
            "workflow" => {
                // Look up the workflow ID by the human-readable name.
                let workflow_id = world
                    .workflow_id_by_name(value)
                    .unwrap_or_else(|| {
                        panic!(
                            "no workflow ID found for '{}' — create the workflow first",
                            value
                        )
                    })
                    .clone();
                extra.push("--workflow".to_string());
                extra.push(workflow_id);
            }
            other => panic!("unsupported table key in create task: '{}'", other),
        }
    }

    assert!(!title.is_empty(), "task table must include a 'title' row");

    let mut args: Vec<String> = vec!["add".to_string(), title];
    args.extend(extra);

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;

    assert_eq!(
        world.last_exit_code, 0,
        "vtb add failed:\nstdout: {}\nstderr: {}",
        world.last_stdout, world.last_stderr
    );

    if let Some(id) = world.extract_task_id_from_output() {
        world.track_task(id);
    } else {
        panic!(
            "failed to extract task ID from vtb output: {}",
            world.last_stdout
        );
    }
}

// ---------------------------------------------------------------------------
// Workflow steps
// ---------------------------------------------------------------------------

#[when("I create a workflow with:")]
async fn when_create_workflow_with_table(world: &mut GuiWorld, step: &cucumber::gherkin::Step) {
    do_create_workflow(world, step).await;
}

#[given("I create a workflow with:")]
async fn given_create_workflow_with_table(world: &mut GuiWorld, step: &cucumber::gherkin::Step) {
    do_create_workflow(world, step).await;
}

#[when(expr = "I create a workflow {string} via the CLI")]
async fn create_workflow_via_cli(world: &mut GuiWorld, name: String) {
    world.run_vtb(&["workflow", "add", &name]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb workflow add failed: {}{}",
        world.last_stdout, world.last_stderr
    );

    if let Some(id) = world.extract_workflow_id_from_output() {
        world.track_workflow(id, Some(name));
    } else {
        panic!(
            "failed to extract workflow ID from vtb workflow add output: {}",
            world.last_stdout
        );
    }
}

#[given(expr = "a workflow {string} exists via the CLI")]
async fn workflow_exists_via_cli(world: &mut GuiWorld, name: String) {
    world.run_vtb(&["workflow", "add", &name]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb workflow add failed: {}{}",
        world.last_stdout, world.last_stderr
    );

    if let Some(id) = world.extract_workflow_id_from_output() {
        world.track_workflow(id, Some(name));
    } else {
        panic!(
            "failed to extract workflow ID from vtb workflow add output: {}",
            world.last_stdout
        );
    }
}

// ---------------------------------------------------------------------------
// Task steps
// ---------------------------------------------------------------------------

#[when("I create a task with:")]
async fn when_create_task_with_table(world: &mut GuiWorld, step: &cucumber::gherkin::Step) {
    do_create_task(world, step).await;
}

#[given("I create a task with:")]
async fn given_create_task_with_table(world: &mut GuiWorld, step: &cucumber::gherkin::Step) {
    do_create_task(world, step).await;
}

#[when(expr = "I create a task {string} via the CLI")]
async fn create_task_via_cli(world: &mut GuiWorld, title: String) {
    world.run_vtb(&["add", &title]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb add failed: {}{}",
        world.last_stdout, world.last_stderr
    );

    if let Some(id) = world.extract_task_id_from_output() {
        world.track_task(id);
    } else {
        panic!(
            "failed to extract task ID from vtb add output: {}",
            world.last_stdout
        );
    }
}

#[when(expr = "I update the task title to {string} via the CLI")]
async fn update_task_title_via_cli(world: &mut GuiWorld, new_title: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world
        .run_vtb(&["update", &task_id, "--title", &new_title])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb update failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[given(expr = "I transition the task to step {string} via the CLI")]
#[when(expr = "I transition the task to step {string} via the CLI")]
async fn transition_task_to_step_via_cli(world: &mut GuiWorld, step_name: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world
        .run_vtb(&["transition-to", &task_id, &step_name, "--skip-validation"])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb transition-to failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[when("I delete the task via the CLI")]
async fn delete_task_via_cli(world: &mut GuiWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["delete", &task_id, "--force"]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb delete failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    world.created_task_ids.retain(|id| id != &task_id);
}

#[when("I start the task workflow via the CLI")]
async fn start_task_workflow_via_cli(world: &mut GuiWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["start-taskrun", &task_id]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb start-taskrun failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[when("I stop the task workflow via the CLI")]
async fn stop_task_workflow_via_cli(world: &mut GuiWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["stop-taskrun", &task_id]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb stop-taskrun failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

// ---------------------------------------------------------------------------
// Step steps
// ---------------------------------------------------------------------------

/// Build and run `vtb step add` for a named workflow.
async fn do_create_step_in_workflow(
    world: &mut GuiWorld,
    step_name: String,
    workflow_name: String,
) {
    let workflow_id = world
        .workflow_id_by_name(&workflow_name)
        .unwrap_or_else(|| {
            panic!(
                "no workflow ID found for '{}' — create it first",
                workflow_name
            )
        })
        .clone();

    world
        .run_vtb(&["step", "add", "--workflow", &workflow_id, &step_name])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step add failed: {}{}",
        world.last_stdout, world.last_stderr
    );

    if let Some(id) = world.extract_step_id_from_output() {
        world.track_step(id);
    }
}

#[given(expr = "I create a step {string} in the workflow {string} via the CLI")]
async fn given_create_step_in_workflow_via_cli(
    world: &mut GuiWorld,
    step_name: String,
    workflow_name: String,
) {
    do_create_step_in_workflow(world, step_name, workflow_name).await;
}

#[when(expr = "I create a step {string} in the workflow {string} via the CLI")]
async fn create_step_in_workflow_via_cli(
    world: &mut GuiWorld,
    step_name: String,
    workflow_name: String,
) {
    do_create_step_in_workflow(world, step_name, workflow_name).await;
}

#[given(expr = "I create a step {string} with type {string} in the workflow {string} via the CLI")]
async fn given_create_step_with_type_in_workflow_via_cli(
    world: &mut GuiWorld,
    step_name: String,
    step_type: String,
    workflow_name: String,
) {
    let workflow_id = world
        .workflow_id_by_name(&workflow_name)
        .unwrap_or_else(|| {
            panic!(
                "no workflow ID found for '{}' — create it first",
                workflow_name
            )
        })
        .clone();

    world
        .run_vtb(&[
            "step",
            "add",
            "--workflow",
            &workflow_id,
            "--step-type",
            &step_type,
            &step_name,
        ])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step add failed: {}{}",
        world.last_stdout, world.last_stderr
    );

    if let Some(id) = world.extract_step_id_from_output() {
        world.track_step(id);
    }
}

#[when(expr = "I update the step name to {string} via the CLI")]
async fn update_step_name_via_cli(world: &mut GuiWorld, new_name: String) {
    let step_id = world.step_id.as_ref().expect("no step ID stored").clone();
    world
        .run_vtb(&["step", "update", &step_id, "--name", &new_name])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step update failed: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[when("I delete the step via the CLI")]
async fn delete_step_via_cli(world: &mut GuiWorld) {
    let step_id = world.step_id.as_ref().expect("no step ID stored").clone();
    world
        .run_vtb(&["step", "delete", &step_id, "--force"])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step delete failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    world.created_step_ids.retain(|id| id != &step_id);
    world.step_id = None;
}
