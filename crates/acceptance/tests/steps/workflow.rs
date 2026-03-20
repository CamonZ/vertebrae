use cucumber::{given, when};

use crate::SmokeWorld;

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
        .insert("second_workflow_id".to_string(), wf_id[..8].to_string());
}

#[when(expr = "I transition the task to step {string}")]
async fn when_transition_task_to_step(world: &mut SmokeWorld, step_name: String) {
    let task_id = world
        .lifecycle_task_id
        .as_ref()
        .or(world.task_id.as_ref())
        .expect("no task ID stored")
        .clone();
    world
        .run_vtb(&["transition-to", &task_id, &step_name])
        .await;
}

#[when(expr = "I transition the task to step {string} with --skip-validation")]
async fn when_transition_task_skip_validation(world: &mut SmokeWorld, step_name: String) {
    let task_id = world
        .lifecycle_task_id
        .as_ref()
        .or(world.task_id.as_ref())
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
        .lifecycle_task_id
        .as_ref()
        .or(world.task_id.as_ref())
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
    let wf_short = &wf_id[..8];

    // Get the step list to find the path from current to target
    let json = world
        .run_vtb_json(&["step", "list", wf_short])
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
        .position(|(_, name, _)| name == target_step_name)
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
