use std::time::Duration;

use cucumber::when;

use crate::DaemonWorld;

const IN_PROGRESS_TIMEOUT: Duration = Duration::from_secs(15);

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
