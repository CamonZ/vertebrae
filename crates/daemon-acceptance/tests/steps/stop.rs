use std::time::{Duration, Instant};

use cucumber::{given, then, when};
use vertebrae_sacrum_client::{TaskResponse, TaskRunResponse};

use crate::DaemonWorld;

const STOP_RUN_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

#[given("a workflow with a stop step and a finish continuation")]
pub async fn stop_boundary_workflow(world: &mut DaemonWorld) {
    let workflow_name = format!("daemon-acc-stop-wf-{}", uuid::Uuid::new_v4().simple());
    world
        .run_vtb(&[
            "workflow",
            "add",
            &workflow_name,
            "--step",
            "pause:claude-sonnet-4-6",
            "--step",
            "finish:claude-sonnet-4-6",
        ])
        .await;
    world.assert_vtb_ok("workflow add (stop boundary)");

    let workflow_id = world
        .last_stdout
        .trim()
        .strip_prefix("Created workflow: ")
        .unwrap_or_else(|| panic!("unexpected workflow output: {}", world.last_stdout))
        .trim()
        .to_string();
    world.workflow_id = Some(workflow_id.clone());
    world.created_workflow_ids.push(workflow_id.clone());

    let pause_id = step_id_by_name(world, &workflow_id, "pause").await;
    let finish_id = step_id_by_name(world, &workflow_id, "finish").await;

    world
        .run_vtb(&[
            "step",
            "update",
            &pause_id,
            "--step-type",
            "stop",
            "--transition-to",
            &finish_id,
        ])
        .await;
    world.assert_vtb_ok("step update (stop boundary)");

    world
        .run_vtb(&["step", "update", &finish_id, "--step-type", "finish"])
        .await;
    world.assert_vtb_ok("step update (finish continuation)");

    world.step_id = Some(pause_id);
}

#[when("I start a TaskRun for the task")]
pub async fn start_task_run(world: &mut DaemonWorld) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    world.run_vtb(&["start-taskrun", &task_id]).await;
    world.assert_vtb_ok("start-taskrun");
}

#[when(expr = "I wait for the TaskRun to reach status {string} with outcome {string}")]
pub async fn wait_for_task_run_outcome(
    world: &mut DaemonWorld,
    expected_status: String,
    expected_outcome: String,
) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    let deadline = Instant::now() + STOP_RUN_TIMEOUT;
    loop {
        let runs = list_task_runs(world, &task_id).await;
        if runs.iter().any(|run| {
            run.status.eq_ignore_ascii_case(&expected_status)
                && run.outcome_kind.as_deref() == Some(expected_outcome.as_str())
        }) {
            return;
        }
        if Instant::now() >= deadline {
            panic!(
                "timed out waiting for TaskRun status={expected_status:?}, outcome={expected_outcome:?}; runs={runs:?}"
            );
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[when(expr = "I wait for the TaskRun to reach status {string}")]
pub async fn wait_for_task_run_status(world: &mut DaemonWorld, expected_status: String) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    let deadline = Instant::now() + STOP_RUN_TIMEOUT;
    loop {
        let runs = list_task_runs(world, &task_id).await;
        if runs
            .iter()
            .any(|run| run.status.eq_ignore_ascii_case(&expected_status))
        {
            return;
        }
        if Instant::now() >= deadline {
            panic!("timed out waiting for TaskRun status={expected_status:?}; runs={runs:?}");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[then("the stop boundary was never dispatched to the daemon")]
pub async fn stop_boundary_was_not_dispatched(world: &mut DaemonWorld) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::LIST_EXECUTIONS,
        &[vertebrae_sacrum_client::queries::executions::EXECUTION_FIELDS],
    );
    let executions: Vec<serde_json::Value> = client
        .execute(
            &query,
            serde_json::json!({ "task_id": task_id }),
            "step_executions",
        )
        .await
        .expect("step_executions query failed");
    assert!(
        executions.is_empty(),
        "stop boundary should not create a step execution: {executions:?}"
    );
}

#[then("the task is still incomplete")]
pub async fn task_is_still_incomplete(world: &mut DaemonWorld) {
    let task = get_task(world).await;
    assert!(
        task.completed_at.is_none(),
        "stop boundary completed the task unexpectedly: {task:?}"
    );
}

#[then("the task is complete")]
pub async fn task_is_complete(world: &mut DaemonWorld) {
    let deadline = Instant::now() + STOP_RUN_TIMEOUT;
    loop {
        let task = get_task(world).await;
        if task.completed_at.is_some() {
            return;
        }
        if Instant::now() >= deadline {
            panic!("task did not complete after the continuation run: {task:?}");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn step_id_by_name(world: &mut DaemonWorld, workflow_id: &str, name: &str) -> String {
    let steps = world
        .run_vtb_json(&["step", "list", workflow_id])
        .await
        .unwrap_or_else(|| panic!("step list failed: {}", world.last_stderr));
    steps
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|step| step["name"].as_str() == Some(name))
        })
        .and_then(|step| step["id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| panic!("step {name:?} not found in workflow: {steps}"))
}

async fn list_task_runs(world: &DaemonWorld, task_id: &str) -> Vec<TaskRunResponse> {
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::TASK_RUNS,
        &[vertebrae_sacrum_client::queries::executions::TASK_RUN_FIELDS],
    );
    client
        .execute(
            &query,
            serde_json::json!({ "task_id": task_id }),
            "task_runs",
        )
        .await
        .expect("task_runs query failed")
}

async fn get_task(world: &DaemonWorld) -> TaskResponse {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::tasks::GET_TASK_SUMMARY,
        &[vertebrae_sacrum_client::queries::tasks::TASK_SUMMARY_FIELDS],
    );
    client
        .execute(&query, serde_json::json!({ "id": task_id }), "task")
        .await
        .expect("task query failed")
}
