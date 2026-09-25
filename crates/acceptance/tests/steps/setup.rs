use cucumber::{given, when};
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

use crate::SmokeWorld;

struct WorkflowFixtureStep {
    name: String,
    step_type: Option<String>,
}

#[given("a configured Sacrum client")]
async fn configured_client(world: &mut SmokeWorld) {
    let api_token = std::env::var("VTB_TOKEN").expect("VTB_TOKEN must be set for acceptance tests");
    let base_url = std::env::var("VTB_URL").unwrap_or_else(|_| "http://localhost:4000".to_string());

    // Create a unique project for this scenario
    let slug = format!("test-{}", uuid::Uuid::new_v4());
    let name = slug.clone();

    let config = SacrumConfig::new(base_url.clone(), api_token.clone(), String::new());
    let client = GraphqlClient::new(config);

    let project: vertebrae_sacrum_client::ProjectResponse = client
        .execute(
            vertebrae_sacrum_client::queries::projects::CREATE_PROJECT,
            serde_json::json!({ "name": name, "slug": slug }),
            "create_project",
        )
        .await
        .expect("failed to create test project");

    let project_id = project.id;
    world.track_project(project_id.clone());
    world
        .stored_ids
        .insert("project_id".to_string(), project_id.clone());

    // Re-create the client with the actual project ID for cleanup
    let config_with_project =
        SacrumConfig::new(base_url.clone(), api_token.clone(), project_id.clone());
    world.graphql_client = Some(GraphqlClient::new(config_with_project));

    // Set environment variables for vtb CLI
    world.env.insert("VTB_TOKEN".to_string(), api_token);
    world.env.insert("VTB_URL".to_string(), base_url);
    world.env.insert("VTB_PROJECT_ID".to_string(), project_id);

    // Find the vtb binary
    let vtb_binary = std::env::var("VTB_BINARY").unwrap_or_else(|_| {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let workspace_root = std::path::Path::new(manifest_dir)
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        workspace_root
            .join("target")
            .join("debug")
            .join("vtb")
            .to_string_lossy()
            .to_string()
    });
    world.vtb_binary = std::path::PathBuf::from(vtb_binary);
}

#[given(expr = "I store the task ID as {string}")]
async fn store_task_id(world: &mut SmokeWorld, name: String) {
    let task_id = world.task_id.as_ref().expect("no task ID to store").clone();
    world.stored_ids.insert(name, task_id);
}

#[given(expr = "a workflow {string} with steps {string}")]
async fn given_workflow_with_steps(world: &mut SmokeWorld, name: String, steps_str: String) {
    let step_specs: Vec<WorkflowFixtureStep> = steps_str
        .split(',')
        .map(|raw| {
            let raw = raw.trim();
            let (name, step_type) = raw
                .split_once(':')
                .map(|(name, step_type)| (name.trim(), Some(step_type.trim().to_string())))
                .unwrap_or((raw, None));
            assert!(
                !name.is_empty(),
                "workflow fixture step name cannot be empty"
            );
            if let Some(step_type) = &step_type {
                assert!(
                    !step_type.is_empty(),
                    "workflow fixture step type cannot be empty for '{}'",
                    name
                );
            }
            WorkflowFixtureStep {
                name: name.to_string(),
                step_type,
            }
        })
        .collect();

    // A step's type is fixed at creation, so `workflow add` creates the
    // leading llm_inference steps and each typed step is added afterwards.
    let is_typed = |spec: &WorkflowFixtureStep| {
        spec.step_type
            .as_deref()
            .is_some_and(|step_type| step_type != "llm_inference")
    };
    let untyped_count = step_specs.iter().take_while(|spec| !is_typed(spec)).count();
    assert!(
        step_specs[untyped_count..].iter().all(is_typed),
        "typed workflow fixture steps must follow the llm_inference steps"
    );

    let mut args: Vec<&str> = vec!["workflow", "add", &name];
    let step_args: Vec<String> = step_specs[..untyped_count]
        .iter()
        .flat_map(|spec| vec!["--step".to_string(), format!("{}:default", spec.name)])
        .collect();
    let step_refs: Vec<&str> = step_args.iter().map(|s| s.as_str()).collect();
    args.extend_from_slice(&step_refs);

    world.run_vtb(&args).await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to create workflow: {}{}",
        world.last_stdout, world.last_stderr
    );

    // Extract workflow ID from output: "Created workflow: <uuid>"
    let stdout = world.last_stdout.trim();
    let wf_id = if let Some(rest) = stdout.strip_prefix("Created workflow: ") {
        rest.trim().to_string()
    } else {
        panic!("unexpected workflow create output: {}", stdout);
    };

    // List steps to resolve the created step IDs.
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

    // Store each step's ID under "step:<name>" so scenarios can reference them
    for (id, step_name, _) in &ordered {
        world
            .stored_ids
            .insert(format!("step:{}", step_name), id.clone());
    }

    // Create typed steps last-to-first so each can link to its successor.
    let mut next_id: Option<String> = None;
    for (index, spec) in step_specs.iter().enumerate().skip(untyped_count).rev() {
        let step_type = spec.step_type.as_deref().expect("typed fixture step");
        let order = index.to_string();
        let mut add_args = vec![
            "step",
            "add",
            spec.name.as_str(),
            "--workflow",
            wf_id.as_str(),
            "--step-type",
            step_type,
            "--order",
            order.as_str(),
        ];
        if let Some(next_id) = &next_id {
            add_args.extend(["--transition-to", next_id.as_str()]);
        }
        world.run_vtb(&add_args).await;
        assert_eq!(
            world.last_exit_code, 0,
            "failed to add {} step '{}': {}{}",
            step_type, spec.name, world.last_stdout, world.last_stderr
        );
        let step_id = world
            .last_stdout
            .trim()
            .strip_prefix("Created step: ")
            .unwrap_or_else(|| panic!("unexpected step add output: {}", world.last_stdout))
            .trim()
            .to_string();
        world
            .stored_ids
            .insert(format!("step:{}", spec.name), step_id.clone());
        next_id = Some(step_id);
    }

    if let (Some(first_typed_id), Some(last_untyped)) = (
        &next_id,
        untyped_count.checked_sub(1).map(|i| &step_specs[i]),
    ) {
        let last_untyped_id = world.stored_ids[&format!("step:{}", last_untyped.name)].clone();
        world
            .run_vtb(&[
                "step",
                "update",
                &last_untyped_id,
                "--transition-to",
                first_typed_id,
            ])
            .await;
        assert_eq!(
            world.last_exit_code, 0,
            "failed to link '{}' to the typed fixture steps: {}{}",
            last_untyped.name, world.last_stdout, world.last_stderr
        );
    }

    world.track_workflow(wf_id);
}

#[given("I assign the workflow to the task")]
async fn given_assign_workflow_to_task(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let wf_id = world
        .workflow_id
        .as_ref()
        .expect("no workflow ID stored")
        .clone();
    world
        .run_vtb(&["workflow", "assign", &task_id, &wf_id])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to assign workflow: {}{}",
        world.last_stdout, world.last_stderr
    );
    // Workflow execution requires a daemon joined to this scenario's project.
    // Start it after assignment so ordinary CLI scenarios do not pay for a
    // daemon, while concurrent execution scenarios remain isolated.
    let project_id = world.env["VTB_PROJECT_ID"].clone();
    world.start_daemon(&project_id).await;
    world.lifecycle_task_id = Some(task_id);
}

#[given(expr = "I create a task with:")]
async fn given_create_task_with_table(world: &mut SmokeWorld, step: &cucumber::gherkin::Step) {
    crate::steps::task::do_create_task(world, step).await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to create fixture task: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[given(expr = "I run depend {string} --on {string}")]
async fn given_run_depend(world: &mut SmokeWorld, task_ref: String, blocker_ref: String) {
    crate::steps::dependencies::do_run_depend(world, task_ref, blocker_ref).await;
}

#[given(expr = "I archive the task")]
async fn given_archive_current_task(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    world.run_vtb(&["archive", &task_id]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to archive task: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[given(expr = "I archive task {string}")]
async fn given_archive_task_by_ref(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    world.run_vtb(&["archive", &task_id]).await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to archive task: {}{}",
        world.last_stdout, world.last_stderr
    );
}

#[given(expr = "I run depend {string} --on the lifecycle task")]
async fn given_run_depend_on_lifecycle_task(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let lifecycle_id = world
        .lifecycle_task_id
        .as_ref()
        .expect("no lifecycle task ID stored")
        .clone();
    world
        .run_vtb(&["depend", &task_id, "--on", &lifecycle_id])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to create dependency on lifecycle task: {}{}",
        world.last_stdout, world.last_stderr
    );
}

// When variants that share Given step patterns
#[when(expr = "I store the task ID as {string}")]
async fn when_store_task_id(world: &mut SmokeWorld, name: String) {
    let task_id = world.task_id.as_ref().expect("no task ID to store").clone();
    world.stored_ids.insert(name, task_id);
}
