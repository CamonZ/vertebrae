use cucumber::{then, when};

use crate::SmokeWorld;

// ============================================================================
// Helpers
// ============================================================================

fn extract_step_id(stdout: &str) -> Option<String> {
    stdout
        .trim()
        .strip_prefix("Created step: ")
        .map(|s| s.trim().to_string())
}

/// Find a step by name in the JSON array returned by `vtb --json step list <wf-id>`.
async fn get_step_json(world: &mut SmokeWorld, step_name: &str) -> Option<serde_json::Value> {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    let json = world.run_vtb_json(&["step", "list", &wf_id]).await?;
    json.as_array()?
        .iter()
        .find(|s| s["name"].as_str() == Some(step_name))
        .cloned()
}

// ============================================================================
// When steps
// ============================================================================

#[when(expr = "I add a step {string} to the workflow")]
async fn when_add_step_to_workflow(world: &mut SmokeWorld, name: String) {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world
        .run_vtb(&["step", "add", &name, "--workflow", &wf_id])
        .await;
    if world.last_exit_code == 0 {
        if let Some(id) = extract_step_id(&world.last_stdout) {
            world.stored_ids.insert(format!("step:{}", name), id);
        }
    }
}

#[when(expr = "I add a step {string} to the workflow with flag {string} and value {string}")]
async fn when_add_step_with_flag(
    world: &mut SmokeWorld,
    name: String,
    flag: String,
    value: String,
) {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world
        .run_vtb(&["step", "add", &name, "--workflow", &wf_id, &flag, &value])
        .await;
    if world.last_exit_code == 0 {
        if let Some(id) = extract_step_id(&world.last_stdout) {
            world.stored_ids.insert(format!("step:{}", name), id);
        }
    }
}

/// Builds `--agent-config '{"model":"<model>"}' ` JSON internally to avoid
/// Gherkin string-escaping issues with nested double quotes.
#[when(expr = "I add a step {string} to the workflow with --agent-config model {string}")]
async fn when_add_step_with_agent_config_model(
    world: &mut SmokeWorld,
    name: String,
    model: String,
) {
    let json = format!(r#"{{"model":"{}"}}"#, model);
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--agent-config",
            &json,
        ])
        .await;
    if world.last_exit_code == 0 {
        if let Some(id) = extract_step_id(&world.last_stdout) {
            world.stored_ids.insert(format!("step:{}", name), id);
        }
    }
}

/// Tests that `--model` overrides the model field inside `--agent-config` JSON.
/// JSON is built internally to avoid Gherkin escaping issues.
#[when(
    expr = "I add a step {string} to the workflow with --agent-config model {string} and --model {string}"
)]
async fn when_add_step_with_agent_config_and_model_override(
    world: &mut SmokeWorld,
    name: String,
    config_model: String,
    override_model: String,
) {
    let json = format!(r#"{{"model":"{}"}}"#, config_model);
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--agent-config",
            &json,
            "--model",
            &override_model,
        ])
        .await;
    if world.last_exit_code == 0 {
        if let Some(id) = extract_step_id(&world.last_stdout) {
            world.stored_ids.insert(format!("step:{}", name), id);
        }
    }
}

/// Tests that invalid JSON produces a clear error message.
#[when(expr = "I add a step {string} to the workflow with invalid --agent-config JSON")]
async fn when_add_step_with_invalid_agent_config(world: &mut SmokeWorld, name: String) {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--agent-config",
            "{bad json}",
        ])
        .await;
}

#[when(expr = "I update the step {string} in the workflow with flag {string} and value {string}")]
async fn when_update_step_with_flag(
    world: &mut SmokeWorld,
    name: String,
    flag: String,
    value: String,
) {
    let step_id = world
        .stored_ids
        .get(&format!("step:{}", name))
        .cloned()
        .unwrap_or_else(|| panic!("no stored ID for step '{}'", name));
    world
        .run_vtb(&["step", "update", &step_id, &flag, &value])
        .await;
}

// ============================================================================
// Then steps
// ============================================================================

#[then(expr = "the step {string} in the workflow should have prompt {string}")]
async fn then_step_should_have_prompt(world: &mut SmokeWorld, step_name: String, expected: String) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    let actual = json["prompt"].as_str().unwrap_or("");
    assert_eq!(
        actual, expected,
        "step '{}' prompt mismatch: expected '{}', got '{}'\nJSON: {}",
        step_name, expected, actual, json
    );
}

#[then(expr = "the step {string} in the workflow should have eval_prompt {string}")]
async fn then_step_should_have_eval_prompt(
    world: &mut SmokeWorld,
    step_name: String,
    expected: String,
) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    let actual = json["eval_prompt"].as_str().unwrap_or("");
    assert_eq!(
        actual, expected,
        "step '{}' eval_prompt mismatch: expected '{}', got '{}'\nJSON: {}",
        step_name, expected, actual, json
    );
}

#[then(expr = "the step {string} in the workflow should have agent model {string}")]
async fn then_step_should_have_agent_model(
    world: &mut SmokeWorld,
    step_name: String,
    expected_model: String,
) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    let actual = json["agent_config"]["model"].as_str().unwrap_or("");
    assert_eq!(
        actual, expected_model,
        "step '{}' agent model mismatch: expected '{}', got '{}'\nJSON: {}",
        step_name, expected_model, actual, json
    );
}
