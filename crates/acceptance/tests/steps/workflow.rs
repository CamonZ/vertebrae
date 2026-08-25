use cucumber::{given, then, when};

use crate::SmokeWorld;

fn extract_workflow_id(stdout: &str) -> String {
    stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow create output: {}", stdout))
        .trim()
        .to_string()
}

#[given(expr = "a second workflow {string} with steps {string}")]
async fn given_second_workflow_with_steps(world: &mut SmokeWorld, name: String, steps_str: String) {
    let mut args: Vec<String> = vec!["workflow".to_string(), "add".to_string(), name];
    let steps: Vec<String> = steps_str
        .split(", ")
        .map(|s| s.trim().to_string())
        .collect();
    for s in &steps {
        args.push("--step".to_string());
        args.push(format!("{}:default", s));
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to create second workflow: {}{}",
        world.last_stdout, world.last_stderr
    );

    // Extract workflow ID from output
    let stdout = world.last_stdout.trim();
    let wf_id = if let Some(rest) = stdout.strip_prefix("Created workflow: ") {
        rest.trim().to_string()
    } else {
        panic!("unexpected workflow create output: {}", stdout);
    };

    world.created_workflow_ids.push(wf_id.clone());
    world
        .stored_ids
        .insert("second_workflow_id".to_string(), wf_id);
}

#[when(expr = "I transition the task to step {string}")]
async fn when_transition_task_to_step(world: &mut SmokeWorld, step_name: String) {
    let task_id = world
        .task_id
        .as_ref()
        .or(world.lifecycle_task_id.as_ref())
        .expect("no task ID stored")
        .clone();
    world
        .run_vtb(&["transition-to", &task_id, &step_name])
        .await;
}

#[when(expr = "I transition the task to step {string} with --skip-validation")]
async fn when_transition_task_skip_validation(world: &mut SmokeWorld, step_name: String) {
    let task_id = world
        .task_id
        .as_ref()
        .or(world.lifecycle_task_id.as_ref())
        .expect("no task ID stored")
        .clone();
    world
        .run_vtb(&["transition-to", &task_id, &step_name, "--skip-validation"])
        .await;
}

#[when(expr = "I transition the task to step {string} of {string}")]
async fn when_transition_task_of_workflow(
    world: &mut SmokeWorld,
    step_name: String,
    _wf_name: String,
) {
    let task_id = world
        .task_id
        .as_ref()
        .or(world.lifecycle_task_id.as_ref())
        .expect("no task ID stored")
        .clone();
    // The transition-to command resolves by step name within the task's current workflow.
    // For cross-workflow transitions, the CLI resolves by step name across all workflows.
    world
        .run_vtb(&["transition-to", &task_id, &step_name])
        .await;
}

#[when(expr = "I transition the lifecycle task through to step {string} with --skip-validation")]
async fn when_transition_lifecycle_task_through(world: &mut SmokeWorld, target_step_name: String) {
    let task_id = world
        .lifecycle_task_id
        .as_ref()
        .expect("no lifecycle task ID stored")
        .clone();
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    // Get the step list to find the path from current to target (use full UUID — step commands don't resolve short IDs)
    let json = world
        .run_vtb_json(&["step", "list", &wf_id])
        .await
        .expect("failed to list workflow steps as JSON");

    let steps_arr = json.as_array().expect("expected array of steps");
    let mut ordered: Vec<(String, String, u64)> = steps_arr
        .iter()
        .map(|s| {
            (
                s["id"].as_str().unwrap().to_string(),
                s["name"].as_str().unwrap().to_string(),
                s["order"].as_u64().unwrap_or(0),
            )
        })
        .collect();
    ordered.sort_by_key(|(_, _, order)| *order);

    // Get current step via show --json
    let task_json = world
        .run_vtb_json(&["show", &task_id])
        .await
        .expect("failed to show task as JSON");

    let current_step_name = task_json
        .get("step_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let current_idx = ordered
        .iter()
        .position(|(_, name, _)| name == current_step_name)
        .unwrap_or(0);

    let target_idx = ordered
        .iter()
        .position(|(_, name, _)| *name == target_step_name)
        .unwrap_or_else(|| panic!("step '{}' not found in workflow", target_step_name));

    // Walk through each step from current+1 to target
    for i in (current_idx + 1)..=target_idx {
        let step_name = &ordered[i].1;
        world
            .run_vtb(&["transition-to", &task_id, step_name, "--skip-validation"])
            .await;
        if world.last_exit_code != 0 {
            return;
        }
    }
}

// ============================================================================
// Workflow creation with table
// ============================================================================

pub async fn do_create_workflow(
    world: &mut SmokeWorld,
    name: &str,
    step: &cucumber::gherkin::Step,
) {
    let table = step.table.as_ref().expect("expected a data table");

    let mut args: Vec<String> = vec!["workflow".to_string(), "add".to_string(), name.to_string()];

    // Default to one step if none provided in the table
    let mut has_steps = false;

    for row in &table.rows {
        let key = row[0].as_str();
        let value = world.resolve_vars(row[1].as_str());
        match key {
            "description" => {
                args.push("--description".to_string());
                args.push(value);
            }
            "steps" => {
                has_steps = true;
                for s in value.split(", ") {
                    args.push("--step".to_string());
                    args.push(format!("{}:default", s.trim()));
                }
            }
            "kanban_column" => {
                args.push("--kanban-column".to_string());
                args.push(value);
            }
            "factory_name" => {
                args.push("--factory-name".to_string());
                args.push(value);
            }
            "default" => {
                if value == "true" {
                    args.push("--default".to_string());
                }
            }
            other => panic!("unsupported table key in create workflow: '{}'", other),
        }
    }

    if !has_steps {
        args.push("--step".to_string());
        args.push("default_step:default".to_string());
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    world.run_vtb(&arg_refs).await;

    if world.last_exit_code == 0 {
        let wf_id = extract_workflow_id(&world.last_stdout);
        world.track_workflow(wf_id);
    }
}

#[when(expr = "I create a workflow {string} with:")]
async fn when_create_workflow_with_table(
    world: &mut SmokeWorld,
    name: String,
    step: &cucumber::gherkin::Step,
) {
    do_create_workflow(world, &name, step).await;
}

#[given(expr = "I create a workflow {string} with:")]
async fn given_create_workflow_with_table(
    world: &mut SmokeWorld,
    name: String,
    step: &cucumber::gherkin::Step,
) {
    do_create_workflow(world, &name, step).await;
}

// ============================================================================
// Workflow field assertions (via --json)
// ============================================================================

async fn get_workflow_json(world: &mut SmokeWorld) -> serde_json::Value {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world
        .run_vtb_json(&["workflow", "show", &wf_id])
        .await
        .unwrap_or_else(|| {
            panic!(
                "failed to show workflow as JSON: {}{}",
                world.last_stdout, world.last_stderr
            )
        })
}

#[then(expr = "the workflow {word} should be {string}")]
async fn workflow_field_should_be(world: &mut SmokeWorld, field: String, expected: String) {
    let json = get_workflow_json(world).await;

    let actual = json[&field].as_str().unwrap_or("");
    assert_eq!(
        actual,
        expected,
        "workflow {} mismatch: expected '{}', got '{}'\nJSON: {}",
        field,
        expected,
        actual,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the workflow {word} should be true")]
async fn workflow_bool_field_should_be_true(world: &mut SmokeWorld, field: String) {
    let json = get_workflow_json(world).await;
    let val = &json[&field];
    assert_eq!(
        val.as_bool(),
        Some(true),
        "expected workflow {} to be true, got: {}\nJSON: {}",
        field,
        val,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the workflow {word} should be false")]
async fn workflow_bool_field_should_be_false(world: &mut SmokeWorld, field: String) {
    let json = get_workflow_json(world).await;
    let val = &json[&field];
    assert_eq!(
        val.as_bool(),
        Some(false),
        "expected workflow {} to be false, got: {}\nJSON: {}",
        field,
        val,
        serde_json::to_string_pretty(&json).unwrap_or_default()
    );
}

#[then(expr = "the workflow JSON steps should include ids for {string}")]
async fn workflow_json_steps_should_include_ids(world: &mut SmokeWorld, step_names: String) {
    let json = get_workflow_json(world).await;
    let steps = json["steps"].as_array().unwrap_or_else(|| {
        panic!(
            "expected workflow steps to be an array\nJSON: {}",
            serde_json::to_string_pretty(&json).unwrap_or_default()
        )
    });

    for expected_name in step_names.split(", ").map(str::trim) {
        let step = steps
            .iter()
            .find(|step| step["name"].as_str() == Some(expected_name))
            .unwrap_or_else(|| {
                panic!(
                    "expected workflow JSON to include step '{}'\nJSON: {}",
                    expected_name,
                    serde_json::to_string_pretty(&json).unwrap_or_default()
                )
            });

        let id = step["id"].as_str().unwrap_or("");
        assert!(
            !id.is_empty(),
            "expected workflow JSON step '{}' to include a non-empty id\nStep: {}",
            expected_name,
            serde_json::to_string_pretty(step).unwrap_or_default()
        );
    }
}

// ============================================================================
// Workflow update steps
// ============================================================================

#[when(expr = "I update the workflow with {word}")]
async fn when_update_workflow_with_flag(world: &mut SmokeWorld, flag: String) {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world.run_vtb(&["workflow", "update", &wf_id, &flag]).await;
}

#[when(expr = "I update the workflow with --factory-name {string}")]
async fn when_update_workflow_factory_name(world: &mut SmokeWorld, factory_name: String) {
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world
        .run_vtb(&[
            "workflow",
            "update",
            &wf_id,
            "--factory-name",
            &factory_name,
        ])
        .await;
}

#[then(expr = "the workflow {word} should be empty")]
async fn workflow_field_should_be_empty(world: &mut SmokeWorld, field: String) {
    let json = get_workflow_json(world).await;

    let val = &json[&field];
    assert!(
        val.is_null() || val.as_str() == Some(""),
        "expected workflow {} to be empty, got: {}",
        field,
        val
    );
}
