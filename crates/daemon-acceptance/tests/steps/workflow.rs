use cucumber::given;

use crate::DaemonWorld;

#[given("a workflow with one execute step")]
pub async fn given_workflow_with_one_execute_step(world: &mut DaemonWorld) {
    create_workflow_and_step(world, None).await;
}

#[given("a workflow with one execute step using openai")]
pub async fn given_workflow_with_codex_step(world: &mut DaemonWorld) {
    create_workflow_and_step(world, None).await;
    update_current_step_openai(world, "gpt-5", None).await;
    world.assert_vtb_ok("step update --provider openai");
}

#[given(expr = "a workflow with one execute step using openai and reasoning effort {string}")]
pub async fn given_workflow_with_codex_step_and_reasoning_effort(
    world: &mut DaemonWorld,
    reasoning_effort: String,
) {
    create_workflow_and_step(world, None).await;
    update_current_step_openai(world, "gpt-5.5", Some(&reasoning_effort)).await;
    world.assert_vtb_ok("step update --provider openai --reasoning-effort");
}

#[given(
    expr = "a workflow with one execute step using openai, speed tier {string}, personality {string}, and verbosity {string}"
)]
pub async fn given_workflow_with_codex_step_and_model_settings(
    world: &mut DaemonWorld,
    speed_tier: String,
    personality: String,
    verbosity: String,
) {
    create_workflow_and_step(world, None).await;
    let step_id = world.step_id.as_ref().expect("step not created").clone();
    world
        .run_vtb(&[
            "step",
            "update",
            &step_id,
            "--provider",
            "openai",
            "--model",
            "gpt-5.5",
            "--speed-tier",
            &speed_tier,
            "--personality",
            &personality,
            "--verbosity",
            &verbosity,
        ])
        .await;
    world.assert_vtb_ok("step update --model-settings");
}

#[given(
    expr = "a workflow with one execute step using anthropic, speed tier {string}, and personality {string}"
)]
pub async fn given_workflow_with_claude_step_and_model_settings(
    world: &mut DaemonWorld,
    speed_tier: String,
    personality: String,
) {
    create_workflow_and_step(world, None).await;
    let step_id = world.step_id.as_ref().expect("step not created").clone();
    world
        .run_vtb(&[
            "step",
            "update",
            &step_id,
            "--provider",
            "anthropic",
            "--model",
            "claude-sonnet-4-6",
            "--speed-tier",
            &speed_tier,
            "--personality",
            &personality,
        ])
        .await;
    world.assert_vtb_ok("step update --model-settings");
}

#[given(
    expr = "a workflow with one execute step using openai, codex model provider {string}, and model {string}"
)]
pub async fn given_workflow_with_codex_step_model_provider_and_model(
    world: &mut DaemonWorld,
    codex_model_provider: String,
    model: String,
) {
    create_workflow_and_step(world, None).await;
    update_current_step_openai_with_codex_model_provider(
        world,
        &model,
        &codex_model_provider,
        None,
    )
    .await;
    world.assert_vtb_ok("step update --provider openai --codex-model-provider");
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

#[given(expr = "the step is configured with persistence logical name {string}")]
pub async fn given_step_persistence_options(world: &mut DaemonWorld, logical_name: String) {
    let step_id = world.step_id.as_ref().expect("step not created").clone();
    let persistence = format!(r#"{{"artifact":{{"logical_name":"{}"}}}}"#, logical_name);
    world
        .run_vtb(&[
            "step",
            "update",
            &step_id,
            "--persistence-options",
            &persistence,
        ])
        .await;
    world.assert_vtb_ok("step update --persistence-options");
}

#[given(expr = "the task has an existing artifact named {string}")]
pub async fn given_task_existing_artifact(world: &mut DaemonWorld, logical_name: String) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    world
        .run_vtb(&[
            "artifact",
            "add",
            "existing.json",
            "--body",
            r#"{"answer":"old"}"#,
            "--subject-type",
            "task",
            "--subject-id",
            &task_id,
            "--logical-name",
            &logical_name,
        ])
        .await;
    world.assert_vtb_ok("artifact add existing task artifact");
}

#[given("a workflow with one execute step using openai and an output schema")]
pub async fn given_workflow_with_codex_schema_step(world: &mut DaemonWorld) {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "verdict": { "type": "string" },
            "score": { "type": "number" }
        },
        "required": ["verdict", "score"],
        "additionalProperties": false
    });
    create_workflow_and_step(world, Some(schema.to_string())).await;
    update_current_step_openai(world, "gpt-5", None).await;
    world.assert_vtb_ok("step update --provider openai");
}

async fn update_current_step_openai(
    world: &mut DaemonWorld,
    model: &str,
    reasoning_effort: Option<&str>,
) {
    let step_id = world.step_id.as_ref().expect("step not created").clone();
    let mut args = vec![
        "step",
        "update",
        step_id.as_str(),
        "--provider",
        "openai",
        "--model",
        model,
    ];
    if let Some(reasoning_effort) = reasoning_effort {
        args.push("--reasoning-effort");
        args.push(reasoning_effort);
    }
    world.run_vtb(&args).await;
}

async fn update_current_step_openai_with_codex_model_provider(
    world: &mut DaemonWorld,
    model: &str,
    codex_model_provider: &str,
    reasoning_effort: Option<&str>,
) {
    let step_id = world.step_id.as_ref().expect("step not created").clone();
    let mut args = vec![
        "step",
        "update",
        step_id.as_str(),
        "--provider",
        "openai",
        "--codex-model-provider",
        codex_model_provider,
        "--model",
        model,
    ];
    if let Some(reasoning_effort) = reasoning_effort {
        args.push("--reasoning-effort");
        args.push(reasoning_effort);
    }
    world.run_vtb(&args).await;
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
        .run_vtb(&[
            "workflow",
            "add",
            &wf_name,
            "--step",
            "run:claude-sonnet-4-6",
            "--step",
            "finish:claude-sonnet-4-6",
        ])
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

    let finish_step_id = arr
        .iter()
        .find(|v| v["name"].as_str() == Some("finish"))
        .unwrap_or_else(|| panic!("step 'finish' not found in list: {arr:?}"))["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Execution completion transitions into the explicit finish step.
    world
        .run_vtb(&["step", "update", &finish_step_id, "--step-type", "finish"])
        .await;
    world.assert_vtb_ok("step update --step-type finish");

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
