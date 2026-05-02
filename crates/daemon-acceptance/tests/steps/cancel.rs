use std::time::{Duration, Instant};

use cucumber::when;

use crate::DaemonWorld;

const IN_PROGRESS_TIMEOUT: Duration = Duration::from_secs(15);
const EXECUTION_APPEARS_TIMEOUT: Duration = Duration::from_secs(10);

#[when("Sacrum broadcasts cancel_step for the running execution")]
pub async fn broadcast_cancel_step(world: &mut DaemonWorld) {
    let execution_id = world.execution_id.as_ref().expect("execution_id").clone();

    // Sacrum only allows cancellation from `pending`/`in_progress`. Wait until
    // the daemon has acknowledged run_step and moved the execution past the
    // initial `entered` state.
    world
        .poll_execution(
            &execution_id,
            &["in_progress", "pending"],
            IN_PROGRESS_TIMEOUT,
        )
        .await
        .expect("execution never reached in_progress before cancel");

    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();
    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::CANCEL_STEP_EXECUTION,
        &[vertebrae_sacrum_client::queries::executions::EXECUTION_FIELDS],
    );
    let _: serde_json::Value = client
        .execute(
            &query,
            serde_json::json!({ "step_execution_id": execution_id }),
            "cancel_step_execution",
        )
        .await
        .expect("cancel_step_execution mutation failed");
}

#[when("I orchestrate the task")]
pub async fn orchestrate_task(world: &mut DaemonWorld) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();

    let _: serde_json::Value = client
        .execute(
            vertebrae_sacrum_client::queries::executions::ORCHESTRATE_TASK,
            serde_json::json!({ "task_id": &task_id }),
            "orchestrate_task",
        )
        .await
        .expect("orchestrate_task mutation failed");

    // The orchestrator FSM creates the step_execution asynchronously; poll
    // until one exists so the subsequent stop step can cancel it.
    let deadline = Instant::now() + EXECUTION_APPEARS_TIMEOUT;
    loop {
        if let Ok(id) = world.latest_execution_id(&task_id).await {
            world.execution_id = Some(id);
            return;
        }
        if Instant::now() >= deadline {
            panic!(
                "no step_execution appeared within {EXECUTION_APPEARS_TIMEOUT:?} after orchestrate_task"
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[when("Sacrum receives stop_orchestrator for the task")]
pub async fn stop_orchestrator_for_task(world: &mut DaemonWorld) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    let execution_id = world.execution_id.as_ref().expect("execution_id").clone();

    // stop_orchestrator only succeeds while the execution is in
    // pending/in_progress; wait until the daemon has acknowledged the
    // orchestrator's run_step before we cancel.
    world
        .poll_execution(
            &execution_id,
            &["in_progress", "pending"],
            IN_PROGRESS_TIMEOUT,
        )
        .await
        .expect("execution never reached in_progress before stop_orchestrator");

    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not configured")
        .clone();

    let _: serde_json::Value = client
        .execute(
            vertebrae_sacrum_client::queries::executions::STOP_ORCHESTRATOR,
            serde_json::json!({ "task_id": &task_id }),
            "stop_orchestrator",
        )
        .await
        .expect("stop_orchestrator mutation failed");
}
