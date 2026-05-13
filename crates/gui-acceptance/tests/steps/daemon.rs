use cucumber::{given, when};
use serde_json::json;
use std::time::{Duration, Instant};

use crate::GuiWorld;

#[given("the daemon is running for the project")]
#[when("the daemon is running for the project")]
pub async fn daemon_is_running(world: &mut GuiWorld) {
    world.start_daemon().await;
}

#[given(expr = "the step prompt is set to a mock that sleeps {int} milliseconds")]
#[when(expr = "the step prompt is set to a mock that sleeps {int} milliseconds")]
pub async fn set_sleep_prompt(world: &mut GuiWorld, ms: u64) {
    let envelope = world
        .mock_response("sleep")
        .with_exit_code(0)
        .with_delay_ms(ms)
        .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-gui"}"#)
        .build()
        .expect("MockResponse envelope builds");

    update_step_prompt(world, &envelope).await;
}

#[given(expr = "the step prompt is set to a mock that emits an assistant message {string}")]
#[when(expr = "the step prompt is set to a mock that emits an assistant message {string}")]
pub async fn set_assistant_message_prompt(world: &mut GuiWorld, message: String) {
    // Three stream-json lines that the daemon parses into 3 SessionLog rows:
    // an init system event, an assistant message carrying `message`, and a
    // success result terminator. The assistant text is what UnifiedChatView
    // renders, so the scenario can assert on the exact string.
    //
    // Lines are hand-rolled with trailing spaces inside nested objects so the
    // serialized JSON never contains `}}` — MockResponse rejects that sequence
    // because the envelope flows through Liquid templating downstream.
    let escaped = serde_json::to_string(&message).expect("escape message text");
    let assistant_line = format!(
        r#"{{"type":"assistant","session_id":"sess-gui-content","message":{{"role":"assistant","content":[{{"type":"text","text":{escaped} }}] }} }}"#
    );
    let result_line = r#"{"type":"result","subtype":"success","cost_usd":0.0,"duration_ms":1.0,"is_error":false,"result":"done","session_id":"sess-gui-content","usage":{"input_tokens":1,"output_tokens":1} }"#;
    let envelope = world
        .mock_response("assistant-message")
        .with_exit_code(0)
        .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-gui-content"}"#)
        .with_stdout_line(assistant_line)
        .with_stdout_line(result_line)
        .build()
        .expect("MockResponse envelope builds");

    update_step_prompt(world, &envelope).await;
}

async fn update_step_prompt(world: &mut GuiWorld, envelope: &str) {
    let step_id = world.step_id.as_ref().expect("no step ID stored").clone();
    world
        .run_vtb(&["step", "update", &step_id, "--prompt", envelope])
        .await;
    assert_eq!(
        world.last_exit_code, 0,
        "vtb step update --prompt failed:\nstdout: {}\nstderr: {}",
        world.last_stdout, world.last_stderr
    );
}

#[when("I navigate to the traces page for the created task")]
pub async fn navigate_to_traces_for_task(world: &mut GuiWorld) {
    // Direct /traces/:taskId navigation. Skips the pipeline → tasks tab → click
    // chain so this scenario doesn't depend on the (currently broken) realtime
    // pipeline-count badge.
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let path = format!("/traces/{task_id}");
    crate::steps::navigation::navigate_to(world, &path, "nav-traces-task").await;
}

#[when(expr = "I wait up to {int} seconds for the task to have a completed execution")]
pub async fn wait_for_completed_execution(world: &mut GuiWorld, timeout_secs: u64) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql_client not initialized")
        .clone();

    let query = vertebrae_sacrum_client::client::with_fragments(
        vertebrae_sacrum_client::queries::executions::LIST_EXECUTIONS,
        &[vertebrae_sacrum_client::queries::executions::EXECUTION_FIELDS],
    );
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        let resp: serde_json::Value = client
            .execute(&query, json!({ "task_id": task_id }), "step_executions")
            .await
            .expect("step_executions query failed");
        if resp
            .as_array()
            .and_then(|arr| {
                arr.iter()
                    .find(|e| e.get("status").and_then(|s| s.as_str()) == Some("completed"))
            })
            .is_some()
        {
            return;
        }
        if Instant::now() >= deadline {
            panic!("no completed execution for task {task_id} within {timeout_secs}s: {resp}");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
