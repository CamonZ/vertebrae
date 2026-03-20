use cucumber::{given, when};
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

use crate::SmokeWorld;

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
    let mut args: Vec<&str> = vec!["workflow", "add", &name];
    let steps: Vec<String> = steps_str
        .split(", ")
        .map(|s| s.trim().to_string())
        .collect();
    let step_args: Vec<String> = steps
        .iter()
        .flat_map(|s| vec!["--step".to_string(), format!("{}:default", s)])
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

    // Set up linear transitions: each step transitions to the next, last step is final
    let wf_id_short = &wf_id[..8];

    // List steps for this workflow
    let json = world
        .run_vtb_json(&["step", "list", wf_id_short])
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
    let step_ids: Vec<(String, String)> = ordered
        .iter()
        .map(|(id, name, _)| (id.clone(), name.clone()))
        .collect();

    // Add transitions: each step -> next step
    for i in 0..step_ids.len() - 1 {
        let from_id = &step_ids[i].0;
        let to_id = &step_ids[i + 1].0;
        let from_short = &from_id[..8];
        let to_short = &to_id[..8];
        world
            .run_vtb(&[
                "workflow",
                "transition",
                "add",
                wf_id_short,
                from_short,
                to_short,
            ])
            .await;
        assert_eq!(
            world.last_exit_code, 0,
            "failed to add transition from {} to {}: {}{}",
            from_short, to_short, world.last_stdout, world.last_stderr
        );
    }

    // Mark last step as final
    let last_id = &step_ids.last().unwrap().0;
    let last_short = &last_id[..8];
    world
        .run_vtb(&["step", "update", last_short, "--is-final", "true"])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to mark last step as final: {}{}",
        world.last_stdout, world.last_stderr
    );

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
    let wf_short = &wf_id[..8];
    world
        .run_vtb(&["workflow", "assign", &task_id, wf_short])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "failed to assign workflow: {}{}",
        world.last_stdout, world.last_stderr
    );
    world.lifecycle_task_id = Some(task_id);
}

#[given(expr = "I create a task with:")]
async fn given_create_task_with_table(world: &mut SmokeWorld, step: &cucumber::gherkin::Step) {
    crate::steps::task::do_create_task(world, step).await;
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
