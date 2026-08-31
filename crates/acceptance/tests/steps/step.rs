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

fn route_predecessor_schema() -> &'static str {
    r#"{"type":"object","properties":{"route":{"type":"object","properties":{"result":{"type":"string","enum":["approved","rejected"]},"handoff":{"type":"object","properties":{},"required":[],"additionalProperties":false}},"required":["result","handoff"],"additionalProperties":false}},"required":["route"],"additionalProperties":false}"#
}

fn route_config_for(target_id: &str) -> String {
    serde_json::json!({
        "version": 1,
        "match_policy": "exactly_one",
        "rules": [
            {
                "id": "approved",
                "when": {"ref": "previous_output.route.result", "op": "eq", "value": "approved"},
                "transition": {"type": "intra_workflow", "step_id": target_id}
            },
            {
                "id": "rejected",
                "when": {"ref": "previous_output.route.result", "op": "eq", "value": "rejected"},
                "transition": {"type": "intra_workflow", "step_id": target_id}
            }
        ]
    })
    .to_string()
}

fn replacement_route_config_for(target_id: &str) -> String {
    serde_json::json!({
        "version": 1,
        "match_policy": "exactly_one",
        "rules": [
            {
                "id": "approved-replacement",
                "when": {"ref": "previous_output.route.result", "op": "eq", "value": "approved"},
                "transition": {"type": "intra_workflow", "step_id": target_id},
                "handoff": {"decision": "{{ previous_output.route.result }}"}
            },
            {
                "id": "rejected-replacement",
                "when": {"ref": "previous_output.route.result", "op": "eq", "value": "rejected"},
                "transition": {"type": "intra_workflow", "step_id": target_id},
                "handoff": {"decision": "{{ previous_output.route.result }}"}
            }
        ]
    })
    .to_string()
}

fn invalid_route_config_for(target_id: &str) -> String {
    serde_json::json!({
        "version": 1,
        "match_policy": "exactly_one",
        "rules": [{
            "id": "invalid-reference",
            "when": {"ref": "task.title", "op": "eq", "value": "not-supported"},
            "transition": {"type": "intra_workflow", "step_id": target_id}
        }]
    })
    .to_string()
}

fn stored_step_id(world: &SmokeWorld, name: &str) -> String {
    world
        .stored_ids
        .get(&format!("step:{name}"))
        .cloned()
        .unwrap_or_else(|| panic!("no stored ID for step '{name}'"))
}

fn assert_command_succeeded(world: &SmokeWorld, action: &str) {
    assert_eq!(
        world.last_exit_code, 0,
        "failed to {action}: {}{}",
        world.last_stdout, world.last_stderr
    );
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

#[when(expr = "I add a stop step {string} to the workflow continuing to {string}")]
async fn when_add_stop_step_with_continuation(
    world: &mut SmokeWorld,
    name: String,
    target_name: String,
) {
    let wf_id = workflow_id(world);
    let target_id = get_step_json(world, &target_name)
        .await
        .and_then(|step| step["id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", target_name));
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--step-type",
            "stop",
            "--transition-to",
            &target_id,
        ])
        .await;
    store_step_id_if_created(world, &name);
}

#[when(
    expr = "I add a stop step {string} to the workflow with continuations {string} and {string}"
)]
async fn when_add_stop_step_with_two_continuations(
    world: &mut SmokeWorld,
    name: String,
    first_target_name: String,
    second_target_name: String,
) {
    let wf_id = workflow_id(world);
    let first_target_id = get_step_json(world, &first_target_name)
        .await
        .and_then(|step| step["id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", first_target_name));
    let second_target_id = get_step_json(world, &second_target_name)
        .await
        .and_then(|step| step["id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", second_target_name));
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--step-type",
            "stop",
            "--transition-to",
            &first_target_id,
            "--transition-to",
            &second_target_id,
        ])
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

#[when(expr = "I add a step {string} to the workflow with persistence logical name {string}")]
async fn when_add_step_with_persistence_name(
    world: &mut SmokeWorld,
    name: String,
    logical_name: String,
) {
    let wf_id = workflow_id(world);
    let schema =
        r#"{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}"#;
    let persistence = format!(r#"{{"artifact":{{"logical_name":"{}"}}}}"#, logical_name);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--output-schema",
            schema,
            "--persistence-options",
            &persistence,
        ])
        .await;
    store_step_id_if_created(world, &name);
}

#[when(expr = "I update the step {string} in the workflow with persistence logical name {string}")]
async fn when_update_step_with_persistence_name(
    world: &mut SmokeWorld,
    name: String,
    logical_name: String,
) {
    let step_id = world
        .stored_ids
        .get(&format!("step:{name}"))
        .cloned()
        .unwrap_or_else(|| panic!("no stored ID for step '{name}'"));
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
}

#[when(expr = "I add a step {string} to the workflow with persistence but no output schema")]
async fn when_add_step_with_persistence_without_schema(world: &mut SmokeWorld, name: String) {
    let wf_id = workflow_id(world);
    let persistence = r#"{"artifact":{"logical_name":"missing-schema"}}"#;
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--persistence-options",
            persistence,
        ])
        .await;
}

#[when(expr = "I add a step {string} to the workflow with an unknown persistence key")]
async fn when_add_step_with_unknown_persistence_key(world: &mut SmokeWorld, name: String) {
    let wf_id = workflow_id(world);
    let schema =
        r#"{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}"#;
    let persistence = r#"{"artifact":{"logical_name":"unknown-key"},"unknown":true}"#;
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--output-schema",
            schema,
            "--persistence-options",
            persistence,
        ])
        .await;
}

#[when(expr = "I add a step {string} to the workflow with a blank persistence logical name")]
async fn when_add_step_with_blank_persistence_name(world: &mut SmokeWorld, name: String) {
    let wf_id = workflow_id(world);
    let schema =
        r#"{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}"#;
    let persistence = r#"{"artifact":{"logical_name":""}}"#;
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--output-schema",
            schema,
            "--persistence-options",
            persistence,
        ])
        .await;
}

#[when(expr = "I add a step {string} to the workflow with an overlong persistence logical name")]
async fn when_add_step_with_overlong_persistence_name(world: &mut SmokeWorld, name: String) {
    let wf_id = workflow_id(world);
    let schema =
        r#"{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}"#;
    let logical_name = "x".repeat(256);
    let persistence = format!(r#"{{"artifact":{{"logical_name":"{}"}}}}"#, logical_name);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--output-schema",
            schema,
            "--persistence-options",
            &persistence,
        ])
        .await;
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

#[when(
    expr = "I add a step {string} to the workflow with provider {string}, model {string}, and reasoning effort {string}"
)]
async fn when_add_step_with_provider_model_reasoning_effort(
    world: &mut SmokeWorld,
    name: String,
    provider: String,
    model: String,
    reasoning_effort: String,
) {
    let wf_id = workflow_id(world);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--provider",
            &provider,
            "--model",
            &model,
            "--reasoning-effort",
            &reasoning_effort,
        ])
        .await;
    store_step_id_if_created(world, &name);
}

#[when(
    expr = "I add a step {string} to the workflow with provider {string}, codex model provider {string}, and model {string}"
)]
async fn when_add_step_with_provider_codex_model_provider_and_model(
    world: &mut SmokeWorld,
    name: String,
    provider: String,
    codex_model_provider: String,
    model: String,
) {
    let wf_id = workflow_id(world);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--provider",
            &provider,
            "--codex-model-provider",
            &codex_model_provider,
            "--model",
            &model,
        ])
        .await;
    store_step_id_if_created(world, &name);
}

#[when(expr = "I add a step {string} to the workflow with provider {string}, model {string}")]
async fn when_add_step_with_provider_and_model(
    world: &mut SmokeWorld,
    name: String,
    provider: String,
    model: String,
) {
    let wf_id = workflow_id(world);
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--provider",
            &provider,
            "--model",
            &model,
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

#[when(expr = "I update the step {string} to stop and continue to {string}")]
async fn when_update_step_to_stop_with_continuation(
    world: &mut SmokeWorld,
    name: String,
    target_name: String,
) {
    let step_id = world
        .stored_ids
        .get(&format!("step:{}", name))
        .cloned()
        .unwrap_or_else(|| panic!("no stored ID for step '{}'", name));
    let target_id = get_step_json(world, &target_name)
        .await
        .and_then(|step| step["id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", target_name));
    world
        .run_vtb(&[
            "step",
            "update",
            &step_id,
            "--step-type",
            "stop",
            "--transition-to",
            &target_id,
        ])
        .await;
}

#[when(
    expr = "I update the step {string} in the workflow with provider {string}, codex model provider {string}, and model {string}"
)]
async fn when_update_step_with_provider_codex_model_provider_and_model(
    world: &mut SmokeWorld,
    name: String,
    provider: String,
    codex_model_provider: String,
    model: String,
) {
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
            "--provider",
            &provider,
            "--codex-model-provider",
            &codex_model_provider,
            "--model",
            &model,
        ])
        .await;
}

/// Create a step with --step-type and --output-schema flags.
/// The output schema JSON is built internally to avoid Gherkin escaping.
#[when(
    expr = "I add a step {string} to the workflow with --step-type {string} and --output-schema"
)]
async fn when_add_step_with_step_type_and_output_schema(
    world: &mut SmokeWorld,
    name: String,
    step_type: String,
) {
    let schema = r#"{"type":"object","properties":{"score":{"type":"number"}}}"#;
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

#[when(expr = "I add and configure a deterministic route step {string} to the workflow")]
async fn when_add_and_configure_route_step(world: &mut SmokeWorld, name: String) {
    let wf_id = workflow_id(world);
    let done_id = stored_step_id(world, "done");
    world
        .run_vtb(&[
            "step",
            "add",
            &name,
            "--workflow",
            &wf_id,
            "--step-type",
            "route",
        ])
        .await;
    store_step_id_if_created(world, &name);

    assert_command_succeeded(world, "create the route draft");
    let route_id = stored_step_id(world, &name);
    let backlog_id = stored_step_id(world, "backlog");

    world
        .run_vtb(&[
            "step",
            "update",
            &backlog_id,
            "--output-schema",
            route_predecessor_schema(),
            "--transition-to",
            &route_id,
        ])
        .await;
    assert_command_succeeded(world, "configure the route predecessor");

    world
        .run_vtb(&["step", "update", &route_id, "--transition-to", &done_id])
        .await;
    assert_command_succeeded(world, "configure the route destination");

    let route_config = route_config_for(&done_id);
    world
        .run_vtb(&["step", "update", &route_id, "--route-config", &route_config])
        .await;
    assert_command_succeeded(world, "configure the deterministic route");
}

#[when(expr = "I replace the route config for step {string}")]
async fn when_replace_route_config(world: &mut SmokeWorld, name: String) {
    let route_id = stored_step_id(world, &name);
    let done_id = stored_step_id(world, "done");
    let route_config = replacement_route_config_for(&done_id);
    world
        .run_vtb(&["step", "update", &route_id, "--route-config", &route_config])
        .await;
}

#[when(expr = "I update the configured route step {string} with an invalid reference")]
async fn when_update_configured_route_with_invalid_reference(world: &mut SmokeWorld, name: String) {
    let route_id = stored_step_id(world, &name);
    let done_id = stored_step_id(world, "done");
    let route_config = invalid_route_config_for(&done_id);
    world
        .run_vtb(&["step", "update", &route_id, "--route-config", &route_config])
        .await;
}

#[when(expr = "I create a route step {string} with a retained prompt")]
async fn when_create_route_step_with_retained_prompt(world: &mut SmokeWorld, name: String) {
    let workflow_id = workflow_id(world);
    let client = world
        .graphql_client
        .as_ref()
        .expect("configured Sacrum client is required");
    let response: serde_json::Value = client
        .execute(
            r#"mutation CreateRetainedRoute($workflow_id: Uuid4!, $name: String!, $prompt: String!) {
                create_workflow_step(
                    workflow_id: $workflow_id,
                    name: $name,
                    prompt: $prompt,
                    step_type: "route",
                    step_order: 0
                ) { id }
            }"#,
            serde_json::json!({
                "workflow_id": workflow_id,
                "name": name,
                "prompt": "retained prompt"
            }),
            "create_workflow_step",
        )
        .await
        .expect("failed to create retained route prompt fixture");
    let step_id = response
        .get("id")
        .and_then(serde_json::Value::as_str)
        .expect("retained route fixture did not return a step ID")
        .to_string();
    world.stored_ids.insert(format!("step:{name}"), step_id);
}

#[when(expr = "I convert the configured route step {string} to execute and clear its route config")]
async fn when_convert_route_to_execute_with_clear(world: &mut SmokeWorld, name: String) {
    let route_id = stored_step_id(world, &name);
    world
        .run_vtb(&[
            "step",
            "update",
            &route_id,
            "--step-type",
            "execute",
            "--clear-route-config",
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

/// Show a specific step by name as JSON (looks up the stored step ID)
#[when(expr = "I show the step {string} as JSON")]
async fn when_show_step_as_json(world: &mut SmokeWorld, name: String) {
    let step_id = world
        .stored_ids
        .get(&format!("step:{}", name))
        .cloned()
        .unwrap_or_else(|| panic!("no stored ID for step '{}'", name));
    world.run_vtb(&["--json", "step", "show", &step_id]).await;
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

#[then(
    expr = "the step {string} in the workflow should have agent_config field {string} equal to {string}"
)]
async fn then_step_should_have_agent_config_field(
    world: &mut SmokeWorld,
    step_name: String,
    field: String,
    expected: String,
) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    let actual = json["agent_config"][&field].as_str().unwrap_or("");
    assert_eq!(
        actual, expected,
        "step '{}' agent_config.{} mismatch: expected '{}', got '{}'\nJSON: {}",
        step_name, field, expected, actual, json
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

#[then(expr = "the step show JSON should have step_type {string}")]
async fn then_step_show_json_should_have_step_type(world: &mut SmokeWorld, expected: String) {
    assert_eq!(
        world.last_exit_code, 0,
        "expected JSON step show command to succeed, but got exit {}.\nstdout: '{}'\nstderr: '{}'",
        world.last_exit_code, world.last_stdout, world.last_stderr
    );
    let json: serde_json::Value = serde_json::from_str(&world.last_stdout).unwrap_or_else(|err| {
        panic!(
            "failed to parse step show JSON: {err}\nstdout: {}",
            world.last_stdout
        )
    });
    let actual = json["step_type"].as_str().unwrap_or("");
    assert_eq!(
        actual, expected,
        "step show JSON step_type mismatch: expected '{}', got '{}'\nJSON: {}",
        expected, actual, json
    );
}

#[then(expr = "the step show JSON should have prompt {string}")]
async fn then_step_show_json_should_have_prompt(world: &mut SmokeWorld, expected: String) {
    assert_eq!(
        world.last_exit_code, 0,
        "step show JSON failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let json: serde_json::Value =
        serde_json::from_str(&world.last_stdout).expect("step show JSON should be valid JSON");
    assert_eq!(
        json["prompt"].as_str(),
        Some(expected.as_str()),
        "step show JSON prompt mismatch: {}",
        json
    );
}

#[then("the step show JSON should have null prompt")]
async fn then_step_show_json_should_have_null_prompt(world: &mut SmokeWorld) {
    assert_eq!(
        world.last_exit_code, 0,
        "step show JSON failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let json: serde_json::Value =
        serde_json::from_str(&world.last_stdout).expect("step show JSON should be valid JSON");
    assert!(
        json["prompt"].is_null(),
        "expected step show JSON prompt to be null, got {}",
        json["prompt"]
    );
}

#[then("the step show JSON should contain the deterministic route config")]
async fn then_step_show_json_should_contain_route_config(world: &mut SmokeWorld) {
    assert_eq!(
        world.last_exit_code, 0,
        "step show JSON failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let json: serde_json::Value =
        serde_json::from_str(&world.last_stdout).expect("step show JSON should be valid JSON");
    let done_id = stored_step_id(world, "done");
    let expected: serde_json::Value = serde_json::from_str(&route_config_for(&done_id))
        .expect("deterministic route fixture should be valid JSON");
    assert_eq!(json["route_config"], expected);
}

#[then("the step show JSON should contain the replacement route config")]
async fn then_step_show_json_should_contain_replacement_route_config(world: &mut SmokeWorld) {
    assert_eq!(
        world.last_exit_code, 0,
        "step show JSON failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let json: serde_json::Value =
        serde_json::from_str(&world.last_stdout).expect("step show JSON should be valid JSON");
    let done_id = stored_step_id(world, "done");
    let expected: serde_json::Value = serde_json::from_str(&replacement_route_config_for(&done_id))
        .expect("replacement route fixture should be valid JSON");
    assert_eq!(json["route_config"], expected);
}

#[then("the step show JSON should have null route_config")]
async fn then_step_show_json_should_have_null_route_config(world: &mut SmokeWorld) {
    assert_eq!(
        world.last_exit_code, 0,
        "step show JSON failed: {}{}",
        world.last_stdout, world.last_stderr
    );
    let json: serde_json::Value =
        serde_json::from_str(&world.last_stdout).expect("step show JSON should be valid JSON");
    assert!(
        json["route_config"].is_null(),
        "expected route_config to be null, got {}",
        json["route_config"]
    );
}

#[then(expr = "the step show JSON should have persistence logical name {string}")]
async fn then_step_show_json_should_have_persistence_name(
    world: &mut SmokeWorld,
    expected: String,
) {
    assert_eq!(
        world.last_exit_code, 0,
        "step show JSON failed: {}",
        world.last_stderr
    );
    let json: serde_json::Value =
        serde_json::from_str(&world.last_stdout).expect("step show JSON should be valid JSON");
    assert_eq!(
        json["persistence_options"]["artifact"]["logical_name"],
        expected
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

#[then(expr = "the step {string} in the workflow should have persistence logical name {string}")]
async fn then_step_should_have_persistence_name(
    world: &mut SmokeWorld,
    step_name: String,
    expected: String,
) {
    let json = get_step_json(world, &step_name)
        .await
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", step_name));
    assert_eq!(
        json["persistence_options"]["artifact"]["logical_name"], expected,
        "step '{}' persistence logical name mismatch: {}",
        step_name, json
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
