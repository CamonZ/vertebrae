use std::time::Duration;

use cucumber::when;

use crate::DaemonWorld;

const DEFAULT_POLL_TIMEOUT: Duration = Duration::from_secs(30);

#[when("the mock is scripted to succeed with full metrics")]
pub async fn script_success_with_metrics(world: &mut DaemonWorld) {
    let result_line = r#"{"type":"result","subtype":"success","cost_usd":0.00425,"duration_ms":1234.0,"is_error":false,"num_turns":2,"result":"computed-answer","session_id":"sess-1","total_cost_usd":0.00425,"usage":{"input_tokens":1500,"output_tokens":200} }"#;
    let builder = world
        .mock_response("happy")
        .with_exit_code(0)
        .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-1"}"#)
        .with_stdout_line(result_line);
    set_prompt(world, builder).await;
}

#[when("the mock is scripted to exit non-zero with an error message")]
pub async fn script_failure(world: &mut DaemonWorld) {
    let builder = world
        .mock_response("failure")
        .with_exit_code(17)
        .with_stderr_line("mock-claude: scripted-failure");
    set_prompt(world, builder).await;
}

#[when("the mock is scripted to succeed without a result line")]
pub async fn script_success_without_result(world: &mut DaemonWorld) {
    let builder = world
        .mock_response("no-result")
        .with_exit_code(0)
        .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-nr"}"#);
    set_prompt(world, builder).await;
}

#[when("the mock is scripted to emit three stream-json lines")]
pub async fn script_three_lines(world: &mut DaemonWorld) {
    let result_line = r#"{"type":"result","subtype":"success","cost_usd":0.0,"duration_ms":1.0,"is_error":false,"result":"done","session_id":"sess-3","usage":{"input_tokens":1,"output_tokens":1} }"#;
    let builder = world
        .mock_response("three-lines")
        .with_exit_code(0)
        .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-3"}"#)
        .with_stdout_line(
            r#"{"type":"assistant","session_id":"sess-3","message":{"content":[{"type":"text","text":"intermediate"}] } }"#,
        )
        .with_stdout_line(result_line);
    set_prompt(world, builder).await;
}

#[when("the mock is scripted to succeed with only stderr output")]
pub async fn script_stderr_only(world: &mut DaemonWorld) {
    let builder = world
        .mock_response("stderr-only")
        .with_exit_code(0)
        .with_stderr_line("informational: nothing to report on stdout");
    set_prompt(world, builder).await;
}

#[when("the mock is scripted to exit with code 137")]
pub async fn script_exit_137(world: &mut DaemonWorld) {
    let builder = world.mock_response("sigkill").with_exit_code(137);
    set_prompt(world, builder).await;
}

#[when("the mock is scripted to emit malformed JSON inside a fence")]
pub async fn script_malformed_fence(world: &mut DaemonWorld) {
    // The daemon's schema validator extracts a fenced ```json block from the
    // stream-json `result` text and feeds it to serde_json. A fence with
    // syntactically invalid JSON triggers SchemaError::InvalidJson.
    let result_line = r#"{"type":"result","subtype":"success","cost_usd":0.0,"duration_ms":1.0,"is_error":false,"result":"Here:\n```json\n{not valid}\n```","session_id":"sess-bad","usage":{"input_tokens":1,"output_tokens":1} }"#;
    let builder = world
        .mock_response("malformed-fence")
        .with_exit_code(0)
        .with_stdout_line(result_line);
    set_prompt(world, builder).await;
}

#[when("the mock emits valid fenced JSON with surrounding prose")]
pub async fn script_valid_fence_with_prose(world: &mut DaemonWorld) {
    // Compatibility fixture for the daemon's legacy result-text fallback.
    let result_line = r#"{"type":"result","subtype":"success","cost_usd":0.0,"duration_ms":1.0,"is_error":false,"result":"Some preamble.\n\n```json\n{\"answer\":\"ok\"}\n```\n\nTrailing thoughts.","session_id":"sess-prose","usage":{"input_tokens":1,"output_tokens":1} }"#;
    let builder = world
        .mock_response("prose-fence")
        .with_exit_code(0)
        .with_stdout_line(result_line);
    set_prompt(world, builder).await;
}

#[when("the mock emits structured JSON output")]
pub async fn script_structured_json_output(world: &mut DaemonWorld) {
    // Claude emits schema-conforming JSON in the terminal `structured_output`
    // field when structured output is requested. The daemon should persist
    // this value directly instead of extracting JSON from result text.
    let result_line = r#"{"type":"result","subtype":"success","cost_usd":0.0,"duration_ms":1.0,"is_error":false,"result":"computed answer","structured_output":{"answer":"ok"},"session_id":"sess-structured","usage":{"input_tokens":1,"output_tokens":1} }"#;
    let builder = world
        .mock_response("structured-output")
        .with_exit_code(0)
        .with_stdout_line(result_line);
    set_prompt(world, builder).await;
}

#[when("the mock is scripted to emit output that violates the schema")]
pub async fn script_schema_violation(world: &mut DaemonWorld) {
    // Result text is not a valid object matching the schema: we declared
    // `answer: string` required, but the mock returns a bare number inside
    // result text which is not JSON-encodable as {"answer":"..."}.
    let result_line = r#"{"type":"result","subtype":"success","cost_usd":0.0,"duration_ms":10.0,"is_error":false,"result":"not-valid-json","session_id":"sess-1","usage":{"input_tokens":1,"output_tokens":1} }"#;
    let builder = world
        .mock_response("schema")
        .with_exit_code(0)
        .with_stdout_line(result_line);
    set_prompt(world, builder).await;
}

#[when(expr = "the mock is scripted to sleep {int} milliseconds")]
pub async fn script_sleep(world: &mut DaemonWorld, ms: u64) {
    let builder = world
        .mock_response("cancel")
        .with_exit_code(0)
        .with_delay_ms(ms)
        .with_stdout_line(r#"{"type":"system","subtype":"init","session_id":"sess-cancel"}"#);
    set_prompt(world, builder).await;
}

async fn set_prompt(world: &mut DaemonWorld, builder: daemon_acceptance::MockResponse) {
    let envelope = builder.build().expect("MockResponse envelope builds");
    let step_id = world.step_id.as_ref().expect("step not created").clone();
    world
        .run_vtb(&["step", "update", &step_id, "--prompt", &envelope])
        .await;
    world.assert_vtb_ok("step update --prompt");
}

#[when("run_step is invoked")]
pub async fn invoke_run_step(world: &mut DaemonWorld) {
    let task_id = world.task_id.as_ref().expect("task not created").clone();
    world.run_vtb(&["run", &task_id]).await;
    world.assert_vtb_ok("vtb run");

    // `vtb run` prints a human string with a short execution id. Resolve the
    // full UUID by listing the task's executions and picking the newest.
    let execution_id = world
        .latest_execution_id(&task_id)
        .await
        .unwrap_or_else(|e| panic!("could not resolve execution id after vtb run: {e}"));
    world.execution_id = Some(execution_id);
}

#[when(expr = "I wait for the execution to reach status {string}")]
pub async fn wait_for_status(world: &mut DaemonWorld, target: String) {
    let execution_id = world
        .execution_id
        .as_ref()
        .expect("no execution id recorded")
        .clone();
    let result = world
        .poll_execution(&execution_id, &[&target], DEFAULT_POLL_TIMEOUT)
        .await
        .expect("polling did not observe target status");
    world.last_execution = Some(result);
}
