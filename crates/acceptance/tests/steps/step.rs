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

fn workflow_id(world: &SmokeWorld) -> String {
    world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone()
}

/// If the last command succeeded, extract the step ID from stdout and store it.
fn store_step_id_if_created(world: &mut SmokeWorld, name: &str) {
    if world.last_exit_code == 0 {
        if let Some(id) = extract_step_id(&world.last_stdout) {
            world.stored_ids.insert(format!("step:{name}"), id);
        }
    }
}

/// Find a step by name in the JSON array returned by `vtb --json step list <wf-id>`.
async fn get_step_json(world: &mut SmokeWorld, step_name: &str) -> Option<serde_json::Value> {
    let wf_id = workflow_id(world);
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
    let wf_id = workflow_id(world);
    world
        .run_vtb(&["step", "add", &name, "--workflow", &wf_id])
        .await;
    store_step_id_if_created(world, &name);
}

#[when(expr = "I add a step {string} to the workflow with flag {string} and value {string}")]
async fn when_add_step_with_flag(
    world: &mut SmokeWorld,
    name: String,
    flag: String,
    value: String,
) {
    let wf_id = workflow_id(world);
    world
        .run_vtb(&["step", "add", &name, "--workflow", &wf_id, &flag, &value])
        .await;
    store_step_id_if_created(world, &name);
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
    let wf_id = workflow_id(world);
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
    store_step_id_if_created(world, &name);
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
    let wf_id = workflow_id(world);
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
    store_step_id_if_created(world, &name);
}

/// Tests that invalid JSON produces a clear error message.
#[when(expr = "I add a step {string} to the workflow with invalid --agent-config JSON")]
async fn when_add_step_with_invalid_agent_config(world: &mut SmokeWorld, name: String) {
    let wf_id = workflow_id(world);
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

/// Create a step with --step-type and --output-schema flags.
/// The output schema JSON is built internally to avoid Gherkin escaping.
/// Route steps require the routing contract schema; other types use an arbitrary test schema.
#[when(
    expr = "I add a step {string} to the workflow with --step-type {string} and --output-schema"
)]
async fn when_add_step_with_step_type_and_output_schema(
    world: &mut SmokeWorld,
    name: String,
    step_type: String,
) {
    let schema = if step_type == "route" {
        r#"{"type":"object","properties":{"transition_to":{"type":"string","format":"uuid"},"transition_type":{"type":"string","enum":["intra_workflow","inter_workflow"]}},"required":["transition_to","transition_type"],"additionalProperties":false}"#
    } else {
        r#"{"type":"object","properties":{"score":{"type":"number"}}}"#
    };
    let wf_id = workflow_id(world);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--step-type",
            &step_type,
            "--output-schema",
            schema,
        ])
        .await;
    store_step_id_if_created(world, &name);
}

/// Create a route step with an invalid (non-routing-contract) output schema.
#[when(expr = "I add a route step {string} to the workflow with an invalid --output-schema")]
async fn when_add_route_step_with_invalid_output_schema(world: &mut SmokeWorld, name: String) {
    let invalid_schema = r#"{"type":"object","properties":{"score":{"type":"number"}}}"#;
    let wf_id = workflow_id(world);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--step-type",
            "route",
            "--output-schema",
            invalid_schema,
        ])
        .await;
    store_step_id_if_created(world, &name);
}

/// The canonical with-handoff routing contract schema (must match
/// `StepType::routing_contract_schema()` and Sacrum's
/// `routing_contract_schema/0`).
const WITH_HANDOFF_ROUTING_SCHEMA: &str = r#"{"type":"object","properties":{"transition_to":{"type":"string","format":"uuid"},"transition_type":{"type":"string","enum":["intra_workflow","inter_workflow"]},"handoff":{"type":"object"}},"required":["transition_to","transition_type"],"additionalProperties":false}"#;

/// Create a route step with the with-handoff routing contract schema.
#[when(expr = "I add a route step {string} to the workflow with the with-handoff schema")]
async fn when_add_route_step_with_handoff_schema(world: &mut SmokeWorld, name: String) {
    let wf_id = workflow_id(world);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--step-type",
            "route",
            "--output-schema",
            WITH_HANDOFF_ROUTING_SCHEMA,
        ])
        .await;
    store_step_id_if_created(world, &name);
}

/// Update an existing route step to use the with-handoff schema.
#[when(expr = "I update the route step {string} to use the with-handoff schema")]
async fn when_update_route_step_to_with_handoff(world: &mut SmokeWorld, name: String) {
    let step_id = world
        .stored_ids
        .get(&format!("step:{}", name))
        .cloned()
        .unwrap_or_else(|| panic!("no stored ID for step '{}'", name));
    world
        .run_vtb(&[
            "step",
            "update",
            &step_id,
            "--output-schema",
            WITH_HANDOFF_ROUTING_SCHEMA,
        ])
        .await;
}

/// Update a step with a flag that takes no value (e.g. --clear-output-schema)
#[when(expr = "I update the step {string} in the workflow with flag {string} and no value")]
async fn when_update_step_with_flag_no_value(world: &mut SmokeWorld, name: String, flag: String) {
    let step_id = world
        .stored_ids
        .get(&format!("step:{}", name))
        .cloned()
        .unwrap_or_else(|| panic!("no stored ID for step '{}'", name));
    world.run_vtb(&["step", "update", &step_id, &flag]).await;
}

/// Show a specific step by name (looks up the stored step ID)
#[when(expr = "I show the step {string}")]
async fn when_show_step(world: &mut SmokeWorld, name: String) {
    let step_id = world
        .stored_ids
        .get(&format!("step:{}", name))
        .cloned()
        .unwrap_or_else(|| panic!("no stored ID for step '{}'", name));
    world.run_vtb(&["step", "show", &step_id]).await;
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

#[then(expr = "the step {string} in the workflow should have step_type {string}")]
async fn then_step_should_have_step_type(
    world: &mut SmokeWorld,
    step_name: String,
    expected: String,
) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    let actual = json["step_type"].as_str().unwrap_or("execute");
    assert_eq!(
        actual, expected,
        "step '{}' step_type mismatch: expected '{}', got '{}'\nJSON: {}",
        step_name, expected, actual, json
    );
}

#[then(expr = "the step {string} in the workflow should have an output_schema")]
async fn then_step_should_have_output_schema(world: &mut SmokeWorld, step_name: String) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    let schema = &json["output_schema"];
    assert!(
        !schema.is_null(),
        "step '{}' expected output_schema to be present, but it was null\nJSON: {}",
        step_name,
        json
    );
}

#[then(
    expr = "the step {string} in the workflow should have a handoff property in its output_schema"
)]
async fn then_step_output_schema_should_contain_handoff(world: &mut SmokeWorld, step_name: String) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    let schema = &json["output_schema"];
    assert!(
        schema
            .get("properties")
            .and_then(|p| p.get("handoff"))
            .is_some(),
        "step '{}' output_schema should include a handoff property, got: {}",
        step_name,
        schema
    );
}

#[then(expr = "the step {string} in the workflow should not have an output_schema")]
async fn then_step_should_not_have_output_schema(world: &mut SmokeWorld, step_name: String) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    let schema = &json["output_schema"];
    assert!(
        schema.is_null(),
        "step '{}' expected output_schema to be null, but got: {}\nJSON: {}",
        step_name,
        schema,
        json
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
