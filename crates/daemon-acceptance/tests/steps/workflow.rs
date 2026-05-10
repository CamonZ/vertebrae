use cucumber::given;

use crate::DaemonWorld;

#[given("a workflow with one execute step")]
pub async fn given_workflow_with_one_execute_step(world: &mut DaemonWorld) {
    create_workflow_and_step(world, None).await;
}

#[given("a workflow with one execute step using openai")]
pub async fn given_workflow_with_codex_step(world: &mut DaemonWorld) {
    create_workflow_and_step(world, None).await;
    let step_id = world.step_id.as_ref().expect("step not created").clone();
    world
        .run_vtb(&["step", "update", &step_id, "--provider", "openai"])
        .await;
    world.assert_vtb_ok("step update --provider openai");
}

#[given("a workflow with one execute step and an output schema")]
pub async fn given_workflow_with_schema(world: &mut DaemonWorld) {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "answer": { "type": "string" }
        },
        "required": ["answer"],
        "additionalProperties": false
    });
    create_workflow_and_step(world, Some(schema.to_string())).await;
}

#[given(expr = "the step is configured with agent_config {string}")]
pub async fn step_has_agent_config(world: &mut DaemonWorld, json: String) {
    let step_id = world.step_id.as_ref().expect("step not created").clone();
    world
        .run_vtb(&["step", "update", &step_id, "--agent-config", &json])
        .await;
    world.assert_vtb_ok("step update --agent-config");
}

#[given(expr = "the task has worktree {string}")]
pub async fn task_has_worktree(world: &mut DaemonWorld, path: String) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    world
        .run_vtb(&["update", &task_id, "--worktree", &path])
        .await;
    world.assert_vtb_ok("update --worktree");
}

async fn create_workflow_and_step(world: &mut DaemonWorld, output_schema: Option<String>) {
    let wf_name = format!("daemon-acc-wf-{}", uuid::Uuid::new_v4().simple());
    world
        .run_vtb(&["workflow", "add", &wf_name, "--step", "run:default"])
        .await;
    world.assert_vtb_ok("workflow add");
    let wf_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.workflow_id = Some(wf_id.clone());
    world.created_workflow_ids.push(wf_id.clone());

    let json = world
        .run_vtb_json(&["step", "list", &wf_id])
        .await
        .expect("step list JSON");
    let arr = json.as_array().expect("array");
    let step = arr
        .iter()
        .find(|v| v["name"].as_str() == Some("run"))
        .unwrap_or_else(|| panic!("step 'run' not found in list: {arr:?}"));
    let step_id = step["id"].as_str().unwrap().to_string();
    world.step_id = Some(step_id.clone());

    // Execution-complete transitions require the step to be marked final.
    world
        .run_vtb(&["step", "update", &step_id, "--final", "true"])
        .await;
    world.assert_vtb_ok("step update --final");

    if let Some(schema_json) = output_schema {
        world
            .run_vtb(&["step", "update", &step_id, "--output-schema", &schema_json])
            .await;
        world.assert_vtb_ok("step update --output-schema");
    }
}

#[given("a task assigned to the workflow")]
pub async fn given_task_assigned_to_workflow(world: &mut DaemonWorld) {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("workflow not created")
        .clone();

    world
        .run_vtb(&["add", "daemon-acc-task", "-d", "scripted task"])
        .await;
    world.assert_vtb_ok("task add");
    let task_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created task: ")
        .unwrap_or_else(|| panic!("unexpected task output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.task_id = Some(task_id.clone());
    world.created_task_ids.push(task_id.clone());

    world
        .run_vtb(&["workflow", "assign", &task_id, &wf_id])
        .await;
    world.assert_vtb_ok("workflow assign");
}
